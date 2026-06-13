import type { Firestore } from 'firebase-admin/firestore';
import { z } from 'zod';
import { logger } from '../logger.js';
import { getLLMProvider, LLMProviderError, type LLMProvider } from '../providers/index.js';
import { defaultLlmTimeoutMs } from './llm-timeout.js';
import { getPlan, patchPlan } from '../db/plans.js';
import { getPipelineBrief } from '../db/pipeline-briefs.js';
import { findLongFormDeliverable, DeliverableNotFoundError } from '../db/deliverables.js';
import { requirementSchema, isAllowedPlanTransition, type Plan, type Requirement } from '../db/schemas.js';
import { extractJson } from './json-utils.js';
import { PlanningEngineError } from './errors.js';
import { getFormatProfile, FormatProfileNotFoundError } from './format-profiles/index.js';
import { getAudienceProfileClient } from '../neurocore/audience-profiles.js';
import { buildSystemPrompt } from './compose-prompt.js';

/**
 * Call 1 of the four-step planning pipeline: requirement detection.
 *
 * For cover_letter plans: reads `plan.sourceListingText`, asks the active LLM
 * provider to extract a structured list of video-demonstration requirements,
 * validates the result, persists it to the plan, and transitions plan.status
 * to 'requirements_reviewed'.
 *
 * For youtube_advanced plans: reads the pipeline brief, builds a v2 system
 * prompt (format profile + audience profile), asks the LLM to produce a
 * structured episode plan (angle, anti-angle, scope, takeaway, risks), and
 * stores it as a single encoded Requirement. Transitions to
 * 'requirements_reviewed'.
 *
 * On invalid LLM output, retries once with a stricter "JSON only" reminder
 * appended to the prompt. Anything past the retry budget surfaces as
 * INVALID_OUTPUT so the UI can show a "try again" button.
 */

const STEP_NAME = 'detect-requirements';

// Cap listing / brief text we hand to the model. 50 KB is comfortably above
// any realistic brief while leaving room for the system prompt + retry tail
// under the runCli MAX_PROMPT_LEN of 200 KB.
const MAX_LISTING_CHARS = 50_000;

const requirementsArraySchema = z.array(requirementSchema);

// ---------------------------------------------------------------------------
// v1 cover_letter system prompt (kept BYTE-IDENTICAL to the v1 implementation)
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are extracting VIDEO DEMONSTRATION REQUIREMENTS from a freelance job listing for a solo AI consultant (Rick).

Your job: identify what the listing is asking Rick to show on a recorded video — what skills, tools, integrations, or outcomes the hiring side wants to see in action.

OUTPUT FORMAT:
Return a single JSON array. Each element matches:
{
  "skill": "<short noun phrase — what to demonstrate>",
  "category": "<one of: backend, frontend, integration, data, ai-ml, automation, devtool, other>",
  "priority": "<must_show | nice_to_show>",
  "evidence": "<verbatim quote or tight paraphrase from the listing supporting this requirement>"
}

RULES:
- Use "must_show" ONLY when the listing explicitly asks to see it on video / Loom / demo / screen recording, or names it as a hard requirement.
- Use "nice_to_show" for skills/tools that would strengthen the demo but aren't explicitly required.
- Keep "skill" tight (3-8 words). No filler.
- "category" must be exactly one of the listed values, lowercase, with hyphens (e.g., "ai-ml" not "AI/ML").
- "evidence" must come from the listing — don't invent it. A short paraphrase is fine if a verbatim quote is awkward.
- If the listing has no clear demo requirements, return [] (empty array).
- Output JSON ONLY. No markdown fences. No prose before or after. No comments.

Begin with [ and end with ].`;

// ---------------------------------------------------------------------------
// v2 youtube_advanced task instructions + output schema
// ---------------------------------------------------------------------------

const V2_TASK_INSTRUCTIONS = `Analyze the brief and produce a structured episode plan. Return a SINGLE JSON object:
{
  "episodeAngle": "<one sentence — what this episode IS about>",
  "antiAngle": "<one sentence — what this episode is NOT about>",
  "technicalScope": "<2-3 sentences — what gets shown vs deferred>",
  "intendedTakeaway": "<one sentence — viewer outcome>",
  "risksToFlag": ["<short string>", "..."]
}

RULES:
- All fields required. Output JSON ONLY. No fences, no prose.
- Begin with { and end with }.
- risksToFlag: 1-5 items — where the build might go wrong on camera.`;

const episodePlanOutputSchema = z.object({
  episodeAngle: z.string().min(1),
  antiAngle: z.string().min(1),
  technicalScope: z.string().min(1),
  intendedTakeaway: z.string().min(1),
  risksToFlag: z.array(z.string().min(1)).min(1).max(5),
});

interface DetectRequirementsOptions {
  /** Override the active LLM provider. Used by tests; production calls
   *  omit this and pick up the env-configured one. */
  provider?: LLMProvider;
  /** Override the Firestore instance. Used by tests with an in-memory fake. */
  db?: Firestore;
  /** Override the per-call LLM timeout. Defaults to env LLM_TIMEOUT_MS. */
  timeoutMs?: number;
}

export interface DetectRequirementsResult {
  plan: Plan;
  requirements: Requirement[];
  /** True when the LLM had to retry because the first JSON parse failed. */
  retried: boolean;
  /** Wall time across both LLM attempts + persistence. */
  durationMs: number;
}

/**
 * Run requirement detection on a plan. Idempotent in spirit — re-running
 * overwrites the previous requirements (and may transition status if the
 * plan was further along). Throws PlanningEngineError on any failure route.
 *
 * Dispatches to a cover_letter branch (v1, unchanged) or youtube_advanced
 * branch (v2) based on plan.type.
 */
export async function detectRequirements(
  planId: string,
  opts: DetectRequirementsOptions = {},
): Promise<DetectRequirementsResult> {
  const t0 = Date.now();
  const provider = opts.provider ?? await getLLMProvider();
  const timeoutMs = defaultLlmTimeoutMs(opts.timeoutMs);

  // ---- Load plan -------------------------------------------------------
  const plan = await getPlan(planId, opts.db);
  if (!plan) {
    throw new PlanningEngineError(STEP_NAME, 'PLAN_NOT_FOUND', `no plan with id ${planId}`, {
      planId,
    });
  }

  // ---- Dispatch by plan type -------------------------------------------
  if (plan.type === 'cover_letter') {
    return detectRequirementsCoverLetter(planId, plan, provider, timeoutMs, opts, t0);
  }
  if (plan.type === 'youtube_advanced') {
    return detectRequirementsYoutubeAdvanced(planId, plan, provider, timeoutMs, opts, t0);
  }

  throw new PlanningEngineError(
    STEP_NAME,
    'WRONG_PLAN_TYPE',
    `requirement detection does not support plan type ${plan.type}`,
    { planId },
  );
}

// ---------------------------------------------------------------------------
// v1 cover_letter path — BYTE-IDENTICAL logic to original implementation
// ---------------------------------------------------------------------------

async function detectRequirementsCoverLetter(
  planId: string,
  plan: Plan,
  provider: LLMProvider,
  timeoutMs: number,
  opts: DetectRequirementsOptions,
  t0: number,
): Promise<DetectRequirementsResult> {
  if (!plan.sourceListingText || plan.sourceListingText.trim().length === 0) {
    throw new PlanningEngineError(
      STEP_NAME,
      'NO_LISTING_TEXT',
      'plan.sourceListingText is missing — cannot extract requirements',
      { planId },
    );
  }
  if (!isAllowedPlanTransition(plan.status, 'requirements_reviewed')) {
    throw new PlanningEngineError(
      STEP_NAME,
      'DISALLOWED_TRANSITION',
      `cannot transition from ${plan.status} to requirements_reviewed`,
      { planId, detail: { from: plan.status, to: 'requirements_reviewed' } },
    );
  }

  // ---- Call the LLM (with one retry on bad JSON) ---------------------
  const listingText = plan.sourceListingText.slice(0, MAX_LISTING_CHARS);
  const basePrompt = buildPrompt(listingText);
  let retried = false;
  let requirements: Requirement[];

  try {
    const raw = await invokeLLM(provider, basePrompt, timeoutMs);
    const parsed = tryParseRequirements(raw);
    if (parsed.ok) {
      requirements = parsed.value;
    } else {
      // Second attempt with a stricter instruction tacked on. We DO NOT
      // include the model's bad first reply in the prompt — that just
      // gives it the chance to repeat its own mistake.
      retried = true;
      const stricter = `${basePrompt}\n\nIMPORTANT: Your previous response was not parseable as JSON. Respond with ONLY a JSON array — no fences, no prose. Start with [ and end with ].`;
      const raw2 = await invokeLLM(provider, stricter, timeoutMs);
      const parsed2 = tryParseRequirements(raw2);
      if (!parsed2.ok) {
        throw new PlanningEngineError(
          STEP_NAME,
          'INVALID_OUTPUT',
          `LLM output did not parse as a valid Requirement[] after retry: ${parsed2.reason}`,
          { planId, detail: parsed2.detail },
        );
      }
      requirements = parsed2.value;
    }
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

  // ---- Persist requirements + status transition ----------------------
  let updated: Plan | null;
  try {
    updated = await patchPlan(
      planId,
      { requirements, status: 'requirements_reviewed' },
      opts.db,
    );
  } catch (err) {
    throw new PlanningEngineError(
      STEP_NAME,
      'PERSIST_FAILED',
      `failed to persist requirements: ${(err as Error).message}`,
      { planId },
    );
  }
  if (!updated) {
    // Plan vanished between the read and the write — vanishingly unlikely
    // in single-user DREK, but cover it anyway so we don't return a stale Plan.
    throw new PlanningEngineError(
      STEP_NAME,
      'PLAN_NOT_FOUND',
      'plan disappeared during requirement detection',
      { planId },
    );
  }

  const durationMs = Date.now() - t0;
  logger.info(
    {
      planId,
      requirementCount: requirements.length,
      mustShowCount: requirements.filter((r) => r.priority === 'must_show').length,
      retried,
      durationMs,
    },
    'requirement detection complete',
  );
  return { plan: updated, requirements, retried, durationMs };
}

// ---------------------------------------------------------------------------
// v2 youtube_advanced path
// ---------------------------------------------------------------------------

async function detectRequirementsYoutubeAdvanced(
  planId: string,
  plan: Plan,
  provider: LLMProvider,
  timeoutMs: number,
  opts: DetectRequirementsOptions,
  t0: number,
): Promise<DetectRequirementsResult> {
  // ---- Pre-conditions --------------------------------------------------

  if (!plan.formatProfileId) {
    throw new PlanningEngineError(
      STEP_NAME,
      'NO_FORMAT_PROFILE',
      'youtube_advanced plan has no formatProfileId — set one before running detect-requirements',
      { planId },
    );
  }

  let formatProfile;
  try {
    formatProfile = getFormatProfile(plan.formatProfileId);
  } catch (err) {
    if (err instanceof FormatProfileNotFoundError) {
      throw new PlanningEngineError(
        STEP_NAME,
        'NO_FORMAT_PROFILE',
        `formatProfileId "${plan.formatProfileId}" not found in registry`,
        { planId },
      );
    }
    throw err;
  }

  if (!plan.pipelineBriefId) {
    throw new PlanningEngineError(
      STEP_NAME,
      'NO_PIPELINE_BRIEF',
      'youtube_advanced plan has no pipelineBriefId — link a brief before running detect-requirements',
      { planId },
    );
  }

  const brief = await getPipelineBrief(plan.pipelineBriefId, opts.db);
  if (!brief) {
    throw new PlanningEngineError(
      STEP_NAME,
      'NO_PIPELINE_BRIEF',
      `pipelineBriefId "${plan.pipelineBriefId}" not found`,
      { planId },
    );
  }

  // Fetch audience profile from the long_form Deliverable. Fetching here
  // keeps the engine self-contained — the route layer doesn't need to
  // resolve and pass it in.
  let longFormDeliverable;
  try {
    longFormDeliverable = await findLongFormDeliverable(planId, opts.db);
  } catch (err) {
    if (err instanceof DeliverableNotFoundError) {
      throw new PlanningEngineError(
        STEP_NAME,
        'NO_LONG_FORM_DELIVERABLE',
        `no long_form Deliverable found for plan ${planId}`,
        { planId },
      );
    }
    throw err;
  }

  const audienceProfile = await getAudienceProfileClient().get(longFormDeliverable.audienceProfileId);

  if (!isAllowedPlanTransition(plan.status, 'requirements_reviewed')) {
    throw new PlanningEngineError(
      STEP_NAME,
      'DISALLOWED_TRANSITION',
      `cannot transition from ${plan.status} to requirements_reviewed`,
      { planId, detail: { from: plan.status, to: 'requirements_reviewed' } },
    );
  }

  // ---- Build system prompt via compose-prompt v2 path ------------------
  const systemPrompt = buildSystemPrompt({
    formatProfile,
    audienceProfile,
    taskInstructions: V2_TASK_INSTRUCTIONS,
  });

  // User prompt is the raw brief text, capped at 50KB per TECH-SPEC §6.
  const briefText = brief.rawText.slice(0, MAX_LISTING_CHARS);
  const fullPrompt = `${systemPrompt}\n\nPIPELINE BRIEF:\n\n${briefText}`;

  // ---- Call the LLM (with one retry on bad JSON) -----------------------
  let retried = false;
  let episodePlan: z.infer<typeof episodePlanOutputSchema>;

  try {
    const raw = await invokeLLM(provider, fullPrompt, timeoutMs);
    const parsed = tryParseEpisodePlan(raw);
    if (parsed.ok) {
      episodePlan = parsed.value;
    } else {
      retried = true;
      const stricter = `${fullPrompt}\n\nIMPORTANT: Your previous response was not parseable as JSON. Respond with ONLY a JSON object — no fences, no prose. Begin with { and end with }.`;
      const raw2 = await invokeLLM(provider, stricter, timeoutMs);
      const parsed2 = tryParseEpisodePlan(raw2);
      if (!parsed2.ok) {
        throw new PlanningEngineError(
          STEP_NAME,
          'INVALID_OUTPUT',
          `LLM output did not parse as a valid episode plan after retry: ${parsed2.reason}`,
          { planId, detail: parsed2.detail },
        );
      }
      episodePlan = parsed2.value;
    }
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

  // ---- Encode episode plan as a single Requirement and persist ---------
  //
  // v2.1 cleanup item: episodeBrief (the structured episode plan) should be
  // extracted into its own dedicated field on Plan rather than being encoded
  // as a Requirement. For now we embed it in the requirements array using the
  // 'episode_plan' skill so v1 schema can hold it without a migration.
  const requirements: Requirement[] = [
    {
      skill: 'episode_plan',
      category: 'episode_outline',
      priority: 'must_show',
      evidence: JSON.stringify(episodePlan),
    },
  ];

  let updated: Plan | null;
  try {
    updated = await patchPlan(
      planId,
      { requirements, status: 'requirements_reviewed' },
      opts.db,
    );
  } catch (err) {
    throw new PlanningEngineError(
      STEP_NAME,
      'PERSIST_FAILED',
      `failed to persist episode plan requirements: ${(err as Error).message}`,
      { planId },
    );
  }
  if (!updated) {
    throw new PlanningEngineError(
      STEP_NAME,
      'PLAN_NOT_FOUND',
      'plan disappeared during episode plan detection',
      { planId },
    );
  }

  const durationMs = Date.now() - t0;
  logger.info(
    {
      planId,
      planType: 'youtube_advanced',
      retried,
      durationMs,
    },
    'episode plan detection complete',
  );
  return { plan: updated, requirements, retried, durationMs };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function buildPrompt(listingText: string): string {
  return `${SYSTEM_PROMPT}\n\nJOB LISTING:\n\n${listingText}`;
}

async function invokeLLM(
  provider: LLMProvider,
  prompt: string,
  timeoutMs: number,
): Promise<string> {
  return provider.generate(prompt, { timeoutMs });
}

type ParseOutcome =
  | { ok: true; value: Requirement[] }
  | { ok: false; reason: string; detail: unknown };

function tryParseRequirements(raw: string): ParseOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(raw));
  } catch (err) {
    return { ok: false, reason: 'not valid JSON', detail: (err as Error).message };
  }
  const validated = requirementsArraySchema.safeParse(parsed);
  if (!validated.success) {
    return {
      ok: false,
      reason: 'JSON parsed but failed schema validation',
      detail: validated.error.issues,
    };
  }
  return { ok: true, value: validated.data };
}

type EpisodePlanParseOutcome =
  | { ok: true; value: z.infer<typeof episodePlanOutputSchema> }
  | { ok: false; reason: string; detail: unknown };

function tryParseEpisodePlan(raw: string): EpisodePlanParseOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(raw));
  } catch (err) {
    return { ok: false, reason: 'not valid JSON', detail: (err as Error).message };
  }
  const validated = episodePlanOutputSchema.safeParse(parsed);
  if (!validated.success) {
    return {
      ok: false,
      reason: 'JSON parsed but failed schema validation',
      detail: validated.error.issues,
    };
  }
  return { ok: true, value: validated.data };
}

// Exposed for tests.
export const _internal = {
  SYSTEM_PROMPT,
  MAX_LISTING_CHARS,
  buildPrompt,
  tryParseRequirements,
  tryParseEpisodePlan,
};
