import type { Firestore } from 'firebase-admin/firestore';
import { getDb } from './firestore.js';
import { makeId } from './ids.js';
import {
  recordingSessionSchema,
  type RecordingSession,
  type RecordingSessionCreate,
} from './schemas.js';

/**
 * RecordingSession CRUD — top-level collection. Each entry is one logged
 * recording session for a Plan, with the file path Rick saved it to, the
 * duration, and which scenes it covers.
 *
 * Coverage is recomputed on read (computeSceneCoverage). It deliberately
 * silently drops references to scenes that no longer exist in the plan —
 * scenes can be renamed in a regeneration without breaking the manifest.
 */

const COLLECTION = 'recording_sessions';

function tsToDate(v: unknown): Date {
  if (v instanceof Date) return v;
  const maybe = v as { toDate?: () => Date };
  return typeof maybe?.toDate === 'function' ? maybe.toDate() : new Date(0);
}

function docToSession(id: string, data: Record<string, unknown>): RecordingSession {
  return recordingSessionSchema.parse({
    id,
    planId: data.planId,
    dateRecorded: tsToDate(data.dateRecorded),
    sessionType: data.sessionType,
    filePath: data.filePath,
    durationSeconds: data.durationSeconds,
    scenesCovered: data.scenesCovered,
    notes: (data.notes as string | null) ?? null,
    createdAt: tsToDate(data.createdAt),
  });
}

export async function logRecordingSession(
  input: RecordingSessionCreate,
  db: Firestore = getDb(),
): Promise<RecordingSession> {
  const id = makeId('rec');
  const doc = {
    planId: input.planId,
    dateRecorded: input.dateRecorded,
    sessionType: input.sessionType,
    filePath: input.filePath,
    durationSeconds: input.durationSeconds,
    scenesCovered: input.scenesCovered,
    notes: input.notes ?? null,
    createdAt: new Date(),
  };
  await db.collection(COLLECTION).doc(id).set(doc);
  return docToSession(id, doc);
}

// FIRESTORE-INDEX: recording_sessions(planId:ASC, dateRecorded:DESC)
export async function listSessionsForPlan(
  planId: string,
  db: Firestore = getDb(),
): Promise<RecordingSession[]> {
  const snap = await db
    .collection(COLLECTION)
    .where('planId', '==', planId)
    .orderBy('dateRecorded', 'desc')
    .get();
  return snap.docs.map((d) =>
    docToSession(d.id, d.data() as Record<string, unknown>),
  );
}

export async function deleteRecordingSession(
  id: string,
  db: Firestore = getDb(),
): Promise<boolean> {
  const ref = db.collection(COLLECTION).doc(id);
  const snap = await ref.get();
  if (!snap.exists) return false;
  await ref.delete();
  return true;
}

export interface SceneCoverage {
  covered: boolean;
  sessionIds: string[];
}

/**
 * For each sceneId in `validSceneIds`, return whether any logged session
 * covers it, and the list of session ids that do. Scene ids referenced by
 * sessions but not in `validSceneIds` (e.g. renamed scenes after a
 * regeneration) are silently dropped — they don't poison the coverage map.
 *
 * Called on every plan-detail render; kept cheap by computing in-memory
 * from a single query.
 */
export async function computeSceneCoverage(
  planId: string,
  validSceneIds: string[],
  db: Firestore = getDb(),
): Promise<Record<string, SceneCoverage>> {
  const validSet = new Set(validSceneIds);
  const out: Record<string, SceneCoverage> = {};
  for (const id of validSceneIds) out[id] = { covered: false, sessionIds: [] };

  const sessions = await listSessionsForPlan(planId, db);
  for (const s of sessions) {
    for (const sceneId of s.scenesCovered) {
      if (!validSet.has(sceneId)) continue;
      const entry = out[sceneId]!;
      entry.covered = true;
      entry.sessionIds.push(s.id);
    }
  }
  return out;
}
