import { z } from 'zod';
import { logger } from '../logger.js';
import { getPlan, patchPlan } from '../db/plans.js';
import { getLLMProvider, LLMProviderError } from '../providers/index.js';
import { defaultLlmTimeoutMs } from '../engine/llm-timeout.js';
import { extractJson } from '../engine/json-utils.js';
import { PlanningEngineError } from '../engine/errors.js';
import { exaSearch, ResearchUnavailableError } from './exa-client.js';
import { buildArcContext } from './arc-context.js';

const STEP_NAME = 'research-synthesis';

const synthesisOutputSchema = z.object({
  synthesis: z.string().min(1),
  keyInsights: z.array(z.string()).min(1).max(10),
  competitorGaps: z.array(z.string()).min(1).max(10),
  sources: z.array(z.object({
    url: z.string(),
    title: z.string(),
    relevance: z.string(),
  })).max(15),
});

interface RunResearchOptions {
  timeoutMs?: number;
}

export interface RunResearchResult {
  synthesis: string;
  keyInsights: string[];
  competitorGaps: string[];
  sources: { url: string; title: string; relevance: string }[];
  synthesizedAt: Date;
}

export async function runResearch(
  planId: string,
  opts: RunResearchOptions = {},
): Promise<RunResearchResult> {
  const timeoutMs = defaultLlmTimeoutMs(opts.timeoutMs);

  const plan = await getPlan(planId);
  if (!plan) {
    throw new PlanningEngineError(STEP_NAME, 'PLAN_NOT_FOUND', `no plan with id ${planId}`, {
      planId,
    });
  }

  if (plan.type !== 'youtube_advanced') {
    throw new PlanningEngineError(
      STEP_NAME,
      'WRONG_PLAN_TYPE',
      `research only supports youtube_advanced plans, got ${plan.type}`,
      { planId },
    );
  }

  // ---- Step 1: Arc context (soft-fail) ------------------------------------
  const arcContext = await buildArcContext(20);

  // ---- Step 2: Exa.ai search (parallel) -----------------------------------
  let exaResults: Awaited<ReturnType<typeof exaSearch>> = [];
  try {
    const [primary, tutorial] = await Promise.all([
      exaSearch(plan.title, { numResults: 10, type: 'neural' }),
      exaSearch(`${plan.title} tutorial`, { numResults: 5, type: 'neural' }),
    ]);
    exaResults = [...primary, ...tutorial];
  } catch (err) {
    if (err instanceof ResearchUnavailableError) {
      throw new PlanningEngineError(
        STEP_NAME,
        'LLM_FAILED',
        err.message,
        { planId },
      );
    }
    throw err;
  }

  // ---- Step 3: LLM synthesis ("Call 12") ----------------------------------
  const sourcesBlock = exaResults
    .slice(0, 12)
    .map((r, i) =>
      `[${i + 1}] ${r.title}\n    URL: ${r.url}\n    ${r.text.slice(0, 600).replace(/\n+/g, ' ')}`,
    )
    .join('\n\n');

  const prompt = [
    'You are a content-strategy researcher for a YouTube channel.',
    '',
    'TASK: Synthesize the search results below into a research brief for a new episode.',
    '',
    `EPISODE TITLE: ${plan.title}`,
    '',
    arcContext ? arcContext + '\n' : '',
    'SEARCH RESULTS (competitor and trending content):',
    sourcesBlock,
    '',
    'Produce a research brief as a JSON object with this exact shape:',
    '{',
    '  "synthesis": "<2-4 sentence summary of the content landscape — what angles exist, what works>",',
    '  "keyInsights": ["<insight 1>", ...],   // 3-7 actionable insights Rick should incorporate',
    '  "competitorGaps": ["<gap 1>", ...],    // 3-5 gaps in existing content this episode can fill',
    '  "sources": [                            // 3-8 most relevant sources from the list above',
    '    { "url": "<url>", "title": "<title>", "relevance": "<one sentence why this matters>" },',
    '    ...',
    '  ]',
    '}',
    '',
    'RULES:',
    '- Output JSON ONLY. No fences, no prose.',
    '- keyInsights and competitorGaps: concrete, specific, actionable. No generic advice.',
    '- Only cite sources that are actually useful for this episode topic.',
  ].join('\n');

  let synthesized: z.infer<typeof synthesisOutputSchema>;

  try {
    const provider = await getLLMProvider();
    const raw = await provider.generate(prompt, { timeoutMs });

    let parsed: unknown;
    try {
      parsed = JSON.parse(extractJson(raw));
    } catch {
      throw new PlanningEngineError(
        STEP_NAME,
        'INVALID_OUTPUT',
        'LLM research synthesis did not return valid JSON',
        { planId },
      );
    }

    const validated = synthesisOutputSchema.safeParse(parsed);
    if (!validated.success) {
      throw new PlanningEngineError(
        STEP_NAME,
        'INVALID_OUTPUT',
        `Research synthesis failed schema validation: ${validated.error.issues[0]?.message ?? 'unknown'}`,
        { planId },
      );
    }
    synthesized = validated.data;
  } catch (err) {
    if (err instanceof PlanningEngineError) throw err;
    if (err instanceof LLMProviderError) {
      throw new PlanningEngineError(
        STEP_NAME,
        'LLM_FAILED',
        `${err.providerName} CLI failed: ${err.message}`,
        { planId, detail: { providerCode: err.code } },
      );
    }
    throw err;
  }

  // ---- Step 4: Persist to plan.researchContext ----------------------------
  const synthesizedAt = new Date();
  const result: RunResearchResult = {
    synthesis: synthesized.synthesis,
    keyInsights: synthesized.keyInsights,
    competitorGaps: synthesized.competitorGaps,
    sources: synthesized.sources,
    synthesizedAt,
  };

  await patchPlan(planId, { researchContext: result });

  logger.info(
    { planId, insightCount: result.keyInsights.length, sourceCount: result.sources.length },
    'research synthesis complete',
  );

  return result;
}
