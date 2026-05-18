import type { Firestore } from 'firebase-admin/firestore';
import { getDb } from './firestore.js';
import { makeId } from './ids.js';
import {
  titleConceptSchema,
  type TitleConcept,
  type TitleConceptCreate,
} from './schemas.js';

/**
 * TitleConcept CRUD — subcollection under each Deliverable.
 *
 * Selection is atomic: setSelectedConcept flips the chosen one to
 * `selected: true` and every sibling to `selected: false` in a single
 * Firestore batch. Avoids the multi-write race where two concepts
 * could both end up selected.
 */

const DELIVERABLES = 'deliverables';
const CONCEPTS = 'title_concepts';

function tsToDate(v: unknown): Date {
  if (v instanceof Date) return v;
  const maybe = v as { toDate?: () => Date };
  return typeof maybe?.toDate === 'function' ? maybe.toDate() : new Date(0);
}

function docToConcept(id: string, data: Record<string, unknown>): TitleConcept {
  return titleConceptSchema.parse({
    id,
    titleText: data.titleText,
    archetype: data.archetype,
    predictedClickability: data.predictedClickability,
    reasoning: data.reasoning,
    keywordsSurfaced: data.keywordsSurfaced ?? [],
    selected: data.selected ?? false,
    createdAt: tsToDate(data.createdAt),
  });
}

function conceptsCol(db: Firestore, deliverableId: string) {
  return db.collection(DELIVERABLES).doc(deliverableId).collection(CONCEPTS);
}

export async function createTitleConcept(
  deliverableId: string,
  input: TitleConceptCreate,
  db: Firestore = getDb(),
): Promise<TitleConcept> {
  const id = makeId('title');
  const doc = {
    titleText: input.titleText,
    archetype: input.archetype,
    predictedClickability: input.predictedClickability,
    reasoning: input.reasoning,
    keywordsSurfaced: input.keywordsSurfaced ?? [],
    selected: input.selected ?? false,
    createdAt: new Date(),
  };
  await conceptsCol(db, deliverableId).doc(id).set(doc);
  return docToConcept(id, doc);
}

export async function listTitleConceptsForDeliverable(
  deliverableId: string,
  db: Firestore = getDb(),
): Promise<TitleConcept[]> {
  const snap = await conceptsCol(db, deliverableId)
    .orderBy('predictedClickability', 'desc')
    .get();
  return snap.docs.map((d) => docToConcept(d.id, d.data() as Record<string, unknown>));
}

export async function getSelectedTitleConcept(
  deliverableId: string,
  db: Firestore = getDb(),
): Promise<TitleConcept | null> {
  const snap = await conceptsCol(db, deliverableId)
    .where('selected', '==', true)
    .limit(1)
    .get();
  if (snap.empty) return null;
  const doc = snap.docs[0]!;
  return docToConcept(doc.id, doc.data() as Record<string, unknown>);
}

/** Atomically flip the chosen concept to selected:true and all siblings
 *  to selected:false. Throws if the concept doesn't exist under the
 *  given deliverable. */
export async function setSelectedTitleConcept(
  deliverableId: string,
  conceptId: string,
  db: Firestore = getDb(),
): Promise<void> {
  const target = await conceptsCol(db, deliverableId).doc(conceptId).get();
  if (!target.exists) {
    throw new Error(
      `TitleConcept ${conceptId} not found under deliverable ${deliverableId}`,
    );
  }
  const all = await conceptsCol(db, deliverableId).get();
  const batch = db.batch();
  for (const d of all.docs) {
    batch.update(d.ref, { selected: d.id === conceptId });
  }
  await batch.commit();
}

export async function deleteAllTitleConceptsForDeliverable(
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
