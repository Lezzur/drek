import { Hono } from 'hono';
import { z } from 'zod';
import { logger } from '../logger.js';
import {
  applyBulkBriefAction,
  createBrief,
  createBriefBatchWithScoring,
  deleteBrief,
  getBrief,
  getBriefBatch,
  listBriefs,
  transitionBriefStage,
  promoteBriefToPlan,
  updateBriefScore,
  type BulkBriefAction,
} from '../intake/service.js';
import { scoreBriefViaLLM } from '../intake/scoring.js';
import { IntakeError } from '../intake/errors.js';
import { listFormatProfiles } from '../engine/format-profiles/index.js';
import { getAudienceProfileClient } from '../neurocore/audience-profiles.js';
import { briefScoreSchema, BRIEF_STAGES, type BriefStage } from '../db/schemas.js';
import { IntakeListPage } from '../views/intake.js';
import { BriefDetailPage } from '../views/intake-detail.js';
import { NewBriefForm } from '../views/intake-new.js';
import { BatchOverviewPage, NewBatchBriefForm } from '../views/intake-batch.js';

const app = new Hono();

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const stageFilterSchema = z.object({
  stage: z.enum(BRIEF_STAGES).optional(),
});

const briefCreateSchema = z.object({
  title: z.string().min(1, 'title is required').max(200, 'title too long'),
  rawText: z
    .string()
    .min(1, 'brief text is required')
    .max(50000, 'brief text must be ≤50000 characters'),
  sourceUrl: z.string().url('sourceUrl must be a valid URL').optional().or(z.literal('')),
  company: z.string().optional(),
});

const batchBriefRowSchema = z.object({
  title: z.string().min(1, 'title is required').max(200, 'title too long'),
  rawText: z
    .string()
    .min(1, 'brief text is required')
    .max(50000, 'brief text must be ≤50000 characters'),
  sourceUrl: z
    .string()
    .url('sourceUrl must be a valid URL')
    .optional()
    .or(z.literal('')),
  company: z.string().optional(),
});

const batchCreateSchema = z.object({
  briefs: z
    .array(batchBriefRowSchema)
    .min(1, 'at least one brief is required')
    .max(25, 'batch size must be ≤25 briefs'),
});

const stageTransitionSchema = z.object({
  stage: z.enum(BRIEF_STAGES),
});

const promoteSchema = z.object({
  formatProfileId: z.string().min(1, 'format profile is required'),
  audienceProfileId: z.string().min(1, 'audience profile is required'),
  targetRuntimeSeconds: z.coerce.number().int().min(30).max(3600).optional(),
});

const manualScoreSchema = z.object({
  visualOutcome: z.coerce.number().int().min(1).max(5),
  storyPotential: z.coerce.number().int().min(1).max(5),
  scopeFit: z.coerce.number().int().min(1).max(5),
  audienceMatch: z.coerce.number().int().min(1).max(5),
  scoringRationale: z.string().optional(),
});

const bulkActionSchema = z.object({
  briefIds: z.array(z.string().min(1)).min(1, 'at least one briefId required').max(50, 'max 50 briefs per bulk action'),
  action: z.enum(['retire', 'delete']),
});

// ---------------------------------------------------------------------------
// GET /intake — list briefs
// ---------------------------------------------------------------------------

app.get('/intake', async (c) => {
  const url = new URL(c.req.url);
  const queryParams = Object.fromEntries(url.searchParams);
  const filter = stageFilterSchema.safeParse(queryParams);
  const stage: BriefStage | undefined = filter.success ? filter.data.stage : undefined;

  const briefs = await listBriefs({ stage, limit: 200 });

  // Compute queue depth (candidate + vetted) for the pipeline warning.
  // For simplicity we count from the returned list when no stage filter,
  // or fetch both stages when filtered.
  let queueDepth: number;
  if (!stage) {
    queueDepth = briefs.filter((b) => b.stage === 'candidate' || b.stage === 'vetted').length;
  } else if (stage === 'candidate' || stage === 'vetted') {
    const other: BriefStage = stage === 'candidate' ? 'vetted' : 'candidate';
    const otherBriefs = await listBriefs({ stage: other, limit: 200 });
    queueDepth = briefs.length + otherBriefs.length;
  } else {
    // Fetch candidate+vetted separately
    const candidateBriefs = await listBriefs({ stage: 'candidate', limit: 200 });
    const vettedBriefs = await listBriefs({ stage: 'vetted', limit: 200 });
    queueDepth = candidateBriefs.length + vettedBriefs.length;
  }

  return c.html(
    <IntakeListPage briefs={briefs} currentStage={stage} queueDepth={queueDepth} />,
  );
});

// ---------------------------------------------------------------------------
// GET /intake/new — new brief form
// ---------------------------------------------------------------------------

app.get('/intake/new', async (c) => {
  return c.html(<NewBriefForm />);
});

// ---------------------------------------------------------------------------
// POST /intake — create brief
// ---------------------------------------------------------------------------

app.post('/intake', async (c) => {
  const form = await c.req.formData();
  const raw = Object.fromEntries(form) as Record<string, string>;

  const parsed = briefCreateSchema.safeParse({
    title: raw.title,
    rawText: raw.rawText,
    sourceUrl: raw.sourceUrl || undefined,
    company: raw.company || undefined,
  });

  if (!parsed.success) {
    return c.html(
      <NewBriefForm
        values={{
          title: raw.title,
          sourceUrl: raw.sourceUrl,
          company: raw.company,
          rawText: raw.rawText,
        }}
        error={parsed.error.errors[0]?.message ?? 'invalid input'}
      />,
      400,
    );
  }

  try {
    const brief = await createBrief({
      title: parsed.data.title,
      rawText: parsed.data.rawText,
      sourceUrl: parsed.data.sourceUrl && parsed.data.sourceUrl.length > 0
        ? parsed.data.sourceUrl
        : null,
      company: parsed.data.company ?? null,
    });
    return c.redirect(`/intake/${brief.id}`, 302);
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'intake: brief create failed');
    return c.html(
      <NewBriefForm
        values={{
          title: parsed.data.title,
          sourceUrl: parsed.data.sourceUrl,
          company: parsed.data.company,
          rawText: parsed.data.rawText,
        }}
        error={`Failed to create brief: ${(err as Error).message}`}
      />,
      500,
    );
  }
});

// ---------------------------------------------------------------------------
// GET /intake/batch/new — batch intake form (must come BEFORE /intake/:briefId)
// ---------------------------------------------------------------------------

app.get('/intake/batch/new', async (c) => {
  return c.html(<NewBatchBriefForm />);
});

// ---------------------------------------------------------------------------
// POST /intake/batch — submit a batch of N briefs
// ---------------------------------------------------------------------------

/**
 * Parse browser-style `briefs[0][title]=...&briefs[0][rawText]=...` form
 * encoding into a dense ordered array. Sparse indices are compacted.
 */
function parseBriefRowsFromForm(form: FormData): unknown[] {
  const rowMap = new Map<number, Record<string, unknown>>();
  const fieldRe = /^briefs\[(\d+)\]\[(\w+)\]$/;
  for (const [key, value] of form.entries()) {
    const match = key.match(fieldRe);
    if (!match) continue;
    const idx = Number(match[1]);
    const field = match[2]!;
    if (!rowMap.has(idx)) rowMap.set(idx, {});
    const row = rowMap.get(idx)!;
    row[field] = value;
  }
  const orderedIndices = [...rowMap.keys()].sort((a, b) => a - b);
  return orderedIndices.map((i) => rowMap.get(i)!);
}

app.post('/intake/batch', async (c) => {
  const contentType = c.req.header('content-type') ?? '';
  let rows: unknown[];
  if (contentType.includes('application/json')) {
    const body = (await c.req.json().catch(() => null)) as { briefs?: unknown[] } | null;
    rows = Array.isArray(body?.briefs) ? body.briefs : [];
  } else {
    const form = await c.req.formData();
    rows = parseBriefRowsFromForm(form);
  }

  const parsed = batchCreateSchema.safeParse({ briefs: rows });
  if (!parsed.success) {
    return c.html(
      <NewBatchBriefForm
        values={rows as Array<Record<string, string>>}
        error={parsed.error.errors[0]?.message ?? 'invalid input'}
      />,
      400,
    );
  }

  try {
    const result = await createBriefBatchWithScoring({
      briefs: parsed.data.briefs.map((r) => ({
        title: r.title,
        rawText: r.rawText,
        sourceUrl: r.sourceUrl && r.sourceUrl.length > 0 ? r.sourceUrl : null,
        company: r.company && r.company.length > 0 ? r.company : null,
      })),
    });
    return c.redirect(`/intake/batch/${result.batchId}`, 302);
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'intake.batch: create failed');
    return c.html(
      <NewBatchBriefForm
        values={parsed.data.briefs as Array<Record<string, string>>}
        error={`Failed to create batch: ${(err as Error).message}`}
      />,
      500,
    );
  }
});

// ---------------------------------------------------------------------------
// GET /intake/batch/:batchId — batch overview (HTMX-polled while scoring)
// ---------------------------------------------------------------------------

app.get('/intake/batch/:batchId', async (c) => {
  const batchId = c.req.param('batchId');
  const briefs = await getBriefBatch(batchId);
  if (briefs.length === 0) {
    return c.html('<h1>404 — batch not found</h1>', 404);
  }
  return c.html(<BatchOverviewPage batchId={batchId} briefs={briefs} />);
});

// ---------------------------------------------------------------------------
// POST /intake/bulk-action — multi-select operations from the pipeline list
// (must come BEFORE /intake/:briefId so the wildcard doesn't swallow it)
// ---------------------------------------------------------------------------

app.post('/intake/bulk-action', async (c) => {
  const contentType = c.req.header('content-type') ?? '';
  let body: { briefIds?: string[] | string; action?: BulkBriefAction };
  if (contentType.includes('application/json')) {
    body = (await c.req.json().catch(() => ({}))) as typeof body;
  } else {
    const form = await c.req.formData();
    // Form-encoded multi-select sends repeated briefIds entries OR a single
    // comma-joined string; accept both shapes for browser ergonomics.
    const ids = form.getAll('briefIds').map(String).filter(Boolean);
    body = {
      briefIds: ids.length > 0 ? ids : undefined,
      action: form.get('action') as BulkBriefAction | undefined,
    };
  }

  // Normalize comma-joined string → array.
  const normalizedIds = Array.isArray(body.briefIds)
    ? body.briefIds
    : typeof body.briefIds === 'string'
    ? body.briefIds.split(',').map((s) => s.trim()).filter(Boolean)
    : [];

  const parsed = bulkActionSchema.safeParse({
    briefIds: normalizedIds,
    action: body.action,
  });
  if (!parsed.success) {
    return c.json(
      { error: { code: 'INVALID_INPUT', message: parsed.error.errors[0]?.message ?? 'invalid bulk action' } },
      400,
    );
  }

  try {
    const result = await applyBulkBriefAction(parsed.data.briefIds, parsed.data.action);
    logger.info(
      { action: result.action, requested: result.requested, succeeded: result.succeeded, skipped: result.skipped, failureCount: result.failures.length },
      'intake.bulk-action',
    );
    // HTMX clients get a redirect back to /intake; JSON clients get the result.
    if (c.req.header('hx-request')) {
      c.header('HX-Redirect', '/intake');
      return c.text('', 200);
    }
    return c.json({ result });
  } catch (err) {
    if (err instanceof IntakeError) {
      const status = err.code === 'BULK_TOO_LARGE' ? 400 : 500;
      return c.json({ error: { code: err.code, message: err.message } }, status);
    }
    logger.error({ err: (err as Error).message }, 'intake.bulk-action: unexpected error');
    throw err;
  }
});

// ---------------------------------------------------------------------------
// DELETE /intake/:briefId — hard-delete a single brief
// ---------------------------------------------------------------------------

app.delete('/intake/:briefId', async (c) => {
  const briefId = c.req.param('briefId');
  try {
    const { deleted } = await deleteBrief(briefId);
    if (c.req.header('hx-request')) {
      c.header('HX-Redirect', '/intake');
      return c.text('', 200);
    }
    return c.json({ briefId, deleted });
  } catch (err) {
    logger.error({ briefId, err: (err as Error).message }, 'intake.delete: failed');
    throw err;
  }
});

// ---------------------------------------------------------------------------
// GET /intake/:briefId — brief detail
// ---------------------------------------------------------------------------

app.get('/intake/:briefId', async (c) => {
  const briefId = c.req.param('briefId');
  const flashParam = new URL(c.req.url).searchParams.get('flash');

  try {
    const [brief, formatProfiles, audienceProfiles] = await Promise.all([
      getBrief(briefId),
      Promise.resolve(listFormatProfiles()),
      getAudienceProfileClient()
        .list()
        .catch(() => []),
    ]);

    const flash =
      flashParam === 'scored'
        ? { type: 'ok' as const, message: 'Brief scored successfully.' }
        : null;

    return c.html(
      <BriefDetailPage
        brief={brief}
        formatProfiles={formatProfiles}
        audienceProfiles={audienceProfiles}
        flash={flash}
      />,
    );
  } catch (err) {
    if (err instanceof IntakeError && err.code === 'BRIEF_NOT_FOUND') {
      return c.json({ error: { code: 'NOT_FOUND', message: `Brief ${briefId} not found` } }, 404);
    }
    throw err;
  }
});

// ---------------------------------------------------------------------------
// POST /intake/:briefId/score — LLM scoring
// ---------------------------------------------------------------------------

app.post('/intake/:briefId/score', async (c) => {
  const briefId = c.req.param('briefId');
  try {
    await scoreBriefViaLLM(briefId);
    return c.redirect(`/intake/${briefId}?flash=scored`, 302);
  } catch (err) {
    if (err instanceof IntakeError) {
      if (err.code === 'BRIEF_NOT_FOUND') {
        return c.json(
          { error: { code: err.code, message: err.message } },
          404,
        );
      }
      if (err.code === 'LLM_FAILED' || err.code === 'INVALID_OUTPUT') {
        return c.json(
          { error: { code: err.code, message: err.message } },
          500,
        );
      }
    }
    logger.error({ briefId, err: (err as Error).message }, 'intake: scoring failed');
    throw err;
  }
});

// ---------------------------------------------------------------------------
// POST /intake/:briefId/stage — stage transition
// ---------------------------------------------------------------------------

app.post('/intake/:briefId/stage', async (c) => {
  const briefId = c.req.param('briefId');

  let body: Record<string, string>;
  const contentType = c.req.header('content-type') ?? '';
  if (contentType.includes('application/json')) {
    body = (await c.req.json()) as Record<string, string>;
  } else {
    const form = await c.req.formData();
    body = Object.fromEntries(form) as Record<string, string>;
  }

  const parsed = stageTransitionSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      {
        error: {
          code: 'INVALID_STAGE',
          message: parsed.error.errors[0]?.message ?? 'invalid stage',
        },
      },
      400,
    );
  }

  try {
    await transitionBriefStage(briefId, parsed.data.stage);
    return c.redirect(`/intake/${briefId}`, 302);
  } catch (err) {
    if (err instanceof IntakeError) {
      if (err.code === 'BRIEF_NOT_FOUND') {
        return c.json({ error: { code: err.code, message: err.message } }, 404);
      }
      if (err.code === 'INVALID_STAGE_TRANSITION') {
        return c.json({ error: { code: err.code, message: err.message } }, 400);
      }
    }
    throw err;
  }
});

// ---------------------------------------------------------------------------
// POST /intake/:briefId/promote — promote brief to plan
// ---------------------------------------------------------------------------

app.post('/intake/:briefId/promote', async (c) => {
  const briefId = c.req.param('briefId');

  let rawBody: Record<string, string>;
  const contentType = c.req.header('content-type') ?? '';
  if (contentType.includes('application/json')) {
    rawBody = (await c.req.json()) as Record<string, string>;
  } else {
    const form = await c.req.formData();
    rawBody = Object.fromEntries(form) as Record<string, string>;
  }

  const parsed = promoteSchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.json(
      {
        error: {
          code: 'INVALID_INPUT',
          message: parsed.error.errors[0]?.message ?? 'invalid input',
        },
      },
      400,
    );
  }

  // Need these for the error re-render path.
  const formatProfiles = listFormatProfiles();
  const audienceProfiles = await getAudienceProfileClient()
    .list()
    .catch(() => []);

  try {
    const { planId } = await promoteBriefToPlan(briefId, {
      formatProfileId: parsed.data.formatProfileId,
      audienceProfileId: parsed.data.audienceProfileId,
      targetRuntimeSeconds: parsed.data.targetRuntimeSeconds,
    });
    return c.redirect(`/plans/${planId}`, 302);
  } catch (err) {
    if (err instanceof IntakeError) {
      // For user-facing errors, re-render the detail page with a flash.
      if (
        err.code === 'BRIEF_NOT_FOUND' ||
        err.code === 'BRIEF_MISSING_SCORE' ||
        err.code === 'BRIEF_ALREADY_PROMOTED' ||
        err.code === 'UNKNOWN_FORMAT_PROFILE' ||
        err.code === 'UNKNOWN_AUDIENCE_PROFILE'
      ) {
        // Try to get the brief for re-render; if not found return 404 JSON.
        if (err.code === 'BRIEF_NOT_FOUND') {
          return c.json({ error: { code: err.code, message: err.message } }, 404);
        }

        try {
          const brief = await getBrief(briefId);
          return c.html(
            <BriefDetailPage
              brief={brief}
              formatProfiles={formatProfiles}
              audienceProfiles={audienceProfiles}
              flash={{ type: 'err', message: err.message }}
            />,
            400,
          );
        } catch {
          return c.json({ error: { code: err.code, message: err.message } }, 400);
        }
      }
    }
    logger.error({ briefId, err: (err as Error).message }, 'intake: promote failed');
    throw err;
  }
});

// ---------------------------------------------------------------------------
// PATCH /intake/:briefId — manual score edit
// ---------------------------------------------------------------------------

app.patch('/intake/:briefId', async (c) => {
  const briefId = c.req.param('briefId');

  let body: Record<string, unknown>;
  const contentType = c.req.header('content-type') ?? '';
  if (contentType.includes('application/json')) {
    body = (await c.req.json()) as Record<string, unknown>;
  } else {
    const form = await c.req.formData();
    body = Object.fromEntries(form) as Record<string, unknown>;
  }

  const parsed = manualScoreSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      {
        error: {
          code: 'INVALID_INPUT',
          message: parsed.error.errors[0]?.message ?? 'invalid score',
        },
      },
      400,
    );
  }

  const { visualOutcome, storyPotential, scopeFit, audienceMatch, scoringRationale } =
    parsed.data;

  const aggregate =
    Math.round(((visualOutcome + storyPotential + scopeFit + audienceMatch) / 4) * 10) / 10;

  const score = briefScoreSchema.parse({
    visualOutcome,
    storyPotential,
    scopeFit,
    audienceMatch,
    aggregate,
  });

  try {
    const updated = await updateBriefScore(briefId, score, scoringRationale);
    const formatProfiles = listFormatProfiles();
    const audienceProfiles = await getAudienceProfileClient()
      .list()
      .catch(() => []);
    return c.html(
      <BriefDetailPage
        brief={updated}
        formatProfiles={formatProfiles}
        audienceProfiles={audienceProfiles}
        flash={{ type: 'ok', message: 'Scores updated.' }}
      />,
    );
  } catch (err) {
    if (err instanceof IntakeError && err.code === 'BRIEF_NOT_FOUND') {
      return c.json({ error: { code: 'NOT_FOUND', message: err.message } }, 404);
    }
    throw err;
  }
});

export default app;
