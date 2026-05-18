import type { Firestore } from 'firebase-admin/firestore';
import { logger } from '../logger.js';
import { getLLMProvider, LLMProviderError, type LLMProvider } from '../providers/index.js';
import { getPlan, patchPlan } from '../db/plans.js';
import { findLongFormDeliverable, DeliverableNotFoundError } from '../db/deliverables.js';
import { getFormatProfile, FormatProfileNotFoundError } from './format-profiles/index.js';
import { getAudienceProfileClient } from '../neurocore/audience-profiles.js';
import { buildSystemPrompt } from './compose-prompt.js';
import { extractJson } from './json-utils.js';
import { PlanningEngineError } from './errors.js';
import {
  createHookDraft,
  deleteAllHookDraftsForPlan,
} from '../db/hook-drafts.js';
import { HOOK_ARCHETYPES, type HookDraft } from '../db/schemas.js';

/**
 * Call 5 of the v2 youtube_advanced pipeline: hook variant generation.
 *
 * Generates 3-4 hook variants for the first 10-15 seconds of the episode.
 * Each variant has an archetype, a 30-60 word script draft, and a predicted
 * retention rationale. Persists all variants as HookDraft docs under the plan,
 * wiping any previous drafts first. Transitions plan.status → hooks_generated.
 *
 * Retry-once on bad JSON or validation failure (bad archetype / bad word count).
 * Throws PlanningEngineError on every failure path.
 */

const STEP_NAME = 'generate-hook-variants';
const DEFAULT_TIMEOUT_MS = 30_000;

const TASK_INSTRUCTIONS = `Generate 3-4 hook variants for the first 10-15 seconds of this episode.

Each variant must be one of these archetypes:
  - pattern_interrupt: open with a surprising moment
  - bold_claim: state an outcome up front
  - retention_question: ask a question whose answer is paradoxical
  - story_cold_open: drop the viewer into a narrative moment
  - demo_first: show the finished thing working

IMPORTANT: pick archetypes that match the format profile's hook guidelines.
Some archetypes are explicitly discouraged by certain formats — honor those.

Output a JSON array of 3-4 objects:
[
  {
    "archetype": "<one of the 5 archetypes>",
    "scriptText": "<30-60 word draft of the first 10-15 seconds>",
    "predictedRetention": "<one sentence why this hook should hold viewers>"
  },
  ...
]

RULES:
- Each scriptText must be 30-60 words.
- At least 3 distinct archetypes across the variants.
- Output JSON ONLY. No fences, no prose. Start with [ end with ].`;

interface HookVariantRaw {
  archetype: string;
  scriptText: string;
  predictedRetention: string;
}

type ParseOutcome =
  | { ok: true; value: HookVariantRaw[] }
  | { ok: false; reason: string; detail: unknown };

function tryParseVariants(raw: string): ParseOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(raw));
  } catch (err) {
    return { ok: false, reason: 'not valid JSON', detail: (err as Error).message };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, reason: 'expected JSON array', detail: parsed };
  }
  return { ok: true, value: parsed as HookVariantRaw[] };
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

interface ValidationResult {
  valid: boolean;
  reason?: string;
}

function validateVariants(variants: HookVariantRaw[]): ValidationResult {
  // Check count: 3-5
  if (variants.length < 3 || variants.length > 5) {
    return {
      valid: false,
      reason: `expected 3-5 variants, got ${variants.length}`,
    };
  }

  // Check all archetypes are known
  const validArchetypes = new Set<string>(HOOK_ARCHETYPES);
  for (const v of variants) {
    if (!validArchetypes.has(v.archetype)) {
      return {
        valid: false,
        reason: `unknown archetype "${v.archetype}" — must be one of ${HOOK_ARCHETYPES.join(', ')}`,
      };
    }
  }

  // Check word counts: 20-80 (per spec: retry-once if any violate)
  for (const v of variants) {
    const wc = countWords(v.scriptText);
    if (wc < 20 || wc > 80) {
      return {
        valid: false,
        reason: `scriptText word count ${wc} out of range 20-80 for archetype "${v.archetype}"`,
      };
    }
  }

  return { valid: true };
}

export async function generateHookVariants(
  planId: string,
  opts: { provider?: LLMProvider; db?: Firestore; timeoutMs?: number } = {},
): Promise<HookDraft[]> {
  const t0 = Date.now();
  const provider = opts.provider ?? (await getLLMProvider());
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // ---- Load plan ---------------------------------------------------------
  const plan = await getPlan(planId, opts.db);
  if (!plan) {
    throw new PlanningEngineError(STEP_NAME, 'PLAN_NOT_FOUND', `no plan with id ${planId}`, {
      planId,
    });
  }

  // ---- Pre-conditions ----------------------------------------------------
  if (plan.type !== 'youtube_advanced') {
    throw new PlanningEngineError(
      STEP_NAME,
      'WRONG_PLAN_TYPE',
      `generate-hook-variants only supports youtube_advanced plans, got ${plan.type}`,
      { planId },
    );
  }

  const allowedStatuses: string[] = ['scenes_generated', 'hooks_generated'];
  if (!allowedStatuses.includes(plan.status)) {
    throw new PlanningEngineError(
      STEP_NAME,
      'DISALLOWED_TRANSITION',
      `cannot generate hooks from status ${plan.status} — plan must be in scenes_generated or hooks_generated`,
      { planId, detail: { currentStatus: plan.status } },
    );
  }

  if (!plan.formatProfileId) {
    throw new PlanningEngineError(
      STEP_NAME,
      'NO_FORMAT_PROFILE',
      'youtube_advanced plan has no formatProfileId — set one before generating hooks',
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

  // ---- Load long-form deliverable + audience profile --------------------
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

  // ---- Build system prompt via compose-prompt v2 path ------------------
  const systemPrompt = buildSystemPrompt({
    formatProfile,
    audienceProfile,
    taskInstructions: TASK_INSTRUCTIONS,
  });

  // ---- Build user prompt -----------------------------------------------
  // Episode plan is stored as requirements[0].evidence (JSON-encoded).
  let episodePlanText = '';
  if (plan.requirements.length > 0 && plan.requirements[0]) {
    episodePlanText = plan.requirements[0].evidence;
  }

  const matchedProjectNames = plan.matchedProjects.map((m) => m.projectName).join(', ');
  const userPrompt = [
    systemPrompt,
    '',
    'EPISODE PLAN:',
    episodePlanText,
    '',
    `MATCHED PROJECTS: ${matchedProjectNames || '(none)'}`,
    `TARGET RUNTIME: ${plan.targetRuntimeSeconds}s`,
  ].join('\n');

  // ---- LLM call with retry-once ----------------------------------------
  let variants: HookVariantRaw[];
  try {
    const raw = await provider.generate(userPrompt, { timeoutMs });
    const parsed = tryParseVariants(raw);
    if (!parsed.ok) {
      // Retry with stricter instruction
      const stricter = `${userPrompt}\n\nIMPORTANT: Your previous response was not parseable as JSON. Respond with ONLY a JSON array — no fences, no prose. Start with [ and end with ].`;
      const raw2 = await provider.generate(stricter, { timeoutMs });
      const parsed2 = tryParseVariants(raw2);
      if (!parsed2.ok) {
        throw new PlanningEngineError(
          STEP_NAME,
          'INVALID_OUTPUT',
          `LLM output did not parse as valid hook variants after retry: ${parsed2.reason}`,
          { planId, detail: parsed2.detail },
        );
      }
      const validation2 = validateVariants(parsed2.value);
      if (!validation2.valid) {
        throw new PlanningEngineError(
          STEP_NAME,
          'INVALID_OUTPUT',
          `Hook variants failed validation after retry: ${validation2.reason}`,
          { planId },
        );
      }
      variants = parsed2.value;
    } else {
      // First parse succeeded — validate
      const validation = validateVariants(parsed.value);
      if (!validation.valid) {
        // Retry with stricter instruction for validation failure
        const stricterValidation = `${userPrompt}\n\nIMPORTANT: Your previous response failed validation: ${validation.reason}. Respond with ONLY a valid JSON array — 3-4 objects, each archetype must be one of [${HOOK_ARCHETYPES.join(', ')}], scriptText must be 30-60 words. Start with [ and end with ].`;
        const raw2 = await provider.generate(stricterValidation, { timeoutMs });
        const parsed2 = tryParseVariants(raw2);
        if (!parsed2.ok) {
          throw new PlanningEngineError(
            STEP_NAME,
            'INVALID_OUTPUT',
            `LLM output did not parse as valid hook variants after retry: ${parsed2.reason}`,
            { planId, detail: parsed2.detail },
          );
        }
        const validation2 = validateVariants(parsed2.value);
        if (!validation2.valid) {
          throw new PlanningEngineError(
            STEP_NAME,
            'INVALID_OUTPUT',
            `Hook variants failed validation after retry: ${validation2.reason}`,
            { planId },
          );
        }
        variants = parsed2.value;
      } else {
        variants = parsed.value;
      }
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

  // ---- Persist hook drafts (wipe old, persist new, then advance status) -
  // Wipe existing drafts first.
  try {
    await deleteAllHookDraftsForPlan(planId, opts.db);
  } catch (err) {
    throw new PlanningEngineError(
      STEP_NAME,
      'PERSIST_FAILED',
      `failed to wipe existing hook drafts: ${(err as Error).message}`,
      { planId },
    );
  }

  // Persist new drafts, tracking those created so we can wipe on partial failure.
  const created: HookDraft[] = [];
  try {
    for (const v of variants) {
      const draft = await createHookDraft(
        planId,
        {
          archetype: v.archetype as (typeof HOOK_ARCHETYPES)[number],
          scriptText: v.scriptText,
          predictedRetention: v.predictedRetention,
          selected: false,
        },
        opts.db,
      );
      created.push(draft);
    }
  } catch (err) {
    // Partial failure — wipe partial drafts to keep the collection clean.
    try {
      await deleteAllHookDraftsForPlan(planId, opts.db);
    } catch {
      // best-effort cleanup
    }
    throw new PlanningEngineError(
      STEP_NAME,
      'PERSIST_FAILED',
      `failed to persist hook drafts (partial write rolled back): ${(err as Error).message}`,
      { planId },
    );
  }

  // ---- Advance plan status ONLY after all drafts are persisted ----------
  try {
    await patchPlan(planId, { status: 'hooks_generated' }, opts.db);
  } catch (err) {
    throw new PlanningEngineError(
      STEP_NAME,
      'PERSIST_FAILED',
      `failed to advance plan status to hooks_generated: ${(err as Error).message}`,
      { planId },
    );
  }

  const durationMs = Date.now() - t0;
  logger.info(
    {
      planId,
      variantCount: created.length,
      durationMs,
    },
    'hook variant generation complete',
  );

  return created;
}
