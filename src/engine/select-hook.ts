import type { Firestore } from 'firebase-admin/firestore';
import { logger } from '../logger.js';
import { getPlan, patchPlan } from '../db/plans.js';
import { listHookDraftsForPlan, setSelectedHookDraft } from '../db/hook-drafts.js';
import { PlanningEngineError } from './errors.js';

/**
 * Select a hook variant for a plan.
 *
 * Atomically flips the `selected` flag on all HookDrafts under the plan
 * (only the chosen hookId gets selected=true), then patches plan.selectedHookVariantId
 * and transitions plan.status → hook_selected.
 *
 * Re-selection from hook_selected is allowed (Rick can change his mind).
 *
 * Throws PlanningEngineError on every failure path.
 */

const STEP_NAME = 'select-hook';

export async function selectHook(
  planId: string,
  hookId: string,
  db?: Firestore,
): Promise<void> {
  // ---- Load plan --------------------------------------------------------
  const plan = await getPlan(planId, db);
  if (!plan) {
    throw new PlanningEngineError(STEP_NAME, 'PLAN_NOT_FOUND', `no plan with id ${planId}`, {
      planId,
    });
  }

  // ---- Status check: must be hooks_generated or hook_selected -----------
  const allowedStatuses: string[] = ['hooks_generated', 'hook_selected'];
  if (!allowedStatuses.includes(plan.status)) {
    throw new PlanningEngineError(
      STEP_NAME,
      'DISALLOWED_TRANSITION',
      `cannot select hook from status ${plan.status} — plan must be in hooks_generated or hook_selected`,
      { planId, detail: { currentStatus: plan.status } },
    );
  }

  // ---- Verify hookId exists under this plan -----------------------------
  const drafts = await listHookDraftsForPlan(planId, db);
  const targetDraft = drafts.find((d) => d.id === hookId);
  if (!targetDraft) {
    throw new PlanningEngineError(
      STEP_NAME,
      'HOOK_NOT_FOUND',
      `hookId "${hookId}" does not exist under plan ${planId}`,
      { planId, detail: { hookId } },
    );
  }

  // ---- Atomically flip selection flags ----------------------------------
  await setSelectedHookDraft(planId, hookId, db);

  // ---- Update plan ------------------------------------------------------
  await patchPlan(planId, { selectedHookVariantId: hookId, status: 'hook_selected' }, db);

  logger.info(
    { planId, hookId, archetype: targetDraft.archetype },
    'hook selected',
  );
}
