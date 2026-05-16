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
 * Full pipeline in one chain: detect requirements (cover letter only) →
 * match projects → generate scenes + scripts.
 *
 * Cover letter plans start at awaiting_review and run all three steps.
 * YouTube plans start at requirements_reviewed and run the final two.
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
    plan.type === 'cover_letter' ? await detectRequirements(planId, opts) : null;

  const matchResult = await matchProjects(planId, opts);
  const { scenesResult, scriptsResult } = await generatePlanContent(planId, opts);

  return { requirementsResult, matchResult, scenesResult, scriptsResult };
}
