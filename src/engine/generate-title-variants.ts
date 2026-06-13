import type { Firestore } from 'firebase-admin/firestore';
import { logger } from '../logger.js';
import { getLLMProvider, LLMProviderError, type LLMProvider } from '../providers/index.js';
import { defaultLlmTimeoutMs } from './llm-timeout.js';
import { getPlan, patchPlan } from '../db/plans.js';
import {
  getDeliverable,
  patchDeliverable,
} from '../db/deliverables.js';
import {
  createTitleConcept,
  deleteAllTitleConceptsForDeliverable,
} from '../db/title-concepts.js';
import { getFormatProfile, FormatProfileNotFoundError } from './format-profiles/index.js';
import { getAudienceProfileClient } from '../neurocore/audience-profiles.js';
import { buildSystemPrompt } from './compose-prompt.js';
import { extractJson } from './json-utils.js';
import { PlanningEngineError } from './errors.js';
import {
  TITLE_ARCHETYPES,
  type TitleConcept,
} from '../db/schemas.js';

/**
 * Call 7 of the v2 youtube_advanced pipeline: title variant generation.
 *
 * Operates per Deliverable. Long-form deliverables run this after shot list
 * is generated; short_clip deliverables run it when they're at scripts_ready.
 *
 * Generates 5-10 title variants tagged by archetype (curiosity_gap,
 * specificity, payoff_promise, etc.) with predicted clickability + reasoning
 * + surfaced keywords. Wipes any existing concepts under the deliverable
 * before persisting new ones (regeneration semantics).
 *
 * For the long-form deliverable, advances plan.status: shot_list_generated
 * → titles_generated. For Shorts the parent plan status isn't touched.
 */

const STEP_NAME = 'generate-title-variants';

const TASK_INSTRUCTIONS = `Generate 5-10 title variants for this YouTube deliverable.

Each title must be one of these archetypes:
  - curiosity_gap: hint at a payoff but withhold the punchline
  - specificity: include concrete numbers, names, or outcomes
  - payoff_promise: state the value the viewer gets up front
  - controversy_hook: take a position that some viewers will disagree with
  - numbered_listicle: "N things..." / "N reasons..." style
  - question_format: an actual question the viewer wants answered
  - before_after: contrast a starting state with the outcome

OUTPUT FORMAT — return a JSON array of 5-10 objects:
[
  {
    "titleText": "<≤70 character title>",
    "archetype": "<one of the 7 archetypes above>",
    "predictedClickability": <integer 1-10>,
    "reasoning": "<one sentence why this title will get clicks>",
    "keywordsSurfaced": ["<keyword>", "..."]   // 1-5 SEO keywords this title naturally surfaces
  },
  ...
]

RULES:
- Each titleText must be at most 70 characters. Count carefully — YouTube truncates longer.
- predictedClickability is a 1-10 integer rating your own estimate of CTR potential.
- At least 4 distinct archetypes across the variants — don't stack 8 curiosity-gap titles.
- keywordsSurfaced must be the SEO terms actually present in the title, not what you wish were there.
- Output JSON ONLY. No fences, no prose. Start with [ end with ].`;

interface TitleConceptRaw {
  titleText: string;
  archetype: string;
  predictedClickability: number;
  reasoning: string;
  keywordsSurfaced: string[];
}

type ParseOutcome =
  | { ok: true; value: TitleConceptRaw[] }
  | { ok: false; reason: string; detail?: unknown };

function tryParseConcepts(raw: string): ParseOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(raw));
  } catch (err) {
    return { ok: false, reason: 'not valid JSON', detail: (err as Error).message };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, reason: 'expected JSON array', detail: parsed };
  }
  return { ok: true, value: parsed as TitleConceptRaw[] };
}

interface ValidationResult {
  valid: boolean;
  reason?: string;
}

const VALID_ARCHETYPES = new Set<string>(TITLE_ARCHETYPES);

function validateConcepts(concepts: TitleConceptRaw[]): ValidationResult {
  if (concepts.length < 5 || concepts.length > 10) {
    return { valid: false, reason: `expected 5-10 variants, got ${concepts.length}` };
  }

  for (const c of concepts) {
    if (typeof c.titleText !== 'string' || c.titleText.length === 0) {
      return { valid: false, reason: 'titleText empty' };
    }
    if (c.titleText.length > 70) {
      return {
        valid: false,
        reason: `titleText "${c.titleText.slice(0, 50)}..." is ${c.titleText.length} chars (max 70)`,
      };
    }
    if (!VALID_ARCHETYPES.has(c.archetype)) {
      return {
        valid: false,
        reason: `unknown archetype "${c.archetype}" — must be one of ${TITLE_ARCHETYPES.join(', ')}`,
      };
    }
    if (!Number.isInteger(c.predictedClickability) || c.predictedClickability < 1 || c.predictedClickability > 10) {
      return {
        valid: false,
        reason: `predictedClickability ${c.predictedClickability} not in integer range 1-10`,
      };
    }
    if (typeof c.reasoning !== 'string' || c.reasoning.length === 0) {
      return { valid: false, reason: 'reasoning empty' };
    }
    if (!Array.isArray(c.keywordsSurfaced)) {
      return { valid: false, reason: 'keywordsSurfaced not an array' };
    }
  }

  const distinctArchetypes = new Set(concepts.map((c) => c.archetype));
  if (distinctArchetypes.size < 4) {
    return {
      valid: false,
      reason: `only ${distinctArchetypes.size} distinct archetypes across ${concepts.length} variants — need at least 4`,
    };
  }

  return { valid: true };
}

export interface GenerateTitleVariantsResult {
  concepts: TitleConcept[];
  retried: boolean;
  durationMs: number;
}

export async function generateTitleVariants(
  deliverableId: string,
  opts: { provider?: LLMProvider; db?: Firestore; timeoutMs?: number } = {},
): Promise<GenerateTitleVariantsResult> {
  const t0 = Date.now();
  const provider = opts.provider ?? (await getLLMProvider());
  const timeoutMs = defaultLlmTimeoutMs(opts.timeoutMs);

  // ---- Load deliverable + parent plan -----------------------------------

  const deliverable = await getDeliverable(deliverableId, opts.db);
  if (!deliverable) {
    throw new PlanningEngineError(
      STEP_NAME,
      'PLAN_NOT_FOUND',
      `no deliverable with id ${deliverableId}`,
      { detail: { deliverableId } },
    );
  }

  const plan = await getPlan(deliverable.planId, opts.db);
  if (!plan) {
    throw new PlanningEngineError(
      STEP_NAME,
      'PLAN_NOT_FOUND',
      `parent plan ${deliverable.planId} missing for deliverable ${deliverableId}`,
      { planId: deliverable.planId, detail: { deliverableId } },
    );
  }

  if (plan.type !== 'youtube_advanced') {
    throw new PlanningEngineError(
      STEP_NAME,
      'WRONG_PLAN_TYPE',
      `generate-title-variants only supports youtube_advanced plans, got ${plan.type}`,
      { planId: plan.id, detail: { deliverableId } },
    );
  }

  // For long-form: require status shot_list_generated or titles_generated
  // (the latter for regeneration). For short_clip: deliverable must be at
  // scripts_ready or later.
  if (deliverable.kind === 'long_form') {
    const allowedStatuses = ['shot_list_generated', 'titles_generated'];
    if (!allowedStatuses.includes(plan.status)) {
      throw new PlanningEngineError(
        STEP_NAME,
        'DISALLOWED_TRANSITION',
        `long-form titles require plan status shot_list_generated or titles_generated; got ${plan.status}`,
        { planId: plan.id, detail: { deliverableId, currentStatus: plan.status } },
      );
    }
  } else if (deliverable.kind === 'short_clip') {
    const allowedDelivStatuses = ['scripts_ready', 'metadata_ready'];
    if (!allowedDelivStatuses.includes(deliverable.status)) {
      throw new PlanningEngineError(
        STEP_NAME,
        'DISALLOWED_TRANSITION',
        `short_clip titles require deliverable status scripts_ready or metadata_ready; got ${deliverable.status}`,
        { planId: plan.id, detail: { deliverableId, deliverableStatus: deliverable.status } },
      );
    }
  }

  if (!plan.formatProfileId) {
    throw new PlanningEngineError(
      STEP_NAME,
      'NO_FORMAT_PROFILE',
      'youtube_advanced plan has no formatProfileId',
      { planId: plan.id },
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
        `formatProfileId "${plan.formatProfileId}" not in registry`,
        { planId: plan.id },
      );
    }
    throw err;
  }

  // ---- Audience profile from the deliverable (NOT the long-form for Shorts) --
  const audienceProfile = await getAudienceProfileClient().get(deliverable.audienceProfileId);

  // ---- Build prompts ----------------------------------------------------

  const systemPrompt = buildSystemPrompt({
    formatProfile,
    audienceProfile,
    taskInstructions: TASK_INSTRUCTIONS,
    researchContext: plan.researchContext?.synthesis,
  });

  // Episode plan summary for context. Parse the encoded structured output
  // stored on plan.requirements[0].evidence if present.
  let episodePlanText = '';
  if (plan.requirements.length > 0 && plan.requirements[0]) {
    episodePlanText = plan.requirements[0].evidence;
  }

  const matchedProjectNames = plan.matchedProjects.map((m) => m.projectName).join(', ');
  const deliverableContext = deliverable.kind === 'short_clip'
    ? `\nDELIVERABLE KIND: short_clip (60-90s vertical)\nNote: titles for Shorts are shorter and punchier than long-form.`
    : `\nDELIVERABLE KIND: long_form (${plan.targetRuntimeSeconds}s episode)`;

  const userPrompt = [
    systemPrompt,
    '',
    deliverableContext,
    '',
    'EPISODE PLAN:',
    episodePlanText || '(none)',
    '',
    `MATCHED PROJECTS: ${matchedProjectNames || '(none)'}`,
    `DELIVERABLE TITLE (current): ${deliverable.title}`,
  ].join('\n');

  // ---- LLM call with retry-once -----------------------------------------

  let concepts: TitleConceptRaw[];
  let retried = false;

  try {
    const raw = await provider.generate(userPrompt, { timeoutMs });
    const parsed = tryParseConcepts(raw);
    if (!parsed.ok) {
      retried = true;
      const stricter = `${userPrompt}\n\nIMPORTANT: Your previous response was not parseable as JSON. Respond with ONLY a JSON array — no fences, no prose. Start with [ and end with ].`;
      const raw2 = await provider.generate(stricter, { timeoutMs });
      const parsed2 = tryParseConcepts(raw2);
      if (!parsed2.ok) {
        throw new PlanningEngineError(
          STEP_NAME,
          'INVALID_OUTPUT',
          `LLM output did not parse after retry: ${parsed2.reason}`,
          { planId: plan.id, detail: parsed2.detail },
        );
      }
      const validation2 = validateConcepts(parsed2.value);
      if (!validation2.valid) {
        throw new PlanningEngineError(
          STEP_NAME,
          'INVALID_OUTPUT',
          `Title concepts failed validation after retry: ${validation2.reason}`,
          { planId: plan.id },
        );
      }
      concepts = parsed2.value;
    } else {
      const validation = validateConcepts(parsed.value);
      if (!validation.valid) {
        retried = true;
        const stricterValidation = `${userPrompt}\n\nIMPORTANT: Your previous response failed validation: ${validation.reason}. Respond with ONLY a valid JSON array — 5-10 titles, each ≤70 chars, archetype in [${TITLE_ARCHETYPES.join(', ')}], predictedClickability 1-10, with at least 4 distinct archetypes. Start with [ and end with ].`;
        const raw2 = await provider.generate(stricterValidation, { timeoutMs });
        const parsed2 = tryParseConcepts(raw2);
        if (!parsed2.ok) {
          throw new PlanningEngineError(
            STEP_NAME,
            'INVALID_OUTPUT',
            `LLM output did not parse after retry: ${parsed2.reason}`,
            { planId: plan.id, detail: parsed2.detail },
          );
        }
        const validation2 = validateConcepts(parsed2.value);
        if (!validation2.valid) {
          throw new PlanningEngineError(
            STEP_NAME,
            'INVALID_OUTPUT',
            `Title concepts failed validation after retry: ${validation2.reason}`,
            { planId: plan.id },
          );
        }
        concepts = parsed2.value;
      } else {
        concepts = parsed.value;
      }
    }
  } catch (err) {
    if (err instanceof PlanningEngineError) throw err;
    if (err instanceof LLMProviderError) {
      throw new PlanningEngineError(
        STEP_NAME,
        'LLM_FAILED',
        `LLM call failed: ${err.message}`,
        { planId: plan.id, detail: { code: err.code } },
      );
    }
    throw err;
  }

  // ---- Persist: wipe old, write new -------------------------------------

  try {
    await deleteAllTitleConceptsForDeliverable(deliverableId, opts.db);
  } catch (err) {
    throw new PlanningEngineError(
      STEP_NAME,
      'PERSIST_FAILED',
      `failed to wipe old title concepts: ${(err as Error).message}`,
      { planId: plan.id, detail: { deliverableId } },
    );
  }

  const persisted: TitleConcept[] = [];
  for (const c of concepts) {
    try {
      const written = await createTitleConcept(
        deliverableId,
        {
          titleText: c.titleText,
          archetype: c.archetype as (typeof TITLE_ARCHETYPES)[number],
          predictedClickability: c.predictedClickability,
          reasoning: c.reasoning,
          keywordsSurfaced: c.keywordsSurfaced,
          selected: false,
        },
        opts.db,
      );
      persisted.push(written);
    } catch (err) {
      // Wipe partial writes to preserve atomicity from the user's POV
      try {
        await deleteAllTitleConceptsForDeliverable(deliverableId, opts.db);
      } catch (cleanupErr) {
        logger.error(
          { err: cleanupErr, deliverableId },
          'generate-title-variants: cleanup after persist failure also failed',
        );
      }
      throw new PlanningEngineError(
        STEP_NAME,
        'PERSIST_FAILED',
        `failed to persist title concept: ${(err as Error).message}`,
        { planId: plan.id, detail: { deliverableId } },
      );
    }
  }

  // ---- Status transition (long-form only) -------------------------------

  if (deliverable.kind === 'long_form' && plan.status === 'shot_list_generated') {
    await patchPlan(plan.id, { status: 'titles_generated' }, opts.db);
  }
  // Re-runs (already titles_generated) keep status; Shorts don't move parent.

  const durationMs = Date.now() - t0;
  logger.info(
    {
      step: STEP_NAME,
      planId: plan.id,
      deliverableId,
      conceptCount: persisted.length,
      retried,
      durationMs,
    },
    'title variants generated',
  );

  return { concepts: persisted, retried, durationMs };
}
