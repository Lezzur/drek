import type { Firestore } from 'firebase-admin/firestore';
import { getDb } from './firestore.js';
import { makeId } from './ids.js';
import {
  deliverableSchema,
  type Deliverable,
  type DeliverableCreate,
  type DeliverableKind,
  type DeliverablePatch,
} from './schemas.js';

const COLLECTION = 'deliverables';

/**
 * Deliverable CRUD — v2 entity representing a single shippable artifact
 * (long_form video, short_clip, lead_magnet) derived from a Plan. Each
 * youtube_advanced Plan auto-creates exactly one `long_form` Deliverable
 * at plan-creation time per TECH-SPEC-drek-v2-youtube-2026-05-18.md
 * §4.2 Component K invariant. `short_clip` Deliverables are created
 * later by the Shorts extractor when Rick approves candidates.
 */

export class DeliverableNotFoundError extends Error {
  public readonly planId: string;
  constructor(planId: string, message: string) {
    super(message);
    this.name = 'DeliverableNotFoundError';
    this.planId = planId;
  }
}

function tsToDate(v: unknown): Date | null {
  if (!v) return null;
  if (v instanceof Date) return v;
  const maybe = v as { toDate?: () => Date };
  return typeof maybe.toDate === 'function' ? maybe.toDate() : null;
}

function docToDeliverable(id: string, data: Record<string, unknown>): Deliverable {
  return deliverableSchema.parse({
    id,
    planId: data.planId,
    kind: data.kind,
    audienceProfileId: data.audienceProfileId,
    title: data.title,
    status: data.status ?? 'draft',
    scriptOverrideSceneIds: (data.scriptOverrideSceneIds as string[] | null) ?? null,
    customScripts: (data.customScripts as Array<Record<string, unknown>> | null) ?? null,
    selectedTitleVariantId: (data.selectedTitleVariantId as string | null) ?? null,
    selectedThumbnailConceptId: (data.selectedThumbnailConceptId as string | null) ?? null,
    publishMetadataId: (data.publishMetadataId as string | null) ?? null,
    youtubeUrl: (data.youtubeUrl as string | null) ?? null,
    publishedAt: tsToDate(data.publishedAt),
    createdAt: tsToDate(data.createdAt) ?? new Date(0),
    updatedAt: tsToDate(data.updatedAt) ?? new Date(0),
  });
}

export async function createDeliverable(
  input: DeliverableCreate,
  db: Firestore = getDb(),
): Promise<Deliverable> {
  const id = makeId('del');
  const now = new Date();
  const doc = {
    planId: input.planId,
    kind: input.kind,
    audienceProfileId: input.audienceProfileId,
    title: input.title,
    status: input.status ?? 'draft',
    scriptOverrideSceneIds: input.scriptOverrideSceneIds ?? null,
    customScripts: input.customScripts ?? null,
    selectedTitleVariantId: input.selectedTitleVariantId ?? null,
    selectedThumbnailConceptId: input.selectedThumbnailConceptId ?? null,
    publishMetadataId: input.publishMetadataId ?? null,
    youtubeUrl: input.youtubeUrl ?? null,
    publishedAt: input.publishedAt ?? null,
    createdAt: now,
    updatedAt: now,
  };
  await db.collection(COLLECTION).doc(id).set(doc);
  return docToDeliverable(id, doc);
}

export async function getDeliverable(
  id: string,
  db: Firestore = getDb(),
): Promise<Deliverable | null> {
  const snap = await db.collection(COLLECTION).doc(id).get();
  if (!snap.exists) return null;
  return docToDeliverable(snap.id, snap.data() as Record<string, unknown>);
}

export interface ListDeliverablesOpts {
  kind?: DeliverableKind;
  limit?: number;
}

export async function listDeliverablesForPlan(
  planId: string,
  opts: ListDeliverablesOpts = {},
  db: Firestore = getDb(),
): Promise<Deliverable[]> {
  let q = db
    .collection(COLLECTION)
    .where('planId', '==', planId) as FirebaseFirestore.Query;
  if (opts.kind) q = q.where('kind', '==', opts.kind);
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  q = q.limit(limit);
  const snap = await q.get();
  return snap.docs.map((d) =>
    docToDeliverable(d.id, d.data() as Record<string, unknown>),
  );
}

/** Convenience for plan-level routes that operate on the long-form
 *  Deliverable (§4.2 Component K invariant: every youtube_advanced plan
 *  has exactly one). Throws if not found. */
export async function findLongFormDeliverable(
  planId: string,
  db: Firestore = getDb(),
): Promise<Deliverable> {
  const matches = await listDeliverablesForPlan(planId, { kind: 'long_form' }, db);
  if (matches.length === 0) {
    throw new DeliverableNotFoundError(
      planId,
      `No long_form Deliverable for plan ${planId}`,
    );
  }
  if (matches.length > 1) {
    // Defensive: invariant violation, but don't throw — return the first
    // and log via the route layer instead.
    return matches[0]!;
  }
  return matches[0]!;
}

export async function patchDeliverable(
  id: string,
  patch: DeliverablePatch,
  db: Firestore = getDb(),
): Promise<Deliverable | null> {
  const ref = db.collection(COLLECTION).doc(id);
  const snap = await ref.get();
  if (!snap.exists) return null;

  const update: Record<string, unknown> = { updatedAt: new Date() };
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) update[k] = v;
  }
  await ref.update(update);
  const refreshed = await ref.get();
  return docToDeliverable(refreshed.id, refreshed.data() as Record<string, unknown>);
}

/** Cascade-delete the deliverable + all three subcollections (title_concepts,
 *  thumbnail_concepts, publish_metadata). Used by the change-format flow
 *  when wiping Short deliverables. */
export async function deleteDeliverable(
  id: string,
  db: Firestore = getDb(),
): Promise<boolean> {
  const ref = db.collection(COLLECTION).doc(id);
  const snap = await ref.get();
  if (!snap.exists) return false;

  const SUBCOLLECTIONS = ['title_concepts', 'thumbnail_concepts', 'publish_metadata'];
  for (const sub of SUBCOLLECTIONS) {
    const subSnap = await ref.collection(sub).limit(500).get();
    if (!subSnap.empty) {
      const batch = db.batch();
      for (const d of subSnap.docs) batch.delete(d.ref);
      await batch.commit();
    }
  }
  await ref.delete();
  return true;
}
