import type { Firestore } from 'firebase-admin/firestore';
import { logger } from '../logger.js';
import { getLLMProvider, LLMProviderError, type LLMProvider } from '../providers/index.js';
import { defaultLlmTimeoutMs } from './llm-timeout.js';
import { getPlan, patchPlan } from '../db/plans.js';
import {
  getDeliverable,
} from '../db/deliverables.js';
import {
  getSelectedTitleConcept,
} from '../db/title-concepts.js';
import {
  createThumbnailConcept,
  deleteAllThumbnailConceptsForDeliverable,
} from '../db/thumbnail-concepts.js';
import { getFormatProfile, FormatProfileNotFoundError } from './format-profiles/index.js';
import { getAudienceProfileClient } from '../neurocore/audience-profiles.js';
import { buildSystemPrompt } from './compose-prompt.js';
import { extractJson } from './json-utils.js';
import { PlanningEngineError } from './errors.js';
import { type ThumbnailConcept } from '../db/schemas.js';

/**
 * Call 8 of the v2 youtube_advanced pipeline: thumbnail concept generation.
 *
 * Text-only structured thumbnail concepts (composition + textHook + palette +
 * assetsRequired). Per PRD §4.10 and tech-spec §11.2, image generation is
 * v3 deferred — these concepts brief whatever tool Rick uses to make the
 * actual thumbnail (Figma, Photoshop, Canva, AI image gen).
 *
 * Operates per Deliverable. Requires the selected title concept (passed via
 * deliverable.selectedTitleVariantId — resolved internally via
 * getSelectedTitleConcept). For long-form: plan status must be title_selected
 * or thumbnails_generated. For short_clip: similar gating on deliverable state.
 *
 * 3-5 concepts produced. Wipes existing then persists. Long-form advances
 * plan status title_selected → thumbnails_generated.
 */

const STEP_NAME = 'generate-thumbnail-concepts';
const MIN_CONCEPTS = 3;
const MAX_CONCEPTS = 5;

const TASK_INSTRUCTIONS = `Generate 3-5 thumbnail concepts for this YouTube deliverable.

These concepts are TEXT-ONLY structured briefs — DO NOT generate or describe
specific images, photos, or pixel art. Concepts describe layout, on-thumbnail
text, color palette, expression, and the source assets needed.

OUTPUT FORMAT — return a JSON array of 3-5 objects:
[
  {
    "composition": "<one sentence describing layout (e.g., 'split: terminal left, headshot right')>",
    "textHook": "<1-4 word overlay text (the big words on the thumbnail)>",
    "expression": "<headshot emotion if applicable, else null>",
    "colorPalette": ["#RRGGBB", "#RRGGBB"]   // 2-3 hex values
  ,
    "assetsRequired": ["<asset>", "..."]   // 1-5 source materials needed (e.g., "screenshot of failed test", "headshot reaction")
  ,
    "conceptSummary": "<one-sentence summary of the visual idea>"
  },
  ...
]

RULES:
- textHook MUST be 1-4 words. Count them carefully. NO punctuation counts as a word.
- colorPalette: 2-3 valid hex values like #0a0a0a or #22c55e. Lowercase or uppercase both fine.
- expression is OPTIONAL — only set when the composition includes a headshot. Use null otherwise.
- Vary the concepts — don't ship 3 near-identical split-screen ideas.
- Output JSON ONLY. No fences, no prose. Start with [ end with ].`;

interface ThumbnailConceptRaw {
  composition: string;
  textHook: string;
  expression: string | null;
  colorPalette: string[];
  assetsRequired: string[];
  conceptSummary: string;
}

type ParseOutcome =
  | { ok: true; value: ThumbnailConceptRaw[] }
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
  return { ok: true, value: parsed as ThumbnailConceptRaw[] };
}

interface ValidationResult {
  valid: boolean;
  reason?: string;
}

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function validateConcepts(concepts: ThumbnailConceptRaw[]): ValidationResult {
  if (concepts.length < MIN_CONCEPTS || concepts.length > MAX_CONCEPTS) {
    return { valid: false, reason: `expected ${MIN_CONCEPTS}-${MAX_CONCEPTS} concepts, got ${concepts.length}` };
  }

  for (const c of concepts) {
    if (typeof c.composition !== 'string' || c.composition.length === 0) {
      return { valid: false, reason: 'composition empty' };
    }
    if (typeof c.textHook !== 'string') {
      return { valid: false, reason: 'textHook missing' };
    }
    const wordCount = countWords(c.textHook);
    if (wordCount < 1 || wordCount > 4) {
      return {
        valid: false,
        reason: `textHook "${c.textHook}" has ${wordCount} words (must be 1-4)`,
      };
    }
    if (!Array.isArray(c.colorPalette)) {
      return { valid: false, reason: 'colorPalette not an array' };
    }
    if (c.colorPalette.length < 2 || c.colorPalette.length > 3) {
      return {
        valid: false,
        reason: `colorPalette must have 2-3 entries, got ${c.colorPalette.length}`,
      };
    }
    for (const hex of c.colorPalette) {
      if (!HEX_RE.test(hex)) {
        return { valid: false, reason: `invalid hex color "${hex}" — must match #RRGGBB` };
      }
    }
    if (!Array.isArray(c.assetsRequired)) {
      return { valid: false, reason: 'assetsRequired not an array' };
    }
    if (typeof c.conceptSummary !== 'string' || c.conceptSummary.length === 0) {
      return { valid: false, reason: 'conceptSummary empty' };
    }
  }
  return { valid: true };
}

export interface GenerateThumbnailConceptsResult {
  concepts: ThumbnailConcept[];
  retried: boolean;
  durationMs: number;
}

export async function generateThumbnailConcepts(
  deliverableId: string,
  opts: { provider?: LLMProvider; db?: Firestore; timeoutMs?: number } = {},
): Promise<GenerateThumbnailConceptsResult> {
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
      `parent plan ${deliverable.planId} missing`,
      { planId: deliverable.planId },
    );
  }

  if (plan.type !== 'youtube_advanced') {
    throw new PlanningEngineError(
      STEP_NAME,
      'WRONG_PLAN_TYPE',
      `generate-thumbnail-concepts only supports youtube_advanced, got ${plan.type}`,
      { planId: plan.id, detail: { deliverableId } },
    );
  }

  // Pre-condition: a title MUST be selected before thumbnails (PRD §4.10).
  if (!deliverable.selectedTitleVariantId) {
    throw new PlanningEngineError(
      STEP_NAME,
      'NO_REQUIREMENTS', // reusing the closest existing code — "missing input"
      'deliverable has no selected title — select a title before generating thumbnails',
      { planId: plan.id, detail: { deliverableId } },
    );
  }

  // Status guards
  if (deliverable.kind === 'long_form') {
    const allowedStatuses = ['title_selected', 'thumbnails_generated'];
    if (!allowedStatuses.includes(plan.status)) {
      throw new PlanningEngineError(
        STEP_NAME,
        'DISALLOWED_TRANSITION',
        `long-form thumbnails require plan status title_selected or thumbnails_generated; got ${plan.status}`,
        { planId: plan.id, detail: { deliverableId, currentStatus: plan.status } },
      );
    }
  } else if (deliverable.kind === 'short_clip') {
    const allowedDelivStatuses = ['scripts_ready', 'metadata_ready'];
    if (!allowedDelivStatuses.includes(deliverable.status)) {
      throw new PlanningEngineError(
        STEP_NAME,
        'DISALLOWED_TRANSITION',
        `short_clip thumbnails require deliverable status scripts_ready or metadata_ready; got ${deliverable.status}`,
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

  const audienceProfile = await getAudienceProfileClient().get(deliverable.audienceProfileId);

  // ---- Build prompt -----------------------------------------------------

  const systemPrompt = buildSystemPrompt({
    formatProfile,
    audienceProfile,
    taskInstructions: TASK_INSTRUCTIONS,
  });

  // Pull the selected title so the LLM knows what hook the thumbnail
  // is reinforcing.
  const selectedTitle = await getSelectedTitleConcept(deliverableId, opts.db);
  const selectedTitleText = selectedTitle?.titleText ?? deliverable.title;

  const matchedProjectNames = plan.matchedProjects.map((m) => m.projectName).join(', ');
  const userPrompt = [
    systemPrompt,
    '',
    `SELECTED TITLE: ${selectedTitleText}`,
    `DELIVERABLE KIND: ${deliverable.kind}`,
    `MATCHED PROJECTS: ${matchedProjectNames || '(none)'}`,
  ].join('\n');

  // ---- LLM call with retry-once -----------------------------------------

  let concepts: ThumbnailConceptRaw[];
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
          `Thumbnail concepts failed validation after retry: ${validation2.reason}`,
          { planId: plan.id },
        );
      }
      concepts = parsed2.value;
    } else {
      const validation = validateConcepts(parsed.value);
      if (!validation.valid) {
        retried = true;
        const stricterValidation = `${userPrompt}\n\nIMPORTANT: Your previous response failed validation: ${validation.reason}. Respond with ONLY a valid JSON array — 3-5 concepts, textHook 1-4 words, colorPalette 2-3 #RRGGBB hex colors. Start with [ and end with ].`;
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
            `Thumbnail concepts failed validation after retry: ${validation2.reason}`,
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
    await deleteAllThumbnailConceptsForDeliverable(deliverableId, opts.db);
  } catch (err) {
    throw new PlanningEngineError(
      STEP_NAME,
      'PERSIST_FAILED',
      `failed to wipe old thumbnail concepts: ${(err as Error).message}`,
      { planId: plan.id, detail: { deliverableId } },
    );
  }

  const persisted: ThumbnailConcept[] = [];
  for (const c of concepts) {
    try {
      const written = await createThumbnailConcept(
        deliverableId,
        {
          composition: c.composition,
          textHook: c.textHook,
          expression: c.expression,
          colorPalette: c.colorPalette,
          assetsRequired: c.assetsRequired,
          conceptSummary: c.conceptSummary,
          selected: false,
        },
        opts.db,
      );
      persisted.push(written);
    } catch (err) {
      try {
        await deleteAllThumbnailConceptsForDeliverable(deliverableId, opts.db);
      } catch (cleanupErr) {
        logger.error(
          { err: cleanupErr, deliverableId },
          'generate-thumbnail-concepts: cleanup after persist failure also failed',
        );
      }
      throw new PlanningEngineError(
        STEP_NAME,
        'PERSIST_FAILED',
        `failed to persist thumbnail concept: ${(err as Error).message}`,
        { planId: plan.id, detail: { deliverableId } },
      );
    }
  }

  // ---- Status transition (long-form only) -------------------------------

  if (deliverable.kind === 'long_form' && plan.status === 'title_selected') {
    await patchPlan(plan.id, { status: 'thumbnails_generated' }, opts.db);
  }

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
    'thumbnail concepts generated',
  );

  return { concepts: persisted, retried, durationMs };
}
