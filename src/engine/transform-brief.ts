import type { Firestore } from 'firebase-admin/firestore';
import { z } from 'zod';
import { logger } from '../logger.js';
import { getLLMProvider, LLMProviderError, type LLMProvider } from '../providers/index.js';
import {
  getPipelineBrief,
  patchPipelineBrief,
} from '../db/pipeline-briefs.js';
import {
  pinnedTechStackSchema,
  transformedBuildPlanSchema,
  type BriefScore,
  type PinnedTechStack,
  type PipelineBrief,
  type TransformedBuildPlan,
} from '../db/schemas.js';
import { extractJson } from './json-utils.js';
import {
  getTechStackProfileClient,
  type TechStackProfile,
} from '../neurocore/tech-stacks.js';
import {
  getAudienceProfileClient,
  type AudienceProfile,
} from '../neurocore/audience-profiles.js';
import {
  getStackPerformanceClient,
  type StackPerformance,
} from '../neurocore/stack-performance.js';
import { IntakeError } from '../intake/errors.js';

/**
 * Brief Transformer v2 (M29-redo).
 *
 * Replaces the original "narrative rewrite" transformer with a
 * build-plan extractor. Per Rick + Lisa's spec discussion 2026-05-21:
 *
 *   Input:  a scored brief that meets a minimum technical fit
 *           (scopeFit >= 3.0 AND audienceMatch >= 3.0).
 *   Output: a structured build plan — goal, finalProduct, toolchain
 *           (given + assumed tools), step-by-step build instructions,
 *           and shot hints for the camera. Plus the pinned tech stack
 *           validated against the Neurocore registry.
 *
 * Why this changed: the old transformer rewrote framing but didn't
 * change what was buildable. The new one extracts buildable structure
 * from a strong-fit brief so Rick can review the plan before promoting
 * to a YouTube plan + recording.
 *
 * Failure semantics: retry-once on bad JSON or invalid tech-stack
 * pick; IntakeError after second failure. Brief stays unchanged on
 * any failure path.
 */

const STEP_NAME = 'transform-brief';
const DEFAULT_TIMEOUT_MS = 90_000;
const TARGET_AUDIENCE_ID = 'developer_longform';

export interface TransformBriefOptions {
  provider?: LLMProvider;
  db?: Firestore;
  timeoutMs?: number;
}

export interface TransformBriefResult {
  brief: PipelineBrief;
  retried: boolean;
  durationMs: number;
}

/**
 * Gate: a brief is transformable iff it meets a minimum technical fit.
 * No narrative-axis check — the new transformer extracts build steps
 * regardless of how the brief is framed, so visualOutcome/storyPotential
 * are irrelevant to whether the transform CAN happen (they're still
 * relevant to whether the topic is worth recording, but that's a human
 * judgment call now, not a gate).
 */
export function isTransformable(score: BriefScore): boolean {
  return score.scopeFit >= 3.0 && score.audienceMatch >= 3.0;
}

const llmTransformSchema = z.object({
  goal: z.string().min(20).max(800),
  finalProduct: z.string().min(20).max(800),
  toolchain: z
    .array(
      z.object({
        name: z.string().min(1).max(120),
        role: z.string().min(1).max(300),
        source: z.enum(['given', 'assumed']),
      }),
    )
    .min(1)
    .max(8),
  buildSteps: z
    .array(
      z.object({
        title: z.string().min(1).max(200),
        description: z.string().min(1).max(800),
        estimatedMinutes: z.number().int().min(1).max(240),
      }),
    )
    .min(3)
    .max(12),
  shotHints: z.array(z.string().min(5).max(200)).min(3).max(12),
  pinnedTechStack: pinnedTechStackSchema,
});
type LLMTransformOutput = z.infer<typeof llmTransformSchema>;

const SYSTEM_HEADER = `You are turning a freelance/client brief into a buildable plan for a YouTube "build along with Claude Code" video.

The brief tells you WHAT the client wants and (usually) which one tool they require. Your job is to extract the latent BUILD: the goal, the final demo state, the full toolchain (including tools the brief didn't name but the build obviously needs), the step-by-step instructions, and the shots that step list implies.

OUTPUT FORMAT — return a SINGLE JSON object:
{
  "goal": "<one paragraph: what we're building and the business outcome it delivers>",
  "finalProduct": "<one paragraph: what the viewer sees working at the end — the 10-second wow shot>",
  "toolchain": [
    { "name": "<Tool name>", "role": "<what role it plays>", "source": "given" | "assumed" },
    ...
  ],
  "buildSteps": [
    { "title": "<short imperative title>", "description": "<what gets built in this step>", "estimatedMinutes": <int 1-240> },
    ...  3 to 12 steps total
  ],
  "shotHints": [
    "<short directive: 'open Vapi dashboard, point to call-flow editor'>",
    ...  3 to 12 hints total
  ],
  "pinnedTechStack": {
    "primary": "<tech_<slug> from the catalog below>",
    "supporting": ["<tech_<slug>>", "..."],
    "rationale": "<1-3 sentences on why this stack is the right pick>"
  }
}

RULES:
- Tech-stack ids in pinnedTechStack MUST exist in the catalog below. Inventing a slug → invalid output → retry.
- toolchain entries: mark "given" when the brief explicitly names the tool, "assumed" when you're filling in what the build obviously needs. The brief is allowed to give one tool (e.g., "Vapi") and you fill in the rest.
- buildSteps must be Claude-Code-executable. Each step should describe an actionable build chunk (not "discuss" or "consider"). estimatedMinutes is your honest guess.
- shotHints describe what the camera should be on during the build — UI screens, terminal output, live demo moments. They don't need to map 1:1 to buildSteps.
- The total estimated build time (sum of estimatedMinutes) should be 60-240 minutes — a 2-to-4-hour Claude Code session. Adjust step granularity to hit that envelope.
- Output JSON ONLY. No fences, no prose. Start with { and end with }.`;

function buildPrompt(
  brief: PipelineBrief,
  rawScore: BriefScore,
  audience: AudienceProfile,
  techStacks: TechStackProfile[],
  channelHistory: StackPerformance[],
): string {
  const catalog = techStacks
    .map(
      (t) =>
        `  ${t.id} — ${t.name} [${t.category}, ${t.popularityTier}]\n    filmable: ${t.filmableNotes}\n    use-cases: ${t.exampleUseCases.slice(0, 3).join(' · ')}`,
    )
    .join('\n');

  const audienceBlock = [
    `AUDIENCE — ${audience.name}`,
    `Persona: ${audience.watchPersona}`,
    `Pain points: ${audience.painPoints.join(' · ')}`,
    `Voice: ${audience.voiceGuidelines.tone}; ${audience.voiceGuidelines.vocabulary}`,
  ].join('\n');

  const scoreBlock = `BRIEF SCORES (informational — gate already passed):
  visualOutcome:  ${rawScore.visualOutcome}/5
  storyPotential: ${rawScore.storyPotential}/5
  scopeFit:       ${rawScore.scopeFit}/5
  audienceMatch:  ${rawScore.audienceMatch}/5`;

  const historyBlock = buildChannelHistoryBlock(channelHistory, techStacks);

  return [
    SYSTEM_HEADER,
    '',
    audienceBlock,
    '',
    'TECH STACK CATALOG (pick primary + supporting ONLY from this list):',
    catalog,
    '',
    historyBlock,
    '',
    scoreBlock,
    '',
    `BRIEF TITLE: ${brief.title}`,
    brief.company ? `COMPANY: ${brief.company}` : null,
    '',
    'RAW BRIEF:',
    brief.rawText,
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
}

function buildChannelHistoryBlock(
  history: StackPerformance[],
  techStacks: TechStackProfile[],
): string {
  if (history.length === 0) {
    return [
      'CHANNEL HISTORY (inform, don\'t avoid):',
      '  (no data yet — pick the best technical fit; coverage rotation activates after the first published video).',
    ].join('\n');
  }
  const tierById = new Map(techStacks.map((t) => [t.id, t.popularityTier]));
  const lines = history
    .slice()
    .sort((a, b) => b.avgViews - a.avgViews)
    .slice(0, 10)
    .map((h) => {
      const tier = tierById.get(h.techStackProfileId) ?? 'unknown';
      const views = Math.round(h.avgViews);
      const ctr = h.avgCtr.toFixed(1);
      return `  ${h.techStackProfileId}: ${h.videoCount} videos, avg ${views} views, ${ctr}% CTR — ${tier}`;
    });
  return [
    'CHANNEL HISTORY (inform, don\'t avoid):',
    ...lines,
    '',
    "TIE-BREAK RULE: When two stacks fit equally, prefer the one with fewer videos UNLESS it's marked 'niche' — for niche stacks, always weigh against view counts. Never penalize a mainstream stack for being popular.",
  ].join('\n');
}

type ParseOutcome =
  | { ok: true; value: LLMTransformOutput }
  | { ok: false; reason: string; detail?: unknown };

function tryParse(raw: string): ParseOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(raw));
  } catch (err) {
    return { ok: false, reason: 'not valid JSON', detail: (err as Error).message };
  }
  const v = llmTransformSchema.safeParse(parsed);
  if (!v.success) {
    return { ok: false, reason: 'schema mismatch', detail: v.error.flatten() };
  }
  return { ok: true, value: v.data };
}

function validateTechStack(
  picked: PinnedTechStack,
  registry: TechStackProfile[],
): { valid: true } | { valid: false; reason: string } {
  const knownIds = new Set(registry.map((t) => t.id));
  if (!knownIds.has(picked.primary)) {
    return {
      valid: false,
      reason: `primary tech stack "${picked.primary}" is not in the active catalog`,
    };
  }
  for (const sid of picked.supporting) {
    if (!knownIds.has(sid)) {
      return {
        valid: false,
        reason: `supporting tech stack "${sid}" is not in the active catalog`,
      };
    }
  }
  return { valid: true };
}

export async function transformBrief(
  briefId: string,
  opts: TransformBriefOptions = {},
): Promise<TransformBriefResult> {
  const t0 = Date.now();
  const provider = opts.provider ?? (await getLLMProvider());
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const brief = await getPipelineBrief(briefId, opts.db);
  if (!brief) {
    throw new IntakeError(
      'BRIEF_NOT_FOUND',
      `no brief with id ${briefId}`,
      { briefId },
    );
  }
  if (!brief.score) {
    throw new IntakeError(
      'BRIEF_MISSING_SCORE',
      'brief must be scored before it can be transformed',
      { briefId },
    );
  }
  if (!isTransformable(brief.score)) {
    throw new IntakeError(
      'INVALID_OUTPUT',
      `brief is not transformable: scopeFit=${brief.score.scopeFit}, audienceMatch=${brief.score.audienceMatch}. Gate requires BOTH technical axes >= 3.0.`,
      { briefId },
    );
  }

  const [techStacks, audience, channelHistory] = await Promise.all([
    getTechStackProfileClient().list({ status: 'active' }),
    getAudienceProfileClient().get(TARGET_AUDIENCE_ID),
    loadChannelHistoryBestEffort(),
  ]);

  if (techStacks.length === 0) {
    throw new IntakeError(
      'INVALID_OUTPUT',
      'tech-stack catalog is empty — run the Neurocore seed script before transforming briefs',
      { briefId },
    );
  }

  const prompt = buildPrompt(brief, brief.score, audience, techStacks, channelHistory);

  let result: LLMTransformOutput;
  let retried = false;

  try {
    const llmOutput = await provider.generate(prompt, { timeoutMs });
    const parsed = tryParse(llmOutput);

    if (parsed.ok) {
      const techCheck = validateTechStack(parsed.value.pinnedTechStack, techStacks);
      if (techCheck.valid) {
        result = parsed.value;
      } else {
        retried = true;
        const stricter = `${prompt}\n\nIMPORTANT: ${techCheck.reason}. Pick from the catalog above. Respond with ONLY valid JSON.`;
        const llm2 = await provider.generate(stricter, { timeoutMs });
        const parsed2 = tryParse(llm2);
        if (!parsed2.ok) {
          throw new IntakeError(
            'INVALID_OUTPUT',
            `LLM output did not parse after retry: ${parsed2.reason}`,
            { briefId, detail: parsed2.detail },
          );
        }
        const techCheck2 = validateTechStack(parsed2.value.pinnedTechStack, techStacks);
        if (!techCheck2.valid) {
          throw new IntakeError(
            'INVALID_OUTPUT',
            `LLM picked invalid tech stack after retry: ${techCheck2.reason}`,
            { briefId },
          );
        }
        result = parsed2.value;
      }
    } else {
      retried = true;
      const stricter = `${prompt}\n\nIMPORTANT: Your previous response was not parseable as JSON matching the required schema (${parsed.reason}). Respond with ONLY a JSON object — no fences, no prose. Start with { and end with }.`;
      const llm2 = await provider.generate(stricter, { timeoutMs });
      const parsed2 = tryParse(llm2);
      if (!parsed2.ok) {
        throw new IntakeError(
          'INVALID_OUTPUT',
          `LLM output did not parse after retry: ${parsed2.reason}`,
          { briefId, detail: parsed2.detail },
        );
      }
      const techCheck2 = validateTechStack(parsed2.value.pinnedTechStack, techStacks);
      if (!techCheck2.valid) {
        throw new IntakeError(
          'INVALID_OUTPUT',
          `LLM picked invalid tech stack after retry: ${techCheck2.reason}`,
          { briefId },
        );
      }
      result = parsed2.value;
    }
  } catch (err) {
    if (err instanceof IntakeError) throw err;
    if (err instanceof LLMProviderError) {
      throw new IntakeError(
        'LLM_FAILED',
        `LLM call failed: ${err.message}`,
        { briefId, detail: { code: err.code } },
      );
    }
    throw err;
  }

  const pinnedTechStack = pinnedTechStackSchema.parse(result.pinnedTechStack);
  const transformedBuildPlan: TransformedBuildPlan = transformedBuildPlanSchema.parse({
    goal: result.goal,
    finalProduct: result.finalProduct,
    toolchain: result.toolchain,
    buildSteps: result.buildSteps,
    shotHints: result.shotHints,
  });

  let updated: PipelineBrief | null;
  try {
    updated = await patchPipelineBrief(
      briefId,
      {
        pinnedTechStack,
        transformedBuildPlan,
      },
      opts.db,
    );
  } catch (err) {
    throw new IntakeError(
      'PERSIST_FAILED',
      `failed to persist transformed brief: ${(err as Error).message}`,
      { briefId },
    );
  }
  if (!updated) {
    throw new IntakeError(
      'BRIEF_NOT_FOUND',
      `brief disappeared mid-transform: ${briefId}`,
      { briefId },
    );
  }

  const durationMs = Date.now() - t0;
  const totalEstimateMinutes = transformedBuildPlan.buildSteps.reduce(
    (sum, s) => sum + s.estimatedMinutes,
    0,
  );
  logger.info(
    {
      step: STEP_NAME,
      briefId,
      pinnedTechStack: pinnedTechStack.primary,
      retried,
      buildStepCount: transformedBuildPlan.buildSteps.length,
      totalEstimateMinutes,
      durationMs,
    },
    'brief transformed (M29-redo: build plan extracted)',
  );

  return {
    brief: updated,
    retried,
    durationMs,
  };
}

/**
 * Channel-history loader. Returns the StackPerformance list, or
 * an empty array when Neurocore is unreachable / hasn't been seeded yet.
 * Best-effort: never blocks a transform on history availability.
 */
async function loadChannelHistoryBestEffort(): Promise<StackPerformance[]> {
  try {
    return await getStackPerformanceClient().list();
  } catch (err) {
    logger.warn(
      { err: (err as Error).message },
      'transform-brief: stack-performance fetch failed, prompting with empty history',
    );
    return [];
  }
}
