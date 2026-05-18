import type { Firestore } from 'firebase-admin/firestore';
import { getDb } from './firestore.js';
import { makeId } from './ids.js';
import {
  thumbnailConceptSchema,
  type ThumbnailConcept,
  type ThumbnailConceptCreate,
} from './schemas.js';

/**
 * ThumbnailConcept CRUD — subcollection under each Deliverable. Mirrors
 * the TitleConcept pattern (atomic selection via batch).
 */

const DELIVERABLES = 'deliverables';
const CONCEPTS = 'thumbnail_concepts';

function tsToDate(v: unknown): Date {
  if (v instanceof Date) return v;
  const maybe = v as { toDate?: () => Date };
  return typeof maybe?.toDate === 'function' ? maybe.toDate() : new Date(0);
}

function docToConcept(id: string, data: Record<string, unknown>): ThumbnailConcept {
  return thumbnailConceptSchema.parse({
    id,
    composition: data.composition,
    textHook: data.textHook,
    expression: (data.expression as string | null) ?? null,
    colorPalette: data.colorPalette,
    assetsRequired: data.assetsRequired ?? [],
    conceptSummary: data.conceptSummary,
    selected: data.selected ?? false,
    createdAt: tsToDate(data.createdAt),
  });
}

function conceptsCol(db: Firestore, deliverableId: string) {
  return db.collection(DELIVERABLES).doc(deliverableId).collection(CONCEPTS);
}

export async function createThumbnailConcept(
  deliverableId: string,
  input: ThumbnailConceptCreate,
  db: Firestore = getDb(),
): Promise<ThumbnailConcept> {
  const id = makeId('thumb');
  const doc = {
    composition: input.composition,
    textHook: input.textHook,
    expression: input.expression ?? null,
    colorPalette: input.colorPalette,
    assetsRequired: input.assetsRequired ?? [],
    conceptSummary: input.conceptSummary,
    selected: input.selected ?? false,
    createdAt: new Date(),
  };
  await conceptsCol(db, deliverableId).doc(id).set(doc);
  return docToConcept(id, doc);
}

export async function listThumbnailConceptsForDeliverable(
  deliverableId: string,
  db: Firestore = getDb(),
): Promise<ThumbnailConcept[]> {
  const snap = await conceptsCol(db, deliverableId).get();
  return snap.docs.map((d) => docToConcept(d.id, d.data() as Record<string, unknown>));
}

export async function getSelectedThumbnailConcept(
  deliverableId: string,
  db: Firestore = getDb(),
): Promise<ThumbnailConcept | null> {
  const snap = await conceptsCol(db, deliverableId)
    .where('selected', '==', true)
    .limit(1)
    .get();
  if (snap.empty) return null;
  const doc = snap.docs[0]!;
  return docToConcept(doc.id, doc.data() as Record<string, unknown>);
}

export async function setSelectedThumbnailConcept(
  deliverableId: string,
  conceptId: string,
  db: Firestore = getDb(),
): Promise<void> {
  const target = await conceptsCol(db, deliverableId).doc(conceptId).get();
  if (!target.exists) {
    throw new Error(
      `ThumbnailConcept ${conceptId} not found under deliverable ${deliverableId}`,
    );
  }
  const all = await conceptsCol(db, deliverableId).get();
  const batch = db.batch();
  for (const d of all.docs) {
    batch.update(d.ref, { selected: d.id === conceptId });
  }
  await batch.commit();
}

export async function deleteAllThumbnailConceptsForDeliverable(
  deliverableId: string,
  db: Firestore = getDb(),
): Promise<number> {
  const snap = await conceptsCol(db, deliverableId).limit(500).get();
  if (snap.empty) return 0;
  const batch = db.batch();
  for (const d of snap.docs) batch.delete(d.ref);
  await batch.commit();
  return snap.size;
}
