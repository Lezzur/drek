import type { Firestore } from 'firebase-admin/firestore';
import { logger } from '../logger.js';
import { getNeurocoreClient, type NeurocoreClient } from '../neurocore/client.js';
import { NeurocoreError } from '../neurocore/errors.js';
import { getPipelineBrief, patchPipelineBrief } from '../db/pipeline-briefs.js';
import { incrementCounter, BUILD_PLAN_EDITS_KEY } from '../db/admin-counters.js';
import {
  transformedBuildPlanSchema,
  pinnedTechStackSchema,
  type PipelineBrief,
  type PinnedTechStack,
  type TransformedBuildPlan,
} from '../db/schemas.js';
import { IntakeError } from './errors.js';

/**
 * Edit-build-plan service (M33).
 *
 * Persists Rick's manual edits to a transformed build plan + fires a
 * `build_plan.edited` signal to Neurocore so it can learn what the LLM
 * consistently gets wrong (toolchain, step granularity, shot vocabulary).
 *
 * Signal-send is best-effort — local edit always succeeds even if
 * Neurocore is unreachable. The signal failure is logged but never
 * propagated.
 */

export interface EditBuildPlanOptions {
  db?: Firestore;
  client?: NeurocoreClient;
}

export interface EditBuildPlanResult {
  brief: PipelineBrief;
  signalSent: boolean;
  signalError?: string;
}

/**
 * Replace the build plan + pinned tech stack on a brief. Both must be
 * provided together — the LLM emits them as one unit and Rick may have
 * edited the rationale or supporting set too.
 */
export async function editBuildPlan(
  briefId: string,
  edited: TransformedBuildPlan,
  editedTechStack: PinnedTechStack,
  opts: EditBuildPlanOptions = {},
): Promise<EditBuildPlanResult> {
  // Validate the incoming edit before reading anything — fail fast on
  // bad input rather than half-completing the transaction.
  const validatedPlan = transformedBuildPlanSchema.parse(edited);
  const validatedStack = pinnedTechStackSchema.parse(editedTechStack);

  const brief = await getPipelineBrief(briefId, opts.db);
  if (!brief) {
    throw new IntakeError(
      'BRIEF_NOT_FOUND',
      `no brief with id ${briefId}`,
      { briefId },
    );
  }
  if (!brief.transformedBuildPlan || !brief.pinnedTechStack) {
    throw new IntakeError(
      'INVALID_OUTPUT',
      'brief has no build plan to edit — run the Transform action first',
      { briefId },
    );
  }

  const originalPlan = brief.transformedBuildPlan;
  const originalStack = brief.pinnedTechStack;

  // Persist edit. Local Firestore write is the source of truth.
  let updated: PipelineBrief | null;
  try {
    updated = await patchPipelineBrief(
      briefId,
      {
        transformedBuildPlan: validatedPlan,
        pinnedTechStack: validatedStack,
      },
      opts.db,
    );
  } catch (err) {
    throw new IntakeError(
      'PERSIST_FAILED',
      `failed to persist edited build plan: ${(err as Error).message}`,
      { briefId },
    );
  }
  if (!updated) {
    throw new IntakeError(
      'BRIEF_NOT_FOUND',
      `brief disappeared mid-edit: ${briefId}`,
      { briefId },
    );
  }

  // Fire the learning signal. Best-effort.
  const client = opts.client ?? getNeurocoreClient();
  const changed = computeChangedSummary(
    originalPlan,
    originalStack,
    validatedPlan,
    validatedStack,
  );
  const editedAt = new Date().toISOString();
  let signalSent = false;
  let signalError: string | undefined;
  try {
    await client.sendBuildPlanEdited({
      briefId,
      originalPlan: {
        ...originalPlan,
        pinnedTechStack: originalStack,
      },
      editedPlan: {
        ...validatedPlan,
        pinnedTechStack: validatedStack,
      },
      changed,
      editedAt,
    });
    signalSent = true;
  } catch (err) {
    signalError =
      err instanceof NeurocoreError
        ? `${err.code}: ${err.message}`
        : (err as Error).message;
    logger.warn(
      { briefId, signalError },
      'edit-build-plan: build_plan.edited signal failed (non-fatal — local edit succeeded)',
    );
  }

  // Bump the M33 counter so the intake page header can surface "edits
  // toward M34 trigger" + flip to the loud banner at >= 15. Best-effort:
  // counter failure never blocks the edit.
  let editCount: number | null = null;
  try {
    editCount = await incrementCounter(BUILD_PLAN_EDITS_KEY, 1, opts.db);
  } catch (err) {
    logger.warn(
      { briefId, err: (err as Error).message },
      'edit-build-plan: counter increment failed (non-fatal)',
    );
  }

  logger.info(
    {
      briefId,
      signalSent,
      changedFieldCount: countTrueFields(changed),
      buildStepCount: validatedPlan.buildSteps.length,
      buildPlanEditCount: editCount,
    },
    'build plan edited',
  );

  return {
    brief: updated,
    signalSent,
    ...(signalError ? { signalError } : {}),
  };
}

/**
 * Compute the coarse `changed` summary the signal payload carries. This
 * is what the M34 corpus-analysis step will query — designed to be
 * cheap to scan across hundreds of signals without parsing the full
 * before/after plans every time.
 */
export function computeChangedSummary(
  originalPlan: TransformedBuildPlan,
  originalStack: PinnedTechStack,
  editedPlan: TransformedBuildPlan,
  editedStack: PinnedTechStack,
): {
  goal: boolean;
  finalProduct: boolean;
  pinnedTechStack: boolean;
  toolchain: { added: string[]; removed: string[]; roleEdits: number };
  buildSteps: { added: number; removed: number; edited: number; totalMinutesDelta: number };
  shotHints: { added: number; removed: number };
} {
  const stackChanged =
    originalStack.primary !== editedStack.primary ||
    !arraysEqual(originalStack.supporting, editedStack.supporting) ||
    originalStack.rationale !== editedStack.rationale;

  const originalToolNames = new Set(originalPlan.toolchain.map((t) => t.name));
  const editedToolNames = new Set(editedPlan.toolchain.map((t) => t.name));
  const added: string[] = [];
  const removed: string[] = [];
  for (const name of editedToolNames) {
    if (!originalToolNames.has(name)) added.push(name);
  }
  for (const name of originalToolNames) {
    if (!editedToolNames.has(name)) removed.push(name);
  }
  // Role edits: tools present in both with a changed role string.
  const originalRoles = new Map(originalPlan.toolchain.map((t) => [t.name, t.role]));
  let roleEdits = 0;
  for (const t of editedPlan.toolchain) {
    const origRole = originalRoles.get(t.name);
    if (origRole !== undefined && origRole !== t.role) roleEdits++;
  }

  // Build steps: count by title (first 60 chars) — a step is "the same"
  // if its title matches, "edited" if it matches but description or
  // estimatedMinutes changed.
  const stepKey = (s: { title: string }): string => s.title.trim().slice(0, 60);
  const originalSteps = new Map(originalPlan.buildSteps.map((s) => [stepKey(s), s]));
  const editedSteps = new Map(editedPlan.buildSteps.map((s) => [stepKey(s), s]));
  let stepsAdded = 0;
  let stepsRemoved = 0;
  let stepsEdited = 0;
  for (const [key, step] of editedSteps) {
    const orig = originalSteps.get(key);
    if (!orig) {
      stepsAdded++;
    } else if (
      orig.description !== step.description ||
      orig.estimatedMinutes !== step.estimatedMinutes
    ) {
      stepsEdited++;
    }
  }
  for (const key of originalSteps.keys()) {
    if (!editedSteps.has(key)) stepsRemoved++;
  }
  const originalTotalMinutes = originalPlan.buildSteps.reduce(
    (s, x) => s + x.estimatedMinutes,
    0,
  );
  const editedTotalMinutes = editedPlan.buildSteps.reduce(
    (s, x) => s + x.estimatedMinutes,
    0,
  );

  // Shot hints: simple set diff on the full hint text (they're short).
  const originalHints = new Set(originalPlan.shotHints.map((h) => h.trim()));
  const editedHints = new Set(editedPlan.shotHints.map((h) => h.trim()));
  let hintsAdded = 0;
  let hintsRemoved = 0;
  for (const h of editedHints) if (!originalHints.has(h)) hintsAdded++;
  for (const h of originalHints) if (!editedHints.has(h)) hintsRemoved++;

  return {
    goal: originalPlan.goal !== editedPlan.goal,
    finalProduct: originalPlan.finalProduct !== editedPlan.finalProduct,
    pinnedTechStack: stackChanged,
    toolchain: { added, removed, roleEdits },
    buildSteps: {
      added: stepsAdded,
      removed: stepsRemoved,
      edited: stepsEdited,
      totalMinutesDelta: editedTotalMinutes - originalTotalMinutes,
    },
    shotHints: { added: hintsAdded, removed: hintsRemoved },
  };
}

function arraysEqual<T>(a: T[], b: T[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function countTrueFields(
  changed: ReturnType<typeof computeChangedSummary>,
): number {
  let n = 0;
  if (changed.goal) n++;
  if (changed.finalProduct) n++;
  if (changed.pinnedTechStack) n++;
  if (changed.toolchain.added.length > 0 || changed.toolchain.removed.length > 0 || changed.toolchain.roleEdits > 0) n++;
  if (changed.buildSteps.added > 0 || changed.buildSteps.removed > 0 || changed.buildSteps.edited > 0) n++;
  if (changed.shotHints.added > 0 || changed.shotHints.removed > 0) n++;
  return n;
}
