import { Hono } from 'hono';
import { logger } from '../logger.js';
import { getPlan, patchPlan } from '../db/plans.js';
import { listScenes } from '../db/scenes.js';
import { PlanDetailPage } from '../views/plan-detail.js';
import { detectRequirements } from '../engine/detect-requirements.js';
import { matchProjects } from '../engine/match-projects.js';
import { generatePlanContent } from '../engine/write-scripts.js';
import { generateHookVariants } from '../engine/generate-hook-variants.js';
import { selectHook } from '../engine/select-hook.js';
import { runPipeline } from '../engine/pipeline.js';
import { PlanningEngineError } from '../engine/errors.js';
import { changePlanFormatProfile } from '../engine/change-format.js';
import { getNeurocoreClient } from '../neurocore/index.js';

const app = new Hono();

/**
 * Render the plan detail page. The page is the canonical view for the
 * planning lifecycle — every engine action (analyze, match, generate,
 * finalize) returns a re-render of this page so the user always sees
 * the latest persisted state.
 */
async function renderPlanPage(
  c: import('hono').Context,
  planId: string,
  flash?: { type: 'ok' | 'warn' | 'err'; message: string } | null,
): Promise<Response> {
  const plan = await getPlan(planId);
  if (!plan) {
    return c.html('<h1>404 — plan not found</h1>', 404);
  }
  const scenes = await listScenes(planId);
  return c.html(
    <PlanDetailPage plan={plan} scenes={scenes} flash={flash ?? null} />,
  );
}

app.get('/plans/:id', async (c) => {
  return renderPlanPage(c, c.req.param('id'));
});

/**
 * The four engine actions. Each runs the relevant pipeline step then
 * re-renders the plan page with a flash. PlanningEngineError surfaces as
 * a red flash; the page renders showing whatever state DID persist.
 *
 * We use POST + hx-swap=outerHTML on body so the entire page refresh is
 * one round-trip — no partial state synchronization needed in client.
 */

app.post('/plans/:id/run', async (c) => {
  const id = c.req.param('id');
  try {
    const result = await runPipeline(id, { client: getNeurocoreClient() });
    const parts: string[] = [];
    if (result.requirementsResult) {
      const n = result.requirementsResult.requirements.length;
      parts.push(`${n} requirement${n === 1 ? '' : 's'} extracted`);
    }
    const pm = result.matchResult.matchedProjects.length;
    parts.push(`${pm} project${pm === 1 ? '' : 's'} matched`);
    const sc = result.scriptsResult.scenes.length;
    parts.push(`${sc} scene${sc === 1 ? '' : 's'} with scripts`);
    const degraded = result.matchResult.degraded || result.scriptsResult.degraded;
    return renderPlanPage(c, id, {
      type: degraded ? 'warn' : 'ok',
      message:
        parts.join(' · ') +
        (degraded ? ' — Neurocore degraded, context may be thinner' : ''),
    });
  } catch (err) {
    return renderPlanPage(c, id, errorToFlash(err, 'pipeline'));
  }
});

app.post('/plans/:id/analyze', async (c) => {
  const id = c.req.param('id');
  try {
    const result = await detectRequirements(id);
    return renderPlanPage(c, id, {
      type: 'ok',
      message: `Extracted ${result.requirements.length} requirement${result.requirements.length === 1 ? '' : 's'}.`,
    });
  } catch (err) {
    return renderPlanPage(c, id, errorToFlash(err, 'requirement detection'));
  }
});

app.post('/plans/:id/match', async (c) => {
  const id = c.req.param('id');
  try {
    const result = await matchProjects(id, { client: getNeurocoreClient() });
    const msg = result.degraded
      ? `Matched ${result.matchedProjects.length} project(s). Neurocore returned a degraded response — context may be thinner than usual.`
      : `Matched ${result.matchedProjects.length} project(s).`;
    return renderPlanPage(c, id, { type: result.degraded ? 'warn' : 'ok', message: msg });
  } catch (err) {
    return renderPlanPage(c, id, errorToFlash(err, 'project matching'));
  }
});

app.post('/plans/:id/generate', async (c) => {
  const id = c.req.param('id');
  try {
    const result = await generatePlanContent(id, { client: getNeurocoreClient() });
    const scenes = result.scriptsResult.scenes.length;
    return renderPlanPage(c, id, {
      type: 'ok',
      message: `Generated ${scenes} scene${scenes === 1 ? '' : 's'} with scripts.`,
    });
  } catch (err) {
    return renderPlanPage(c, id, errorToFlash(err, 'scene + script generation'));
  }
});

/**
 * Finalize — transition to 'finalized' and send approved scripts to
 * Neurocore as spoken-voice training data. Failure of the Neurocore
 * call doesn't roll back the status transition — local finalization
 * succeeded; the spoken-voice feedback is best-effort.
 */
app.post('/plans/:id/finalize', async (c) => {
  const id = c.req.param('id');
  try {
    const plan = await getPlan(id);
    if (!plan) return c.html('<h1>404</h1>', 404);
    const scenes = await listScenes(id);
    if (scenes.length === 0) {
      return renderPlanPage(c, id, {
        type: 'err',
        message: 'Cannot finalize a plan with no scenes.',
      });
    }
    await patchPlan(id, { status: 'finalized' });
    // Send approved scripts back to Neurocore for spoken-voice calibration.
    try {
      const client = getNeurocoreClient();
      await client.sendApprovedScript({
        planId: id,
        planMode: plan.type,
        scenes: scenes.map((s) => ({
          script: s.script,
          scriptDraft: s.scriptDraft,
          wasEdited: s.script !== s.scriptDraft,
        })),
      });
    } catch (err) {
      logger.warn(
        { id, err: (err as Error).message },
        'finalize: sendApprovedScript failed (non-fatal)',
      );
    }
    return renderPlanPage(c, id, {
      type: 'ok',
      message: 'Finalized. Approved scripts sent to Neurocore for spoken-voice training.',
    });
  } catch (err) {
    return renderPlanPage(c, id, errorToFlash(err, 'finalize'));
  }
});

/**
 * POST /plans/:id/change-format
 * Body: { formatProfileId: string }
 *
 * Changes the plan's format profile, wiping all format-dependent data
 * (scenes, hook drafts, title/thumbnail concepts, short_clip deliverables)
 * and reverting the plan to `projects_matched`. For plans not yet past
 * `projects_matched`, just updates formatProfileId (no-op wipe).
 *
 * Per TECH-SPEC §4.9. Only applies to youtube_advanced plans.
 */
app.post('/plans/:id/change-format', async (c) => {
  const id = c.req.param('id');
  let body: { formatProfileId?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400);
  }
  if (!body.formatProfileId || typeof body.formatProfileId !== 'string') {
    return c.json({ error: 'formatProfileId is required' }, 400);
  }

  try {
    await changePlanFormatProfile(id, body.formatProfileId);
    // HTMX: redirect to plan detail with success flash.
    c.header('HX-Redirect', `/plans/${id}?flash=format-changed`);
    return c.text('', 200);
  } catch (err) {
    if (err instanceof PlanningEngineError) {
      if (err.code === 'CANNOT_CHANGE_AFTER_PUBLISH') {
        return c.json({ error: err.message, code: err.code }, 409);
      }
      if (err.code === 'PLAN_NOT_FOUND') {
        return c.json({ error: err.message, code: err.code }, 404);
      }
      if (err.code === 'WRONG_PLAN_TYPE' || err.code === 'UNKNOWN_FORMAT_PROFILE') {
        return c.json({ error: err.message, code: err.code }, 400);
      }
    }
    logger.error({ planId: id, err: (err as Error).message }, 'change-format: unexpected error');
    return c.json({ error: (err as Error).message }, 500);
  }
});

/**
 * POST /plans/:id/generate-hooks
 *
 * Calls generateHookVariants then redirects to the hook workshop via
 * HX-Redirect so HTMX replaces the whole page.
 *
 * On PlanningEngineError returns 4xx with structured JSON.
 */
app.post('/plans/:id/generate-hooks', async (c) => {
  const id = c.req.param('id');
  try {
    await generateHookVariants(id);
    c.header('HX-Redirect', `/plans/${id}/workshop/hooks`);
    return c.text('', 200);
  } catch (err) {
    if (err instanceof PlanningEngineError) {
      const status =
        err.code === 'PLAN_NOT_FOUND' ? 404
        : err.code === 'WRONG_PLAN_TYPE' || err.code === 'DISALLOWED_TRANSITION' || err.code === 'NO_FORMAT_PROFILE' || err.code === 'NO_LONG_FORM_DELIVERABLE' ? 400
        : 500;
      return c.json({ error: { code: err.code, message: err.message } }, status as 400 | 404 | 500);
    }
    logger.error({ planId: id, err: (err as Error).message }, 'generate-hooks: unexpected error');
    return c.json({ error: { code: 'INTERNAL_ERROR', message: (err as Error).message } }, 500);
  }
});

/**
 * POST /plans/:id/select-hook
 * Body: hookId (form-encoded or JSON)
 *
 * Calls selectHook then redirects to the hook workshop.
 * On error returns 4xx structured JSON.
 */
app.post('/plans/:id/select-hook', async (c) => {
  const id = c.req.param('id');
  let hookId: string | undefined;
  try {
    // Support both form-encoded and JSON bodies.
    const contentType = c.req.header('content-type') ?? '';
    if (contentType.includes('application/json')) {
      const body = await c.req.json<{ hookId?: string }>();
      hookId = body.hookId;
    } else {
      const form = await c.req.parseBody();
      hookId = form['hookId'] as string | undefined;
    }
  } catch {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'could not parse request body' } }, 400);
  }

  if (!hookId || typeof hookId !== 'string') {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'hookId is required' } }, 400);
  }

  try {
    await selectHook(id, hookId);
    c.header('HX-Redirect', `/plans/${id}/workshop/hooks`);
    return c.text('', 200);
  } catch (err) {
    if (err instanceof PlanningEngineError) {
      const status =
        err.code === 'PLAN_NOT_FOUND' || err.code === 'HOOK_NOT_FOUND' ? 404
        : err.code === 'DISALLOWED_TRANSITION' ? 400
        : 500;
      return c.json({ error: { code: err.code, message: err.message } }, status as 400 | 404 | 500);
    }
    logger.error({ planId: id, err: (err as Error).message }, 'select-hook: unexpected error');
    return c.json({ error: { code: 'INTERNAL_ERROR', message: (err as Error).message } }, 500);
  }
});

function errorToFlash(
  err: unknown,
  stepLabel: string,
): { type: 'err'; message: string } {
  if (err instanceof PlanningEngineError) {
    return {
      type: 'err',
      message: `${stepLabel} failed (${err.code}): ${err.message}`,
    };
  }
  return {
    type: 'err',
    message: `${stepLabel} failed: ${(err as Error).message}`,
  };
}

export default app;
