import { Hono } from 'hono';
import { getPlan, patchPlan } from '../db/plans.js';
import { listScenes } from '../db/scenes.js';
import { ShootInstructionsPage, toPlainText } from '../views/export.js';

const app = new Hono();

/**
 * GET /plans/:id/export — HTML shoot-instructions document. Records
 * exportedAt on the plan; this transitions plan.status to 'exported' iff
 * the plan was 'finalized'. Other states leave status alone — Rick can
 * preview the export at any time during planning.
 */
app.get('/plans/:id/export', async (c) => {
  const id = c.req.param('id');
  const plan = await getPlan(id);
  if (!plan) return c.html('<h1>404 — plan not found</h1>', 404);
  const scenes = await listScenes(id);

  // Determine staleness BEFORE bumping exportedAt.
  const stale = plan.exportedAt
    ? plan.updatedAt.getTime() > plan.exportedAt.getTime()
    : false;

  // Bump exportedAt + transition to 'exported' when finalized.
  try {
    const patch: { status?: 'exported' } = {};
    if (plan.status === 'finalized') patch.status = 'exported';
    if (Object.keys(patch).length > 0) {
      await patchPlan(id, patch);
    }
    // No explicit exportedAt field in PlanPatch yet — patchPlan stamps it on
    // the 'exported' transition automatically. For other states we leave it
    // alone (preview behavior).
  } catch {
    // best-effort — render anyway
  }

  return c.html(
    <ShootInstructionsPage plan={plan} scenes={scenes} stale={stale} />,
  );
});

/**
 * GET /plans/:id/export.txt — plain-text variant. Same content, paste-friendly.
 */
app.get('/plans/:id/export.txt', async (c) => {
  const id = c.req.param('id');
  const plan = await getPlan(id);
  if (!plan) return c.text('plan not found', 404);
  const scenes = await listScenes(id);
  return c.text(toPlainText(plan, scenes), 200, {
    'content-type': 'text/plain; charset=utf-8',
  });
});

export default app;
