import { z } from 'zod';

/**
 * Zod schemas for every DREK entity stored in Firestore. These are the
 * single source of truth — DB code, route handlers, and tests all use
 * them. Anything that touches a Firestore doc should pass through one of
 * these on the way in or out.
 */

// ---------------------------------------------------------------------------
// Plans (top-level collection)
// ---------------------------------------------------------------------------

// v2: `youtube` renamed `youtube_lite`; `youtube_advanced` is the new
// type that drives the YouTube Channel Operating System pipeline. Migration
// script (scripts/migrate-youtube-to-youtube-lite.ts) flips existing
// `youtube` documents to `youtube_lite` during the v2 deploy window.
export const PLAN_TYPES = ['cover_letter', 'youtube_lite', 'youtube_advanced'] as const;
export type PlanType = (typeof PLAN_TYPES)[number];

export const PLAN_STATUSES = [
  'awaiting_review',         // polled from Neurocore, not yet triaged by Rick
  'dismissed',               // Rick chose not to plan this listing
  'requirements_reviewed',   // requirement extraction confirmed
  'projects_matched',        // project matches confirmed
  'scenes_generated',        // scenes + scripts written, ready for review
  'finalized',               // Rick finished editing
  'exported',                // shoot instructions exported at least once
  // ---- v2 additions (only reachable from youtube_advanced plans) ---------
  'hooks_generated',         // 3-4 hook variants ready, awaiting Rick's pick
  'hook_selected',           // Rick picked a hook; script writer can use it
  'shot_list_generated',     // per-scene shot lists produced
  'titles_generated',        // 5-10 title variants ready (long-form)
  'title_selected',          // Rick picked a title
  'thumbnails_generated',    // 3-5 thumbnail concepts ready
  'thumbnail_selected',      // Rick picked a thumbnail concept
  'shorts_extracted',        // Shorts candidates produced, awaiting approval
  'metadata_generated',      // publishing metadata produced (post-finalize)
] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

/** A single demonstration requirement extracted from a listing (or entered
 *  manually). Cover-letter mode populates this; YouTube mode usually
 *  skips it. */
export const requirementSchema = z.object({
  skill: z.string().min(1),
  category: z.string().min(1),
  priority: z.enum(['must_show', 'nice_to_show']),
  evidence: z.string(),
});
export type Requirement = z.infer<typeof requirementSchema>;

/** A matched project the LLM picked from Neurocore's catalog, with the
 *  metadata DREK needs to compose scenes around it. */
export const matchedProjectSchema = z.object({
  projectSlug: z.string().min(1),
  projectName: z.string().min(1),
  matchedFeatures: z.array(z.string()),
  relevanceScore: z.number().min(0).max(1),
  suggestedDemoSequence: z.string(),
});
export type MatchedProject = z.infer<typeof matchedProjectSchema>;

const MIN_RUNTIME = 30;
const MAX_RUNTIME = 3_600;

/** A Plan document, validated for both reads and writes. createdAt/updatedAt
 *  arrive from Firestore as `Timestamp` objects; the calling code converts
 *  them to Date before/after the schema.
 *
 *  v2 added six additive fields (all nullable / defaulted to null) so v1
 *  cover_letter and youtube_lite documents continue to parse without
 *  migration. The v2 fields are only meaningful for type='youtube_advanced'. */
export const planSchema = z.object({
  id: z.string().min(1),
  type: z.enum(PLAN_TYPES),
  status: z.enum(PLAN_STATUSES),
  title: z.string().min(1),
  sourceListingId: z.string().nullable(),
  sourceListingText: z.string().nullable(),
  requirements: z.array(requirementSchema).default([]),
  matchedProjects: z.array(matchedProjectSchema).default([]),
  targetRuntimeSeconds: z.number().int().min(MIN_RUNTIME).max(MAX_RUNTIME),
  estimatedRuntimeSeconds: z.number().int().nonnegative().default(0),
  userConstraints: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
  exportedAt: z.date().nullable(),
  // ---- v2 additive fields -------------------------------------------------
  /** FORMAT_PROFILES registry key. Required at the route layer for
   *  type='youtube_advanced'; null for v1 plan types. */
  formatProfileId: z.string().nullable().default(null),
  /** PipelineBrief reference if this plan was promoted from intake. */
  pipelineBriefId: z.string().nullable().default(null),
  /** Absolute path on disk for the plan's workspace folder. Null until the
   *  workspace module has successfully created the directory. */
  workspacePath: z.string().nullable().default(null),
  /** Selected HookDraft id (from plans/{planId}/hook_drafts). */
  selectedHookVariantId: z.string().nullable().default(null),
  /** Selected TitleConcept id on the long-form Deliverable. */
  selectedTitleVariantId: z.string().nullable().default(null),
  /** Selected ThumbnailConcept id on the long-form Deliverable. */
  selectedThumbnailConceptId: z.string().nullable().default(null),
});
export type Plan = z.infer<typeof planSchema>;

/** Subset of fields accepted when creating a plan. Server fills in the rest.
 *  formatProfileId + pipelineBriefId are optional here — required at the
 *  route layer when type='youtube_advanced'. */
export const planCreateSchema = z.object({
  type: z.enum(PLAN_TYPES),
  title: z.string().min(1),
  targetRuntimeSeconds: z
    .number()
    .int()
    .min(MIN_RUNTIME)
    .max(MAX_RUNTIME),
  sourceListingId: z.string().nullable().optional(),
  sourceListingText: z.string().nullable().optional(),
  userConstraints: z.string().nullable().optional(),
  status: z.enum(PLAN_STATUSES).optional(),
  // v2 additive — optional at the schema level, required by route handlers
  // when type='youtube_advanced'.
  formatProfileId: z.string().nullable().optional(),
  pipelineBriefId: z.string().nullable().optional(),
});
export type PlanCreate = z.infer<typeof planCreateSchema>;

/** Fields a PATCH can touch. Status transitions are validated separately
 *  via `isAllowedPlanTransition`.
 *
 *  v2: formatProfileId is patchable (change-format flow per tech-spec §4.9
 *  uses this). selectedHookVariantId / selectedTitleVariantId /
 *  selectedThumbnailConceptId are patchable via the dedicated select-X
 *  routes. workspacePath is patchable (retry-create-workspace flow).
 *  pipelineBriefId is NOT patchable — set once at plan creation. */
export const planPatchSchema = z
  .object({
    status: z.enum(PLAN_STATUSES),
    title: z.string().min(1),
    requirements: z.array(requirementSchema),
    matchedProjects: z.array(matchedProjectSchema),
    targetRuntimeSeconds: z.number().int().min(MIN_RUNTIME).max(MAX_RUNTIME),
    estimatedRuntimeSeconds: z.number().int().nonnegative(),
    userConstraints: z.string().nullable(),
    formatProfileId: z.string().nullable(),
    workspacePath: z.string().nullable(),
    selectedHookVariantId: z.string().nullable(),
    selectedTitleVariantId: z.string().nullable(),
    selectedThumbnailConceptId: z.string().nullable(),
  })
  .partial();
export type PlanPatch = z.infer<typeof planPatchSchema>;

/** Allowed status transitions. Pulled out so route handlers and tests share
 *  one source of truth.
 *
 *  v1 transitions preserved. v2 adds nine new statuses + corresponding
 *  transitions per TECH-SPEC §4.3 — only reachable via the youtube_advanced
 *  workflow.
 *
 *  v2 path: scenes_generated → hooks_generated → hook_selected →
 *  shot_list_generated → titles_generated → title_selected →
 *  thumbnails_generated → thumbnail_selected → shorts_extracted →
 *  finalized → metadata_generated → exported.
 *
 *  Backwards transitions on the v2 path allow Rick to re-run any earlier
 *  step (e.g., regenerate scenes from hooks_generated). The change-format
 *  flow (TECH-SPEC §4.9) is a hard reset back to projects_matched that
 *  wipes derived data via a Firestore batch, not a normal transition. */
const PLAN_TRANSITIONS: Record<PlanStatus, PlanStatus[]> = {
  // v1
  awaiting_review: ['dismissed', 'requirements_reviewed'],
  dismissed: ['awaiting_review'],
  requirements_reviewed: ['projects_matched', 'dismissed'],
  projects_matched: ['scenes_generated', 'requirements_reviewed'],
  // scenes_generated keeps its v1 transitions and gets one v2 forward path
  scenes_generated: ['finalized', 'projects_matched', 'hooks_generated'],
  // finalized keeps its v1 transitions and gets one v2 forward path
  finalized: ['exported', 'scenes_generated', 'metadata_generated'],
  exported: ['finalized'],
  // v2 statuses (youtube_advanced only)
  hooks_generated: ['hook_selected', 'scenes_generated'],
  hook_selected: ['shot_list_generated', 'hooks_generated'],
  shot_list_generated: ['titles_generated', 'hook_selected'],
  titles_generated: ['title_selected', 'shot_list_generated'],
  title_selected: ['thumbnails_generated', 'titles_generated'],
  thumbnails_generated: ['thumbnail_selected', 'title_selected'],
  thumbnail_selected: ['shorts_extracted', 'thumbnails_generated'],
  shorts_extracted: ['finalized', 'thumbnail_selected'],
  metadata_generated: ['exported', 'finalized'],
};

export function isAllowedPlanTransition(from: PlanStatus, to: PlanStatus): boolean {
  if (from === to) return true;
  return PLAN_TRANSITIONS[from].includes(to);
}

// ---------------------------------------------------------------------------
// Scenes (subcollection under each plan)
// ---------------------------------------------------------------------------

export const SCENE_INTERFACE_TYPES = [
  'web-ui',
  'terminal',
  'api-response',
  'code-walkthrough',
  'diagram',
  'logs',
  'headshot',
] as const;
export type SceneInterfaceType = (typeof SCENE_INTERFACE_TYPES)[number];

/** v2 shot list item — used for both primary shot, B-roll, and supplementary
 *  shot list items (one shape, three lists). */
export const SHOT_ITEM_SOURCES = [
  'record_during_scene',
  'pull_from_finished_demo',
  'reuse_from_episode',
  'generate_with_tool',
] as const;
export type ShotItemSource = (typeof SHOT_ITEM_SOURCES)[number];

export const brollItemSchema = z.object({
  type: z.enum(SCENE_INTERFACE_TYPES),
  description: z.string().min(1).max(500),
  source: z.enum(SHOT_ITEM_SOURCES),
  durationSeconds: z.number().int().min(1).max(600),
});
export type BrollItem = z.infer<typeof brollItemSchema>;

export const ON_SCREEN_TEXT_STYLES = [
  'callout',
  'quote',
  'chapter_marker',
  'footnote',
] as const;
export type OnScreenTextStyle = (typeof ON_SCREEN_TEXT_STYLES)[number];

export const onScreenTextOverlaySchema = z.object({
  textContent: z.string().min(1).max(80),
  timingHint: z.string().min(1).max(200),
  styleHint: z.enum(ON_SCREEN_TEXT_STYLES),
});
export type OnScreenTextOverlay = z.infer<typeof onScreenTextOverlaySchema>;

export const cutPointSchema = z.object({
  scriptLineNumber: z.number().int().nonnegative(),
  reason: z.string().min(1).max(300),
});
export type CutPoint = z.infer<typeof cutPointSchema>;

export const primaryShotSchema = z.object({
  type: z.enum(SCENE_INTERFACE_TYPES),
  description: z.string().min(1).max(500),
});
export type PrimaryShot = z.infer<typeof primaryShotSchema>;

export const sceneSchema = z.object({
  id: z.string().min(1),
  planId: z.string().min(1),
  order: z.number().int().min(1),
  title: z.string().min(1),
  description: z.string(),
  framingNotes: z.string(),
  script: z.string(),
  scriptDraft: z.string().default(''),
  emphasisCues: z.array(z.string()).default([]),
  pacingNotes: z.string().default(''),
  transitionNote: z.string().default(''),
  estimatedDurationSeconds: z.number().int().nonnegative().default(0),
  projectRef: z.string().nullable().default(null),
  // Reserved for v2 image generation — always null in v1, but typed in so
  // we don't need a schema migration when it lands.
  storyboardImageUrl: z.string().nullable().default(null),
  // ---- v2 additive fields (only populated for youtube_advanced) -----------
  /** Format-profile beat name (e.g. `cold_open`, `war_room`). Null for v1
   *  plan types. */
  beatTag: z.string().nullable().default(null),
  /** Per-scene primary shot — overrides framingNotes in v2 UIs but doesn't
   *  replace it (framingNotes stays as the v1 free-text field). */
  primaryShot: primaryShotSchema.nullable().default(null),
  /** B-roll suggestions to film. */
  brollItems: z.array(brollItemSchema).default([]),
  /** Supplementary shot list items beyond primaryShot. */
  shotListItems: z.array(brollItemSchema).default([]),
  /** Text overlays the editor should add on screen during this scene. */
  onScreenTextOverlays: z.array(onScreenTextOverlaySchema).default([]),
  /** Cut points the editor should respect within this scene. */
  cutPoints: z.array(cutPointSchema).default([]),
});
export type Scene = z.infer<typeof sceneSchema>;

export const sceneCreateSchema = sceneSchema.omit({ id: true, planId: true }).partial({
  order: true,
  description: true,
  framingNotes: true,
  script: true,
  scriptDraft: true,
  emphasisCues: true,
  pacingNotes: true,
  transitionNote: true,
  estimatedDurationSeconds: true,
  projectRef: true,
  storyboardImageUrl: true,
  // v2 fields all default at the schema level — partial here so callers
  // can omit them entirely when creating v1 scenes.
  beatTag: true,
  primaryShot: true,
  brollItems: true,
  shotListItems: true,
  onScreenTextOverlays: true,
  cutPoints: true,
});
export type SceneCreate = z.infer<typeof sceneCreateSchema>;

export const scenePatchSchema = sceneSchema
  .omit({ id: true, planId: true, order: true })
  .partial();
export type ScenePatch = z.infer<typeof scenePatchSchema>;

// ---------------------------------------------------------------------------
// Available listings (top-level collection)
// ---------------------------------------------------------------------------

/** Listings DREK fetched from Neurocore that DIDN'T have requiresVideo=true.
 *  Rick browses these and can manually pick one to plan a cover letter for —
 *  see PRD 4.1 / 5.3. */
export const availableListingSchema = z.object({
  id: z.string().min(1),         // PI's listing id (also Neurocore's memory id)
  title: z.string().min(1),
  company: z.string().nullable(),
  summary: z.string().nullable(),
  rawText: z.string().nullable(),
  receivedAt: z.date(),
  selectedAt: z.date().nullable(),
  planId: z.string().nullable(), // set once Rick picks this listing
});
export type AvailableListing = z.infer<typeof availableListingSchema>;

export const availableListingCreateSchema = availableListingSchema
  .omit({ receivedAt: true, selectedAt: true, planId: true })
  .extend({
    receivedAt: z.date().optional(),
  });
export type AvailableListingCreate = z.infer<typeof availableListingCreateSchema>;

// ---------------------------------------------------------------------------
// Polling config (single doc under `config/polling`)
// ---------------------------------------------------------------------------

const MIN_POLL_INTERVAL_MS = 60 * 1000;        // 1 min — guardrail
const DEFAULT_POLL_INTERVAL_MS = 30 * 60_000;  // 30 min — PRD 4.1

export const pollingConfigSchema = z.object({
  lastPollAt: z.date().nullable().default(null),
  pollingEnabled: z.boolean().default(true),
  pollingIntervalMs: z
    .number()
    .int()
    .min(MIN_POLL_INTERVAL_MS)
    .default(DEFAULT_POLL_INTERVAL_MS),
});
export type PollingConfig = z.infer<typeof pollingConfigSchema>;

export const DEFAULT_POLLING_CONFIG: PollingConfig = {
  lastPollAt: null,
  pollingEnabled: true,
  pollingIntervalMs: DEFAULT_POLL_INTERVAL_MS,
};

// ===========================================================================
// v2 entities — YouTube Channel Operating System
// ===========================================================================
//
// All schemas below ship with DREK v2 and are only populated when a Plan has
// type='youtube_advanced'. v1 (cover_letter / youtube_lite) plans never write
// to these collections.

// ---------------------------------------------------------------------------
// Deliverable (top-level collection)
// ---------------------------------------------------------------------------

export const DELIVERABLE_KINDS = ['long_form', 'short_clip', 'lead_magnet'] as const;
export type DeliverableKind = (typeof DELIVERABLE_KINDS)[number];

export const DELIVERABLE_STATUSES = [
  'draft',
  'scripts_ready',
  'metadata_ready',
  'exported',
  'published',
] as const;
export type DeliverableStatus = (typeof DELIVERABLE_STATUSES)[number];

/** A Short candidate's reworked script can diverge from the long-form's
 *  scene scripts — kept as a simple ordered list of strings to avoid a
 *  full Scene subcollection per Deliverable. */
export const customShortScriptSchema = z.object({
  /** Optional reference to the source long-form scene id. Null when the
   *  Short re-arranges the long-form into a different narrative order. */
  sourceSceneId: z.string().nullable(),
  script: z.string().min(1).max(5_000),
});
export type CustomShortScript = z.infer<typeof customShortScriptSchema>;

export const deliverableSchema = z.object({
  id: z.string().min(1),
  planId: z.string().min(1),
  kind: z.enum(DELIVERABLE_KINDS),
  /** Neurocore AudienceProfile id this deliverable was authored for. */
  audienceProfileId: z.string().min(1),
  title: z.string().min(1).max(200),
  status: z.enum(DELIVERABLE_STATUSES),
  /** For Shorts: which long-form scene ids the Short was extracted from.
   *  Null for long_form Deliverables (which use the parent plan's scenes). */
  scriptOverrideSceneIds: z.array(z.string().min(1)).nullable().default(null),
  /** For Shorts: the reworked scripts when they don't simply quote the
   *  long-form. Null for long_form (which uses the parent plan's scenes). */
  customScripts: z.array(customShortScriptSchema).nullable().default(null),
  selectedTitleVariantId: z.string().nullable().default(null),
  selectedThumbnailConceptId: z.string().nullable().default(null),
  publishMetadataId: z.string().nullable().default(null),
  /** YouTube URL once Rick has published the deliverable. */
  youtubeUrl: z.string().url().nullable().default(null),
  publishedAt: z.date().nullable().default(null),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type Deliverable = z.infer<typeof deliverableSchema>;

export const deliverableCreateSchema = deliverableSchema
  .omit({ id: true, createdAt: true, updatedAt: true })
  .partial({
    status: true,
    scriptOverrideSceneIds: true,
    customScripts: true,
    selectedTitleVariantId: true,
    selectedThumbnailConceptId: true,
    publishMetadataId: true,
    youtubeUrl: true,
    publishedAt: true,
  });
export type DeliverableCreate = z.infer<typeof deliverableCreateSchema>;

export const deliverablePatchSchema = deliverableSchema
  .omit({ id: true, planId: true, kind: true, createdAt: true, updatedAt: true })
  .partial();
export type DeliverablePatch = z.infer<typeof deliverablePatchSchema>;

// ---------------------------------------------------------------------------
// PipelineBrief (top-level collection — intake module)
// ---------------------------------------------------------------------------

export const BRIEF_STAGES = [
  'candidate',
  'vetted',
  'selected',
  'in_production',
  'published',
  'retired',
] as const;
export type BriefStage = (typeof BRIEF_STAGES)[number];

const SCORE_MIN = 1;
const SCORE_MAX = 5;

export const briefScoreSchema = z.object({
  /** Will the finished build produce something visually compelling? */
  visualOutcome: z.number().int().min(SCORE_MIN).max(SCORE_MAX),
  /** Does the brief contain natural narrative arcs? */
  storyPotential: z.number().int().min(SCORE_MIN).max(SCORE_MAX),
  /** Is this completable in a 4-hour Claude Code session? */
  scopeFit: z.number().int().min(SCORE_MIN).max(SCORE_MAX),
  /** How well does this match developer_longform audience? */
  audienceMatch: z.number().int().min(SCORE_MIN).max(SCORE_MAX),
  /** Mean of the four dimensions, to one decimal. */
  aggregate: z.number().min(SCORE_MIN).max(SCORE_MAX),
});
export type BriefScore = z.infer<typeof briefScoreSchema>;

const MAX_BRIEF_RAW_TEXT_BYTES = 50_000;

export const pipelineBriefSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(300),
  company: z.string().nullable(),
  sourceUrl: z.string().url().nullable(),
  rawText: z.string().min(1).max(MAX_BRIEF_RAW_TEXT_BYTES),
  score: briefScoreSchema.nullable().default(null),
  scoringRationale: z.string().nullable().default(null),
  stage: z.enum(BRIEF_STAGES),
  promotedPlanId: z.string().nullable().default(null),
  /** v2.1: group briefs submitted in the same batch-intake form. Null for
   *  briefs created via the single-brief intake or pre-v2.1 docs. */
  batchId: z.string().nullable().default(null),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type PipelineBrief = z.infer<typeof pipelineBriefSchema>;

export const pipelineBriefCreateSchema = pipelineBriefSchema
  .omit({ id: true, createdAt: true, updatedAt: true })
  .partial({
    score: true,
    scoringRationale: true,
    stage: true,
    promotedPlanId: true,
    company: true,
    sourceUrl: true,
    batchId: true,
  });
export type PipelineBriefCreate = z.infer<typeof pipelineBriefCreateSchema>;

export const pipelineBriefPatchSchema = pipelineBriefSchema
  .omit({ id: true, createdAt: true, updatedAt: true })
  .partial();
export type PipelineBriefPatch = z.infer<typeof pipelineBriefPatchSchema>;

const BRIEF_STAGE_TRANSITIONS: Record<BriefStage, BriefStage[]> = {
  candidate: ['vetted', 'retired'],
  vetted: ['selected', 'candidate', 'retired'],
  selected: ['in_production', 'vetted', 'retired'],
  in_production: ['published', 'selected', 'retired'],
  published: ['retired'],
  retired: ['candidate'],
};

export function isAllowedBriefStageTransition(from: BriefStage, to: BriefStage): boolean {
  if (from === to) return true;
  return BRIEF_STAGE_TRANSITIONS[from].includes(to);
}

// ---------------------------------------------------------------------------
// HookDraft (subcollection plans/{planId}/hook_drafts)
// ---------------------------------------------------------------------------

export const HOOK_ARCHETYPES = [
  'pattern_interrupt',
  'bold_claim',
  'retention_question',
  'story_cold_open',
  'demo_first',
] as const;
export type HookArchetype = (typeof HOOK_ARCHETYPES)[number];

export const hookDraftSchema = z.object({
  id: z.string().min(1),
  archetype: z.enum(HOOK_ARCHETYPES),
  /** 30-60 word draft of the first 10-15 seconds. Bounds enforced as
   *  characters here; LLM word-count validation lives in the engine step. */
  scriptText: z.string().min(50).max(1_000),
  predictedRetention: z.string().min(1).max(500),
  selected: z.boolean().default(false),
  createdAt: z.date(),
});
export type HookDraft = z.infer<typeof hookDraftSchema>;

export const hookDraftCreateSchema = hookDraftSchema
  .omit({ id: true, createdAt: true })
  .partial({ selected: true });
export type HookDraftCreate = z.infer<typeof hookDraftCreateSchema>;

// ---------------------------------------------------------------------------
// TitleConcept (subcollection deliverables/{deliverableId}/title_concepts)
// ---------------------------------------------------------------------------

export const TITLE_ARCHETYPES = [
  'curiosity_gap',
  'specificity',
  'payoff_promise',
  'controversy_hook',
  'numbered_listicle',
  'question_format',
  'before_after',
] as const;
export type TitleArchetype = (typeof TITLE_ARCHETYPES)[number];

export const titleConceptSchema = z.object({
  id: z.string().min(1),
  titleText: z.string().min(1).max(70),
  archetype: z.enum(TITLE_ARCHETYPES),
  predictedClickability: z.number().int().min(1).max(10),
  reasoning: z.string().min(1).max(500),
  keywordsSurfaced: z.array(z.string().min(1).max(50)).default([]),
  selected: z.boolean().default(false),
  createdAt: z.date(),
});
export type TitleConcept = z.infer<typeof titleConceptSchema>;

export const titleConceptCreateSchema = titleConceptSchema
  .omit({ id: true, createdAt: true })
  .partial({ selected: true, keywordsSurfaced: true });
export type TitleConceptCreate = z.infer<typeof titleConceptCreateSchema>;

// ---------------------------------------------------------------------------
// ThumbnailConcept (subcollection deliverables/{deliverableId}/thumbnail_concepts)
// ---------------------------------------------------------------------------

const HEX_COLOR_REGEX = /^#[0-9a-fA-F]{6}$/;

/** Enforce ≤4 words for the on-thumbnail text hook. Implemented as a regex
 *  rather than .refine() so the message is clear and the constraint is
 *  visible in the schema. */
const TEXT_HOOK_REGEX = /^(?:\S+(?:\s+\S+){0,3})$/;

export const thumbnailConceptSchema = z.object({
  id: z.string().min(1),
  composition: z.string().min(1).max(500),
  textHook: z
    .string()
    .min(1)
    .max(120)
    .regex(TEXT_HOOK_REGEX, 'textHook must be 1-4 words'),
  expression: z.string().nullable().default(null),
  colorPalette: z
    .array(z.string().regex(HEX_COLOR_REGEX, 'palette entries must be #RRGGBB'))
    .min(1)
    .max(5),
  assetsRequired: z.array(z.string().min(1).max(200)).default([]),
  conceptSummary: z.string().min(1).max(500),
  selected: z.boolean().default(false),
  createdAt: z.date(),
});
export type ThumbnailConcept = z.infer<typeof thumbnailConceptSchema>;

export const thumbnailConceptCreateSchema = thumbnailConceptSchema
  .omit({ id: true, createdAt: true })
  .partial({ selected: true, assetsRequired: true, expression: true });
export type ThumbnailConceptCreate = z.infer<typeof thumbnailConceptCreateSchema>;

// ---------------------------------------------------------------------------
// PublishMetadata (single doc 'current' under each deliverable)
// ---------------------------------------------------------------------------

export const chapterMarkerSchema = z.object({
  timestampSeconds: z.number().int().nonnegative(),
  label: z.string().min(1).max(120),
});
export type ChapterMarker = z.infer<typeof chapterMarkerSchema>;

export const publishMetadataSchema = z.object({
  description: z.string().min(1).max(5_000),
  chapters: z.array(chapterMarkerSchema).min(1).max(50),
  tags: z.array(z.string().min(1).max(50)).min(1).max(20),
  pinnedComment: z.string().min(1).max(500),
  endScreenSuggestion: z.string().min(1).max(500),
  generatedAt: z.date(),
  lastEditedAt: z.date().nullable().default(null),
});
export type PublishMetadata = z.infer<typeof publishMetadataSchema>;

export const publishMetadataCreateSchema = publishMetadataSchema.omit({
  generatedAt: true,
  lastEditedAt: true,
});
export type PublishMetadataCreate = z.infer<typeof publishMetadataCreateSchema>;

export const publishMetadataPatchSchema = publishMetadataSchema
  .omit({ generatedAt: true })
  .partial();
export type PublishMetadataPatch = z.infer<typeof publishMetadataPatchSchema>;

// ---------------------------------------------------------------------------
// RecordingSession (top-level collection — footage manifest)
// ---------------------------------------------------------------------------

export const RECORDING_SESSION_TYPES = [
  'build_session',
  'demo_session',
  'reflection',
  'b_roll',
  'screen_capture',
] as const;
export type RecordingSessionType = (typeof RECORDING_SESSION_TYPES)[number];

export const recordingSessionSchema = z.object({
  id: z.string().min(1),
  planId: z.string().min(1),
  dateRecorded: z.date(),
  sessionType: z.enum(RECORDING_SESSION_TYPES),
  /** Workspace-relative or absolute filesystem path. */
  filePath: z.string().min(1).max(1_000),
  durationSeconds: z.number().int().min(1).max(86_400),
  /** Scene ids this session covers. Coverage is recomputed on read so
   *  scenes that are renamed in a regeneration don't cause stale state. */
  scenesCovered: z.array(z.string().min(1)).min(1),
  notes: z.string().nullable().default(null),
  createdAt: z.date(),
});
export type RecordingSession = z.infer<typeof recordingSessionSchema>;

export const recordingSessionCreateSchema = recordingSessionSchema
  .omit({ id: true, createdAt: true })
  .partial({ notes: true });
export type RecordingSessionCreate = z.infer<typeof recordingSessionCreateSchema>;
