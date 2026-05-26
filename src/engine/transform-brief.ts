import type { Firestore } from 'firebase-admin/firestore';
import { z } from 'zod';
import { logger } from '../logger.js';
import { getLLMProvider, LLMProviderError, type LLMProvider } from '../providers/index.js';
import {
  getPipelineBrief,
  patchPipelineBrief,
} from '../db/pipeline-briefs.js';
import {
  buildPhaseSchema,
  pinnedTechStackSchema,
  transformedBuildPlanSchema,
  type BriefScore,
  type BuildPhase,
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
import { getLLMSettings } from '../db/llm-settings.js';
import { critiquePlan, type CritiqueFinding as CriticFinding } from './critique-plan.js';
import { revisePlan } from './revise-plan.js';
import { listCriteriaIds } from './critique-criteria.js';
import {
  persistFindings,
  markAppliedByRevisor,
  deleteFindingsByBriefId,
} from '../db/critique-findings.js';
import type { CritiqueFinding } from '../db/schemas.js';

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
// M35.2: bumped from 90s -> 240s. The phased-build prompt is ~5x the
// pre-M35 size (catalog + audience + history + phase rules + raw brief),
// and claude-sonnet-4-6 was consistently timing out at 90s on Rick's
// host (~145s wall time before SIGKILL, both retries). 240s gives the
// model real headroom; the retry path then has 480s total budget.
const DEFAULT_TIMEOUT_MS = 240_000;
const TARGET_AUDIENCE_ID = 'developer_longform';

export interface TransformBriefOptions {
  provider?: LLMProvider;
  db?: Firestore;
  timeoutMs?: number;
  /** M36: explicit override for the critique toggle. When undefined, falls
   *  back to getLLMSettings(). Tests inject `false` to skip the critique
   *  path without needing a real settings doc / GCP env. */
  useCritique?: boolean;
}

export interface TransformBriefResult {
  brief: PipelineBrief;
  retried: boolean;
  durationMs: number;
  /** M36: critique meta. critiqueRan=false means the critic was disabled
   *  via settings OR it errored out (the draft plan shipped unchanged). */
  critiqueRan: boolean;
  /** Persisted findings (status=unresolved for ones the revisor didn't
   *  apply, applied_by_revisor for ones it did). Empty when critique
   *  didn't run or the plan passed every criterion. */
  findings: CritiqueFinding[];
  /** Number of findings the revisor incorporated into the final plan. */
  revisorAppliedCount: number;
  /** When the critic ran but the revisor failed, this records why so
   *  the UI can surface "critique findings unresolved". */
  revisorReason: string | null;
}

/**
 * Gate: a brief is transformable iff
 *   - audienceMatch >= 3.0  (must have a real audience)
 *   - scopeFit >= 2.0       (sanity floor — rejects "build me a startup")
 *
 * Multi-day briefs (scopeFit = 2) are NOW allowed: the transformer
 * splits them into 2-5 phases, each phase becoming one video in a
 * series. Pre-M35 the gate was scopeFit >= 3.0 (single-session only).
 *
 * visualOutcome/storyPotential are not gated — they're a human
 * judgment about whether the topic is worth recording, separate from
 * whether the transform CAN happen.
 */
export function isTransformable(score: BriefScore): boolean {
  return score.audienceMatch >= 3.0 && score.scopeFit >= 2.0;
}

/**
 * Per-axis breakdown of why a brief failed the gate. Returned alongside
 * isTransformable so the UI can render specific "Blocked: scope" /
 * "Blocked: audience" badges with a hover-title explaining the rule.
 */
export function transformableReason(score: BriefScore): {
  ok: boolean;
  failedAxes: Array<'scopeFit' | 'audienceMatch'>;
} {
  const failed: Array<'scopeFit' | 'audienceMatch'> = [];
  if (score.scopeFit < 2.0) failed.push('scopeFit');
  if (score.audienceMatch < 3.0) failed.push('audienceMatch');
  return { ok: failed.length === 0, failedAxes: failed };
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
  phases: z.array(buildPhaseSchema).min(1).max(5),
  pinnedTechStack: pinnedTechStackSchema,
});
type LLMTransformOutput = z.infer<typeof llmTransformSchema>;

const SYSTEM_HEADER = `You are turning a freelance/client brief into a buildable plan for a YouTube "build along with Claude Code" video series.

The brief tells you WHAT the client wants and (usually) which one tool they require. Your job is to extract the latent BUILD: the goal, the final demo state, the full toolchain (including tools the brief didn't name but the build obviously needs), and the build broken into PHASES — each phase is one recordable video.

A PHASE is one demoable milestone. The viewer should be able to watch a single phase video and see something working at the end of it. A phase has its own goal, its own step-by-step build instructions, and its own shot hints.

PHASE COUNT GUIDANCE:
- If the total build is ≤ 4 hours of focused work: emit ONE phase (single-video build).
- If the total build is 4-12 hours: emit 2-3 phases.
- If the total build is multi-day (> 12 hours of focused work): emit 3-5 phases.
- NEVER emit a phase that lacks a visible demo at the end ("phase 1: set up project" — bad. "phase 1: working ingest pipeline you can pipe a file through" — good).

OUTPUT FORMAT — return a SINGLE JSON object:
{
  "goal": "<one paragraph: what the whole series is building and the business outcome it delivers>",
  "finalProduct": "<one paragraph: what the viewer sees working at the end of the FINAL phase — the 10-second wow shot>",
  "toolchain": [
    { "name": "<Tool name>", "role": "<what role it plays>", "source": "given" | "assumed" },
    ...
  ],
  "phases": [
    {
      "title": "<short imperative title: 'Wire the ingest pipeline'>",
      "goal": "<one paragraph: what this specific phase produces — the milestone you can demo at the end of this video>",
      "buildSteps": [
        { "title": "<short imperative title>", "description": "<what gets built in this step>", "estimatedMinutes": <int 1-240> },
        ...  2 to 12 steps per phase
      ],
      "shotHints": [
        "<short directive: 'open Vapi dashboard, point to call-flow editor'>",
        ...  2 to 12 hints per phase
      ]
    },
    ...  1 to 5 phases total
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
- Each phase's buildSteps must be Claude-Code-executable. Each step should describe an actionable build chunk (not "discuss" or "consider"). estimatedMinutes is your honest guess.
- Each phase's shotHints describe what the camera should be on during that phase — UI screens, terminal output, live demo moments.
- Each phase should sum to 60-240 minutes of work (a recordable session). Don't pad short phases or stuff a multi-day phase into one video.
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
      `brief is not transformable: scopeFit=${brief.score.scopeFit}, audienceMatch=${brief.score.audienceMatch}. Gate requires scopeFit >= 2.0 AND audienceMatch >= 3.0.`,
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
  // Flatten phases into the legacy top-level fields so existing readers
  // (M33 edit diffing, downstream renderers, Firestore exports) keep
  // working without conditional branches. The phases array remains the
  // canonical structured form for the accordion UI + per-phase promotion.
  const flattenedSteps = result.phases.flatMap((p) => p.buildSteps);
  const flattenedShots = result.phases.flatMap((p) => p.shotHints);
  const draftPlan: TransformedBuildPlan = transformedBuildPlanSchema.parse({
    goal: result.goal,
    finalProduct: result.finalProduct,
    toolchain: result.toolchain,
    buildSteps: flattenedSteps,
    shotHints: flattenedShots,
    phases: result.phases,
  });

  /* ─── M36: production-realism critic + revisor ────────────────────── */
  // useCritique resolution priority:
  //   1. Explicit opts.useCritique (tests / programmatic callers)
  //   2. getLLMSettings().useCritique (UI toggle, defaults true)
  // Resolving from opts first avoids calling getLLMSettings — and its
  // transitive GCP env requirement — in tests that don't need critique.
  const useCritique =
    opts.useCritique !== undefined
      ? opts.useCritique
      : (await getLLMSettings()).useCritique;

  let finalPlan = draftPlan;
  let persistedFindings: CritiqueFinding[] = [];
  let critiqueRan = false;
  let revisorAppliedCount = 0;
  let revisorReason: string | null = null;

  if (useCritique) {
    // Re-transform: wipe any findings tied to the previous draft. They
    // reference an obsolete plan and would mislead the user.
    await deleteFindingsByBriefId(briefId, opts.db);

    const critique = await critiquePlan({
      plan: draftPlan,
      goalSummary: brief.title,
      criteriaIds: listCriteriaIds(),
      provider,
      timeoutMs,
    });

    if (critique.ran) {
      critiqueRan = true;

      if (critique.findings.length > 0) {
        // Persist findings to get canonical Firestore IDs.
        persistedFindings = await persistFindings(
          critique.findings.map((f) => ({
            briefId,
            criterionId: f.criterionId,
            severity: f.severity,
            confidence: f.confidence,
            issue: f.issue,
            suggestedFix: f.suggestedFix,
            stepRef: f.stepRef,
            criteriaVersion: f.criteriaVersion,
            modelUsed: critique.modelUsed,
          })),
          opts.db,
        );

        // Map critic UUIDs → canonical IDs before handing to revisor.
        // Order is preserved by persistFindings (sequential batch).
        const findingsForRevisor: CriticFinding[] = persistedFindings.map((p) => ({
          id: p.id,
          criterionId: p.criterionId,
          severity: p.severity,
          confidence: p.confidence,
          issue: p.issue,
          suggestedFix: p.suggestedFix,
          stepRef: p.stepRef,
          criteriaVersion: p.criteriaVersion,
        }));

        const revise = await revisePlan({
          plan: draftPlan,
          findings: findingsForRevisor,
          provider,
          timeoutMs,
        });

        if (revise.ran) {
          finalPlan = revise.revisedPlan;
          revisorAppliedCount = revise.appliedFindingIds.length;
          if (revise.appliedFindingIds.length > 0) {
            await markAppliedByRevisor(revise.appliedFindingIds, opts.db);
          }
        } else {
          // Revisor failed — keep draft + findings as unresolved.
          revisorReason = revise.reason;
          logger.warn(
            { briefId, reason: revise.reason, findingsCount: persistedFindings.length },
            'transform-brief: revisor unavailable, shipping draft plan with findings unresolved',
          );
        }
      }
    } else {
      logger.warn(
        { briefId, reason: critique.reason },
        'transform-brief: critique unavailable, shipping draft plan unchanged',
      );
    }
  }

  let updated: PipelineBrief | null;
  try {
    updated = await patchPipelineBrief(
      briefId,
      {
        pinnedTechStack,
        transformedBuildPlan: finalPlan,
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
  const totalEstimateMinutes = finalPlan.buildSteps.reduce(
    (sum, s) => sum + s.estimatedMinutes,
    0,
  );
  logger.info(
    {
      step: STEP_NAME,
      briefId,
      pinnedTechStack: pinnedTechStack.primary,
      retried,
      phaseCount: finalPlan.phases?.length ?? 1,
      buildStepCount: finalPlan.buildSteps.length,
      totalEstimateMinutes,
      critiqueRan,
      findingsCount: persistedFindings.length,
      revisorAppliedCount,
      revisorReason,
      durationMs,
    },
    'brief transformed (M36: critique + revisor integrated)',
  );

  return {
    brief: updated,
    retried,
    durationMs,
    critiqueRan,
    findings: persistedFindings,
    revisorAppliedCount,
    revisorReason,
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
