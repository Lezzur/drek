import type { Firestore } from 'firebase-admin/firestore';
import type { LLMProvider } from '../providers/index.js';
import type { NeurocoreClient } from '../neurocore/index.js';
import { getPlan } from '../db/plans.js';
import { PlanningEngineError } from './errors.js';
import { detectRequirements, type DetectRequirementsResult } from './detect-requirements.js';
import { matchProjects, type MatchProjectsResult } from './match-projects.js';
import { generatePlanContent } from './write-scripts.js';
import type { GenerateScenesResult } from './generate-scenes.js';
import type { WriteScriptsResult } from './write-scripts.js';

interface RunPipelineOptions {
  provider?: LLMProvider;
  client?: NeurocoreClient;
  db?: Firestore;
  timeoutMs?: number;
}

export interface RunPipelineResult {
  requirementsResult: DetectRequirementsResult | null;
  matchResult: MatchProjectsResult;
  scenesResult: GenerateScenesResult | null;
  scriptsResult: WriteScriptsResult;
}

/**
 * Full pipeline in one chain: detect requirements → match projects →
 * generate scenes + scripts.
 *
 * The requirements step runs whenever the plan is still at awaiting_review,
 * regardless of type — detectRequirements self-dispatches by plan.type
 * (v1 cover_letter path / v2 youtube_advanced brief path) and advances the
 * plan to requirements_reviewed, which is the only legal predecessor of
 * projects_matched. Plans that already enter at requirements_reviewed
 * (e.g. youtube_lite, whose intake form sets that status) skip straight to
 * matching.
 */
export async function runPipeline(
  planId: string,
  opts: RunPipelineOptions = {},
): Promise<RunPipelineResult> {
  const plan = await getPlan(planId, opts.db);
  if (!plan) {
    throw new PlanningEngineError(
      'run-pipeline',
      'PLAN_NOT_FOUND',
      `no plan with id ${planId}`,
      { planId },
    );
  }

  const requirementsResult =
    plan.status === 'awaiting_review' ? await detectRequirements(planId, opts) : null;

  const matchResult = await matchProjects(planId, opts);
  const { scenesResult, scriptsResult } = await generatePlanContent(planId, opts);

  return { requirementsResult, matchResult, scenesResult, scriptsResult };
}
