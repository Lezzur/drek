import type { Firestore } from 'firebase-admin/firestore';
import { getDb } from './firestore.js';
import {
  publishMetadataSchema,
  type PublishMetadata,
  type PublishMetadataCreate,
  type PublishMetadataPatch,
} from './schemas.js';

/**
 * PublishMetadata CRUD — there is exactly one document per Deliverable,
 * stored at `deliverables/{deliverableId}/publish_metadata/current`. Using
 * a fixed doc id ("current") makes upserts deterministic and avoids
 * an indexed query for the one-and-only document.
 */

const DELIVERABLES = 'deliverables';
const SUB = 'publish_metadata';
const DOC_ID = 'current';

function tsToDate(v: unknown): Date {
  if (v instanceof Date) return v;
  const maybe = v as { toDate?: () => Date };
  return typeof maybe?.toDate === 'function' ? maybe.toDate() : new Date(0);
}

function nullableTsToDate(v: unknown): Date | null {
  if (!v) return null;
  return tsToDate(v);
}

function docToMetadata(data: Record<string, unknown>): PublishMetadata {
  return publishMetadataSchema.parse({
    description: data.description,
    chapters: data.chapters,
    tags: data.tags,
    pinnedComment: data.pinnedComment,
    endScreenSuggestion: data.endScreenSuggestion,
    generatedAt: tsToDate(data.generatedAt),
    lastEditedAt: nullableTsToDate(data.lastEditedAt),
  });
}

function ref(db: Firestore, deliverableId: string) {
  return db.collection(DELIVERABLES).doc(deliverableId).collection(SUB).doc(DOC_ID);
}

export async function upsertPublishMetadata(
  deliverableId: string,
  input: PublishMetadataCreate,
  db: Firestore = getDb(),
): Promise<PublishMetadata> {
  const doc = {
    description: input.description,
    chapters: input.chapters,
    tags: input.tags,
    pinnedComment: input.pinnedComment,
    endScreenSuggestion: input.endScreenSuggestion,
    generatedAt: new Date(),
    lastEditedAt: null,
  };
  await ref(db, deliverableId).set(doc);
  return docToMetadata(doc);
}

export async function getPublishMetadata(
  deliverableId: string,
  db: Firestore = getDb(),
): Promise<PublishMetadata | null> {
  const snap = await ref(db, deliverableId).get();
  if (!snap.exists) return null;
  return docToMetadata(snap.data() as Record<string, unknown>);
}

export async function patchPublishMetadata(
  deliverableId: string,
  patch: PublishMetadataPatch,
  db: Firestore = getDb(),
): Promise<PublishMetadata | null> {
  const r = ref(db, deliverableId);
  const snap = await r.get();
  if (!snap.exists) return null;
  const update: Record<string, unknown> = { lastEditedAt: new Date() };
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) update[k] = v;
  }
  await r.update(update);
  const refreshed = await r.get();
  return docToMetadata(refreshed.data() as Record<string, unknown>);
}

export async function deletePublishMetadata(
  deliverableId: string,
  db: Firestore = getDb(),
): Promise<boolean> {
  const r = ref(db, deliverableId);
  const snap = await r.get();
  if (!snap.exists) return false;
  await r.delete();
  return true;
}
