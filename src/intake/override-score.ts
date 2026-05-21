import type { Firestore } from 'firebase-admin/firestore';
import { logger } from '../logger.js';
import { getNeurocoreClient, type NeurocoreClient } from '../neurocore/client.js';
import { NeurocoreError } from '../neurocore/errors.js';
import { getPipelineBrief, patchPipelineBrief } from '../db/pipeline-briefs.js';
import {
  incrementCounter,
  SCORE_OVERRIDES_KEY,
} from '../db/admin-counters.js';
import {
  briefScoreSchema,
  type BriefScore,
  type PipelineBrief,
} from '../db/schemas.js';
import { IntakeError } from './errors.js';

/**
 * Override-score service (M35).
 *
 * Persists Rick's manual score edits + fires a `score.overridden`
 * learning signal to Neurocore. Highest-value labeled signal in the
 * system — every override is ground truth that the LLM scorer rated
 * a brief incorrectly. Used downstream to detect systematic scorer bias.
 *
 * Signal-send is best-effort; local edit always succeeds.
 */

export interface OverrideScoreOptions {
  db?: Firestore;
  client?: NeurocoreClient;
}

export interface OverrideScoreResult {
  brief: PipelineBrief;
  signalSent: boolean;
  signalError?: string;
}

type AxisName = 'visualOutcome' | 'storyPotential' | 'scopeFit' | 'audienceMatch';
const ALL_AXES: AxisName[] = [
  'visualOutcome',
  'storyPotential',
  'scopeFit',
  'audienceMatch',
];

export async function overrideScore(
  briefId: string,
  editedScore: BriefScore,
  reason: string | undefined,
  rationale: string | null,
  opts: OverrideScoreOptions = {},
): Promise<OverrideScoreResult> {
  const validatedScore = briefScoreSchema.parse(editedScore);

  const brief = await getPipelineBrief(briefId, opts.db);
  if (!brief) {
    throw new IntakeError('BRIEF_NOT_FOUND', `no brief with id ${briefId}`, {
      briefId,
    });
  }

  const originalScore = brief.score;

  let updated: PipelineBrief | null;
  try {
    updated = await patchPipelineBrief(
      briefId,
      { score: validatedScore, scoringRationale: rationale },
      opts.db,
    );
  } catch (err) {
    throw new IntakeError(
      'PERSIST_FAILED',
      `failed to persist score override: ${(err as Error).message}`,
      { briefId },
    );
  }
  if (!updated) {
    throw new IntakeError(
      'BRIEF_NOT_FOUND',
      `brief disappeared mid-override: ${briefId}`,
      { briefId },
    );
  }

  // If there was no prior score (this is the first manual score), there's
  // nothing to "override" — skip the signal but keep the persistence path.
  if (!originalScore) {
    logger.info(
      { briefId },
      'override-score: first-touch manual score (no prior score → no override signal)',
    );
    return { brief: updated, signalSent: false };
  }

  const axesChanged: AxisName[] = ALL_AXES.filter(
    (a) => originalScore[a] !== validatedScore[a],
  );

  // No-op edit (same values, maybe just rationale changed) → no signal.
  if (axesChanged.length === 0) {
    logger.info(
      { briefId },
      'override-score: no-op score edit (only rationale changed → no signal)',
    );
    return { brief: updated, signalSent: false };
  }

  const overriddenAt = new Date().toISOString();
  const client = opts.client ?? getNeurocoreClient();
  let signalSent = false;
  let signalError: string | undefined;
  try {
    await client.sendScoreOverridden({
      briefId,
      originalScore,
      editedScore: validatedScore,
      axesChanged,
      ...(reason && reason.trim().length > 0 ? { reason: reason.trim() } : {}),
      overriddenAt,
    });
    signalSent = true;
  } catch (err) {
    signalError =
      err instanceof NeurocoreError
        ? `${err.code}: ${err.message}`
        : (err as Error).message;
    logger.warn(
      { briefId, signalError },
      'override-score: score.overridden signal failed (non-fatal — local edit succeeded)',
    );
  }

  let overrideCount: number | null = null;
  try {
    overrideCount = await incrementCounter(SCORE_OVERRIDES_KEY, 1, opts.db);
  } catch (err) {
    logger.warn(
      { briefId, err: (err as Error).message },
      'override-score: counter increment failed (non-fatal)',
    );
  }

  logger.info(
    {
      briefId,
      signalSent,
      axesChanged,
      reasonProvided: Boolean(reason && reason.trim().length > 0),
      scoreOverrideCount: overrideCount,
    },
    'score overridden',
  );

  return {
    brief: updated,
    signalSent,
    ...(signalError ? { signalError } : {}),
  };
}
