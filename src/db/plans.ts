import type { Firestore } from 'firebase-admin/firestore';
import { getDb } from './firestore.js';
import { makeId } from './ids.js';
import {
  planSchema,
  type Plan,
  type PlanCreate,
  type PlanPatch,
  type PlanStatus,
  type PlanType,
  isAllowedPlanTransition,
} from './schemas.js';

const COLLECTION = 'plans';

/**
 * Plan CRUD. Functions accept an optional `db` so tests can inject a fake
 * Firestore; production callers omit it and the module pulls from getDb().
 */

function tsToDate(v: unknown): Date | null {
  if (!v) return null;
  if (v instanceof Date) return v;
  const maybe = v as { toDate?: () => Date };
  return typeof maybe.toDate === 'function' ? maybe.toDate() : null;
}

function docToPlan(id: string, data: Record<string, unknown>): Plan {
  return planSchema.parse({
    id,
    type: data.type,
    status: data.status,
    title: data.title,
    sourceListingId: (data.sourceListingId as string | null) ?? null,
    sourceListingText: (data.sourceListingText as string | null) ?? null,
    requirements: data.requirements ?? [],
    matchedProjects: data.matchedProjects ?? [],
    targetRuntimeSeconds: data.targetRuntimeSeconds,
    estimatedRuntimeSeconds: data.estimatedRuntimeSeconds ?? 0,
    userConstraints: (data.userConstraints as string | null) ?? null,
    createdAt: tsToDate(data.createdAt) ?? new Date(0),
    updatedAt: tsToDate(data.updatedAt) ?? new Date(0),
    exportedAt: tsToDate(data.exportedAt),
    // v2 additive — v1 documents will have these as undefined; the schema
    // defaults them to null, but we pass through explicitly when present.
    formatProfileId: (data.formatProfileId as string | null) ?? null,
    pipelineBriefId: (data.pipelineBriefId as string | null) ?? null,
    workspacePath: (data.workspacePath as string | null) ?? null,
    selectedHookVariantId: (data.selectedHookVariantId as string | null) ?? null,
    selectedTitleVariantId: (data.selectedTitleVariantId as string | null) ?? null,
    selectedThumbnailConceptId: (data.selectedThumbnailConceptId as string | null) ?? null,
  });
}

export async function createPlan(input: PlanCreate, db: Firestore = getDb()): Promise<Plan> {
  const id = makeId('plan');
  const now = new Date();
  const status: PlanStatus = input.status ?? 'awaiting_review';
  const doc = {
    type: input.type,
    status,
    title: input.title,
    sourceListingId: input.sourceListingId ?? null,
    sourceListingText: input.sourceListingText ?? null,
    requirements: [],
    matchedProjects: [],
    targetRuntimeSeconds: input.targetRuntimeSeconds,
    estimatedRuntimeSeconds: 0,
    userConstraints: input.userConstraints ?? null,
    createdAt: now,
    updatedAt: now,
    exportedAt: null,
    // v2 additive
    formatProfileId: input.formatProfileId ?? null,
    pipelineBriefId: input.pipelineBriefId ?? null,
    workspacePath: null,
    selectedHookVariantId: null,
    selectedTitleVariantId: null,
    selectedThumbnailConceptId: null,
  };
  await db.collection(COLLECTION).doc(id).set(doc);
  return docToPlan(id, doc);
}

export async function getPlan(id: string, db: Firestore = getDb()): Promise<Plan | null> {
  const snap = await db.collection(COLLECTION).doc(id).get();
  if (!snap.exists) return null;
  return docToPlan(snap.id, snap.data() as Record<string, unknown>);
}

export interface ListPlansFilter {
  type?: PlanType;
  status?: PlanStatus;
  limit?: number;
  cursor?: string;
}

export async function listPlans(
  filter: ListPlansFilter = {},
  db: Firestore = getDb(),
): Promise<{ plans: Plan[]; nextCursor: string | null }> {
  let q = db.collection(COLLECTION).orderBy('createdAt', 'desc') as FirebaseFirestore.Query;
  if (filter.type) q = q.where('type', '==', filter.type);
  if (filter.status) q = q.where('status', '==', filter.status);
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
  q = q.limit(limit + 1);
  if (filter.cursor) {
    const after = await db.collection(COLLECTION).doc(filter.cursor).get();
    if (after.exists) q = q.startAfter(after);
  }
  const snap = await q.get();
  const docs = snap.docs.slice(0, limit);
  const plans = docs.map((d) => docToPlan(d.id, d.data() as Record<string, unknown>));
  const nextCursor =
    snap.docs.length > limit ? (snap.docs[limit]?.id ?? null) : null;
  return { plans, nextCursor };
}

export async function patchPlan(
  id: string,
  patch: PlanPatch,
  db: Firestore = getDb(),
): Promise<Plan | null> {
  const ref = db.collection(COLLECTION).doc(id);
  const snap = await ref.get();
  if (!snap.exists) return null;
  const existing = docToPlan(snap.id, snap.data() as Record<string, unknown>);

  if (patch.status && !isAllowedPlanTransition(existing.status, patch.status)) {
    throw new Error(
      `Disallowed plan transition: ${existing.status} -> ${patch.status}`,
    );
  }

  const now = new Date();
  const update: Record<string, unknown> = { updatedAt: now };
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) update[k] = v;
  }
  // Set exportedAt when transitioning into 'exported'. Caller can override
  // by passing exportedAt explicitly via raw write — out of scope for patch.
  if (patch.status === 'exported') update.exportedAt = now;

  await ref.update(update);
  const refreshed = await ref.get();
  return docToPlan(refreshed.id, refreshed.data() as Record<string, unknown>);
}

export async function deletePlan(id: string, db: Firestore = getDb()): Promise<boolean> {
  const ref = db.collection(COLLECTION).doc(id);
  const snap = await ref.get();
  if (!snap.exists) return false;
  // Cascade: delete all scenes in the subcollection. Firestore doesn't do
  // this for us — orphaned subdocs are a real footgun.
  const scenesSnap = await ref.collection('scenes').limit(500).get();
  if (!scenesSnap.empty) {
    const batch = db.batch();
    for (const d of scenesSnap.docs) batch.delete(d.ref);
    await batch.commit();
  }
  await ref.delete();
  return true;
}

/** Convenience: look up a plan by its source PI listing id. Used by the
 *  polling cron to skip listings that already have plans. */
export async function findPlanByListing(
  listingId: string,
  db: Firestore = getDb(),
): Promise<Plan | null> {
  const snap = await db
    .collection(COLLECTION)
    .where('sourceListingId', '==', listingId)
    .limit(1)
    .get();
  if (snap.empty) return null;
  const d = snap.docs[0]!;
  return docToPlan(d.id, d.data() as Record<string, unknown>);
}
