import { Hono } from 'hono';
import { getPlan } from '../db/plans.js';
import { listHookDraftsForPlan } from '../db/hook-drafts.js';
import { HookWorkshopView } from '../views/workshop.js';

const app = new Hono();

/**
 * GET /plans/:id/workshop/hooks
 *
 * Renders the hook workshop — a card-grid UI where Rick can review the
 * generated hook variants and select one for the episode.
 *
 * Must be mounted BEFORE the generic /plans/:id plan-detail route so this
 * more-specific path wins against the wildcard.
 */
app.get('/plans/:id/workshop/hooks', async (c) => {
  const id = c.req.param('id');
  const plan = await getPlan(id);
  if (!plan) {
    return c.html('<h1>404 — plan not found</h1>', 404);
  }
  const hooks = await listHookDraftsForPlan(id);
  return c.html(
    <HookWorkshopView plan={plan} hooks={hooks} />,
  );
});

export default app;
