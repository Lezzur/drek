import { Hono } from 'hono';
import { logger } from '../logger.js';
import { selectTitle } from '../engine/select-title.js';
import { selectThumbnail } from '../engine/select-thumbnail.js';
import { generateTitleVariants } from '../engine/generate-title-variants.js';
import { generateThumbnailConcepts } from '../engine/generate-thumbnail-concepts.js';
import { PlanningEngineError } from '../engine/errors.js';
import { getDeliverable } from '../db/deliverables.js';

/**
 * Per-deliverable action routes. Plan-level routes (which dispatch to the
 * long-form deliverable) live in src/routes/plan.tsx. These are the routes
 * Rick hits for per-Short title/thumbnail selection in M23.
 */

const app = new Hono();

async function readConceptId(c: import('hono').Context): Promise<string | undefined> {
  const contentType = c.req.header('content-type') ?? '';
  if (contentType.includes('application/json')) {
    const body = await c.req.json<{ conceptId?: string }>().catch(() => null);
    return body?.conceptId;
  }
  const form = (await c.req.parseBody().catch(() => null)) as Record<string, unknown> | null;
  if (!form) return undefined;
  const v = form['conceptId'];
  return typeof v === 'string' ? v : undefined;
}

function planningErrToHttp(err: PlanningEngineError) {
  const code = err.code;
  if (code === 'PLAN_NOT_FOUND') return 404;
  if (
    code === 'WRONG_PLAN_TYPE' ||
    code === 'DISALLOWED_TRANSITION' ||
    code === 'NO_FORMAT_PROFILE' ||
    code === 'NO_LONG_FORM_DELIVERABLE' ||
    code === 'NO_REQUIREMENTS'
  ) {
    return 400;
  }
  return 500;
}

/** POST /deliverables/:deliverableId/generate-titles — fires Call 7. */
app.post('/deliverables/:deliverableId/generate-titles', async (c) => {
  const id = c.req.param('deliverableId');
  try {
    await generateTitleVariants(id);
    const planId = (await getDeliverable(id))?.planId;
    if (planId) {
      c.header('HX-Redirect', `/plans/${planId}/workshop/titles?deliverableId=${id}`);
    }
    return c.text('', 200);
  } catch (err) {
    if (err instanceof PlanningEngineError) {
      return c.json(
        { error: { code: err.code, message: err.message } },
        planningErrToHttp(err) as 400 | 404 | 500,
      );
    }
    logger.error({ deliverableId: id, err: (err as Error).message }, 'deliverable generate-titles failed');
    return c.json({ error: { code: 'INTERNAL_ERROR', message: (err as Error).message } }, 500);
  }
});

/** POST /deliverables/:deliverableId/generate-thumbnails — fires Call 8. */
app.post('/deliverables/:deliverableId/generate-thumbnails', async (c) => {
  const id = c.req.param('deliverableId');
  try {
    await generateThumbnailConcepts(id);
    const planId = (await getDeliverable(id))?.planId;
    if (planId) {
      c.header('HX-Redirect', `/plans/${planId}/workshop/thumbnails?deliverableId=${id}`);
    }
    return c.text('', 200);
  } catch (err) {
    if (err instanceof PlanningEngineError) {
      return c.json(
        { error: { code: err.code, message: err.message } },
        planningErrToHttp(err) as 400 | 404 | 500,
      );
    }
    logger.error({ deliverableId: id, err: (err as Error).message }, 'deliverable generate-thumbnails failed');
    return c.json({ error: { code: 'INTERNAL_ERROR', message: (err as Error).message } }, 500);
  }
});

/** POST /deliverables/:deliverableId/select-title — body conceptId */
app.post('/deliverables/:deliverableId/select-title', async (c) => {
  const id = c.req.param('deliverableId');
  const conceptId = await readConceptId(c);
  if (!conceptId) {
    return c.json({ error: { code: 'INVALID_INPUT', message: 'conceptId is required' } }, 400);
  }
  try {
    await selectTitle(id, conceptId);
    const planId = (await getDeliverable(id))?.planId;
    if (planId) {
      c.header('HX-Redirect', `/plans/${planId}/workshop/titles?deliverableId=${id}`);
    }
    return c.text('', 200);
  } catch (err) {
    if (err instanceof PlanningEngineError) {
      return c.json(
        { error: { code: err.code, message: err.message } },
        planningErrToHttp(err) as 400 | 404 | 500,
      );
    }
    logger.error({ deliverableId: id, err: (err as Error).message }, 'deliverable select-title failed');
    return c.json({ error: { code: 'INTERNAL_ERROR', message: (err as Error).message } }, 500);
  }
});

/** POST /deliverables/:deliverableId/select-thumbnail — body conceptId */
app.post('/deliverables/:deliverableId/select-thumbnail', async (c) => {
  const id = c.req.param('deliverableId');
  const conceptId = await readConceptId(c);
  if (!conceptId) {
    return c.json({ error: { code: 'INVALID_INPUT', message: 'conceptId is required' } }, 400);
  }
  try {
    await selectThumbnail(id, conceptId);
    const planId = (await getDeliverable(id))?.planId;
    if (planId) {
      c.header('HX-Redirect', `/plans/${planId}/workshop/thumbnails?deliverableId=${id}`);
    }
    return c.text('', 200);
  } catch (err) {
    if (err instanceof PlanningEngineError) {
      return c.json(
        { error: { code: err.code, message: err.message } },
        planningErrToHttp(err) as 400 | 404 | 500,
      );
    }
    logger.error({ deliverableId: id, err: (err as Error).message }, 'deliverable select-thumbnail failed');
    return c.json({ error: { code: 'INTERNAL_ERROR', message: (err as Error).message } }, 500);
  }
});

export default app;
