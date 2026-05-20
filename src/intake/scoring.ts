import type { Firestore } from 'firebase-admin/firestore';
import { z } from 'zod';
import { logger } from '../logger.js';
import { getLLMProvider, LLMProviderError, type LLMProvider } from '../providers/index.js';
import { briefScoreSchema, type BriefScore } from '../db/schemas.js';
import { extractJson } from '../engine/json-utils.js';
import { getPipelineBrief, patchPipelineBrief } from '../db/pipeline-briefs.js';
import { IntakeError } from './errors.js';

/**
 * Call 11 in the v2 pipeline: LLM scoring of a pipeline brief against
 * the four-dimensional rubric. Persists the score + a 1-paragraph
 * rationale to the brief.
 *
 * Pattern mirrors the v1 engine steps: structured-JSON output, retry-once
 * on bad parse, typed IntakeError on failure. LLM timeout is 30s per the
 * tech-spec performance budget for this step.
 */

const STEP_NAME = 'score-brief';
// Real Upwork briefs are dense — 6-8KB of marketing fluff around the actual
// scope. Observed CLI invocations: 22-30s on the happy path, 45-60s when
// the model needs the retry. 60s gives us headroom without dragging out
// batch UX. Tunable via opts.timeoutMs at call sites.
const LLM_TIMEOUT_MS = 60_000;
const MAX_BRIEF_TEXT = 50_000; // hard cap (also enforced by schema on write)

/** What the LLM returns. We compute the aggregate server-side from the
 *  four dimensions rather than trusting the model's arithmetic. */
const llmScoreSchema = z.object({
  visualOutcome: z.number().int().min(1).max(5),
  storyPotential: z.number().int().min(1).max(5),
  scopeFit: z.number().int().min(1).max(5),
  audienceMatch: z.number().int().min(1).max(5),
  rationale: z.string().min(1).max(2_000),
});

const SYSTEM_PROMPT = `You are scoring a job brief for video production potential. The brief comes from a freelance job board (Upwork, Freelancer, etc.). You're scoring whether it would make a good YouTube episode for a "build along with Claude Code" channel.

OUTPUT FORMAT:
Return a single JSON object:
{
  "visualOutcome": <1-5>,
  "storyPotential": <1-5>,
  "scopeFit": <1-5>,
  "audienceMatch": <1-5>,
  "rationale": "<one paragraph explaining the scores, 2-5 sentences>"
}

DIMENSION DEFINITIONS:

visualOutcome (1-5): Will the finished build produce something visually compelling that holds the camera?
  1 = boring backend with no visible output
  3 = some visible artifacts (CLI, JSON, logs)
  5 = stunning live demo (UI, dashboards, real-time data, visible automation)

storyPotential (1-5): Does the brief contain natural narrative arcs?
  1 = flat — a single task with no twists
  3 = a few decision points but no obvious tension
  5 = built-in drama — failure modes, surprising solution, before/after contrast

scopeFit (1-5): Is this completable in a 4-hour Claude Code session?
  1 = weeks/months of work
  3 = 1-2 days of focused work
  5 = clean 2-4 hour build

audienceMatch (1-5): How well does this match a "developer_longform" audience — AI/automation practitioners watching to understand how someone directs Claude Code on real client work?
  1 = wrong tribe (e.g., generic data entry, no AI angle)
  3 = adjacent (e.g., automation but no Claude relevance)
  5 = bullseye (AI integration, agent design, real-time RAG, automation orchestration)

RULES:
- Scores are integers 1-5. No half-scores. No 0 or 6.
- Rationale must justify the specific scores you gave, not generic platitudes.
- If the brief is unclear or thin on detail, score conservatively (favor lower scores) and call out the ambiguity in the rationale.
- Output JSON ONLY. No markdown fences. No prose before or after.

Begin with { and end with }.`;

interface ScoreBriefOptions {
  /** Inject a test provider; production calls omit this. */
  provider?: LLMProvider;
  db?: Firestore;
  timeoutMs?: number;
}

export interface ScoreBriefResult {
  score: BriefScore;
  rationale: string;
  retried: boolean;
  durationMs: number;
}

/**
 * Score a pipeline brief via the active LLM. Persists the score + rationale
 * to the brief document. Throws IntakeError on every failure path.
 */
export async function scoreBriefViaLLM(
  briefId: string,
  opts: ScoreBriefOptions = {},
): Promise<ScoreBriefResult> {
  const t0 = Date.now();
  const db = opts.db;
  const provider = opts.provider ?? (await getLLMProvider());

  const brief = await getPipelineBrief(briefId, db);
  if (!brief) {
    throw new IntakeError(
      'BRIEF_NOT_FOUND',
      `no brief with id ${briefId}`,
      { briefId },
    );
  }

  const briefText = brief.rawText.slice(0, MAX_BRIEF_TEXT);
  const basePrompt = buildPrompt(brief.title, brief.company, briefText);
  let retried = false;

  let parsed: z.infer<typeof llmScoreSchema>;
  try {
    const raw = await invokeLLM(provider, basePrompt, opts.timeoutMs ?? LLM_TIMEOUT_MS);
    const first = tryParseScore(raw);
    if (first.ok) {
      parsed = first.value;
    } else {
      retried = true;
      const stricter = `${basePrompt}\n\nIMPORTANT: Your previous response did not parse as the required JSON object. Respond with ONLY the JSON — no fences, no prose. Start with { and end with }.`;
      const raw2 = await invokeLLM(provider, stricter, opts.timeoutMs ?? LLM_TIMEOUT_MS);
      const second = tryParseScore(raw2);
      if (!second.ok) {
        throw new IntakeError(
          'INVALID_OUTPUT',
          `LLM scoring output did not parse after retry: ${second.reason}`,
          { briefId, detail: second.detail },
        );
      }
      parsed = second.value;
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

  // Compute the aggregate server-side — don't trust the model's arithmetic.
  const aggregate = roundToOneDecimal(
    (parsed.visualOutcome + parsed.storyPotential + parsed.scopeFit + parsed.audienceMatch) /
      4,
  );

  const score: BriefScore = briefScoreSchema.parse({
    visualOutcome: parsed.visualOutcome,
    storyPotential: parsed.storyPotential,
    scopeFit: parsed.scopeFit,
    audienceMatch: parsed.audienceMatch,
    aggregate,
  });

  try {
    await patchPipelineBrief(
      briefId,
      { score, scoringRationale: parsed.rationale },
      db,
    );
  } catch (err) {
    throw new IntakeError(
      'PERSIST_FAILED',
      `Firestore write failed: ${(err as Error).message}`,
      { briefId },
    );
  }

  const durationMs = Date.now() - t0;
  logger.info(
    {
      step: STEP_NAME,
      briefId,
      aggregate,
      retried,
      durationMs,
    },
    'brief scored',
  );

  return { score, rationale: parsed.rationale, retried, durationMs };
}

function buildPrompt(title: string, company: string | null, rawText: string): string {
  const header = company
    ? `BRIEF TITLE: ${title}\nCOMPANY: ${company}\n\nBRIEF TEXT:\n`
    : `BRIEF TITLE: ${title}\n\nBRIEF TEXT:\n`;
  return `${SYSTEM_PROMPT}\n\n${header}${rawText}`;
}

/**
 * Score arbitrary brief text WITHOUT touching Firestore. Used by the
 * Brief Transformer (M29) to re-score the transformed brief in-process.
 *
 * Shape-coupled to `scoreBriefViaLLM` — same prompt, same parse, same
 * retry-once policy. Returns the BriefScore only; no rationale, no
 * persistence.
 */
export async function scoreBriefTextDirect(
  input: { title: string; company: string | null; text: string },
  opts: { provider: LLMProvider; timeoutMs?: number },
): Promise<BriefScore> {
  const provider = opts.provider;
  const timeoutMs = opts.timeoutMs ?? LLM_TIMEOUT_MS;
  const text = input.text.slice(0, MAX_BRIEF_TEXT);
  const basePrompt = buildPrompt(input.title, input.company, text);

  let parsed: z.infer<typeof llmScoreSchema>;
  try {
    const raw = await invokeLLM(provider, basePrompt, timeoutMs);
    const first = tryParseScore(raw);
    if (first.ok) {
      parsed = first.value;
    } else {
      const stricter = `${basePrompt}\n\nIMPORTANT: Your previous response did not parse as the required JSON object. Respond with ONLY the JSON — no fences, no prose. Start with { and end with }.`;
      const raw2 = await invokeLLM(provider, stricter, timeoutMs);
      const second = tryParseScore(raw2);
      if (!second.ok) {
        throw new IntakeError(
          'INVALID_OUTPUT',
          `LLM scoring output did not parse after retry: ${second.reason}`,
          { detail: second.detail },
        );
      }
      parsed = second.value;
    }
  } catch (err) {
    if (err instanceof IntakeError) throw err;
    if (err instanceof LLMProviderError) {
      throw new IntakeError(
        'LLM_FAILED',
        `LLM call failed: ${err.message}`,
        { detail: { code: err.code } },
      );
    }
    throw err;
  }

  const aggregate = roundToOneDecimal(
    (parsed.visualOutcome + parsed.storyPotential + parsed.scopeFit + parsed.audienceMatch) /
      4,
  );
  return briefScoreSchema.parse({
    visualOutcome: parsed.visualOutcome,
    storyPotential: parsed.storyPotential,
    scopeFit: parsed.scopeFit,
    audienceMatch: parsed.audienceMatch,
    aggregate,
  });
}

interface ParseOk {
  ok: true;
  value: z.infer<typeof llmScoreSchema>;
}
interface ParseErr {
  ok: false;
  reason: string;
  detail: unknown;
}

function tryParseScore(raw: string): ParseOk | ParseErr {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(raw));
  } catch (err) {
    return { ok: false, reason: 'not valid JSON', detail: (err as Error).message };
  }
  const result = llmScoreSchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      reason: 'schema mismatch',
      detail: result.error.flatten(),
    };
  }
  return { ok: true, value: result.data };
}

async function invokeLLM(
  provider: LLMProvider,
  prompt: string,
  timeoutMs: number,
): Promise<string> {
  return provider.generate(prompt, { timeoutMs });
}

function roundToOneDecimal(n: number): number {
  return Math.round(n * 10) / 10;
}
