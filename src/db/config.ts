import type { Firestore } from 'firebase-admin/firestore';
import { getDb } from './firestore.js';
import {
  pollingConfigSchema,
  DEFAULT_POLLING_CONFIG,
  type PollingConfig,
} from './schemas.js';

const COLLECTION = 'config';
const DOC = 'polling';

function tsToDate(v: unknown): Date | null {
  if (!v) return null;
  if (v instanceof Date) return v;
  const maybe = v as { toDate?: () => Date };
  return typeof maybe.toDate === 'function' ? maybe.toDate() : null;
}

/** Read the polling config. Returns DEFAULT_POLLING_CONFIG on first boot
 *  (doc doesn't exist yet) so callers always get a usable value. */
export async function readPollingConfig(
  db: Firestore = getDb(),
): Promise<PollingConfig> {
  const snap = await db.collection(COLLECTION).doc(DOC).get();
  if (!snap.exists) return DEFAULT_POLLING_CONFIG;
  const data = snap.data() ?? {};
  return pollingConfigSchema.parse({
    lastPollAt: tsToDate(data.lastPollAt),
    pollingEnabled: data.pollingEnabled ?? DEFAULT_POLLING_CONFIG.pollingEnabled,
    pollingIntervalMs: data.pollingIntervalMs ?? DEFAULT_POLLING_CONFIG.pollingIntervalMs,
  });
}

/** Patch the polling config. Fields not in the patch are left alone. */
export async function patchPollingConfig(
  patch: Partial<PollingConfig>,
  db: Firestore = getDb(),
): Promise<PollingConfig> {
  const ref = db.collection(COLLECTION).doc(DOC);
  // Use set+merge so the doc is created on first patch. patch values pass
  // through unchanged (Firestore stores Date as Timestamp automatically).
  await ref.set(patch, { merge: true });
  return readPollingConfig(db);
}

/** Bump lastPollAt to now. Called by the polling cron after each cycle. */
export async function recordPoll(db: Firestore = getDb()): Promise<void> {
  await db
    .collection(COLLECTION)
    .doc(DOC)
    .set({ lastPollAt: new Date() }, { merge: true });
}
