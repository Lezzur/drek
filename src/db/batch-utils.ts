import type { Firestore, Query } from 'firebase-admin/firestore';

/**
 * Chunk size for batched subcollection deletes. Kept under Firestore's hard
 * 500-operation batch limit with headroom so a single commit never overflows.
 */
const DELETE_CHUNK = 450;

/**
 * Delete every document matched by `query`, draining in chunks until the query
 * returns nothing. This avoids two failure modes of a single `.limit(500)`
 * batch: silently orphaning docs beyond the cap, and throwing when the op
 * count exceeds Firestore's 500-operation batch limit.
 *
 * Pass a bare CollectionReference (or a Query without orderBy) so no composite
 * index is required for the drain. Returns the total number of docs deleted.
 */
export async function deleteAllMatching(query: Query, db: Firestore): Promise<number> {
  let total = 0;
  for (;;) {
    const snap = await query.limit(DELETE_CHUNK).get();
    if (snap.empty) break;
    const batch = db.batch();
    for (const d of snap.docs) batch.delete(d.ref);
    await batch.commit();
    total += snap.size;
    // A short page means we've reached the end — skip the extra empty round-trip.
    if (snap.size < DELETE_CHUNK) break;
  }
  return total;
}
