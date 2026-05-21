import type { Firestore } from 'firebase-admin/firestore';
import { getDb } from './firestore.js';
import {
  availableListingSchema,
  type AvailableListing,
  type AvailableListingCreate,
} from './schemas.js';

const COLLECTION = 'available_listings';

function tsToDate(v: unknown): Date | null {
  if (!v) return null;
  if (v instanceof Date) return v;
  const maybe = v as { toDate?: () => Date };
  return typeof maybe.toDate === 'function' ? maybe.toDate() : null;
}

function docToListing(id: string, data: Record<string, unknown>): AvailableListing {
  return availableListingSchema.parse({
    id,
    title: data.title,
    company: (data.company as string | null) ?? null,
    summary: (data.summary as string | null) ?? null,
    rawText: (data.rawText as string | null) ?? null,
    receivedAt: tsToDate(data.receivedAt) ?? new Date(0),
    selectedAt: tsToDate(data.selectedAt),
    planId: (data.planId as string | null) ?? null,
  });
}

/** Create an available_listings doc. The id matches the Neurocore memoryId
 *  so polling can dedup on it. */
export async function upsertListing(
  input: AvailableListingCreate,
  db: Firestore = getDb(),
): Promise<AvailableListing> {
  const now = input.receivedAt ?? new Date();
  const doc = {
    title: input.title,
    company: input.company ?? null,
    summary: input.summary ?? null,
    rawText: input.rawText ?? null,
    receivedAt: now,
    selectedAt: null,
    planId: null,
  };
  // set with merge=false: a re-poll with the same id overwrites. The id is
  // stable upstream (PI listing id) so this is safe.
  await db.collection(COLLECTION).doc(input.id).set(doc);
  return docToListing(input.id, doc);
}

export async function getListing(
  id: string,
  db: Firestore = getDb(),
): Promise<AvailableListing | null> {
  const snap = await db.collection(COLLECTION).doc(id).get();
  if (!snap.exists) return null;
  return docToListing(snap.id, snap.data() as Record<string, unknown>);
}

export interface ListListingsFilter {
  /** When true, only return listings that haven't been turned into a plan. */
  unselectedOnly?: boolean;
  limit?: number;
}

// FIRESTORE-INDEX: available_listings(planId:ASC, receivedAt:DESC)
export async function listListings(
  filter: ListListingsFilter = {},
  db: Firestore = getDb(),
): Promise<AvailableListing[]> {
  let q = db.collection(COLLECTION).orderBy('receivedAt', 'desc') as FirebaseFirestore.Query;
  if (filter.unselectedOnly) q = q.where('planId', '==', null);
  q = q.limit(Math.min(Math.max(filter.limit ?? 100, 1), 500));
  const snap = await q.get();
  return snap.docs.map((d) => docToListing(d.id, d.data() as Record<string, unknown>));
}

/** Mark a listing as selected for planning. Idempotent — re-selecting the
 *  same plan is a no-op; selecting again with a different planId overwrites. */
export async function markListingSelected(
  id: string,
  planId: string,
  db: Firestore = getDb(),
): Promise<AvailableListing | null> {
  const ref = db.collection(COLLECTION).doc(id);
  const snap = await ref.get();
  if (!snap.exists) return null;
  await ref.update({ planId, selectedAt: new Date() });
  const refreshed = await ref.get();
  return docToListing(refreshed.id, refreshed.data() as Record<string, unknown>);
}

export async function deleteListing(
  id: string,
  db: Firestore = getDb(),
): Promise<boolean> {
  const ref = db.collection(COLLECTION).doc(id);
  const snap = await ref.get();
  if (!snap.exists) return false;
  await ref.delete();
  return true;
}
