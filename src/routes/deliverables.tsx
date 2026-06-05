import { Hono } from 'hono';
import { logger } from '../logger.js';
import { selectTitle } from '../engine/select-title.js';
import { selectThumbnail } from '../engine/select-thumbnail.js';
import { generateTitleVariants } from '../engine/generate-title-variants.js';
import { generateThumbnailConcepts } from '../engine/generate-thumbnail-concepts.js';
import { PlanningEngineError } from '../engine/errors.js';
import {
  getDeliverable,
  listDeliverablesForPlan,
} from '../db/deliverables.js';
import { getPlan } from '../db/plans.js';
import { listScenes } from '../db/scenes.js';
import { getSelectedTitleConcept } from '../db/title-concepts.js';
import { getSelectedThumbnailConcept } from '../db/thumbnail-concepts.js';
import { getPublishMetadata } from '../db/publish-metadata.js';
import {
  DeliverableBundleView,
  type DeliverableSummary,
} from '../views/deliverable-bundle.js';
import { DeliverableDetailView } from '../views/deliverable-detail.js';
import { ShootInstructionsPage, toPlainText } from '../views/export.js';
import { renderPublishBundle } from '../engine/generate-publish-metadata.js';
import { exportToWorkspace } from '../workspace/service.js';
import type { Deliverable, Scene } from '../db/schemas.js';

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
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } }, 500);
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
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } }, 500);
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
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } }, 500);
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
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } }, 500);
  }
});

// ---------------------------------------------------------------------------
// Bundle view + per-deliverable detail + export-all (M24)
// ---------------------------------------------------------------------------

async function loadBundleSummaries(planId: string): Promise<DeliverableSummary[]> {
  const deliverables = await listDeliverablesForPlan(planId, { limit: 50 });
  const summaries: DeliverableSummary[] = [];
  for (const d of deliverables) {
    const [selectedTitle, selectedThumbnail, metadata] = await Promise.all([
      getSelectedTitleConcept(d.id),
      getSelectedThumbnailConcept(d.id),
      getPublishMetadata(d.id),
    ]);
    summaries.push({
      deliverable: d,
      selectedTitle,
      selectedThumbnail,
      hasPublishMetadata: !!metadata,
    });
  }
  return summaries;
}

app.get('/plans/:id/deliverables', async (c) => {
  const id = c.req.param('id');
  const plan = await getPlan(id);
  if (!plan) {
    return c.html('<h1>404 — plan not found</h1>', 404);
  }
  const summaries = await loadBundleSummaries(id);
  return c.html(<DeliverableBundleView plan={plan} summaries={summaries} />);
});

app.get('/plans/:id/deliverables/:deliverableId', async (c) => {
  const planId = c.req.param('id');
  const deliverableId = c.req.param('deliverableId');
  const plan = await getPlan(planId);
  if (!plan) return c.html('<h1>404 — plan not found</h1>', 404);
  const deliverable = await getDeliverable(deliverableId);
  if (!deliverable || deliverable.planId !== planId) {
    return c.html('<h1>404 — deliverable not found</h1>', 404);
  }

  let relatedScenes: Scene[];
  if (deliverable.kind === 'long_form' || !deliverable.scriptOverrideSceneIds) {
    relatedScenes = await listScenes(planId);
  } else {
    const all = await listScenes(planId);
    const overrideSet = new Set(deliverable.scriptOverrideSceneIds);
    relatedScenes = all.filter((s) => overrideSet.has(s.id));
  }

  return c.html(
    <DeliverableDetailView
      plan={plan}
      deliverable={deliverable}
      relatedScenes={relatedScenes}
      customScripts={deliverable.customScripts}
    />,
  );
});

/**
 * Convert a deliverable id (`del_abc123...`) into a slug-safe stem suitable
 * for the workspace filename validator (no underscores, alphanumeric + hyphens).
 */
function deliverableIdToFileStem(deliverableId: string): string {
  return deliverableId.replace(/_/g, '-');
}

interface ExportFailure {
  deliverableId: string;
  reason: string;
}

async function exportSingleDeliverable(
  planId: string,
  deliverable: Deliverable,
  scenes: Scene[],
): Promise<void> {
  const metadata = await getPublishMetadata(deliverable.id);
  if (!metadata) {
    throw new Error('no publish metadata generated yet');
  }
  const selectedTitle = await getSelectedTitleConcept(deliverable.id);
  const titleText = selectedTitle?.titleText ?? deliverable.title;
  const stem = deliverableIdToFileStem(deliverable.id);

  // Build the HTML + plain text shoot instructions using the deliverable's
  // scoped title so each export is self-describing.
  const scopedPlan = {
    id: planId,
    type: 'youtube_advanced' as const,
    status: 'finalized' as const,
    title: titleText,
    sourceListingId: null,
    sourceListingText: null,
    requirements: [],
    matchedProjects: [],
    targetRuntimeSeconds: scenes.reduce(
      (sum, s) => sum + s.estimatedDurationSeconds,
      0,
    ) || 60,
    estimatedRuntimeSeconds: scenes.reduce(
      (sum, s) => sum + s.estimatedDurationSeconds,
      0,
    ),
    userConstraints: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    exportedAt: null,
    formatProfileId: null,
    pipelineBriefId: null,
    workspacePath: null,
    selectedHookVariantId: null,
    selectedTitleVariantId: null,
    selectedThumbnailConceptId: null,
  };

  const htmlBody = String(
    ShootInstructionsPage({ plan: scopedPlan, scenes, stale: false }),
  );
  const txtBody = toPlainText(scopedPlan, scenes);
  const bundleBody = renderPublishBundle({ title: titleText, metadata });
  const metadataJson = JSON.stringify(metadata, null, 2);

  await exportToWorkspace(planId, 'exports', `${stem}-shoot-instructions.html`, htmlBody);
  await exportToWorkspace(planId, 'exports', `${stem}-shoot-instructions.txt`, txtBody);
  await exportToWorkspace(planId, 'exports', `${stem}-publish-bundle.txt`, bundleBody);
  await exportToWorkspace(planId, 'exports', `${stem}-metadata.json`, metadataJson);
}

app.post('/plans/:id/deliverables/export-all', async (c) => {
  const id = c.req.param('id');
  const plan = await getPlan(id);
  if (!plan) return c.html('<h1>404 — plan not found</h1>', 404);
  if (!plan.workspacePath) {
    return c.json(
      {
        error: {
          code: 'WORKSPACE_NOT_CONFIGURED',
          message: 'plan has no workspacePath — create the workspace first',
        },
      },
      400,
    );
  }

  const deliverables = await listDeliverablesForPlan(id, { limit: 50 });
  const scenes = await listScenes(id);
  let successCount = 0;
  const failures: ExportFailure[] = [];

  for (const d of deliverables) {
    try {
      await exportSingleDeliverable(id, d, scenes);
      successCount += 1;
    } catch (err) {
      failures.push({
        deliverableId: d.id,
        reason: (err as Error).message,
      });
    }
  }

  logger.info(
    { planId: id, successCount, failureCount: failures.length },
    'export-all completed',
  );

  const summaries = await loadBundleSummaries(id);
  return c.html(
    <DeliverableBundleView
      plan={plan}
      summaries={summaries}
      exportFlash={{ successCount, failures }}
    />,
  );
});

export default app;
