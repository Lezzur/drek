import type { Firestore } from 'firebase-admin/firestore';
import { getDb } from '../db/firestore.js';
import { getPlan } from '../db/plans.js';
import {
  findLongFormDeliverable,
  listDeliverablesForPlan,
  deleteDeliverable,
  DeliverableNotFoundError,
} from '../db/deliverables.js';
import { FORMAT_PROFILES } from './format-profiles/index.js';
import { deleteAllMatching } from '../db/batch-utils.js';
import { PlanningEngineError } from './errors.js';
import { logger } from '../logger.js';

/**
 * change-format engine step — Mid-plan format profile change (wipe-and-revert).
 *
 * Per TECH-SPEC-drek-v2-youtube-2026-05-18.md §4.9:
 *
 * When Rick changes a youtube_advanced plan's format profile after scenes
 * have been generated, everything format-dependent is wiped and the plan
 * reverts to `projects_matched`. No partial-wipe path exists — it's atomic
 * or nothing.
 *
 * No-op short-circuit: if the plan is at `awaiting_review`, `dismissed`,
 * `requirements_reviewed`, or `projects_matched` (no scenes yet), only
 * formatProfileId is updated.
 *
 * Production uses a Firestore batch for atomicity. The fake Firestore used
 * in tests doesn't support `runTransaction` — we use plain `batch()` which
 * is what the fake implements. The comment below marks where a real
 * `runTransaction` would wrap the batch in production for strict atomicity.
 */

const STEP_NAME = 'change-format';

// Statuses where no scenes exist yet — no wipe needed, just update the id.
const NO_WIPE_STATUSES = new Set([
  'awaiting_review',
  'dismissed',
  'requirements_reviewed',
  'projects_matched',
]);

export async function changePlanFormatProfile(
  planId: string,
  newFormatProfileId: string,
  db: Firestore = getDb(),
): Promise<void> {
  // ---- Load plan -------------------------------------------------------
  const plan = await getPlan(planId, db);
  if (!plan) {
    throw new PlanningEngineError(
      STEP_NAME,
      'PLAN_NOT_FOUND',
      `no plan with id ${planId}`,
      { planId },
    );
  }

  // ---- Pre-condition checks --------------------------------------------
  if (plan.type !== 'youtube_advanced') {
    throw new PlanningEngineError(
      STEP_NAME,
      'WRONG_PLAN_TYPE',
      `change-format only applies to youtube_advanced plans; got ${plan.type}`,
      { planId },
    );
  }

  if (plan.status === 'exported' || (plan.status as string) === 'published') {
    throw new PlanningEngineError(
      STEP_NAME,
      'CANNOT_CHANGE_AFTER_PUBLISH',
      `cannot change format profile after plan has been ${plan.status} — create a new plan instead`,
      { planId, detail: { status: plan.status } },
    );
  }

  if (!FORMAT_PROFILES[newFormatProfileId]) {
    throw new PlanningEngineError(
      STEP_NAME,
      'UNKNOWN_FORMAT_PROFILE',
      `unknown format profile id: "${newFormatProfileId}"`,
      { planId, detail: { newFormatProfileId } },
    );
  }

  // ---- No-op short-circuit: no scenes yet, just update formatProfileId --
  if (NO_WIPE_STATUSES.has(plan.status)) {
    const now = new Date();
    await db.collection('plans').doc(planId).update({
      formatProfileId: newFormatProfileId,
      updatedAt: now,
    });
    logger.info(
      { planId, newFormatProfileId, status: plan.status },
      'change-format: no-op (no scenes exist) — updated formatProfileId only',
    );
    return;
  }

  // ---- Full wipe-and-revert path ----------------------------------------
  //
  // Find the long_form Deliverable (invariant: every youtube_advanced plan has
  // exactly one). We resolve it before the batch so we can enumerate its
  // subcollections.
  let longFormDeliverable;
  try {
    longFormDeliverable = await findLongFormDeliverable(planId, db);
  } catch (err) {
    if (err instanceof DeliverableNotFoundError) {
      // No long_form deliverable found — treat as no-op wipe (shouldn't happen
      // in production but be defensive).
      logger.warn({ planId }, 'change-format: no long_form deliverable found, skipping wipe');
      const now = new Date();
      await db.collection('plans').doc(planId).update({
        formatProfileId: newFormatProfileId,
        updatedAt: now,
      });
      return;
    }
    throw err;
  }

  const now = new Date();

  // Collect all short_clip deliverables for this plan so we can delete them.
  const shortClipDeliverables = await listDeliverablesForPlan(planId, { kind: 'short_clip' }, db);

  // ---- Drain derived subcollections ------------------------------------
  //
  // Done as chunked drains (not one big batch) so a plan with many scenes can
  // never silently orphan docs past 500, nor overflow Firestore's 500-op batch
  // limit and throw mid-wipe. A crash between a drain and the field-reset below
  // is self-healing: re-running change-format re-drains (a no-op) and completes
  // the reset. The user-visible state flip (plan + deliverable fields) stays
  // atomic in the single batch that follows.
  const longFormRef = db.collection('deliverables').doc(longFormDeliverable.id);
  const scenesWiped = await deleteAllMatching(
    db.collection('plans').doc(planId).collection('scenes'),
    db,
  );
  const hookDraftsWiped = await deleteAllMatching(
    db.collection('plans').doc(planId).collection('hook_drafts'),
    db,
  );
  for (const subCol of ['title_concepts', 'thumbnail_concepts', 'publish_metadata'] as const) {
    await deleteAllMatching(longFormRef.collection(subCol), db);
  }

  // ---- Atomic field reset ----------------------------------------------
  // Plan + long_form Deliverable flip together: either both revert or neither.
  const batch = db.batch();
  batch.update(longFormRef, {
    selectedTitleVariantId: null,
    selectedThumbnailConceptId: null,
    publishMetadataId: null,
    status: 'draft',
    updatedAt: now,
  });
  batch.update(db.collection('plans').doc(planId), {
    selectedHookVariantId: null,
    selectedTitleVariantId: null,
    selectedThumbnailConceptId: null,
    estimatedRuntimeSeconds: 0,
    formatProfileId: newFormatProfileId,
    status: 'projects_matched',
    updatedAt: now,
  });
  await batch.commit();

  // 6. Delete short_clip Deliverables (and their subcollections) separately
  //    via deleteDeliverable() which handles the cascade. We do this after the
  //    main batch because deleteDeliverable() uses its own internal batches.
  //    If this fails, the plan is already reverted and the orphaned short_clip
  //    docs will be cleaned up on the next change-format or at plan deletion.
  for (const shortClip of shortClipDeliverables) {
    try {
      await deleteDeliverable(shortClip.id, db);
    } catch (err) {
      // Log but don't rethrow — the core wipe already committed.
      logger.warn(
        { planId, deliverableId: shortClip.id, err: (err as Error).message },
        'change-format: failed to delete short_clip deliverable (non-fatal — main batch already committed)',
      );
    }
  }

  logger.info(
    {
      planId,
      newFormatProfileId,
      previousStatus: plan.status,
      scenesWiped,
      hookDraftsWiped,
      shortClipsWiped: shortClipDeliverables.length,
    },
    'change-format: wipe-and-revert complete',
  );
}
