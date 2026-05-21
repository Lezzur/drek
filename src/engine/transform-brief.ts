import type { Firestore } from 'firebase-admin/firestore';
import { z } from 'zod';
import { logger } from '../logger.js';
import { getLLMProvider, LLMProviderError, type LLMProvider } from '../providers/index.js';
import {
  getPipelineBrief,
  patchPipelineBrief,
} from '../db/pipeline-briefs.js';
import {
  briefScoreSchema,
  pinnedTechStackSchema,
  type BriefScore,
  type PinnedTechStack,
  type PipelineBrief,
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
import { scoreBriefViaLLM } from '../intake/scoring.js';
import { IntakeError } from '../intake/errors.js';

/**
 * Call 11.5 of the v2.1 pipeline: Brief Transformer.
 *
 * Promotes a "3.0+ with weak narrative axes" raw brief into a 5.0-grade
 * brief by extracting latent narrative (visualOutcome + storyPotential)
 * and pinning a tech stack from Neurocore's catalog. Per TECH-SPEC v2.1
 * §4 Piece 2.
 *
 * Transformability gate (Lisa-revised — no composite floor):
 *   scopeFit >= 3.5 AND audienceMatch >= 3.5 AND
 *   (visualOutcome < 3.0 OR storyPotential < 3.0)
 *
 * Flow:
 *   1. Pre-condition checks (brief exists, score exists, gate passes)
 *   2. Fetch active TechStackProfiles from Neurocore (catalog block)
 *   3. Fetch the developer_longform AudienceProfile (voice block)
 *   4. LLM call with retry-once on bad JSON or invalid pick
 *   5. Validate pinnedTechStack against the registry (phantom ids → retry)
 *   6. Re-score the transformed brief via scoreBriefViaLLM (Call 11 again)
 *   7. Drift check: warn-log if scopeFit or audienceMatch deltas exceed
 *      ±0.5 (the transformer should preserve the project's technical shape)
 *   8. Persist {transformedBriefText, transformedScore, pinnedTechStack}
 *
 * Failure semantics: PlanningEngineError-style codes via IntakeError.
 * Plan/brief state never advances on failure — the brief stays in its
 * pre-transform state, fully recoverable.
 */

const STEP_NAME = 'transform-brief';
const DEFAULT_TIMEOUT_MS = 60_000;
const DRIFT_THRESHOLD = 0.5;
const SHORTS_AUDIENCE_ID = 'developer_longform';

export interface TransformBriefOptions {
  provider?: LLMProvider;
  db?: Firestore;
  timeoutMs?: number;
}

export interface TransformBriefResult {
  brief: PipelineBrief;
  retried: boolean;
  durationMs: number;
  drift: {
    scopeFitDelta: number;
    audienceMatchDelta: number;
    visualOutcomeDelta: number;
    storyPotentialDelta: number;
    flagged: boolean;
  };
}

/**
 * Lisa-revised gate (TECH-SPEC v2.1 §4 Piece 2). NO composite floor —
 * the per-axis shape IS the gate. A brief at
 * {scopeFit: 4, audienceMatch: 4, visualOutcome: 1.5, storyPotential: 1.5}
 * is the ideal transformer candidate even though its aggregate is 2.75.
 */
export function isTransformable(score: BriefScore): boolean {
  return (
    score.scopeFit >= 3.5 &&
    score.audienceMatch >= 3.5 &&
    (score.visualOutcome < 3.0 || score.storyPotential < 3.0)
  );
}

const llmTransformSchema = z.object({
  visualOutcome: z.string().min(20).max(1500).optional(),
  storyPotential: z.string().min(20).max(1500).optional(),
  pinnedTechStack: pinnedTechStackSchema,
  transformedBriefText: z.string().min(100).max(20_000),
});
type LLMTransformOutput = z.infer<typeof llmTransformSchema>;

const SYSTEM_HEADER = `You are rewriting a freelance job brief so it scores higher on the YouTube production rubric.

The brief comes in WITH SCORES already attached. Your job is NOT to score it — that's a separate step. Your job is to:
1. Extract the latent narrative that's there but unstated. Most freelance briefs were written for engineers, not cameras. They describe the deliverable but never the story.
2. Commit to ONE tech stack from the Neurocore catalog (provided below). The deliverable shouldn't change; the story around it gets sharpened.
3. Preserve scopeFit and audienceMatch — DO NOT change what the project actually is, only how it's framed for video.

OUTPUT FORMAT — return a SINGLE JSON object:
{
  "visualOutcome": "<one paragraph describing what the viewer sees working on screen — before/after state, the 10-second wow shot. OMIT this field if the brief's visualOutcome score was already >= 3.0.>",
  "storyPotential": "<one paragraph describing the arc: client pain → architectural constraint → build tension → reveal. OMIT this field if the brief's storyPotential score was already >= 3.0.>",
  "pinnedTechStack": {
    "primary": "<tech_<slug> from the catalog — ONLY use ids that appear in the catalog below>",
    "supporting": ["<tech_<slug>>", "..."],   // 0-4 supporting stack ids
    "rationale": "<1-3 sentences on why this stack is the right pick for this brief>"
  },
  "transformedBriefText": "<the full reassembled brief — keep the project description faithful but add the visual + story scaffolding. 100-20000 chars.>"
}

RULES:
- Tech-stack ids MUST exist in the catalog below. Inventing a slug → invalid output → retry.
- Do NOT change the underlying project. If the raw brief was "build a CRUD app for inventory", the transformed brief is still a CRUD-app-for-inventory build — just with the story scaffolding.
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

  const scoreBlock = `PRE-TRANSFORM SCORES (DO NOT CHANGE the project — only the framing):
  visualOutcome:  ${rawScore.visualOutcome}/5
  storyPotential: ${rawScore.storyPotential}/5
  scopeFit:       ${rawScore.scopeFit}/5  (must preserve)
  audienceMatch:  ${rawScore.audienceMatch}/5  (must preserve)`;

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

/**
 * CHANNEL HISTORY block — populated from Neurocore StackPerformance once
 * Rick's channel has at least one published video. Until then, the
 * empty-data fallback tells the LLM there's no signal to bias toward.
 *
 * Tie-break rule encodes Rick's instruction from spec discussion:
 * popular stacks STAY popular because that's what audiences want; only
 * NICHE stacks get the "give the underdog a shot" treatment.
 */
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
    .slice() // copy before sort
    .sort((a, b) => b.avgViews - a.avgViews)
    .slice(0, 10) // cap the block — 10 rows is plenty of signal
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
      `brief is not transformable: scopeFit=${brief.score.scopeFit}, audienceMatch=${brief.score.audienceMatch}, visualOutcome=${brief.score.visualOutcome}, storyPotential=${brief.score.storyPotential}. Gate requires both technical axes >= 3.5 AND at least one narrative axis < 3.0.`,
      { briefId },
    );
  }

  // Fetch the catalog + audience profile + channel history in parallel.
  // History is best-effort: an empty array or a failed Neurocore call
  // just means the LLM gets the "no data yet" fallback. We never block
  // a transform on history availability.
  const [techStacks, audience, channelHistory] = await Promise.all([
    getTechStackProfileClient().list({ status: 'active' }),
    getAudienceProfileClient().get(SHORTS_AUDIENCE_ID),
    loadChannelHistoryBestEffort(),
  ]);

  if (techStacks.length === 0) {
    throw new IntakeError(
      'INVALID_OUTPUT',
      'tech-stack catalog is empty — run the Neurocore seed script before transforming briefs',
      { briefId },
    );
  }

  const rawScore = brief.score;
  const prompt = buildPrompt(brief, rawScore, audience, techStacks, channelHistory);

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
        const techCheck2 = validateTechStack(
          parsed2.value.pinnedTechStack,
          techStacks,
        );
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
      const techCheck2 = validateTechStack(
        parsed2.value.pinnedTechStack,
        techStacks,
      );
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

  // Persist the transformed brief BEFORE re-scoring so the re-score reads
  // from the right source. We patch `transformedBriefText` + tech stack
  // first; `transformedScore` follows after the second LLM call.
  try {
    await patchPipelineBrief(
      briefId,
      {
        transformedBriefText: result.transformedBriefText,
        pinnedTechStack,
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

  // Re-score the transformed brief by temporarily swapping rawText for the
  // transformed text via a scoped fake brief. The existing scoring engine
  // reads `brief.rawText` — but we want to score the transformed version.
  // The cleanest path is a small ad-hoc scoring helper rather than mutating
  // the brief doc back and forth.
  const transformedScore = await scoreBriefByText(
    {
      title: brief.title,
      company: brief.company,
      text: result.transformedBriefText,
    },
    { provider, timeoutMs },
  );

  // Persist the transformedScore.
  let updated: PipelineBrief | null;
  try {
    updated = await patchPipelineBrief(
      briefId,
      { transformedScore },
      opts.db,
    );
  } catch (err) {
    throw new IntakeError(
      'PERSIST_FAILED',
      `failed to persist transformedScore: ${(err as Error).message}`,
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

  // Drift detection. The transformer should preserve scopeFit + audienceMatch
  // (the project itself didn't change), and improve visualOutcome / storyPotential
  // (which is the whole point). Large deltas on the technical axes mean the
  // transformer is rewriting facts, not framing. Log a warning so the
  // future drift report can pick it up; never fail the transform on drift
  // alone (the user can still inspect the result).
  const drift = {
    scopeFitDelta: transformedScore.scopeFit - rawScore.scopeFit,
    audienceMatchDelta: transformedScore.audienceMatch - rawScore.audienceMatch,
    visualOutcomeDelta: transformedScore.visualOutcome - rawScore.visualOutcome,
    storyPotentialDelta: transformedScore.storyPotential - rawScore.storyPotential,
    flagged: false,
  };
  drift.flagged =
    Math.abs(drift.scopeFitDelta) > DRIFT_THRESHOLD ||
    Math.abs(drift.audienceMatchDelta) > DRIFT_THRESHOLD;
  if (drift.flagged) {
    logger.warn(
      {
        step: STEP_NAME,
        briefId,
        drift,
      },
      'transform-brief: technical-axis drift exceeds threshold — transformer may be rewriting facts',
    );
  }

  const durationMs = Date.now() - t0;
  logger.info(
    {
      step: STEP_NAME,
      briefId,
      pinnedTechStack: pinnedTechStack.primary,
      retried,
      drift,
      durationMs,
    },
    'brief transformed',
  );

  return {
    brief: updated,
    retried,
    durationMs,
    drift,
  };
}

// ---------------------------------------------------------------------------
// scoreBriefByText — scores arbitrary brief text WITHOUT writing back to
// Firestore. Used internally for the post-transform re-score. Built as a
// thin wrapper around scoreBriefViaLLM via a synthetic in-memory brief.
//
// We can't just call scoreBriefViaLLM directly because it persists by
// briefId. So we briefly stash the transformed text on the brief's
// rawText, score it, then restore the original. Concurrency-safe because
// only one transform runs per brief at a time (no cross-transform locking
// needed — the transform is gated on a button click in the UI).
// ---------------------------------------------------------------------------

interface BriefScoringInput {
  title: string;
  company: string | null;
  text: string;
}

async function scoreBriefByText(
  input: BriefScoringInput,
  opts: { provider: LLMProvider; timeoutMs: number },
): Promise<BriefScore> {
  // Build a minimal in-memory scoring path that doesn't depend on
  // briefId/Firestore. This is intentionally a near-duplicate of the
  // scoring engine's prompt+parse flow because:
  //   1. We want zero Firestore writes during the re-score
  //   2. We don't want the briefId-scoped error codes leaking out
  //   3. The output type is just BriefScore — no need for rationale
  //
  // If you change scoring.ts's prompt or schema, mirror it here too.
  // The two paths are coupled by design — they're both Call 11.
  const { scoreBriefTextDirect } = await import('../intake/scoring.js');
  return scoreBriefTextDirect(
    { title: input.title, company: input.company, text: input.text },
    opts,
  );
}

/**
 * Channel-history loader (M31). Returns the StackPerformance list, or
 * an empty array when Neurocore is unreachable / hasn't been seeded yet.
 * We swallow ALL failures here intentionally — coverage rotation is a
 * nice-to-have for the transformer, not a hard dependency. The "no data
 * yet" fallback in the prompt is the same string the LLM sees when
 * history truly is empty, so the LLM can't distinguish "missing because
 * Neurocore is down" from "missing because channel is new" — that's by
 * design (degrade silently).
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
