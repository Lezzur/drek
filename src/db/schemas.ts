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

export const PLAN_TYPES = ['cover_letter', 'youtube'] as const;
export type PlanType = (typeof PLAN_TYPES)[number];

export const PLAN_STATUSES = [
  'awaiting_review',         // polled from Neurocore, not yet triaged by Rick
  'dismissed',               // Rick chose not to plan this listing
  'requirements_reviewed',   // requirement extraction confirmed
  'projects_matched',        // project matches confirmed
  'scenes_generated',        // scenes + scripts written, ready for review
  'finalized',               // Rick finished editing
  'exported',                // shoot instructions exported at least once
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
 *  them to Date before/after the schema. */
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
});
export type Plan = z.infer<typeof planSchema>;

/** Subset of fields accepted when creating a plan. Server fills in the rest. */
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
});
export type PlanCreate = z.infer<typeof planCreateSchema>;

/** Fields a PATCH can touch. Status transitions are validated separately
 *  via `isAllowedPlanTransition`. */
export const planPatchSchema = z
  .object({
    status: z.enum(PLAN_STATUSES),
    title: z.string().min(1),
    requirements: z.array(requirementSchema),
    matchedProjects: z.array(matchedProjectSchema),
    targetRuntimeSeconds: z.number().int().min(MIN_RUNTIME).max(MAX_RUNTIME),
    estimatedRuntimeSeconds: z.number().int().nonnegative(),
    userConstraints: z.string().nullable(),
  })
  .partial();
export type PlanPatch = z.infer<typeof planPatchSchema>;

/** Allowed status transitions. Pulled out so route handlers and tests share
 *  one source of truth. */
const PLAN_TRANSITIONS: Record<PlanStatus, PlanStatus[]> = {
  awaiting_review: ['dismissed', 'requirements_reviewed'],
  dismissed: ['awaiting_review'],
  requirements_reviewed: ['projects_matched', 'dismissed'],
  projects_matched: ['scenes_generated', 'requirements_reviewed'],
  scenes_generated: ['finalized', 'projects_matched'],
  finalized: ['exported', 'scenes_generated'],
  exported: ['finalized'],
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
