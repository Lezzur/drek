import { Hono } from 'hono';
import { getPlan } from '../db/plans.js';
import { listHookDraftsForPlan } from '../db/hook-drafts.js';
import {
  findLongFormDeliverable,
  getDeliverable,
  DeliverableNotFoundError,
} from '../db/deliverables.js';
import {
  listTitleConceptsForDeliverable,
  getSelectedTitleConcept,
} from '../db/title-concepts.js';
import { listThumbnailConceptsForDeliverable } from '../db/thumbnail-concepts.js';
import {
  HookWorkshopView,
  TitleWorkshopView,
  ThumbnailWorkshopView,
} from '../views/workshop.js';

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

/**
 * GET /plans/:id/workshop/titles[?deliverableId=...]
 *
 * If deliverableId is omitted, defaults to the long-form deliverable.
 * Renders TitleWorkshopView with the concepts for that deliverable.
 */
app.get('/plans/:id/workshop/titles', async (c) => {
  const id = c.req.param('id');
  const plan = await getPlan(id);
  if (!plan) {
    return c.html('<h1>404 — plan not found</h1>', 404);
  }
  const deliverableIdParam = c.req.query('deliverableId');
  let deliverable;
  try {
    if (deliverableIdParam) {
      const d = await getDeliverable(deliverableIdParam);
      if (!d || d.planId !== id) {
        return c.html('<h1>404 — deliverable not found</h1>', 404);
      }
      deliverable = d;
    } else {
      deliverable = await findLongFormDeliverable(id);
    }
  } catch (err) {
    if (err instanceof DeliverableNotFoundError) {
      return c.html(
        '<h1>404 — long-form deliverable not found for this plan</h1>',
        404,
      );
    }
    throw err;
  }
  const concepts = await listTitleConceptsForDeliverable(deliverable.id);
  return c.html(
    <TitleWorkshopView plan={plan} deliverable={deliverable} concepts={concepts} />,
  );
});

/**
 * GET /plans/:id/workshop/thumbnails[?deliverableId=...]
 *
 * Renders ThumbnailWorkshopView. Also passes the selected title text so
 * Rick can see what hook the thumbnails are reinforcing.
 */
app.get('/plans/:id/workshop/thumbnails', async (c) => {
  const id = c.req.param('id');
  const plan = await getPlan(id);
  if (!plan) {
    return c.html('<h1>404 — plan not found</h1>', 404);
  }
  const deliverableIdParam = c.req.query('deliverableId');
  let deliverable;
  try {
    if (deliverableIdParam) {
      const d = await getDeliverable(deliverableIdParam);
      if (!d || d.planId !== id) {
        return c.html('<h1>404 — deliverable not found</h1>', 404);
      }
      deliverable = d;
    } else {
      deliverable = await findLongFormDeliverable(id);
    }
  } catch (err) {
    if (err instanceof DeliverableNotFoundError) {
      return c.html(
        '<h1>404 — long-form deliverable not found for this plan</h1>',
        404,
      );
    }
    throw err;
  }
  const concepts = await listThumbnailConceptsForDeliverable(deliverable.id);
  const selectedTitle = await getSelectedTitleConcept(deliverable.id);
  return c.html(
    <ThumbnailWorkshopView
      plan={plan}
      deliverable={deliverable}
      concepts={concepts}
      selectedTitleText={selectedTitle?.titleText ?? null}
    />,
  );
});

export default app;
