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
    scriptDraft: (data.scriptDraft as string | undefined) ?? '',
    emphasisCues: data.emphasisCues ?? [],
    pacingNotes: data.pacingNotes ?? '',
    transitionNote: data.transitionNote ?? '',
    estimatedDurationSeconds: data.estimatedDurationSeconds ?? 0,
    projectRef: (data.projectRef as string | null) ?? null,
    storyboardImageUrl: (data.storyboardImageUrl as string | null) ?? null,
    // v2 additive — defaults to null/[] via schema for v1 documents
    beatTag: (data.beatTag as string | null) ?? null,
    primaryShot: (data.primaryShot as Record<string, unknown> | null) ?? null,
    brollItems: data.brollItems ?? [],
    shotListItems: data.shotListItems ?? [],
    onScreenTextOverlays: data.onScreenTextOverlays ?? [],
    cutPoints: data.cutPoints ?? [],
  });
}

function scenesCollection(db: Firestore, planId: string) {
  return db.collection(PLANS).doc(planId).collection(SCENES);
}

/** Map a SceneCreate input to its persisted document shape at a given order.
 *  Shared by createScene and replaceAllScenes so the field defaults stay in
 *  one place. */
function buildSceneDoc(input: SceneCreate, order: number): Record<string, unknown> {
  return {
    order,
    title: input.title,
    description: input.description ?? '',
    framingNotes: input.framingNotes ?? '',
    script: input.script ?? '',
    scriptDraft: input.scriptDraft ?? '',
    emphasisCues: input.emphasisCues ?? [],
    pacingNotes: input.pacingNotes ?? '',
    transitionNote: input.transitionNote ?? '',
    estimatedDurationSeconds: input.estimatedDurationSeconds ?? 0,
    projectRef: input.projectRef ?? null,
    storyboardImageUrl: input.storyboardImageUrl ?? null,
    // v2 additive
    beatTag: input.beatTag ?? null,
    primaryShot: input.primaryShot ?? null,
    brollItems: input.brollItems ?? [],
    shotListItems: input.shotListItems ?? [],
    onScreenTextOverlays: input.onScreenTextOverlays ?? [],
    cutPoints: input.cutPoints ?? [],
  };
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
  const doc = buildSceneDoc(input, order);
  await scenesCollection(db, planId).doc(id).set(doc);
  return docToScene(planId, id, doc);
}

/**
 * Atomically replace ALL scenes for a plan in a single batched commit: every
 * existing scene is deleted and the new set written together. Either the whole
 * swap lands or none of it does — there is no window where a crash or Firestore
 * error leaves the plan with zero or partially-written scenes (the failure mode
 * of the old delete-loop-then-create-loop). `order` is assigned positionally
 * (1-based) from the input array. Scene counts are bounded small (format
 * profiles cap at ~20), so the 500-op batch limit is never a concern here.
 */
export async function replaceAllScenes(
  planId: string,
  inputs: SceneCreate[],
  db: Firestore = getDb(),
): Promise<Scene[]> {
  const col = scenesCollection(db, planId);
  const existing = await col.get();
  const batch = db.batch();
  for (const d of existing.docs) {
    batch.delete(d.ref);
  }
  const created: Scene[] = [];
  for (let i = 0; i < inputs.length; i++) {
    const id = makeId('scene');
    const doc = buildSceneDoc(inputs[i]!, i + 1);
    batch.set(col.doc(id), doc);
    created.push(docToScene(planId, id, doc));
  }
  await batch.commit();
  return created;
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

/**
 * Apply patches to multiple scenes in a single atomic batch. Used by the
 * script-writing step so all scenes get their scripts in one commit — no
 * partial-write window where some scenes have new scripts and others old.
 * Undefined fields are skipped per scene.
 */
export async function patchScenesBatch(
  planId: string,
  updates: Array<{ id: string; patch: ScenePatch }>,
  db: Firestore = getDb(),
): Promise<void> {
  if (updates.length === 0) return;
  const col = scenesCollection(db, planId);
  const batch = db.batch();
  let ops = 0;
  for (const { id, patch } of updates) {
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined) clean[k] = v;
    }
    if (Object.keys(clean).length > 0) {
      batch.update(col.doc(id), clean);
      ops++;
    }
  }
  if (ops > 0) await batch.commit();
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
