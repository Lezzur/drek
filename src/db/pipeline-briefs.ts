import type { Firestore } from 'firebase-admin/firestore';
import { getDb } from './firestore.js';
import { makeId } from './ids.js';
import {
  pipelineBriefSchema,
  type PipelineBrief,
  type PipelineBriefCreate,
  type PipelineBriefPatch,
  type BriefStage,
  BRIEF_STAGES,
} from './schemas.js';

/**
 * PipelineBrief CRUD — top-level collection for the intake module. Briefs
 * pasted from Upwork/Freelancer/manual sources sit in this queue, get
 * scored, then get promoted to youtube_advanced plans.
 */

const COLLECTION = 'pipeline_briefs';

function tsToDate(v: unknown): Date {
  if (v instanceof Date) return v;
  const maybe = v as { toDate?: () => Date };
  return typeof maybe?.toDate === 'function' ? maybe.toDate() : new Date(0);
}

function docToBrief(id: string, data: Record<string, unknown>): PipelineBrief {
  return pipelineBriefSchema.parse({
    id,
    title: data.title,
    company: (data.company as string | null) ?? null,
    sourceUrl: (data.sourceUrl as string | null) ?? null,
    rawText: data.rawText,
    score: (data.score as Record<string, unknown> | null) ?? null,
    scoringRationale: (data.scoringRationale as string | null) ?? null,
    stage: data.stage,
    promotedPlanId: (data.promotedPlanId as string | null) ?? null,
    batchId: (data.batchId as string | null) ?? null,
    transformedBriefText: (data.transformedBriefText as string | null) ?? null,
    transformedScore: (data.transformedScore as Record<string, unknown> | null) ?? null,
    pinnedTechStack: (data.pinnedTechStack as Record<string, unknown> | null) ?? null,
    createdAt: tsToDate(data.createdAt),
    updatedAt: tsToDate(data.updatedAt),
  });
}

export async function createPipelineBrief(
  input: PipelineBriefCreate,
  db: Firestore = getDb(),
): Promise<PipelineBrief> {
  const id = makeId('brief');
  const now = new Date();
  const doc = {
    title: input.title,
    company: input.company ?? null,
    sourceUrl: input.sourceUrl ?? null,
    rawText: input.rawText,
    score: input.score ?? null,
    scoringRationale: input.scoringRationale ?? null,
    stage: input.stage ?? 'candidate',
    promotedPlanId: input.promotedPlanId ?? null,
    batchId: input.batchId ?? null,
    transformedBriefText: input.transformedBriefText ?? null,
    transformedScore: input.transformedScore ?? null,
    pinnedTechStack: input.pinnedTechStack ?? null,
    createdAt: now,
    updatedAt: now,
  };
  await db.collection(COLLECTION).doc(id).set(doc);
  return docToBrief(id, doc);
}

export async function getPipelineBrief(
  id: string,
  db: Firestore = getDb(),
): Promise<PipelineBrief | null> {
  const snap = await db.collection(COLLECTION).doc(id).get();
  if (!snap.exists) return null;
  return docToBrief(snap.id, snap.data() as Record<string, unknown>);
}

export type BriefSort = 'aggregate' | 'updatedAt';

export interface ListBriefsOpts {
  stage?: BriefStage;
  limit?: number;
  sortBy?: BriefSort;
}

export async function listPipelineBriefs(
  opts: ListBriefsOpts = {},
  db: Firestore = getDb(),
): Promise<PipelineBrief[]> {
  const sortField = opts.sortBy === 'aggregate' ? 'score.aggregate' : 'updatedAt';
  let q = db.collection(COLLECTION).orderBy(sortField, 'desc') as FirebaseFirestore.Query;
  if (opts.stage) q = q.where('stage', '==', opts.stage);
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  q = q.limit(limit);
  const snap = await q.get();
  return snap.docs.map((d) => docToBrief(d.id, d.data() as Record<string, unknown>));
}

export async function patchPipelineBrief(
  id: string,
  patch: PipelineBriefPatch,
  db: Firestore = getDb(),
): Promise<PipelineBrief | null> {
  const ref = db.collection(COLLECTION).doc(id);
  const snap = await ref.get();
  if (!snap.exists) return null;
  const update: Record<string, unknown> = { updatedAt: new Date() };
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) update[k] = v;
  }
  await ref.update(update);
  const refreshed = await ref.get();
  return docToBrief(refreshed.id, refreshed.data() as Record<string, unknown>);
}

/**
 * List all briefs that share a batchId, oldest-first by insertion order.
 * Used by the batch-intake overview page to render the row list.
 */
export async function listBriefsByBatchId(
  batchId: string,
  db: Firestore = getDb(),
): Promise<PipelineBrief[]> {
  const snap = await db
    .collection(COLLECTION)
    .where('batchId', '==', batchId)
    .orderBy('createdAt', 'asc')
    .get();
  return snap.docs.map((d) => docToBrief(d.id, d.data() as Record<string, unknown>));
}

/**
 * Atomically create N briefs with a shared batchId in one Firestore batch.
 * Used by the batch-intake submit handler — if any write fails, all fail,
 * so we never end up with partial paste content stranded mid-batch.
 */
export async function createBriefBatch(
  briefs: PipelineBriefCreate[],
  batchId: string,
  db: Firestore = getDb(),
): Promise<PipelineBrief[]> {
  if (briefs.length === 0) return [];
  if (briefs.length > 25) {
    throw new Error(`batch size ${briefs.length} exceeds max 25`);
  }
  const now = new Date();
  const batch = db.batch();
  const persisted: PipelineBrief[] = [];
  for (const input of briefs) {
    const id = makeId('brief');
    const doc = {
      title: input.title,
      company: input.company ?? null,
      sourceUrl: input.sourceUrl ?? null,
      rawText: input.rawText,
      score: input.score ?? null,
      scoringRationale: input.scoringRationale ?? null,
      stage: input.stage ?? 'candidate',
      promotedPlanId: input.promotedPlanId ?? null,
      batchId,
      transformedBriefText: null,
      transformedScore: null,
      pinnedTechStack: null,
      createdAt: now,
      updatedAt: now,
    };
    batch.set(db.collection(COLLECTION).doc(id), doc);
    persisted.push(docToBrief(id, doc));
  }
  await batch.commit();
  return persisted;
}

/**
 * Hard-delete a brief. Used by the bulk-delete intake action. Does NOT
 * cascade — `pipeline_briefs` has no subcollections in v2.1. Returns
 * false if the brief didn't exist (idempotent — bulk-delete of already-
 * gone briefs is a no-op, not an error).
 */
export async function deletePipelineBrief(
  id: string,
  db: Firestore = getDb(),
): Promise<boolean> {
  const ref = db.collection(COLLECTION).doc(id);
  const snap = await ref.get();
  if (!snap.exists) return false;
  await ref.delete();
  return true;
}

/**
 * Bulk hard-delete N briefs in one Firestore batch (atomic). Skips ids
 * that don't exist; returns the count of actual deletions.
 */
export async function deletePipelineBriefsBulk(
  ids: string[],
  db: Firestore = getDb(),
): Promise<number> {
  if (ids.length === 0) return 0;
  // Firestore batch caps at 500 writes; we cap at 50 for ergonomics.
  if (ids.length > 50) {
    throw new Error(`bulk delete size ${ids.length} exceeds max 50`);
  }
  const refs = ids.map((id) => db.collection(COLLECTION).doc(id));
  const snaps = await Promise.all(refs.map((r) => r.get()));
  const existing = refs.filter((_, i) => snaps[i]!.exists);
  if (existing.length === 0) return 0;
  const batch = db.batch();
  for (const ref of existing) batch.delete(ref);
  await batch.commit();
  return existing.length;
}

/** Per-stage counts for the queue depth indicator. Used by /intake to
 *  warn Rick when the candidate+vetted pool is < 3 briefs deep. */
export async function countBriefsByStage(
  db: Firestore = getDb(),
): Promise<Record<BriefStage, number>> {
  const out = Object.fromEntries(BRIEF_STAGES.map((s) => [s, 0])) as Record<BriefStage, number>;
  await Promise.all(
    BRIEF_STAGES.map(async (stage) => {
      const snap = await db
        .collection(COLLECTION)
        .where('stage', '==', stage)
        .count()
        .get();
      out[stage] = snap.data().count;
    }),
  );
  return out;
}
