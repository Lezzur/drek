import { Hono } from 'hono';
import { z } from 'zod';
import { logger } from '../logger.js';
import {
  createScene,
  deleteScene,
  getScene,
  listScenes,
  patchScene,
  reorderScenes,
} from '../db/scenes.js';
import { SceneCard, SceneList, ShotListBlock } from '../views/scene-card.js';
import {
  scenePatchSchema,
  brollItemSchema,
  primaryShotSchema,
  SCENE_INTERFACE_TYPES,
  SHOT_ITEM_SOURCES,
} from '../db/schemas.js';
import { estimateSceneSeconds } from '../engine/composition-rules.js';

/**
 * HTMX partial routes for scene-card interactivity (PRD §4.9). Every endpoint
 * here returns an HTML fragment — never JSON, never a full page — so the
 * dashboard / plan-detail page can swap the affected DOM in place without a
 * full reload.
 *
 * The conventions:
 *   - Scene list interactions (add, move, delete, reorder) return the full
 *     SceneList component so HTMX swaps #scene-list outerHTML.
 *   - Single-scene edits (inline field swap, save) return the affected
 *     SceneCard so HTMX swaps #scene-{id} outerHTML.
 *   - Estimated duration is recomputed from script word count any time a
 *     script is patched, so the runtime bar stays honest.
 */

const app = new Hono();

const editFieldSchema = z.object({
  field: z.enum([
    'title',
    'description',
    'framingNotes',
    'script',
    'pacingNotes',
    'transitionNote',
  ]),
});

/** GET /plans/:id/scenes/:sceneId/edit?field=X — swap the card into edit
 *  mode for one field. Single-server-round-trip click-to-edit. */
app.get('/plans/:id/scenes/:sceneId/edit', async (c) => {
  const planId = c.req.param('id');
  const sceneId = c.req.param('sceneId');
  const parse = editFieldSchema.safeParse(
    Object.fromEntries(new URL(c.req.url).searchParams),
  );
  if (!parse.success) return c.html('', 400);
  const scene = await getScene(planId, sceneId);
  if (!scene) return c.html('<div class="card">Scene not found.</div>', 404);
  const scenes = await listScenes(planId);
  const idx = scenes.findIndex((s) => s.id === sceneId);
  return c.html(
    <SceneCard
      planId={planId}
      scene={scene}
      editField={parse.data.field}
      isFirst={idx === 0}
      isLast={idx === scenes.length - 1}
    />,
  );
});

/** PATCH /plans/:id/scenes/:sceneId — inline edit save. Body: form fields
 *  `field` + `value`. Re-renders the single card without edit mode. */
app.patch('/plans/:id/scenes/:sceneId', async (c) => {
  const planId = c.req.param('id');
  const sceneId = c.req.param('sceneId');
  let body: Record<string, string>;
  try {
    const form = await c.req.formData();
    body = Object.fromEntries(form) as Record<string, string>;
  } catch {
    return c.html('', 400);
  }
  const parse = editFieldSchema.safeParse({ field: body.field });
  if (!parse.success) return c.html('', 400);
  const value = body.value ?? '';
  const field = parse.data.field;

  const patch: Record<string, unknown> = { [field]: value };
  // Keep estimatedDurationSeconds honest when the script changes.
  if (field === 'script') {
    patch.estimatedDurationSeconds = estimateSceneSeconds(value);
  }
  const validated = scenePatchSchema.safeParse(patch);
  if (!validated.success) return c.html('', 400);

  const updated = await patchScene(planId, sceneId, validated.data);
  if (!updated) return c.html('<div class="card">Scene not found.</div>', 404);

  const scenes = await listScenes(planId);
  const idx = scenes.findIndex((s) => s.id === sceneId);
  return c.html(
    <SceneCard
      planId={planId}
      scene={updated}
      isFirst={idx === 0}
      isLast={idx === scenes.length - 1}
    />,
  );
});

/** POST /plans/:id/scenes/:sceneId/move-up — atomic re-order. */
app.post('/plans/:id/scenes/:sceneId/move-up', async (c) => {
  const planId = c.req.param('id');
  const sceneId = c.req.param('sceneId');
  const scenes = await listScenes(planId);
  const idx = scenes.findIndex((s) => s.id === sceneId);
  if (idx <= 0) {
    return c.html(<SceneList planId={planId} scenes={scenes} />);
  }
  const prev = scenes[idx - 1]!;
  const cur = scenes[idx]!;
  await reorderScenes(
    planId,
    [
      { id: prev.id, order: cur.order },
      { id: cur.id, order: prev.order },
    ],
  );
  const fresh = await listScenes(planId);
  return c.html(<SceneList planId={planId} scenes={fresh} />);
});

app.post('/plans/:id/scenes/:sceneId/move-down', async (c) => {
  const planId = c.req.param('id');
  const sceneId = c.req.param('sceneId');
  const scenes = await listScenes(planId);
  const idx = scenes.findIndex((s) => s.id === sceneId);
  if (idx === -1 || idx >= scenes.length - 1) {
    return c.html(<SceneList planId={planId} scenes={scenes} />);
  }
  const next = scenes[idx + 1]!;
  const cur = scenes[idx]!;
  await reorderScenes(
    planId,
    [
      { id: next.id, order: cur.order },
      { id: cur.id, order: next.order },
    ],
  );
  const fresh = await listScenes(planId);
  return c.html(<SceneList planId={planId} scenes={fresh} />);
});

/** DELETE /plans/:id/scenes/:sceneId. Renumbers the remaining scenes
 *  contiguously so order gaps don't accumulate. */
app.delete('/plans/:id/scenes/:sceneId', async (c) => {
  const planId = c.req.param('id');
  const sceneId = c.req.param('sceneId');
  const ok = await deleteScene(planId, sceneId);
  if (!ok) {
    logger.warn({ planId, sceneId }, 'scene delete: not found');
  }
  // Compact orders.
  const remaining = await listScenes(planId);
  const renumber = remaining.map((s, i) => ({ id: s.id, order: i + 1 }));
  if (renumber.length > 0) await reorderScenes(planId, renumber);
  const fresh = await listScenes(planId);
  return c.html(<SceneList planId={planId} scenes={fresh} />);
});

// ---------------------------------------------------------------------------
// Shot list inline editing
// ---------------------------------------------------------------------------

/** PATCH /plans/:id/scenes/:sceneId/shots/primary — update primaryShot type + description. */
app.patch('/plans/:id/scenes/:sceneId/shots/primary', async (c) => {
  const planId = c.req.param('id');
  const sceneId = c.req.param('sceneId');
  let form: FormData;
  try { form = await c.req.formData(); } catch { return c.html('', 400); }
  const raw = Object.fromEntries(form);
  const parsed = primaryShotSchema.safeParse({
    type: raw.type,
    description: raw.description,
  });
  if (!parsed.success) return c.html('', 400);
  const scene = await getScene(planId, sceneId);
  if (!scene) return c.html('', 404);
  const updated = await patchScene(planId, sceneId, { primaryShot: parsed.data });
  if (!updated) return c.html('', 404);
  return c.html(<ShotListBlock planId={planId} scene={updated} />);
});

/** POST /plans/:id/scenes/:sceneId/shots/broll — append a b-roll item. */
app.post('/plans/:id/scenes/:sceneId/shots/broll', async (c) => {
  const planId = c.req.param('id');
  const sceneId = c.req.param('sceneId');
  let form: FormData;
  try { form = await c.req.formData(); } catch { return c.html('', 400); }
  const raw = Object.fromEntries(form);
  const parsed = brollItemSchema.safeParse({
    type: raw.type,
    description: raw.description,
    source: raw.source ?? 'record_during_scene',
    durationSeconds: Number(raw.durationSeconds) || 10,
  });
  if (!parsed.success) return c.html('', 400);
  const scene = await getScene(planId, sceneId);
  if (!scene) return c.html('', 404);
  const updated = await patchScene(planId, sceneId, {
    brollItems: [...scene.brollItems, parsed.data],
  });
  if (!updated) return c.html('', 404);
  return c.html(<ShotListBlock planId={planId} scene={updated} />);
});

/** PATCH /plans/:id/scenes/:sceneId/shots/broll/:index — edit b-roll item description. */
app.patch('/plans/:id/scenes/:sceneId/shots/broll/:index', async (c) => {
  const planId = c.req.param('id');
  const sceneId = c.req.param('sceneId');
  const idx = parseInt(c.req.param('index'), 10);
  let form: FormData;
  try { form = await c.req.formData(); } catch { return c.html('', 400); }
  const raw = Object.fromEntries(form);
  const scene = await getScene(planId, sceneId);
  if (!scene || idx < 0 || idx >= scene.brollItems.length) return c.html('', 404);
  const updated_items = scene.brollItems.map((b, i) =>
    i === idx ? { ...b, description: String(raw.description ?? b.description) } : b
  );
  const validated = z.array(brollItemSchema).safeParse(updated_items);
  if (!validated.success) return c.html('', 400);
  const updated = await patchScene(planId, sceneId, { brollItems: validated.data });
  if (!updated) return c.html('', 404);
  return c.html(<ShotListBlock planId={planId} scene={updated} />);
});

/** DELETE /plans/:id/scenes/:sceneId/shots/broll/:index — remove a b-roll item. */
app.delete('/plans/:id/scenes/:sceneId/shots/broll/:index', async (c) => {
  const planId = c.req.param('id');
  const sceneId = c.req.param('sceneId');
  const idx = parseInt(c.req.param('index'), 10);
  const scene = await getScene(planId, sceneId);
  if (!scene || idx < 0 || idx >= scene.brollItems.length) return c.html('', 404);
  const updated = await patchScene(planId, sceneId, {
    brollItems: scene.brollItems.filter((_, i) => i !== idx),
  });
  if (!updated) return c.html('', 404);
  return c.html(<ShotListBlock planId={planId} scene={updated} />);
});

/** POST /plans/:id/scenes — append a blank scene at the end. */
app.post('/plans/:id/scenes', async (c) => {
  const planId = c.req.param('id');
  await createScene(planId, {
    title: 'New scene',
    description: '',
    framingNotes: '',
    script: '',
  });
  const fresh = await listScenes(planId);
  return c.html(<SceneList planId={planId} scenes={fresh} />);
});

export default app;
