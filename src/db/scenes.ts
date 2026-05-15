import type { Firestore } from 'firebase-admin/firestore';
import { getDb } from './firestore.js';
import { makeId } from './ids.js';
import {
  sceneSchema,
  type Scene,
  type SceneCreate,
  type ScenePatch,
} from './schemas.js';

const PLANS = 'plans';
const SCENES = 'scenes';

/**
 * Scene CRUD. Scenes live under plans/{planId}/scenes/{sceneId}, so every
 * function takes a planId.
 */

function docToScene(planId: string, id: string, data: Record<string, unknown>): Scene {
  return sceneSchema.parse({
    id,
    planId,
    order: data.order,
    title: data.title,
    description: data.description ?? '',
    framingNotes: data.framingNotes ?? '',
    script: data.script ?? '',
    emphasisCues: data.emphasisCues ?? [],
    pacingNotes: data.pacingNotes ?? '',
    transitionNote: data.transitionNote ?? '',
    estimatedDurationSeconds: data.estimatedDurationSeconds ?? 0,
    projectRef: (data.projectRef as string | null) ?? null,
    storyboardImageUrl: (data.storyboardImageUrl as string | null) ?? null,
  });
}

function scenesCollection(db: Firestore, planId: string) {
  return db.collection(PLANS).doc(planId).collection(SCENES);
}

/** Create a scene under the given plan. When `order` is omitted, append to
 *  the end (existing-count + 1). */
export async function createScene(
  planId: string,
  input: SceneCreate,
  db: Firestore = getDb(),
): Promise<Scene> {
  const id = makeId('scene');
  let order = input.order;
  if (order === undefined) {
    const existing = await scenesCollection(db, planId).count().get();
    order = existing.data().count + 1;
  }
  const doc = {
    order,
    title: input.title,
    description: input.description ?? '',
    framingNotes: input.framingNotes ?? '',
    script: input.script ?? '',
    emphasisCues: input.emphasisCues ?? [],
    pacingNotes: input.pacingNotes ?? '',
    transitionNote: input.transitionNote ?? '',
    estimatedDurationSeconds: input.estimatedDurationSeconds ?? 0,
    projectRef: input.projectRef ?? null,
    storyboardImageUrl: input.storyboardImageUrl ?? null,
  };
  await scenesCollection(db, planId).doc(id).set(doc);
  return docToScene(planId, id, doc);
}

export async function getScene(
  planId: string,
  sceneId: string,
  db: Firestore = getDb(),
): Promise<Scene | null> {
  const snap = await scenesCollection(db, planId).doc(sceneId).get();
  if (!snap.exists) return null;
  return docToScene(planId, snap.id, snap.data() as Record<string, unknown>);
}

/** All scenes for a plan, ordered by `order` ascending. */
export async function listScenes(
  planId: string,
  db: Firestore = getDb(),
): Promise<Scene[]> {
  const snap = await scenesCollection(db, planId).orderBy('order', 'asc').get();
  return snap.docs.map((d) => docToScene(planId, d.id, d.data() as Record<string, unknown>));
}

export async function patchScene(
  planId: string,
  sceneId: string,
  patch: ScenePatch,
  db: Firestore = getDb(),
): Promise<Scene | null> {
  const ref = scenesCollection(db, planId).doc(sceneId);
  const snap = await ref.get();
  if (!snap.exists) return null;
  const update: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) update[k] = v;
  }
  if (Object.keys(update).length === 0) {
    return docToScene(planId, snap.id, snap.data() as Record<string, unknown>);
  }
  await ref.update(update);
  const refreshed = await ref.get();
  return docToScene(planId, refreshed.id, refreshed.data() as Record<string, unknown>);
}

export async function deleteScene(
  planId: string,
  sceneId: string,
  db: Firestore = getDb(),
): Promise<boolean> {
  const ref = scenesCollection(db, planId).doc(sceneId);
  const snap = await ref.get();
  if (!snap.exists) return false;
  await ref.delete();
  return true;
}

/**
 * Atomically renumber a plan's scenes to the order given. Pass the full set
 * of `{id, order}` pairs; missing ids are not touched. Used by the HTMX
 * move-up/move-down handlers in M8.
 */
export async function reorderScenes(
  planId: string,
  newOrder: Array<{ id: string; order: number }>,
  db: Firestore = getDb(),
): Promise<void> {
  if (newOrder.length === 0) return;
  const batch = db.batch();
  for (const { id, order } of newOrder) {
    batch.update(scenesCollection(db, planId).doc(id), { order });
  }
  await batch.commit();
}
