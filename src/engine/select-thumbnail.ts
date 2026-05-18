import type { Firestore } from 'firebase-admin/firestore';
import { getPlan, patchPlan } from '../db/plans.js';
import {
  getDeliverable,
  patchDeliverable,
} from '../db/deliverables.js';
import {
  listThumbnailConceptsForDeliverable,
  setSelectedThumbnailConcept,
} from '../db/thumbnail-concepts.js';
import { PlanningEngineError } from './errors.js';

/**
 * Atomic thumbnail-concept selection for a Deliverable. Mirrors selectTitle.
 *
 * Pre-conditions:
 *   - Deliverable exists; concept id belongs to it
 *   - For long-form: plan status in {thumbnails_generated, thumbnail_selected}
 *   - For short_clip: deliverable status in {scripts_ready, metadata_ready}
 */
export async function selectThumbnail(
  deliverableId: string,
  conceptId: string,
  db?: Firestore,
): Promise<void> {
  const deliverable = await getDeliverable(deliverableId, db);
  if (!deliverable) {
    throw new PlanningEngineError(
      'select-thumbnail',
      'PLAN_NOT_FOUND',
      `no deliverable ${deliverableId}`,
      { detail: { deliverableId } },
    );
  }

  const plan = await getPlan(deliverable.planId, db);
  if (!plan) {
    throw new PlanningEngineError(
      'select-thumbnail',
      'PLAN_NOT_FOUND',
      `parent plan ${deliverable.planId} missing`,
      { planId: deliverable.planId },
    );
  }

  if (deliverable.kind === 'long_form') {
    const allowed = ['thumbnails_generated', 'thumbnail_selected'];
    if (!allowed.includes(plan.status)) {
      throw new PlanningEngineError(
        'select-thumbnail',
        'DISALLOWED_TRANSITION',
        `cannot select thumbnail from plan status ${plan.status}`,
        { planId: plan.id, detail: { deliverableId } },
      );
    }
  } else if (deliverable.kind === 'short_clip') {
    const allowed = ['scripts_ready', 'metadata_ready'];
    if (!allowed.includes(deliverable.status)) {
      throw new PlanningEngineError(
        'select-thumbnail',
        'DISALLOWED_TRANSITION',
        `cannot select thumbnail from deliverable status ${deliverable.status}`,
        { planId: plan.id, detail: { deliverableId } },
      );
    }
  }

  const concepts = await listThumbnailConceptsForDeliverable(deliverableId, db);
  const target = concepts.find((c) => c.id === conceptId);
  if (!target) {
    throw new PlanningEngineError(
      'select-thumbnail',
      'PLAN_NOT_FOUND',
      `thumbnail concept ${conceptId} not found under deliverable ${deliverableId}`,
      { planId: plan.id, detail: { deliverableId, conceptId } },
    );
  }

  await setSelectedThumbnailConcept(deliverableId, conceptId, db);
  await patchDeliverable(deliverableId, { selectedThumbnailConceptId: conceptId }, db);

  if (deliverable.kind === 'long_form' && plan.status === 'thumbnails_generated') {
    await patchPlan(
      plan.id,
      { status: 'thumbnail_selected', selectedThumbnailConceptId: conceptId },
      db,
    );
  } else if (deliverable.kind === 'long_form') {
    await patchPlan(plan.id, { selectedThumbnailConceptId: conceptId }, db);
  }
}
