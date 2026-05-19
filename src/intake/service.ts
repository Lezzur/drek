import type { Firestore } from 'firebase-admin/firestore';
import { getDb } from '../db/firestore.js';
import { logger } from '../logger.js';
import { randomUUID } from 'node:crypto';
import {
  createBriefBatch,
  createPipelineBrief,
  getPipelineBrief,
  listBriefsByBatchId,
  listPipelineBriefs,
  patchPipelineBrief,
  type BriefSort,
  type ListBriefsOpts,
} from '../db/pipeline-briefs.js';
import { createDeliverable } from '../db/deliverables.js';
import { makeId } from '../db/ids.js';
import {
  isAllowedBriefStageTransition,
  type BriefScore,
  type BriefStage,
  type PipelineBrief,
  type PipelineBriefCreate,
} from '../db/schemas.js';
import { scoreBriefViaLLM } from './scoring.js';
import {
  getFormatProfile,
  FormatProfileNotFoundError,
} from '../engine/format-profiles/index.js';
import {
  getAudienceProfileClient,
  AudienceProfileNotFoundError,
} from '../neurocore/audience-profiles.js';
import { IntakeError } from './errors.js';

/**
 * Intake service — wraps the PipelineBrief CRUD with explicit state
 * transitions and the promote-to-plan flow.
 *
 * The headline operation is `promoteBriefToPlan`: in a single Firestore
 * batch, create a youtube_advanced Plan + its long_form Deliverable bound
 * to the chosen AudienceProfile, then advance the brief stage to
 * 'selected'. All three writes succeed together or none do — Firestore
 * batches are atomic.
 *
 * Pre-conditions enforced fail-fast (before any writes):
 *   - Brief exists
 *   - Brief not already promoted
 *   - Brief has a score (per Rick's "LLM scoring on day 1" directive)
 *   - Format profile id is registered
 *   - Audience profile id resolves via the Neurocore client
 */

export interface CreateBriefInput extends PipelineBriefCreate {}

export async function createBrief(
  input: CreateBriefInput,
  db: Firestore = getDb(),
): Promise<PipelineBrief> {
  return createPipelineBrief(input, db);
}

export async function listBriefs(
  opts: ListBriefsOpts = {},
  db: Firestore = getDb(),
): Promise<PipelineBrief[]> {
  return listPipelineBriefs(opts, db);
}

export async function getBrief(
  id: string,
  db: Firestore = getDb(),
): Promise<PipelineBrief> {
  const brief = await getPipelineBrief(id, db);
  if (!brief) {
    throw new IntakeError('BRIEF_NOT_FOUND', `no brief with id ${id}`, { briefId: id });
  }
  return brief;
}

export async function updateBriefScore(
  id: string,
  score: BriefScore,
  rationale?: string,
  db: Firestore = getDb(),
): Promise<PipelineBrief> {
  const updated = await patchPipelineBrief(
    id,
    { score, scoringRationale: rationale ?? null },
    db,
  );
  if (!updated) {
    throw new IntakeError('BRIEF_NOT_FOUND', `no brief with id ${id}`, { briefId: id });
  }
  return updated;
}

export async function transitionBriefStage(
  id: string,
  toStage: BriefStage,
  db: Firestore = getDb(),
): Promise<PipelineBrief> {
  const brief = await getBrief(id, db);
  if (!isAllowedBriefStageTransition(brief.stage, toStage)) {
    throw new IntakeError(
      'INVALID_STAGE_TRANSITION',
      `cannot transition brief ${id} from ${brief.stage} to ${toStage}`,
      { briefId: id, detail: { from: brief.stage, to: toStage } },
    );
  }
  const updated = await patchPipelineBrief(id, { stage: toStage }, db);
  if (!updated) {
    throw new IntakeError('BRIEF_NOT_FOUND', `brief vanished mid-transition: ${id}`, {
      briefId: id,
    });
  }
  return updated;
}

export interface PromoteBriefOptions {
  formatProfileId: string;
  audienceProfileId: string;
  /** Optional override of the per-format default runtime. */
  targetRuntimeSeconds?: number;
  db?: Firestore;
}

export interface PromoteBriefResult {
  planId: string;
  deliverableId: string;
}

/**
 * Promote a vetted brief into a fresh `youtube_advanced` plan. Atomic:
 * the plan + long_form Deliverable are written in a single Firestore batch
 * along with the brief stage advancement.
 *
 * Throws IntakeError on every pre-condition failure. Throws (and rolls back)
 * whatever Firestore raises if the batch commit itself fails.
 */
export async function promoteBriefToPlan(
  briefId: string,
  opts: PromoteBriefOptions,
): Promise<PromoteBriefResult> {
  const db = opts.db ?? getDb();

  // ---- Pre-condition checks (fail fast before any writes) -----------------

  const brief = await getBrief(briefId, db);
  if (brief.promotedPlanId) {
    throw new IntakeError(
      'BRIEF_ALREADY_PROMOTED',
      `brief ${briefId} already promoted to plan ${brief.promotedPlanId}`,
      { briefId, detail: { existingPlanId: brief.promotedPlanId } },
    );
  }
  if (!brief.score) {
    throw new IntakeError(
      'BRIEF_MISSING_SCORE',
      `brief ${briefId} has no score — score before promoting`,
      { briefId },
    );
  }

  // Validate format profile (cheap synchronous lookup).
  let formatProfile;
  try {
    formatProfile = getFormatProfile(opts.formatProfileId);
  } catch (err) {
    if (err instanceof FormatProfileNotFoundError) {
      throw new IntakeError(
        'UNKNOWN_FORMAT_PROFILE',
        `unknown format profile: ${opts.formatProfileId}`,
        { briefId, detail: { formatProfileId: opts.formatProfileId } },
      );
    }
    throw err;
  }

  // Validate audience profile (Neurocore round-trip).
  try {
    await getAudienceProfileClient().get(opts.audienceProfileId);
  } catch (err) {
    if (err instanceof AudienceProfileNotFoundError) {
      throw new IntakeError(
        'UNKNOWN_AUDIENCE_PROFILE',
        `unknown audience profile: ${opts.audienceProfileId}`,
        { briefId, detail: { audienceProfileId: opts.audienceProfileId } },
      );
    }
    // Other Neurocore errors (timeout, 5xx) bubble up — caller surfaces them.
    throw err;
  }

  // ---- Build doc payloads -------------------------------------------------

  const now = new Date();
  const planId = makeId('plan');

  // Use the format profile's midpoint runtime if Rick didn't override.
  const [minRuntime, maxRuntime] = formatProfile.runtimeRange;
  const targetRuntimeSeconds =
    opts.targetRuntimeSeconds ?? Math.round((minRuntime + maxRuntime) / 2);

  const planDoc = {
    type: 'youtube_advanced' as const,
    status: 'awaiting_review' as const,
    title: brief.title,
    sourceListingId: null,
    sourceListingText: null,
    requirements: [],
    matchedProjects: [],
    targetRuntimeSeconds,
    estimatedRuntimeSeconds: 0,
    userConstraints: null,
    createdAt: now,
    updatedAt: now,
    exportedAt: null,
    // v2 fields
    formatProfileId: opts.formatProfileId,
    pipelineBriefId: briefId,
    workspacePath: null,
    selectedHookVariantId: null,
    selectedTitleVariantId: null,
    selectedThumbnailConceptId: null,
  };

  // Use a fresh deliverable id so we can reference it before the write
  // and return it to the caller.
  const deliverableId = makeId('del');
  const deliverableDoc = {
    planId,
    kind: 'long_form' as const,
    audienceProfileId: opts.audienceProfileId,
    title: brief.title,
    status: 'draft' as const,
    scriptOverrideSceneIds: null,
    customScripts: null,
    selectedTitleVariantId: null,
    selectedThumbnailConceptId: null,
    publishMetadataId: null,
    youtubeUrl: null,
    publishedAt: null,
    createdAt: now,
    updatedAt: now,
  };

  // ---- Atomic batch: plan + deliverable + brief stage advance -------------

  const batch = db.batch();
  batch.set(db.collection('plans').doc(planId), planDoc);
  batch.set(db.collection('deliverables').doc(deliverableId), deliverableDoc);
  batch.update(db.collection('pipeline_briefs').doc(briefId), {
    stage: 'selected',
    promotedPlanId: planId,
    updatedAt: now,
  });

  try {
    await batch.commit();
  } catch (err) {
    logger.error(
      { err, briefId, planId, deliverableId },
      'intake.promote: batch commit failed',
    );
    throw new IntakeError(
      'PERSIST_FAILED',
      `Firestore batch commit failed: ${(err as Error).message}`,
      { briefId, detail: { planId, deliverableId } },
    );
  }

  logger.info(
    {
      briefId,
      planId,
      deliverableId,
      formatProfileId: opts.formatProfileId,
      audienceProfileId: opts.audienceProfileId,
    },
    'intake.promote: brief promoted to plan',
  );

  // Create the on-disk workspace folder. Failure is non-fatal — plan +
  // deliverable are already persisted; Rick can retry from the plan
  // detail UI if WORKSPACE_ROOT was offline.
  try {
    const { createPlanWorkspaceForPlan } = await import('../workspace/service.js');
    const { getPlan } = await import('../db/plans.js');
    const freshPlan = await getPlan(planId, db);
    if (freshPlan) {
      await createPlanWorkspaceForPlan(freshPlan);
    }
  } catch (err) {
    // Don't fail the promote — the workspace module already logs the error.
    logger.warn(
      { briefId, planId, err: (err as Error).message },
      'intake.promote: workspace creation deferred (will retry on plan detail)',
    );
  }

  return { planId, deliverableId };
}

// ---------------------------------------------------------------------------
// Batch intake (v2.1 M25)
// ---------------------------------------------------------------------------

/** Concurrency cap for parallel LLM scoring within one batch. Picked to stay
 *  inside the Claude CLI's per-minute rate envelope without serializing. */
const BATCH_SCORING_CONCURRENCY = 3;

export interface CreateBriefBatchInput {
  briefs: PipelineBriefCreate[];
}

export interface CreateBriefBatchResult {
  batchId: string;
  briefs: PipelineBrief[];
}

/**
 * Persist N briefs in one atomic Firestore batch with a shared `batchId`,
 * then kick off LLM scoring asynchronously (capped at
 * BATCH_SCORING_CONCURRENCY parallel calls). Returns immediately after the
 * persist — scoring continues in the background; clients poll
 * /intake/batch/:batchId for live progress.
 *
 * Persist-first semantics: even if every LLM call fails, the brief docs
 * are already in Firestore. Rick can re-score individually from the row.
 */
export async function createBriefBatchWithScoring(
  input: CreateBriefBatchInput,
  db: Firestore = getDb(),
): Promise<CreateBriefBatchResult> {
  if (input.briefs.length === 0) {
    throw new Error('batch must contain at least one brief');
  }
  const batchId = `batch_${randomUUID().replace(/-/g, '')}`;
  const persisted = await createBriefBatch(input.briefs, batchId, db);

  // Fire-and-forget scoring. We intentionally don't await — the route
  // returns immediately and the client polls. Scoring errors get logged
  // and surface in the per-row score=null state.
  void scoreBriefBatchInBackground(persisted, db);

  logger.info(
    { batchId, count: persisted.length },
    'intake.batch: persisted, scoring queued',
  );
  return { batchId, briefs: persisted };
}

/**
 * Score a batch of briefs in parallel with a concurrency cap. Each per-brief
 * failure is logged and isolated — one bad brief doesn't break the rest.
 *
 * Exported for tests; in production the only caller is
 * `createBriefBatchWithScoring`.
 */
export async function scoreBriefBatchInBackground(
  briefs: PipelineBrief[],
  db: Firestore = getDb(),
  opts: { concurrency?: number } = {},
): Promise<void> {
  const concurrency = opts.concurrency ?? BATCH_SCORING_CONCURRENCY;
  const queue = [...briefs];
  const workers: Array<Promise<void>> = [];

  const worker = async (): Promise<void> => {
    while (queue.length > 0) {
      const next = queue.shift();
      if (!next) return;
      try {
        await scoreBriefViaLLM(next.id, { db });
      } catch (err) {
        logger.warn(
          { briefId: next.id, batchId: next.batchId, err: (err as Error).message },
          'intake.batch: per-brief scoring failed; row remains unscored',
        );
      }
    }
  };

  for (let i = 0; i < concurrency; i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
}

/**
 * List all briefs in a batch, in insertion order. Used by the batch overview
 * page.
 */
export async function getBriefBatch(
  batchId: string,
  db: Firestore = getDb(),
): Promise<PipelineBrief[]> {
  return listBriefsByBatchId(batchId, db);
}

// Re-export for ergonomic imports by route handlers.
export type { BriefSort };
