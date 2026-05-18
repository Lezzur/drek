import type { Firestore } from 'firebase-admin/firestore';
import { getPlan, patchPlan } from '../db/plans.js';
import {
  getDeliverable,
  patchDeliverable,
} from '../db/deliverables.js';
import {
  listTitleConceptsForDeliverable,
  setSelectedTitleConcept,
} from '../db/title-concepts.js';
import { PlanningEngineError } from './errors.js';

/**
 * Atomic title selection for a Deliverable.
 *
 * Pre-conditions:
 *   - Deliverable exists
 *   - Concept id belongs to this deliverable
 *   - For long-form: plan.status in {titles_generated, title_selected}
 *   - For short_clip: deliverable status in {scripts_ready, metadata_ready}
 *
 * Side effects (single Firestore batch via setSelectedTitleConcept):
 *   - Toggle selected=true on the chosen concept, false on every sibling
 *   - patchDeliverable: selectedTitleVariantId = conceptId
 *   - For long-form: patchPlan status → title_selected + selectedTitleVariantId
 */
export async function selectTitle(
  deliverableId: string,
  conceptId: string,
  db?: Firestore,
): Promise<void> {
  const deliverable = await getDeliverable(deliverableId, db);
  if (!deliverable) {
    throw new PlanningEngineError(
      'select-title',
      'PLAN_NOT_FOUND',
      `no deliverable ${deliverableId}`,
      { detail: { deliverableId } },
    );
  }

  const plan = await getPlan(deliverable.planId, db);
  if (!plan) {
    throw new PlanningEngineError(
      'select-title',
      'PLAN_NOT_FOUND',
      `parent plan ${deliverable.planId} missing`,
      { planId: deliverable.planId },
    );
  }

  if (deliverable.kind === 'long_form') {
    const allowed = ['titles_generated', 'title_selected'];
    if (!allowed.includes(plan.status)) {
      throw new PlanningEngineError(
        'select-title',
        'DISALLOWED_TRANSITION',
        `cannot select title from plan status ${plan.status}`,
        { planId: plan.id, detail: { deliverableId } },
      );
    }
  } else if (deliverable.kind === 'short_clip') {
    const allowed = ['scripts_ready', 'metadata_ready'];
    if (!allowed.includes(deliverable.status)) {
      throw new PlanningEngineError(
        'select-title',
        'DISALLOWED_TRANSITION',
        `cannot select title from deliverable status ${deliverable.status}`,
        { planId: plan.id, detail: { deliverableId } },
      );
    }
  }

  // Verify the concept exists under this deliverable
  const concepts = await listTitleConceptsForDeliverable(deliverableId, db);
  const target = concepts.find((c) => c.id === conceptId);
  if (!target) {
    throw new PlanningEngineError(
      'select-title',
      'PLAN_NOT_FOUND',
      `title concept ${conceptId} not found under deliverable ${deliverableId}`,
      { planId: plan.id, detail: { deliverableId, conceptId } },
    );
  }

  await setSelectedTitleConcept(deliverableId, conceptId, db);
  await patchDeliverable(deliverableId, { selectedTitleVariantId: conceptId }, db);

  if (deliverable.kind === 'long_form' && plan.status === 'titles_generated') {
    await patchPlan(
      plan.id,
      { status: 'title_selected', selectedTitleVariantId: conceptId },
      db,
    );
  } else if (deliverable.kind === 'long_form') {
    // Already at title_selected — just sync the plan's denormalized field.
    await patchPlan(plan.id, { selectedTitleVariantId: conceptId }, db);
  }
}
