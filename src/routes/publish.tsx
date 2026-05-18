import { Hono } from 'hono';
import { logger } from '../logger.js';
import { getPlan } from '../db/plans.js';
import { getDeliverable } from '../db/deliverables.js';
import {
  getPublishMetadata,
  patchPublishMetadata,
} from '../db/publish-metadata.js';
import { getSelectedTitleConcept } from '../db/title-concepts.js';
import {
  generatePublishMetadata,
  renderPublishBundle,
} from '../engine/generate-publish-metadata.js';
import {
  publishDeliverable,
  InvalidYouTubeUrlError,
} from '../engine/publish-deliverable.js';
import { PlanningEngineError } from '../engine/errors.js';
import { PublishMetadataView } from '../views/publish.js';
import { publishMetadataPatchSchema } from '../db/schemas.js';

const app = new Hono();

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

/**
 * GET /deliverables/:deliverableId/publish
 *
 * Renders the publish-metadata workshop for a deliverable. If no metadata
 * has been generated yet, shows an empty state with a "Generate" CTA.
 */
app.get('/deliverables/:deliverableId/publish', async (c) => {
  const id = c.req.param('deliverableId');
  const deliverable = await getDeliverable(id);
  if (!deliverable) {
    return c.html('<h1>404 — deliverable not found</h1>', 404);
  }
  const plan = await getPlan(deliverable.planId);
  if (!plan) {
    return c.html('<h1>404 — parent plan not found</h1>', 404);
  }
  const metadata = await getPublishMetadata(id);
  const selectedTitle = await getSelectedTitleConcept(id);
  return c.html(
    <PublishMetadataView
      plan={plan}
      deliverable={deliverable}
      metadata={metadata}
      selectedTitleText={selectedTitle?.titleText ?? null}
    />,
  );
});

/**
 * GET /deliverables/:deliverableId/publish/bundle
 *
 * Plain-text dump of the upload bundle (title + description + chapters +
 * tags + pinned comment + end-screen). Designed for copy-paste straight
 * into the YouTube Studio upload form.
 */
app.get('/deliverables/:deliverableId/publish/bundle', async (c) => {
  const id = c.req.param('deliverableId');
  const deliverable = await getDeliverable(id);
  if (!deliverable) {
    return c.text('deliverable not found', 404);
  }
  const metadata = await getPublishMetadata(id);
  if (!metadata) {
    return c.text('no publish metadata generated yet', 404);
  }
  const selectedTitle = await getSelectedTitleConcept(id);
  const title = selectedTitle?.titleText ?? deliverable.title;
  const bundle = renderPublishBundle({ title, metadata });
  c.header('Content-Type', 'text/plain; charset=utf-8');
  return c.text(bundle);
});

/**
 * PATCH /deliverables/:deliverableId/publish
 *
 * Inline edits to the publish metadata. Accepts any of description, tags
 * (as tagsCsv), pinnedComment, endScreenSuggestion. Returns the
 * re-rendered publish view.
 */
app.patch('/deliverables/:deliverableId/publish', async (c) => {
  const id = c.req.param('deliverableId');
  const deliverable = await getDeliverable(id);
  if (!deliverable) {
    return c.text('deliverable not found', 404);
  }

  const contentType = c.req.header('content-type') ?? '';
  let form: Record<string, unknown> = {};
  try {
    if (contentType.includes('application/json')) {
      form = (await c.req.json<Record<string, unknown>>()) ?? {};
    } else {
      form = (await c.req.parseBody()) as Record<string, unknown>;
    }
  } catch {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'could not parse body' } }, 400);
  }

  const patch: Record<string, unknown> = {};
  if (typeof form.description === 'string') patch.description = form.description;
  if (typeof form.pinnedComment === 'string') patch.pinnedComment = form.pinnedComment;
  if (typeof form.endScreenSuggestion === 'string') {
    patch.endScreenSuggestion = form.endScreenSuggestion;
  }
  if (typeof form.tagsCsv === 'string') {
    patch.tags = form.tagsCsv
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
  } else if (Array.isArray(form.tags)) {
    patch.tags = form.tags;
  }

  const parsed = publishMetadataPatchSchema.safeParse(patch);
  if (!parsed.success) {
    return c.json(
      { error: { code: 'INVALID_INPUT', message: parsed.error.issues.map((i) => i.message).join('; ') } },
      400,
    );
  }

  try {
    const updated = await patchPublishMetadata(id, parsed.data);
    if (!updated) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'no metadata to update' } }, 404);
    }
  } catch (err) {
    logger.error({ deliverableId: id, err: (err as Error).message }, 'publish patch failed');
    return c.json({ error: { code: 'INTERNAL_ERROR', message: (err as Error).message } }, 500);
  }

  c.header('HX-Redirect', `/deliverables/${id}/publish`);
  return c.text('', 200);
});

/**
 * POST /deliverables/:deliverableId/publish — mark this deliverable as
 * published. Body: youtubeUrl. Fires the script.published signal to
 * Neurocore (best-effort). On success, re-renders the publish view.
 */
app.post('/deliverables/:deliverableId/publish', async (c) => {
  const id = c.req.param('deliverableId');
  let youtubeUrl: string | undefined;
  const contentType = c.req.header('content-type') ?? '';
  try {
    if (contentType.includes('application/json')) {
      const body = await c.req.json<{ youtubeUrl?: string }>();
      youtubeUrl = body.youtubeUrl;
    } else {
      const form = await c.req.parseBody();
      youtubeUrl = form['youtubeUrl'] as string | undefined;
    }
  } catch {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'could not parse body' } }, 400);
  }

  if (!youtubeUrl) {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'youtubeUrl required' } }, 400);
  }

  try {
    await publishDeliverable(id, youtubeUrl);
    c.header('HX-Redirect', `/deliverables/${id}/publish`);
    return c.text('', 200);
  } catch (err) {
    if (err instanceof InvalidYouTubeUrlError) {
      return c.json(
        { error: { code: 'INVALID_INPUT', message: err.message, field: 'youtubeUrl' } },
        400,
      );
    }
    if (err instanceof PlanningEngineError) {
      return c.json(
        { error: { code: err.code, message: err.message } },
        planningErrToHttp(err) as 400 | 404 | 500,
      );
    }
    logger.error({ deliverableId: id, err: (err as Error).message }, 'publish deliverable failed');
    return c.json({ error: { code: 'INTERNAL_ERROR', message: (err as Error).message } }, 500);
  }
});

/**
 * POST /deliverables/:deliverableId/generate-publish-metadata
 *
 * Fires Call 10 for this deliverable. On success: HX-Redirect to the
 * publish view.
 */
app.post('/deliverables/:deliverableId/generate-publish-metadata', async (c) => {
  const id = c.req.param('deliverableId');
  try {
    await generatePublishMetadata(id);
    c.header('HX-Redirect', `/deliverables/${id}/publish`);
    return c.text('', 200);
  } catch (err) {
    if (err instanceof PlanningEngineError) {
      return c.json(
        { error: { code: err.code, message: err.message } },
        planningErrToHttp(err) as 400 | 404 | 500,
      );
    }
    logger.error(
      { deliverableId: id, err: (err as Error).message },
      'generate-publish-metadata failed',
    );
    return c.json({ error: { code: 'INTERNAL_ERROR', message: (err as Error).message } }, 500);
  }
});

export default app;
