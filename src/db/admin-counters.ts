import type { Firestore } from 'firebase-admin/firestore';
import { getDb } from './firestore.js';

/**
 * Tiny key/value counter store at `admin_counters/<key>`. Used so far for:
 *
 *   - `build_plan_edits` (M33) — count of successful editBuildPlan calls.
 *     Surfaced in the intake page header as "Build-plan edits: N/15".
 *     When N crosses 15, the M34 trigger banner fires. Rick reviews the
 *     corpus to decide what edit-derived preferences to teach the
 *     transformer prompt.
 *
 * Plain integer counters; no fancy histogramming or per-day buckets. If
 * we need more granularity later (e.g., "edits this week"), wider tools
 * exist — but they should live alongside this, not replace it.
 */

const COLLECTION = 'admin_counters';

export async function getCounter(
  key: string,
  db: Firestore = getDb(),
): Promise<number> {
  const snap = await db.collection(COLLECTION).doc(key).get();
  if (!snap.exists) return 0;
  const data = snap.data() as Record<string, unknown> | undefined;
  const n = data?.count;
  return typeof n === 'number' ? n : 0;
}

export async function incrementCounter(
  key: string,
  by: number = 1,
  db: Firestore = getDb(),
): Promise<number> {
  const ref = db.collection(COLLECTION).doc(key);
  // Read-modify-write — not atomic across processes, but DREK runs as a
  // single process (NSSM-wrapped Node service) so this is fine. If we
  // ever go multi-process, swap to Firestore.FieldValue.increment.
  const snap = await ref.get();
  const current =
    snap.exists && typeof (snap.data() as Record<string, unknown>).count === 'number'
      ? ((snap.data() as Record<string, unknown>).count as number)
      : 0;
  const next = current + by;
  await ref.set(
    { count: next, lastUpdatedAt: new Date() },
    { merge: false },
  );
  return next;
}

export async function resetCounter(
  key: string,
  db: Firestore = getDb(),
): Promise<void> {
  await db
    .collection(COLLECTION)
    .doc(key)
    .set({ count: 0, lastUpdatedAt: new Date() }, { merge: false });
}

/** Well-known keys live here so callers don't pass magic strings. */
export const BUILD_PLAN_EDITS_KEY = 'build_plan_edits';
/** M35: count of manual score overrides (Edit-scores form submissions).
 *  Surfaced alongside build-plan edits; same review-threshold pattern. */
export const SCORE_OVERRIDES_KEY = 'score_overrides';

/** M33: how many edits before we flag a "review the corpus" reminder. */
export const M34_TRIGGER_THRESHOLD = 15;
/** M35: same threshold for score-override pattern review. */
export const SCORE_REVIEW_THRESHOLD = 15;
