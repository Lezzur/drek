import type { Firestore } from 'firebase-admin/firestore';
import { logger } from '../logger.js';
import { getLLMProvider, LLMProviderError, type LLMProvider } from '../providers/index.js';
import { defaultLlmTimeoutMs } from './llm-timeout.js';
import { getPlan, patchPlan } from '../db/plans.js';
import {
  getDeliverable,
  patchDeliverable,
} from '../db/deliverables.js';
import { listScenes } from '../db/scenes.js';
import { getSelectedTitleConcept } from '../db/title-concepts.js';
import { upsertPublishMetadata } from '../db/publish-metadata.js';
import { getFormatProfile, FormatProfileNotFoundError } from './format-profiles/index.js';
import { getAudienceProfileClient } from '../neurocore/audience-profiles.js';
import { buildSystemPrompt } from './compose-prompt.js';
import { extractJson } from './json-utils.js';
import { PlanningEngineError } from './errors.js';
import { type PublishMetadata } from '../db/schemas.js';

/**
 * Call 10 of the v2 youtube_advanced pipeline: publishing metadata.
 *
 * Generates the YouTube upload-form package: description (with timestamps),
 * chapters (auto-computed from scene durations + LLM-named labels), tags,
 * pinned comment, end-screen suggestion.
 *
 * Operates per Deliverable. For long-form: requires plan.status === 'finalized'
 * (Rick has approved the scripts). For short_clip: deliverable status
 * must be 'scripts_ready' or 'metadata_ready'.
 *
 * Chapter timestamps are computed server-side from scene
 * estimatedDurationSeconds — NOT taken from the LLM. The LLM only labels.
 *
 * Persists via upsertPublishMetadata (one doc per deliverable). Patches
 * deliverable.publishMetadataId to a sentinel value 'current' so the
 * route layer knows metadata exists. Long-form advances plan status
 * 'finalized' → 'metadata_generated'.
 */

const STEP_NAME = 'generate-publish-metadata';
const MAX_SCRIPTS_CHARS = 30_000;

// Beats that earn a chapter marker (long-form). For non-build-along formats
// the chapter list ends up being all beats — that's fine, YouTube
// auto-collapses very short chapters.
const CHAPTER_ELIGIBLE_BEATS = new Set([
  'cold_open',
  'problem',
  'war_room',
  'build_reel',
  'breakdown',
  'demo',
  'outro',
]);

const TASK_INSTRUCTIONS = `Generate the YouTube upload package for this deliverable.

OUTPUT FORMAT — return a SINGLE JSON object:
{
  "description": "<full description block, 1-5 paragraphs>",
  "chapterLabels": ["<label>", "..."],   // one label per chapter-eligible scene, in scene order
  "tags": ["<tag>", "..."],              // 10-15 YouTube tags (single words or short phrases)
  "pinnedComment": "<1-2 sentence engagement prompt>",
  "endScreenSuggestion": "<one sentence on what to point to next>"
}

RULES:
- description: opening hook line + 2-3 paragraph body + a CTA block. Do NOT include the timestamp list — DREK appends that server-side. Max 5000 chars.
- chapterLabels: 1-50 entries. One per chapter-eligible scene, IN THE ORDER GIVEN BELOW. Each label is a short, viewer-facing string (≤120 chars).
- tags: 10-15 entries, each 1-50 chars. SEO-relevant single words or short phrases.
- pinnedComment: 1-2 sentences. ≤500 chars. Should be a question or hot-take prompting first-comment engagement.
- endScreenSuggestion: 1 sentence. ≤500 chars. What viewers should watch/click next.
- Output JSON ONLY. No fences, no prose. Start with { end with }.`;

interface RawMetadata {
  description: string;
  chapterLabels: string[];
  tags: string[];
  pinnedComment: string;
  endScreenSuggestion: string;
}

type ParseOutcome =
  | { ok: true; value: RawMetadata }
  | { ok: false; reason: string; detail?: unknown };

function tryParse(raw: string): ParseOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(raw));
  } catch (err) {
    return { ok: false, reason: 'not valid JSON', detail: (err as Error).message };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'expected JSON object', detail: parsed };
  }
  return { ok: true, value: parsed as RawMetadata };
}

interface ValidationResult {
  valid: boolean;
  reason?: string;
}

function validateRaw(raw: RawMetadata, expectedChapterCount: number): ValidationResult {
  if (typeof raw.description !== 'string' || raw.description.length === 0) {
    return { valid: false, reason: 'description empty' };
  }
  if (raw.description.length > 5000) {
    return { valid: false, reason: `description too long (${raw.description.length} > 5000)` };
  }
  if (!Array.isArray(raw.chapterLabels)) {
    return { valid: false, reason: 'chapterLabels not an array' };
  }
  if (raw.chapterLabels.length !== expectedChapterCount) {
    return {
      valid: false,
      reason: `chapterLabels count ${raw.chapterLabels.length} != expected ${expectedChapterCount}`,
    };
  }
  for (const [i, label] of raw.chapterLabels.entries()) {
    if (typeof label !== 'string' || label.length === 0 || label.length > 120) {
      return {
        valid: false,
        reason: `chapterLabels[${i}] length ${label?.length} not in 1-120`,
      };
    }
  }
  if (!Array.isArray(raw.tags)) {
    return { valid: false, reason: 'tags not an array' };
  }
  if (raw.tags.length < 10 || raw.tags.length > 15) {
    return { valid: false, reason: `tags count ${raw.tags.length} not in 10-15` };
  }
  for (const [i, tag] of raw.tags.entries()) {
    if (typeof tag !== 'string' || tag.length === 0 || tag.length > 50) {
      return { valid: false, reason: `tags[${i}] length ${tag?.length} not in 1-50` };
    }
  }
  if (typeof raw.pinnedComment !== 'string' || raw.pinnedComment.length === 0 || raw.pinnedComment.length > 500) {
    return { valid: false, reason: `pinnedComment length ${raw.pinnedComment?.length} not in 1-500` };
  }
  if (typeof raw.endScreenSuggestion !== 'string' || raw.endScreenSuggestion.length === 0 || raw.endScreenSuggestion.length > 500) {
    return { valid: false, reason: `endScreenSuggestion length ${raw.endScreenSuggestion?.length} not in 1-500` };
  }
  return { valid: true };
}

function formatTimestamp(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export interface GeneratePublishMetadataResult {
  metadata: PublishMetadata;
  retried: boolean;
  durationMs: number;
}

export async function generatePublishMetadata(
  deliverableId: string,
  opts: { provider?: LLMProvider; db?: Firestore; timeoutMs?: number } = {},
): Promise<GeneratePublishMetadataResult> {
  const t0 = Date.now();
  const provider = opts.provider ?? (await getLLMProvider());
  const timeoutMs = defaultLlmTimeoutMs(opts.timeoutMs);

  // ---- Load deliverable + plan ------------------------------------------

  const deliverable = await getDeliverable(deliverableId, opts.db);
  if (!deliverable) {
    throw new PlanningEngineError(
      STEP_NAME,
      'PLAN_NOT_FOUND',
      `no deliverable ${deliverableId}`,
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
      `generate-publish-metadata only supports youtube_advanced, got ${plan.type}`,
      { planId: plan.id, detail: { deliverableId } },
    );
  }

  // Pre-condition: selected title + thumbnail required.
  if (!deliverable.selectedTitleVariantId || !deliverable.selectedThumbnailConceptId) {
    throw new PlanningEngineError(
      STEP_NAME,
      'NO_REQUIREMENTS',
      'deliverable must have both selected title AND selected thumbnail before generating metadata',
      { planId: plan.id, detail: { deliverableId } },
    );
  }

  // Status guards.
  if (deliverable.kind === 'long_form') {
    const allowedStatuses = ['finalized', 'metadata_generated'];
    if (!allowedStatuses.includes(plan.status)) {
      throw new PlanningEngineError(
        STEP_NAME,
        'DISALLOWED_TRANSITION',
        `long-form publish metadata requires plan status finalized or metadata_generated; got ${plan.status}`,
        { planId: plan.id, detail: { deliverableId, currentStatus: plan.status } },
      );
    }
  } else if (deliverable.kind === 'short_clip') {
    const allowedDelivStatuses = ['scripts_ready', 'metadata_ready'];
    if (!allowedDelivStatuses.includes(deliverable.status)) {
      throw new PlanningEngineError(
        STEP_NAME,
        'DISALLOWED_TRANSITION',
        `short_clip publish metadata requires deliverable status scripts_ready or metadata_ready; got ${deliverable.status}`,
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

  // ---- Compute chapter timestamps server-side ---------------------------

  const scenes = await listScenes(plan.id, opts.db);
  const chapterEligibleScenes = scenes.filter((s) =>
    s.beatTag ? CHAPTER_ELIGIBLE_BEATS.has(s.beatTag) : true,
  );

  // Cumulative timestamps from scene order.
  const chapterTimestamps: number[] = [];
  let runningTotal = 0;
  // We need to walk through ALL scenes in order and accumulate, recording
  // the running total at each chapter-eligible scene.
  for (const s of scenes) {
    const isEligible = s.beatTag ? CHAPTER_ELIGIBLE_BEATS.has(s.beatTag) : true;
    if (isEligible) {
      chapterTimestamps.push(runningTotal);
    }
    runningTotal += s.estimatedDurationSeconds || 0;
  }

  if (chapterTimestamps.length === 0) {
    throw new PlanningEngineError(
      STEP_NAME,
      'INVALID_OUTPUT',
      'no chapter-eligible scenes — cannot generate metadata',
      { planId: plan.id },
    );
  }

  // ---- Pull selected title for context ----------------------------------

  const selectedTitle = await getSelectedTitleConcept(deliverableId, opts.db);
  const titleText = selectedTitle?.titleText ?? deliverable.title;

  // ---- Build prompt -----------------------------------------------------

  const systemPrompt = buildSystemPrompt({
    formatProfile,
    audienceProfile,
    taskInstructions: TASK_INSTRUCTIONS,
    researchContext: plan.researchContext?.synthesis,
  });

  const scriptsCombined = scenes
    .map((s) => `--- scene ${s.order} (${s.beatTag ?? 'untagged'}) ---\n${s.script || '(no script)'}`)
    .join('\n\n')
    .slice(0, MAX_SCRIPTS_CHARS);

  const beatsForChapters = chapterEligibleScenes
    .map((s, i) => `  ${i + 1}. ${s.beatTag ?? 'scene'}: "${s.title}"`)
    .join('\n');

  const userPrompt = [
    systemPrompt,
    '',
    `SELECTED TITLE: ${titleText}`,
    `EPISODE TARGET RUNTIME: ${plan.targetRuntimeSeconds}s`,
    '',
    `CHAPTERS NEEDED (provide ${chapterEligibleScenes.length} labels in order):`,
    beatsForChapters,
    '',
    'SCRIPTS:',
    scriptsCombined,
  ].join('\n');

  // ---- LLM call with retry-once -----------------------------------------

  let parsedMeta: RawMetadata;
  let retried = false;

  try {
    const raw = await provider.generate(userPrompt, { timeoutMs });
    const parsed = tryParse(raw);
    if (!parsed.ok) {
      retried = true;
      const stricter = `${userPrompt}\n\nIMPORTANT: Your previous response was not parseable as JSON. Respond with ONLY a JSON object — no fences, no prose. Start with { and end with }.`;
      const raw2 = await provider.generate(stricter, { timeoutMs });
      const parsed2 = tryParse(raw2);
      if (!parsed2.ok) {
        throw new PlanningEngineError(
          STEP_NAME,
          'INVALID_OUTPUT',
          `LLM output did not parse after retry: ${parsed2.reason}`,
          { planId: plan.id, detail: parsed2.detail },
        );
      }
      const v2 = validateRaw(parsed2.value, chapterEligibleScenes.length);
      if (!v2.valid) {
        throw new PlanningEngineError(
          STEP_NAME,
          'INVALID_OUTPUT',
          `Metadata failed validation after retry: ${v2.reason}`,
          { planId: plan.id },
        );
      }
      parsedMeta = parsed2.value;
    } else {
      const v1 = validateRaw(parsed.value, chapterEligibleScenes.length);
      if (!v1.valid) {
        retried = true;
        const stricterValidation = `${userPrompt}\n\nIMPORTANT: Your previous response failed validation: ${v1.reason}. Respond with ONLY valid JSON matching the schema exactly. Start with { and end with }.`;
        const raw2 = await provider.generate(stricterValidation, { timeoutMs });
        const parsed2 = tryParse(raw2);
        if (!parsed2.ok) {
          throw new PlanningEngineError(
            STEP_NAME,
            'INVALID_OUTPUT',
            `LLM output did not parse after retry: ${parsed2.reason}`,
            { planId: plan.id, detail: parsed2.detail },
          );
        }
        const v2 = validateRaw(parsed2.value, chapterEligibleScenes.length);
        if (!v2.valid) {
          throw new PlanningEngineError(
            STEP_NAME,
            'INVALID_OUTPUT',
            `Metadata failed validation after retry: ${v2.reason}`,
            { planId: plan.id },
          );
        }
        parsedMeta = parsed2.value;
      } else {
        parsedMeta = parsed.value;
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

  // ---- Assemble final metadata (server merges timestamps with labels) ---

  const chapters = chapterTimestamps.map((ts, i) => ({
    timestampSeconds: ts,
    label: parsedMeta.chapterLabels[i]!,
  }));

  // Prepend timestamp list to the description for the YouTube upload form.
  const timestampList = chapters
    .map((c) => `${formatTimestamp(c.timestampSeconds)} — ${c.label}`)
    .join('\n');
  const description = `${parsedMeta.description}\n\n--- Chapters ---\n${timestampList}`;

  let written: PublishMetadata;
  try {
    written = await upsertPublishMetadata(
      deliverableId,
      {
        description,
        chapters,
        tags: parsedMeta.tags,
        pinnedComment: parsedMeta.pinnedComment,
        endScreenSuggestion: parsedMeta.endScreenSuggestion,
      },
      opts.db,
    );
  } catch (err) {
    throw new PlanningEngineError(
      STEP_NAME,
      'PERSIST_FAILED',
      `failed to persist publish metadata: ${(err as Error).message}`,
      { planId: plan.id, detail: { deliverableId } },
    );
  }

  // Patch deliverable publishMetadataId to the sentinel 'current'.
  await patchDeliverable(
    deliverableId,
    { publishMetadataId: 'current', status: 'metadata_ready' },
    opts.db,
  );

  // Long-form: advance plan status to metadata_generated (if at finalized).
  if (deliverable.kind === 'long_form' && plan.status === 'finalized') {
    await patchPlan(plan.id, { status: 'metadata_generated' }, opts.db);
  }

  const durationMs = Date.now() - t0;
  logger.info(
    {
      step: STEP_NAME,
      planId: plan.id,
      deliverableId,
      chapterCount: chapters.length,
      tagCount: parsedMeta.tags.length,
      retried,
      durationMs,
    },
    'publish metadata generated',
  );

  return { metadata: written, retried, durationMs };
}

/**
 * Render the YouTube-Studio-paste-ready bundle. Plain text, deterministic
 * sections. Used by the GET /deliverables/:id/publish/bundle route.
 */
export function renderPublishBundle(opts: {
  title: string;
  metadata: PublishMetadata;
}): string {
  const { title, metadata } = opts;
  const chaptersBlock = metadata.chapters
    .map((c) => `${formatTimestamp(c.timestampSeconds)} ${c.label}`)
    .join('\n');
  const tagsBlock = metadata.tags.join(', ');

  return [
    '=== TITLE ===',
    title,
    '',
    '=== DESCRIPTION ===',
    metadata.description,
    '',
    '=== CHAPTERS ===',
    chaptersBlock,
    '',
    '=== TAGS ===',
    tagsBlock,
    '',
    '=== PINNED COMMENT ===',
    metadata.pinnedComment,
    '',
    '=== END SCREEN ===',
    metadata.endScreenSuggestion,
    '',
  ].join('\n');
}
