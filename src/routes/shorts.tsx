import { Hono } from 'hono';
import { logger } from '../logger.js';
import { getPlan } from '../db/plans.js';
import {
  extractShortsCandidates,
  approveShortCandidate,
  type ShortCandidate,
} from '../engine/extract-shorts.js';
import { PlanningEngineError } from '../engine/errors.js';
import { ShortsCandidateView } from '../views/shorts-candidates.js';
import { listScenes } from '../db/scenes.js';

/**
 * Shorts candidate review routes.
 *
 * Candidates are EPHEMERAL — never persisted as Deliverable docs at
 * extraction time. We hold them in a tiny in-process cache keyed by planId.
 * The cache entry is evicted on approve, dismiss, or after 1 hour. Rick
 * can re-extract any time to get a fresh set.
 *
 * Routes:
 *   GET  /plans/:id/shorts            — render candidate review UI
 *   POST /plans/:id/extract-shorts    — fire Call 9, cache result, render
 *   POST /plans/:id/approve-short     — body: full ShortCandidate JSON;
 *                                       creates short_clip Deliverable +
 *                                       redirects to its publish page
 *   POST /plans/:id/dismiss-short     — body: candidateId; removes from cache
 */

const app = new Hono();

interface CacheEntry {
  candidates: ShortCandidate[];
  cachedAt: number;
}

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const candidatesByPlan = new Map<string, CacheEntry>();

function cacheGet(planId: string): ShortCandidate[] | null {
  const entry = candidatesByPlan.get(planId);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > CACHE_TTL_MS) {
    candidatesByPlan.delete(planId);
    return null;
  }
  return entry.candidates;
}

function cacheSet(planId: string, candidates: ShortCandidate[]): void {
  candidatesByPlan.set(planId, { candidates, cachedAt: Date.now() });
}

function cacheDelete(planId: string): void {
  candidatesByPlan.delete(planId);
}

/** Test-only: reset the in-memory cache between tests. */
export function _resetShortsCacheForTests(): void {
  candidatesByPlan.clear();
}

function planningErrToHttp(err: PlanningEngineError) {
  const code = err.code;
  if (code === 'PLAN_NOT_FOUND') return 404;
  if (
    code === 'WRONG_PLAN_TYPE' ||
    code === 'DISALLOWED_TRANSITION' ||
    code === 'NO_FORMAT_PROFILE' ||
    code === 'NO_LONG_FORM_DELIVERABLE' ||
    code === 'NO_REQUIREMENTS' ||
    code === 'INVALID_OUTPUT'
  ) {
    return 400;
  }
  return 500;
}

app.get('/plans/:id/shorts', async (c) => {
  const id = c.req.param('id');
  const plan = await getPlan(id);
  if (!plan) {
    return c.html('<h1>404 — plan not found</h1>', 404);
  }
  const candidates = cacheGet(id) ?? [];
  const scenes = await listScenes(id);
  return c.html(
    <ShortsCandidateView
      plan={plan}
      candidates={candidates}
      sceneTitlesById={Object.fromEntries(scenes.map((s) => [s.id, s.title]))}
    />,
  );
});

app.post('/plans/:id/extract-shorts', async (c) => {
  const id = c.req.param('id');
  try {
    const result = await extractShortsCandidates(id);
    cacheSet(id, result.candidates);
    c.header('HX-Redirect', `/plans/${id}/shorts`);
    return c.text('', 200);
  } catch (err) {
    if (err instanceof PlanningEngineError) {
      return c.json(
        { error: { code: err.code, message: err.message } },
        planningErrToHttp(err) as 400 | 404 | 500,
      );
    }
    logger.error({ planId: id, err: (err as Error).message }, 'extract-shorts: unexpected error');
    return c.json({ error: { code: 'INTERNAL_ERROR', message: (err as Error).message } }, 500);
  }
});

app.post('/plans/:id/approve-short', async (c) => {
  const id = c.req.param('id');
  let body: { candidateId?: string; reworkedScriptOverride?: string };
  try {
    const contentType = c.req.header('content-type') ?? '';
    if (contentType.includes('application/json')) {
      body = await c.req.json();
    } else {
      const form = await c.req.parseBody();
      body = {
        candidateId: form['candidateId'] as string | undefined,
        reworkedScriptOverride: form['reworkedScriptOverride'] as string | undefined,
      };
    }
  } catch {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'could not parse body' } }, 400);
  }

  if (!body.candidateId) {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'candidateId required' } }, 400);
  }

  const cached = cacheGet(id);
  if (!cached) {
    return c.json(
      { error: { code: 'NO_CANDIDATES', message: 'no cached candidates — extract first' } },
      400,
    );
  }
  const candidate = cached.find((c) => c.id === body.candidateId);
  if (!candidate) {
    return c.json(
      { error: { code: 'CANDIDATE_NOT_FOUND', message: `no candidate ${body.candidateId} in cache` } },
      404,
    );
  }

  const toApprove: ShortCandidate = body.reworkedScriptOverride
    ? { ...candidate, reworkedScript: body.reworkedScriptOverride }
    : candidate;

  try {
    const { deliverableId } = await approveShortCandidate(id, toApprove);
    // Evict the cache so re-extraction works against a clean slate.
    cacheDelete(id);
    c.header('HX-Redirect', `/deliverables/${deliverableId}/publish`);
    return c.text('', 200);
  } catch (err) {
    if (err instanceof PlanningEngineError) {
      return c.json(
        { error: { code: err.code, message: err.message } },
        planningErrToHttp(err) as 400 | 404 | 500,
      );
    }
    logger.error({ planId: id, err: (err as Error).message }, 'approve-short: unexpected error');
    return c.json({ error: { code: 'INTERNAL_ERROR', message: (err as Error).message } }, 500);
  }
});

app.post('/plans/:id/dismiss-short', async (c) => {
  const id = c.req.param('id');
  let body: { candidateId?: string };
  try {
    const contentType = c.req.header('content-type') ?? '';
    if (contentType.includes('application/json')) {
      body = await c.req.json();
    } else {
      const form = await c.req.parseBody();
      body = { candidateId: form['candidateId'] as string | undefined };
    }
  } catch {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'could not parse body' } }, 400);
  }
  if (!body.candidateId) {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'candidateId required' } }, 400);
  }
  const cached = cacheGet(id);
  if (cached) {
    cacheSet(
      id,
      cached.filter((c) => c.id !== body.candidateId),
    );
  }
  c.header('HX-Redirect', `/plans/${id}/shorts`);
  return c.text('', 200);
});

export default app;
