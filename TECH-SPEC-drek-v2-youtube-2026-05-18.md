# DREK v2 — Technical Specification

**Author:** Tony Stark
**Status:** Draft
**Last Updated:** 2026-05-18
**Reviewers:** @lisa (PRD), @rick (final approval)
**PRD Reference:** `PRD-drek-v2-youtube-2026-05-18.md` (commit `7dc4a59`)
**Predecessor:** `TECH-SPEC-drek-2026-05-15.md` — v1 spec, still authoritative for everything not redefined here
**Repository:** `Lezzur/drek` (extends v1 in place — no new repo)

---

## 1. Overview

DREK v2 extends the shipped v1 service into a YouTube channel operating system. The v1 product plans video scripts; v2 plans entire video productions and their downstream artifacts (titles, thumbnails, B-roll, Shorts, publishing metadata) for a developer-first YouTube channel that doubles as Rick's client funnel.

The v1 core (Hono + HTMX + Firestore + LLM provider abstraction + Neurocore client + polling service + NSSM service wrapper) is preserved and reused. v2 adds:

1. A new top-level entity — `Deliverable` — that sits between `Plan` and the per-artifact scenes/scripts/metadata. A plan now produces many deliverables (one long-form + N Shorts + future formats), each bound to its own audience.
2. A **Neurocore-side** `AudienceProfile` entity, fetched per-deliverable and injected verbatim into generation prompts.
3. A **format profile** registry (TypeScript constants) defining structural rules per video format (build-along, tutorial, case study, etc.).
4. Five new engine steps: hook variant generation, shot list generation, title variant generation, thumbnail concept generation, Shorts candidate extraction, publishing metadata generation.
5. An upstream **intake** module (named to avoid collision with the existing `pipeline.ts` LLM orchestrator) for sourcing and scoring candidate briefs from Upwork/Freelancer.
6. A **workspace** module that materializes a deterministic folder layout per plan on disk.
7. A **footage manifest** module for tracking recording sessions per plan.
8. Three new Neurocore endpoints + one new signal type (`script.published`).

The hard problems are: (1) cleanly composing two prompt registries (format-side + audience-side) without mode-blending, (2) extending the plan-status state machine without breaking v1's status invariants, (3) coordinating two parallel build tracks (Neurocore CRUD + DREK consumer) within the same M14 window, and (4) keeping the existing v1 cover-letter pipeline untouched while v2 capability ships alongside it.

## 2. Context and Background

- **Current system state.** DREK v1 shipped (commits M0-M13 + post-M13 polish: Firestore-backed LLM settings page, single "Run Pipeline" orchestrator at `src/engine/pipeline.ts`, scriptDraft tracking for edit detection, Codex CLI support, CLAUDE.md). 308+ tests passing. NSSM service `DREK` runs at `http://localhost:3003`. Firebase project: `red-tool-8193c` (production DREK Firestore). The post-M13 work has not changed any v1 contract — Plan/Scene schemas are stable.
- **Problem.** v1's YouTube mode is a single composition template (`YOUTUBE_RULES`) producing only scene cards + scripts. No titles, no thumbnails, no hooks, no shot lists, no Shorts, no publishing metadata, no format diversity. Rick is launching a YouTube channel as a client acquisition funnel and needs the full operating system, not just the scripting half.
- **Motivation.** The PRD documents 8 specific gaps in v1's YouTube capability + 9 of 14 modules from the YouTube channel master document. v2 closes the gaps and ships the modules.
- **Constraints.** Same as v1: single user, no auth, desktop Chrome only, Windows host with NSSM. v2 adds: AudienceProfile must live in Neurocore (Rick's directive — common-denominator data across future apps); existing v1 capability must remain functional during and after v2 ships.
- **Related systems.** Neurocore (now owns AudienceProfile + `script.published` signal handler), PI (unchanged — still emits `listing.ingested` signals), DREK Firestore (extended schema), Claude CLI / Codex CLI (existing providers, unchanged).

## 3. Goals and Non-Goals

### Goals

- Ship 9 of 14 modules from the channel master document (Pipeline/Sourcing, Workspace, Brief/PRD, Episode Outline, Footage Manifest, Script/Voiceover, Title/Thumbnail Workshop, Publishing Metadata, Shorts Extractor).
- Close all 8 gaps from the DREK YouTube critique (titles/thumbnails, hooks, format diversity, shot list, chapters/description/tags, Shorts, performance loop *partial*, external research *deferred*).
- AudienceProfile as a first-class Neurocore entity, with at least 2 seed profiles (`developer_longform`, `business_owner_shorts`) shipping at v2 launch.
- Format profile registry with `claude_code_build_along` + 6 other profiles, each implementing the same `FormatProfile` interface.
- Per-deliverable artifact model: one plan, many deliverables, each with its own audience binding.
- All v1 cover-letter and `youtube_lite` plans continue to function unchanged.
- Two-track M14: Neurocore AudienceProfile CRUD + DREK consumer plumbing complete in parallel within week 1-2.

### Non-Goals

- Thumbnail image generation. Thumbnails are text-only structured concepts in v2; image generation is v3.
- YouTube API integration. No upload automation, no analytics ingestion. (Analytics deferred to v2.1, upload deferred indefinitely.)
- Lead/CRM layer (Module 10). Deferred to v2.1.
- Community/paid content bridge (Module 12), contract/legal templates (Module 13), time/cost tracker (Module 14). All deferred to v3.
- External research integration (gap #8). Deferred to v2.1.
- Multi-user, multi-tenant, mobile, responsive design. Same v1 boundaries.
- Migration of existing v1 plans into `youtube_advanced`. v1 plans stay typed as `cover_letter` or `youtube_lite` (the renamed `youtube` enum value) forever. v2 only applies to *new* plans created with type `youtube_advanced`.

## 4. Proposed Architecture

### 4.1 High-Level Design

v1 architecture preserved verbatim. v2 adds the bracketed components:

```
                          ┌───────────────────────────────────────────┐
                          │                  DREK                      │
                          │                                            │
  Browser ───── HTTP ────▶│  ┌──────────┐  ┌────────────────────────┐ │
  (Rick)                  │  │  Hono    │  │  Planning Engine        │ │
                          │  │  Routes  │  │  ┌───────────────────┐  │ │
                          │  │  + HTMX  │  │  │ v1: detect-req,   │  │ │
                          │  └────┬─────┘  │  │  match-projects,  │  │ │
                          │       │        │  │  generate-scenes, │  │ │
                          │       │        │  │  write-scripts    │  │ │
                          │       │        │  ├───────────────────┤  │ │
                          │       │        │  │ v2 NEW:           │  │ │
                          │       │        │  │  generate-hook-   │  │ │
                          │       │        │  │   variants,       │  │ │
                          │       │        │  │  generate-shot-   │  │ │
                          │       │        │  │   list,           │  │ │
                          │       │        │  │  generate-title-  │  │ │
                          │       │        │  │   variants,       │  │ │
                          │       │        │  │  generate-thumb-  │  │ │
                          │       │        │  │   concepts,       │  │ │
                          │       │        │  │  extract-shorts,  │  │ │
                          │       │        │  │  generate-publish-│  │ │
                          │       │        │  │   metadata,       │  │ │
                          │       │        │  │  score-brief      │  │ │
                          │       │        │  └───────────────────┘  │ │
                          │       │        └─────────┬───────────────┘ │
                          │       │                  │                 │
                          │  ┌────┴──────────────────┴──────────────┐ │
                          │  │  LLM Provider (unchanged from v1)    │ │
                          │  └──────────────────────────────────────┘ │
                          │  ┌──────────────────────────────────────┐ │
                          │  │  Neurocore Client                    │ │
                          │  │  v1: project context, voice, polling │ │
                          │  │  v2 NEW: audience-profile fetch +    │ │
                          │  │   script.published signal emit       │ │
                          │  └──────────┬───────────────────────────┘ │
                          │  ┌──────────┴────────────────────────────┐│
                          │  │  Firestore (red-tool-8193c)            ││
                          │  │  v1: plans, scenes, available_listings,││
                          │  │       config, llm_settings             ││
                          │  │  v2 NEW: deliverables, pipeline_briefs,││
                          │  │       hook_drafts, title_concepts,     ││
                          │  │       thumbnail_concepts,              ││
                          │  │       publish_metadata,                ││
                          │  │       recording_sessions               ││
                          │  └────────────────────────────────────────┘│
                          │  ┌──────────────────────────────────────┐  │
                          │  │  Workspace Module (NEW)              │  │
                          │  │  Folder creation per plan on disk    │  │
                          │  └──────────────────────────────────────┘  │
                          └───────┬────────────────────────────────────┘
                                  │ localhost HTTP
                          ┌───────▼────────────────────────────────────┐
                          │              Neurocore                      │
                          │  v1: /v1/memory/context                     │
                          │  v1: /v1/signals/pending, /ack              │
                          │  v1: /v1/memory/signals (script.approved)   │
                          │  v2 NEW: /v1/audience-profiles (GET, POST,  │
                          │           PATCH)                            │
                          │  v2 NEW: /v1/audience-profiles/:id (GET)    │
                          │  v2 NEW: signal handler: script.published   │
                          └─────────────────────────────────────────────┘
```

### 4.2 Component Details

#### Component F: AudienceProfile Client (NEW — DREK side)

- **Responsibility:** Fetch AudienceProfiles from Neurocore. Cache per plan-edit session (TTL: process lifetime; invalidated on Neurocore reachability error).
- **Location:** `src/neurocore/audience-profiles.ts`. Extends the existing Neurocore client pattern from v1.
- **Interface:**

```typescript
export interface AudienceProfile {
  id: string;
  name: string;
  description: string;
  watchPersona: string;
  painPoints: string[];
  buyingTriggers: string[];
  voiceGuidelines: {
    tone: string;
    vocabulary: string;
    sentenceLengthGuide: string;
    taboos: string[];
  };
  hookPatterns: string[];
  pacingRules: {
    wordsPerMinute: number;
    avgSentenceWords: number;
    densityNote: string;
  };
  ctaStyle: {
    type: 'subscribe_and_long_form' | 'consultation_book' | 'community_join' | 'lead_magnet_download';
    phrasing: string;
    placement: string;
  };
  createdAt: Date;
  updatedAt: Date;
}

export interface AudienceProfileClient {
  list(): Promise<AudienceProfile[]>;
  get(id: string): Promise<AudienceProfile>;
}
```

- **Caching:** In-memory `Map<string, AudienceProfile>` keyed by profile ID. Populated on first fetch within a process. Invalidated by explicit `clearCache()` call only used in tests. Production restart re-warms the cache.
- **Error handling:** AudienceProfile fetch failure is a **hard error** — no fallback to generic voice. The engine step that triggered the fetch returns a `LLMProviderError` subclass (`AudienceProfileUnavailableError`) and the route surfaces it to the UI with a retry button. Per PRD §6.4, this is intentional — silent fallback defeats the targeting.

#### Component G: Format Profile Registry (NEW — DREK side)

- **Responsibility:** Statically-defined TypeScript constants for each video format. Provide structure (beats, scene range, runtime range, hook guidelines, anti-patterns, shot conventions) that the LLM consumes.
- **Location:** `src/engine/format-profiles/`. One file per format profile, plus `index.ts` exposing the registry.
- **Interface:**

```typescript
export interface FormatProfileBeat {
  name: string;                       // "cold_open", "war_room", "outro"
  targetDurationSeconds: number;      // suggested per-beat duration
  description: string;                // what happens in this beat
  shotConventions: string[];          // primary shot expectations
}

export interface FormatProfile {
  id: string;                         // "claude_code_build_along"
  displayName: string;
  description: string;
  sceneRange: [number, number];       // [min, max] scenes
  runtimeRange: [number, number];     // [min, max] seconds
  beats: FormatProfileBeat[];         // ordered beat templates
  hookGuidelines: string;             // multi-line prompt block
  pacingRules: {
    wordsPerMinute: number;
    sentenceLengthGuide: string;
  };
  antiPatterns: string[];             // "DO NOT" injections
  ctaPolicy: string;                  // long-form CTA rules per channel doc
}

export const FORMAT_PROFILES: Record<string, FormatProfile>;
export function getFormatProfile(id: string): FormatProfile;  // throws on unknown ID
```

- **Profiles shipped at v2 launch:** `claude_code_build_along` (default, full implementation), `tutorial`, `case_study`, `comparison`, `essay_opinion`, `listicle`, `reaction_review`. The first ships at depth; the other six ship with minimum-viable structure and can be tuned after first use.
- **Why constants, not Firestore:** Format profile rules are prompt engineering. Changes need code review + tests. Rick should never edit them via UI.

#### Component H: Intake Module (NEW)

- **Responsibility:** Manage candidate briefs sourced from Upwork/Freelancer/manual paste. Score them. Queue them. Promote to plans.
- **Location:** `src/intake/` (chosen over `src/pipeline/` to avoid name collision with the existing `src/engine/pipeline.ts` orchestrator).
- **Public functions:**

```typescript
export function createPipelineBrief(input: PipelineBriefCreate): Promise<PipelineBrief>;
export function listPipelineBriefs(opts?: { stage?: BriefStage; limit?: number }): Promise<PipelineBrief[]>;
export function getPipelineBrief(id: string): Promise<PipelineBrief>;
export function updatePipelineBriefScore(id: string, score: BriefScore): Promise<void>;
export function transitionBriefStage(id: string, toStage: BriefStage): Promise<void>;
export function promoteBriefToPlan(briefId: string, formatProfileId: string): Promise<string>; // returns planId
export async function scoreBriefViaLLM(briefId: string): Promise<BriefScore>;                  // engine step
```

- **State machine:** `candidate → vetted → selected → in_production → published → retired`. Transitions are explicit (no auto-advancement). Validated at the function level — invalid transitions throw.

#### Component I: Workspace Module (NEW)

- **Responsibility:** Create + manage on-disk folder layout per plan. Provide "open folder" route. Validate workspace root.
- **Location:** `src/workspace/`.
- **Folder layout (created on plan creation):**

```
{WORKSPACE_ROOT}/{planId}-{slug}/
├── brief/             # original brief text, screenshots
├── briefs/            # alias kept for backward typo tolerance
├── scripts/           # exported shoot instructions, per-deliverable
├── shotlist/          # exported shot list per scene
├── recordings/        # Rick points his recorder here
├── assets/            # source materials for thumbnails, screenshots
└── exports/           # publishing metadata text bundles
```

- **Public functions:**

```typescript
export function createPlanWorkspace(planId: string, slug: string): Promise<{ path: string }>;
export function getPlanWorkspacePath(planId: string): Promise<string | null>;
export function exportToWorkspace(planId: string, subdir: string, filename: string, content: string | Buffer): Promise<string>;
export function validateWorkspaceRoot(): Promise<{ ok: boolean; reason?: string }>;
```

- **Security:** Workspace root is configured via `WORKSPACE_ROOT` env var. All paths are resolved + verified to be within the root (no `..` traversal). Filenames are slug-validated (`/^[a-z0-9-]+(\.[a-z]+)?$/`).
- **Failure mode:** If workspace root is unreachable (drive disconnected, antivirus lock), folder operations fail but generation still proceeds. The plan record stores `workspacePath: null` until next successful creation. UI shows a workspace-degraded indicator on plans that lack a folder.

#### Component J: Footage Manifest Module (NEW)

- **Responsibility:** Per-plan recording session ledger. Tracks which scenes have footage logged. Surfaces coverage gaps.
- **Location:** `src/footage/`.
- **Public functions:**

```typescript
export function logRecordingSession(input: RecordingSessionCreate): Promise<RecordingSession>;
export function listSessionsForPlan(planId: string): Promise<RecordingSession[]>;
export function computeSceneCoverage(planId: string): Promise<Record<string, { covered: boolean; sessions: string[] }>>;
export function deleteRecordingSession(id: string): Promise<void>;
```

- **Coverage logic:** A scene is "covered" if at least one `RecordingSession` exists with the scene's ID in its `scenesCovered[]`. Coverage is recomputed on read (cheap), not persisted.

#### Component K: Deliverable Module (NEW)

- **Responsibility:** CRUD for the `Deliverable` entity (per-artifact representation: long-form, Short, future). Bind deliverables to AudienceProfiles. Track per-deliverable status independently of plan status.
- **Location:** `src/db/deliverables.ts`.
- **Public functions:** Standard CRUD pattern matching v1's `src/db/plans.ts`.

#### Existing Components — v2 Modifications

| Component | v1 Behavior | v2 Modification |
|-----------|------------|-----------------|
| **Hono routes** | Page routes + action routes + HTMX partials for v1 capability | Add ~25 new routes for v2 capability (see §4.4) |
| **Planning engine** | 4 LLM calls + composition rules constants | Add 7 new engine steps; modify `match-projects.ts`, `generate-scenes.ts`, `write-scripts.ts` to accept `formatProfileId` + `audienceProfileId` and inject both into prompts when present |
| **Neurocore client** | 5 methods | Add `listAudienceProfiles()`, `getAudienceProfile(id)`, `sendPublishedScript(payload)` |
| **Polling service** | Cron pulling `listing.ingested` signals | Unchanged. Pipeline briefs are a separate intake mechanism — not polled. |
| **Firestore schemas** | Plan, Scene, AvailableListing, PollingConfig + post-M13 LlmSettings | Add 8 new entity schemas (see §4.3); extend Plan + Scene schemas (additive only — no breaking changes to v1 documents) |
| **NSSM service** | Single service named `DREK` | Unchanged. Env additions for `WORKSPACE_ROOT`. |
| **HTMX UI** | Dashboard, plan detail, scene cards, listings, new-plan, settings | Add 6 new views: pipeline brief intake, deliverable bundle, hook/title/thumbnail workshop, footage manifest tab, publishing tab. All HTMX-driven, same patterns as v1. |

### 4.3 Data Model

**Firestore project:** `red-tool-8193c` (existing — no new project).

#### Extended Collection: `plans`

v1 schema preserved. New fields (all nullable / defaulted, so v1 documents continue to validate):

| Field | Type | Constraints | Description |
|-------|------|-------------|-------------|
| `type` | enum | `'cover_letter' \| 'youtube_lite' \| 'youtube_advanced'` | `youtube` enum value renamed `youtube_lite` (see §4.7 for migration) |
| `formatProfileId` | string \| null | required when `type === 'youtube_advanced'`, else null | Reference to `FORMAT_PROFILES` registry key |
| `pipelineBriefId` | string \| null | optional | Reference to source `PipelineBrief` if promoted |
| `workspacePath` | string \| null | optional | Absolute path on disk |
| `selectedHookVariantId` | string \| null | optional | Reference to `HookDraft` |
| `selectedTitleVariantId` | string \| null | optional | Reference to `TitleConcept` (for the long-form deliverable; Shorts have their own) |
| `selectedThumbnailConceptId` | string \| null | optional | Reference to `ThumbnailConcept` |

**Plan status enum — extended** (additive only; no v1 statuses removed or renamed):

v1 statuses preserved: `awaiting_review`, `dismissed`, `requirements_reviewed`, `projects_matched`, `scenes_generated`, `finalized`, `exported`

v2 additions (only reachable from `youtube_advanced` plans):
- `hooks_generated` — hook variants produced, awaiting selection
- `hook_selected` — Rick picked a hook variant
- `shot_list_generated` — per-scene shot lists produced
- `titles_generated` — title variants produced, awaiting selection
- `title_selected` — Rick picked a title
- `thumbnails_generated` — thumbnail concepts produced
- `thumbnail_selected` — Rick picked a thumbnail concept
- `shorts_extracted` — Shorts candidates produced
- `metadata_generated` — publishing metadata produced (preceded by finalize for the long-form deliverable)

**Extended plan transition table** (additions only — v1 transitions unchanged):

```typescript
const V2_PLAN_TRANSITIONS_ADDITIONS: Partial<Record<PlanStatus, PlanStatus[]>> = {
  scenes_generated: ['finalized', 'projects_matched', 'hooks_generated'],          // v2: scene gen leads to hook gen
  hooks_generated: ['hook_selected', 'scenes_generated'],
  hook_selected: ['shot_list_generated', 'hooks_generated'],
  shot_list_generated: ['titles_generated', 'hook_selected'],
  titles_generated: ['title_selected', 'shot_list_generated'],
  title_selected: ['thumbnails_generated', 'titles_generated'],
  thumbnails_generated: ['thumbnail_selected', 'title_selected'],
  thumbnail_selected: ['shorts_extracted', 'thumbnails_generated'],
  shorts_extracted: ['finalized', 'thumbnail_selected'],
  finalized: ['exported', 'scenes_generated', 'metadata_generated'],               // v2: finalize can lead to metadata
  metadata_generated: ['exported', 'finalized'],
};
```

The merged `PLAN_TRANSITIONS` table validates with `isAllowedPlanTransition()`. v1 cover-letter plans never reach v2 statuses because no v1 transition leads into them.

#### Extended Collection: `plans/{planId}/scenes`

v1 schema preserved. New fields (all defaulted to `null` or `[]` so v1 documents validate):

| Field | Type | Constraints | Description |
|-------|------|-------------|-------------|
| `beatTag` | string \| null | optional | Format-profile beat name (e.g., `cold_open`, `war_room`). Null for non-`youtube_advanced` scenes. |
| `primaryShot` | object \| null | optional | `{ type: SceneInterfaceType, description: string }` — reuses existing v1 `SCENE_INTERFACE_TYPES` enum |
| `brollItems` | object[] | default: [] | `[{ type, description, source, durationSeconds }]` |
| `shotListItems` | object[] | default: [] | Additional specific shots beyond `primaryShot` |
| `onScreenTextOverlays` | object[] | default: [] | `[{ textContent, timingHint, styleHint }]` |
| `cutPoints` | object[] | default: [] | `[{ scriptLineNumber, reason }]` |

#### New Collection: `pipeline_briefs`

| Field | Type | Constraints | Description |
|-------|------|-------------|-------------|
| `id` | string | PK, auto-generated | |
| `title` | string | required | |
| `company` | string \| null | optional | |
| `sourceUrl` | string \| null | optional | |
| `rawText` | string | required, max 50KB | |
| `score` | object | optional | `{ visualOutcome, storyPotential, scopeFit, audienceMatch, aggregate }` — all 1-5 integers, aggregate is the mean |
| `scoringRationale` | string \| null | optional | LLM reasoning for the score |
| `stage` | enum | required | `candidate \| vetted \| selected \| in_production \| published \| retired` |
| `promotedPlanId` | string \| null | optional | Plan ID once promoted |
| `createdAt` | Timestamp | required | |
| `updatedAt` | Timestamp | required | |

**Indexes:**
- `pipeline_briefs_stage`: composite on `(stage, updatedAt DESC)` — list view filtering.
- `pipeline_briefs_score`: composite on `(stage, score.aggregate DESC)` — sort by score within stage.

#### New Collection: `deliverables`

| Field | Type | Constraints | Description |
|-------|------|-------------|-------------|
| `id` | string | PK | |
| `planId` | string | required, indexed | Parent plan |
| `kind` | enum | required | `long_form \| short_clip \| lead_magnet` (future kinds additive) |
| `audienceProfileId` | string | required | Neurocore AudienceProfile reference |
| `title` | string | required | Per-deliverable title |
| `status` | enum | required | `draft \| scripts_ready \| metadata_ready \| exported \| published` |
| `scriptOverrideSceneIds` | string[] \| null | optional | For Shorts: which long-form scenes this is derived from |
| `customScripts` | object[] \| null | optional | For Shorts: reworked per-scene scripts that diverge from the long-form |
| `selectedTitleVariantId` | string \| null | optional | |
| `selectedThumbnailConceptId` | string \| null | optional | |
| `publishMetadataId` | string \| null | optional | |
| `youtubeUrl` | string \| null | optional | Populated after publish |
| `publishedAt` | Timestamp \| null | optional | |
| `createdAt` | Timestamp | required | |
| `updatedAt` | Timestamp | required | |

**Indexes:**
- `deliverables_planId`: ascending on `planId` — fetch a plan's deliverables.
- `deliverables_status`: composite on `(status, updatedAt DESC)` — dashboard surfacing.

#### New Subcollection: `plans/{planId}/hook_drafts`

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | PK |
| `archetype` | enum | `pattern_interrupt \| bold_claim \| retention_question \| story_cold_open \| demo_first` |
| `scriptText` | string | 30-60 word draft |
| `predictedRetention` | string | LLM rationale |
| `selected` | boolean | True if Rick picked this one |
| `createdAt` | Timestamp | |

#### New Subcollection: `deliverables/{deliverableId}/title_concepts`

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | PK |
| `titleText` | string | ≤70 chars |
| `archetype` | enum | `curiosity_gap \| specificity \| payoff_promise \| controversy_hook \| numbered_listicle \| question_format \| before_after` |
| `predictedClickability` | number | 1-10 |
| `reasoning` | string | One-line LLM rationale |
| `keywordsSurfaced` | string[] | |
| `selected` | boolean | |
| `createdAt` | Timestamp | |

#### New Subcollection: `deliverables/{deliverableId}/thumbnail_concepts`

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | PK |
| `composition` | string | Layout description |
| `textHook` | string | ≤4 words |
| `expression` | string \| null | Headshot emotion if applicable |
| `colorPalette` | string[] | 2-3 hex values |
| `assetsRequired` | string[] | Source materials needed |
| `conceptSummary` | string | One-sentence description |
| `selected` | boolean | |
| `createdAt` | Timestamp | |

#### New Subcollection: `deliverables/{deliverableId}/publish_metadata`

Single document `current`:

| Field | Type | Description |
|-------|------|-------------|
| `description` | string | Full description block with timestamps + CTAs |
| `chapters` | object[] | `[{timestampSeconds, label}]` |
| `tags` | string[] | 10-15 YouTube tags |
| `pinnedComment` | string | 1-2 sentence engagement prompt |
| `endScreenSuggestion` | string | |
| `generatedAt` | Timestamp | |
| `lastEditedAt` | Timestamp \| null | |

Stored as a single doc (not collection) because there's exactly one per deliverable. Saves a query.

#### New Collection: `recording_sessions`

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | PK |
| `planId` | string | required, indexed |
| `dateRecorded` | Timestamp | required |
| `sessionType` | enum | `build_session \| demo_session \| reflection \| b_roll \| screen_capture` |
| `filePath` | string | required — workspace-relative or absolute |
| `durationSeconds` | number | required |
| `scenesCovered` | string[] | required, ≥1 element |
| `notes` | string \| null | optional |
| `createdAt` | Timestamp | |

**Indexes:**
- `recording_sessions_planId`: composite on `(planId, dateRecorded DESC)` — per-plan session list.

### 4.4 API Design (Internal Routes)

v1 routes preserved verbatim. v2 additions:

#### Page Routes (new)

| Method | Path | Renders |
|--------|------|---------|
| GET | `/intake` | Pipeline brief list with stage filters + queue depth indicator |
| GET | `/intake/new` | Manual brief paste form |
| GET | `/intake/:briefId` | Brief detail + score + promote-to-plan controls |
| GET | `/plans/:id/deliverables` | Deliverable bundle view for a plan |
| GET | `/plans/:id/deliverables/:deliverableId` | Single deliverable detail (scenes, titles, thumbnails, metadata) |
| GET | `/plans/:id/footage` | Recording session log + coverage indicator |
| GET | `/plans/:id/workshop/hooks` | Hook variant selection UI |
| GET | `/plans/:id/workshop/titles` | Title variant selection UI |
| GET | `/plans/:id/workshop/thumbnails` | Thumbnail concept selection UI |
| GET | `/deliverables/:deliverableId/publish` | Publishing metadata review + copy-to-clipboard export |

#### Action Routes (new)

| Method | Path | Action |
|--------|------|--------|
| POST | `/intake` | Create a pipeline brief from form submission |
| POST | `/intake/:briefId/score` | Trigger LLM scoring step |
| POST | `/intake/:briefId/stage` | Transition stage (`{stage}` in body) |
| POST | `/intake/:briefId/promote` | Promote brief to plan (creates `youtube_advanced` plan + transitions brief to `selected`); body: `{ formatProfileId, audienceProfileId }` |
| POST | `/plans/:id/generate-hooks` | Trigger hook variant generation |
| POST | `/plans/:id/select-hook` | Persist hook selection; body: `{ hookId }` |
| POST | `/plans/:id/generate-shot-list` | Trigger shot list generation per scene |
| POST | `/plans/:id/generate-titles` | Trigger title variant generation (long-form deliverable) |
| POST | `/plans/:id/generate-thumbnails` | Trigger thumbnail concept generation (long-form deliverable) |
| POST | `/plans/:id/extract-shorts` | Trigger Shorts candidate extraction (creates draft Deliverables for each candidate) |
| POST | `/deliverables/:deliverableId/approve` | Mark a Short deliverable as approved (advances status from `draft` → `scripts_ready`) |
| POST | `/deliverables/:deliverableId/generate-titles` | Per-deliverable title gen (Shorts) |
| POST | `/deliverables/:deliverableId/generate-thumbnails` | Per-deliverable thumbnail gen (Shorts) |
| POST | `/deliverables/:deliverableId/generate-publish-metadata` | Generate publishing metadata for the deliverable |
| POST | `/plans/:id/recording-sessions` | Log a recording session |
| DELETE | `/recording-sessions/:id` | Delete a recording session log entry |
| POST | `/plans/:id/open-workspace` | OS-level "open folder" — invokes `explorer.exe` on Windows (no-op on other platforms) |

#### HTMX Partial Routes (new — same conventions as v1)

| Method | Path | Returns |
|--------|------|---------|
| GET | `/intake/:briefId/score-form` | Score editor partial (inline edit pattern) |
| PATCH | `/intake/:briefId` | Updated brief card partial |
| GET | `/plans/:id/scenes/:sceneId/shot-list/edit` | Shot list editor partial for one scene |
| PATCH | `/plans/:id/scenes/:sceneId/shot-list` | Save shot list edits, return updated card |
| PATCH | `/deliverables/:deliverableId/publish-metadata` | Save metadata edit, return updated field |
| PATCH | `/deliverables/:deliverableId/title-concepts/:conceptId` | Toggle selection |
| PATCH | `/deliverables/:deliverableId/thumbnail-concepts/:conceptId` | Toggle selection |

### 4.5 LLM Prompt Architecture — v2 Additions

v1's four-call pattern (detect-requirements, match-projects, generate-scenes, write-scripts) is preserved and reused. v2 adds 7 new LLM calls. The composition pattern for v2 calls is:

```
SYSTEM PROMPT
=============
[FORMAT PROFILE BLOCK]
  - structure template (beats with durations)
  - hook guidelines
  - pacing rules
  - anti-patterns
  - shot conventions

[AUDIENCE PROFILE BLOCK]    <-- injected verbatim from Neurocore
  - watch persona
  - pain points
  - buying triggers
  - voice guidelines
  - hook patterns (audience-specific)
  - pacing rules (words/min, sentence length)
  - CTA style

[TASK-SPECIFIC INSTRUCTIONS]
  - what this call produces
  - structured output schema (JSON)
  - retry-on-invalid-JSON expectation

USER PROMPT
===========
[task-specific input data]
```

Format profile is injected first (defines structure), audience profile second (defines voice). This order is load-bearing — voice rules can override format defaults (e.g., a format may suggest 150 wpm but an audience profile may specify 175 for shorts).

#### Call 5: Hook Variant Generation

**Input:** Format profile hook guidelines, AudienceProfile hookPatterns, episode angle, technical scope, target runtime.
**Output:** Array of 3-4 `HookDraft` objects with `archetype`, `scriptText`, `predictedRetention`.
**Failure mode:** Bad JSON → retry once with stricter instruction. Second failure → surface to UI.

#### Call 6: Shot List Generation (per scene, batched)

**Input:** All scenes' scripts + format profile shot conventions + AudienceProfile pacing rules.
**Output:** Array of per-scene objects with `primaryShot`, `brollItems[]`, `shotListItems[]`, `onScreenTextOverlays[]`, `cutPoints[]`.
**Why batched:** One LLM call covering all scenes preserves cross-scene shot coherence (e.g., same B-roll asset used in two scenes shouldn't be re-suggested).

#### Call 7: Title Variant Generation

**Input:** Selected title type, format profile, AudienceProfile, episode angle, selected hook archetype.
**Output:** Array of 5-10 `TitleConcept` objects with `titleText`, `archetype`, `predictedClickability`, `reasoning`, `keywordsSurfaced`.

#### Call 8: Thumbnail Concept Generation

**Input:** Selected title, format profile, hook archetype, available project visuals (string descriptions only — DREK doesn't generate images).
**Output:** Array of 3-5 `ThumbnailConcept` objects with `composition`, `textHook`, `expression`, `colorPalette`, `assetsRequired`, `conceptSummary`.

#### Call 9: Shorts Candidate Extraction

**Input:** Long-form scripts (with beat tags) + beat-importance heuristics + `business_owner_shorts` AudienceProfile.
**Output:** Array of 3-5 short candidates, each with `sourceSceneIds`, `cutWindow` (start/end line ranges), `reworkedScript`, `hookText`, `verticalReframingNotes`.

**Beat importance heuristic:** Hardcoded weights per beat type (e.g., `demo` = 10, `outro` = 8 for pricing moment, `build_reel` = 5, `cold_open` = 7, `war_room` = 6). The LLM ranks candidate moments using these weights as input, not as a hard filter — it can override based on script content (e.g., a particularly punchy `war_room` line beats a flat `demo` opening).

#### Call 10: Publishing Metadata Generation

**Input:** Selected title, episode angle, all scripts, scene beat tags (for chapter markers), AudienceProfile CTA style.
**Output:** Single `PublishMetadata` object with `description`, `chapters`, `tags`, `pinnedComment`, `endScreenSuggestion`.

#### Call 11: Brief Scoring (intake module)

**Input:** Raw brief text + scoring rubric definition.
**Output:** `BriefScore` object: `{ visualOutcome: 1-5, storyPotential: 1-5, scopeFit: 1-5, audienceMatch: 1-5, aggregate: number }` + one-paragraph `scoringRationale`.

### 4.6 Composition Rules — v2 Architecture

v1's `composition-rules.ts` constants (`COVER_LETTER_RULES`, `YOUTUBE_RULES`) are preserved. v2 introduces the format profile registry described in §4.2 Component G.

**Composition order in prompts** (load-bearing):

```typescript
function buildSystemPrompt(opts: {
  v1CompositionRules?: CompositionRules;  // for v1 plan types
  formatProfile?: FormatProfile;          // for youtube_advanced
  audienceProfile?: AudienceProfile;      // for youtube_advanced
  taskInstructions: string;
}): string {
  const blocks: string[] = [];
  if (opts.v1CompositionRules) blocks.push(renderV1Rules(opts.v1CompositionRules));
  if (opts.formatProfile)     blocks.push(renderFormatProfile(opts.formatProfile));
  if (opts.audienceProfile)   blocks.push(renderAudienceProfile(opts.audienceProfile));
  blocks.push(opts.taskInstructions);
  return blocks.join('\n\n---\n\n');
}
```

For v1 plan types, only `v1CompositionRules` is set. For `youtube_advanced`, only `formatProfile` + `audienceProfile`. The function asserts at the boundary that exactly one of the two paths is used — preventing accidental mode-blending.

### 4.7 Migration: `youtube` → `youtube_lite`

v1 ships with `type: 'youtube'` plans. v2 renames this enum value to `youtube_lite`. The migration is:

1. **Code change:** Update `PLAN_TYPES` constant: `['cover_letter', 'youtube_lite', 'youtube_advanced']`.
2. **One-time backfill script:** `scripts/migrate-youtube-to-youtube-lite.ts` reads all `plans` documents where `type === 'youtube'` and updates them to `type === 'youtube_lite'`. Idempotent (no-op on re-run).
3. **Run during M14 deployment.** Service stopped, script run, service started. <1 minute total.
4. **UI label:** Existing "YouTube" dropdown stays labeled "YouTube" in the v1 form for non-advanced; "YouTube Advanced" is a separate option that becomes available in v2.
5. **Zero data loss.** Migration only changes the enum string. All other fields preserved.

### 4.8 AudienceProfile Seeding

Two profiles must exist in Neurocore at v2 launch. They are seeded via:

1. **Neurocore migration script:** `scripts/seed-audience-profiles.ts` in the Neurocore repo. Run during M14 Track A.
2. **Profile content:** Drafted in this tech spec section, then committed to Neurocore as a fixture. Subject to Rick's approval before going live.

**Seed: `developer_longform`**

```yaml
id: developer_longform
name: "Developer / Learner — Long-form"
description: "AI/automation practitioners watching to understand how Rick directs Claude Code on real client work."
watchPersona: |
  AI engineers, agency owners, and intermediate-to-senior developers
  who want to see the actual prompt-response loop with Claude Code,
  not just the polished demo. They will sit through 25-35 minutes if
  the structure rewards their time. They share clips on Twitter/LinkedIn
  when something genuinely impresses them.
painPoints:
  - "Most 'AI coding' content is sponsored thinly-veiled marketing"
  - "Tutorials use toy examples, not real client briefs"
  - "Builds are heavily edited so the actual decision-making is invisible"
  - "No one shows what they do when Claude gives a bad answer"
buyingTriggers:
  - "Sees Rick handle a build failure calmly and recover on screen"
  - "Recognizes their own pain in the brief"
  - "Hears a pricing moment that contextualizes the value"
voiceGuidelines:
  tone: "authoritative-warm; confident but not arrogant"
  vocabulary: "technical but accessible; explain jargon once then reuse"
  sentenceLengthGuide: "mix short and medium; avoid runs of long sentences"
  taboos: ["'guys'", "'super easy'", "filler 'basically/literally/essentially'"]
hookPatterns:
  - "Start with the moment the build almost failed and what saved it"
  - "Open with a one-line claim about the architectural choice and back it up"
  - "Show the finished demo for 5 seconds, then 'here's what they actually asked for'"
pacingRules:
  wordsPerMinute: 150
  avgSentenceWords: 14
  densityNote: "Leave 1-2 second pauses after big claims. Don't fill silence."
ctaStyle:
  type: "subscribe_and_long_form"
  phrasing: |
    "If you're building with Claude Code, subscribe — the next one's
    a [adjacent topic]. And if you actually need something like this
    built, the link's in the description."
  placement: "final 15 seconds, after the reflection beat"
```

**Seed: `business_owner_shorts`**

```yaml
id: business_owner_shorts
name: "Business Owner — Shorts"
description: "Founders / ops leads scrolling Shorts who could become $10k+ clients."
watchPersona: |
  Founders, agency owners, and ops leads who scroll Shorts during
  downtime. They are not researching AI consultants on purpose. They
  judge competence in 5 seconds. They will swipe away the moment the
  hook softens.
painPoints:
  - "Their team is drowning in repetitive work that should be automated"
  - "They've been burned by 'AI consultants' who didn't deliver"
  - "They don't understand the AI tooling landscape and don't have time to learn"
buyingTriggers:
  - "Sees a concrete before/after — manual process vs automation"
  - "Hears a price range that frames value, not cost"
  - "Sees this exact problem solved end-to-end in 60 seconds"
voiceGuidelines:
  tone: "confident-direct; outcome-first; zero hedging"
  vocabulary: "business language; no jargon unless immediately explained"
  sentenceLengthGuide: "short. punchy. one idea per sentence."
  taboos: ["'just'", "'simply'", "'might'", "'maybe'"]
hookPatterns:
  - "State the cost of the problem in the first 3 seconds"
  - "Show the demo working in the first 5 seconds"
  - "Lead with a number ('saves 12 hours a week')"
pacingRules:
  wordsPerMinute: 175
  avgSentenceWords: 9
  densityNote: "No silence. No pauses. Every second earns its place."
ctaStyle:
  type: "consultation_book"
  phrasing: |
    "If this is your problem, the link in bio books a call.
    First one's free."
  placement: "final 5 seconds, hard CTA"
```

## 5. Alternatives Considered

### Option A: New repo (rejected)

- **Description:** Separate TypeScript service for YouTube channel ops. Shares Neurocore.
- **Pros:** Cleaner separation. No risk of v2 changes breaking v1 cover-letter pipeline.
- **Cons:** Re-implements Plan/Scene/Script CRUD, LLM provider abstraction, Neurocore client, polling cron, NSSM service wrapper, HTMX UI shell, 308-test harness. Forks the voice profile. Two services to deploy and monitor.
- **Why rejected:** Locked in discovery as L-1. Extension reuses ~80% of existing infrastructure. Cost of avoiding breakage in v1 is lower than cost of rebuilding the whole stack.

### Option B: Replace v1 YouTube mode entirely (rejected)

- **Description:** Convert all existing `youtube` plans to `youtube_advanced` via migration. Delete the old YOUTUBE_RULES path.
- **Pros:** Single code path for all YouTube content. No mode-blending risk because there's no other mode.
- **Cons:** Existing v1 plans don't have format profile or audience profile bindings. Migration would require fabricating these. Risks corrupting working plans Rick already finalized.
- **Why rejected:** `youtube_lite` as a preserved alias is safer. v1 plans stay as-is. New plans go `youtube_advanced`. No data conversion.

### Option C: AudienceProfile in DREK's Firestore, not Neurocore (rejected)

- **Description:** Store AudienceProfile as a DREK collection. Avoid Neurocore work.
- **Pros:** No Neurocore API additions. Faster to ship M14.
- **Cons:** Forks the data when the next consumer (blog post generator, email generator, future apps) needs the same profiles. Each app re-implements CRUD.
- **Why rejected:** Locked in discovery as L-2. Neurocore is the common-denominator layer — that's its whole architectural purpose. Adding a one-off DREK store creates a future migration.

### Option D: Image generation for thumbnails in v2 (rejected)

- **Description:** Call an image API (DALL-E, Imagen, Replicate Stable Diffusion) to produce actual thumbnail images alongside the structured concept.
- **Pros:** Closes the thumbnail loop end-to-end.
- **Cons:** Adds a third-party provider abstraction layer. Thumbnail quality from current AI image gen is inconsistent for the channel's visual style. Manual thumbnail production gives Rick control over branding and CTR optimization that AI gen doesn't.
- **Why rejected:** Out of scope per PRD §11.2. v3 deferred. Structured concept is enough to brief whatever tool Rick actually uses (Figma, Photoshop, Canva).

### Option E: Single mega-call replacing the 11-step pipeline (rejected)

- **Description:** One LLM call ingests brief + projects + format + audience + everything, outputs the full plan including scenes, scripts, hooks, titles, thumbnails, metadata.
- **Pros:** One round-trip. Simpler code.
- **Cons:** 100k+ token context required. No intermediate review points. Output consistency degrades. Bad-JSON failures lose everything. Debugging "which step went wrong" becomes impossible.
- **Why rejected:** Same reasoning as v1 — staged calls give Rick control + bounded blast radius on failure. Each new v2 call is a separately-retriable engine step.

### Decision

Extend DREK in place. AudienceProfile in Neurocore. Format profiles as TypeScript constants. 7 new LLM calls layered onto v1's existing 4. v1 YouTube mode preserved as `youtube_lite`. New capability lives under `youtube_advanced` plan type.

## 6. Security Considerations

Inherits v1 §6 entirely. v2 additions:

- **Workspace path traversal:** All paths are resolved via `path.resolve()` and verified to be under `WORKSPACE_ROOT` before any filesystem operation. Filenames slug-validated. `path.join()` never called with user-supplied path components without normalization.
- **AudienceProfile injection:** Profiles are fetched from Neurocore (trusted source) and injected verbatim into LLM prompts. No user-supplied audience text is concatenated into prompts.
- **`script.published` signal:** DREK emits `youtubeUrl` to Neurocore. URL is validated against a YouTube hostname allowlist (`^https://(www\.)?(youtube\.com|youtu\.be)/`) before emission to prevent accidental leak of internal URLs.
- **Pipeline brief raw text:** Capped at 50KB before storage. Same `userConstraints` 200KB cap pattern from v1.
- **Neurocore token:** Same `NEUROCORE_TOKEN` env var as v1. No new secrets introduced.

## 7. Performance and Scalability

Inherits v1 §7. v2 additions:

| Metric | Target | Rationale |
|--------|--------|-----------|
| Hook variant generation (Call 5) | < 30s | Small input (angle + scope), small output (3-4 short drafts) |
| Shot list generation (Call 6, all scenes) | < 60s | Batched per plan, ~5-12 scenes per call |
| Title variant generation (Call 7) | < 30s | Small input/output |
| Thumbnail concept generation (Call 8) | < 20s | Smallest output |
| Shorts candidate extraction (Call 9) | < 90s | Reads all long-form scripts, produces reworked Short scripts |
| Publishing metadata generation (Call 10) | < 30s | Single output object |
| Brief scoring (Call 11) | < 15s | Small focused call |
| Intake list page load | < 2s | Composite-indexed query, max 200 results |
| Deliverable bundle view load | < 2s | Plan doc + Deliverables collection query + per-deliverable subcollection summaries |
| Workspace folder creation | < 500ms | mkdir cascade, 7 subfolders |

**Caching:**
- **AudienceProfile cache:** In-memory per process. Avoids refetching the same profile across multiple LLM calls in the same plan-edit session. Cache cleared on Neurocore reachability error.
- **Format profile cache:** N/A — TypeScript constants, already in-memory.
- **Brief scoring:** No caching. Each scoring run is fresh because Rick may have edited the brief text.

## 8. Reliability and Failure Handling

Inherits v1 §8. v2 additions:

### Dependency Failure Matrix — v2 additions

| Dependency | Failure Mode | Detection | Fallback | Recovery |
|-----------|-------------|-----------|----------|----------|
| Neurocore AudienceProfile fetch | 404 (profile deleted) | HTTP 404 from `get(id)` | Hard error — `AudienceProfileNotFoundError`. UI shows "Profile no longer exists, select another" and lists available profiles. | Rick picks a different profile. |
| Neurocore AudienceProfile fetch | 5xx or timeout | Standard Neurocore retry exhaustion | Hard error — `AudienceProfileUnavailableError`. Generation step blocks. UI shows retry button. | Auto-recovers on next successful Neurocore call (cache invalidated). |
| Workspace filesystem | Drive disconnected / ENOENT | `fs.mkdir` throws | Plan record saves with `workspacePath: null`. Generation proceeds. UI shows workspace-degraded indicator. | Rick reconnects drive, clicks "Retry create workspace" on plan. |
| Workspace filesystem | Permission denied / EACCES | `fs.mkdir` throws | Same as above. | Rick fixes permissions, retries. |
| Pipeline brief LLM scoring | LLM call fails | Standard LLM provider error path | Score remains null. Rick can manually enter scores in the UI. | Rick clicks "Score" again or enters manually. |
| Hook variant generation | All 4 variants fail JSON parsing twice | Engine step throws | Plan status reverts to prior state. UI shows error + retry. | Rick clicks regenerate. |
| Shorts extraction | LLM produces zero candidates | Engine step returns empty array | UI shows "No Shorts candidates found" with regenerate option. Rick can also manually create a Short deliverable from a long-form scene. | Manual create or regenerate. |

### Data Durability — v2 additions

- Hook variants, title concepts, thumbnail concepts, shot list items, and Shorts candidates are persisted as soon as the LLM call completes (before display in UI). No data loss on browser close mid-review.
- Workspace folder creation is independent of plan creation. Plan record always persists; folder creation can be retried independently.
- Recording session logs are append-only (delete supported but no edit). Each entry is immutable once created.

### Process Management

Unchanged from v1. NSSM `DREK` service.

## 9. Observability

Inherits v1 §9. v2 additions:

- **New log events:**
  - `intake.brief.created`, `intake.brief.scored`, `intake.brief.promoted`
  - `engine.hook.generated`, `engine.shot_list.generated`, `engine.title.generated`, `engine.thumbnail.generated`, `engine.shorts.extracted`, `engine.publish_metadata.generated`
  - `deliverable.created`, `deliverable.status.transitioned`, `deliverable.published`
  - `workspace.created`, `workspace.error`
  - `audience_profile.fetched`, `audience_profile.cache.hit`, `audience_profile.cache.miss`, `audience_profile.fetch.failed`
  - `recording_session.logged`
- **Health check extension:** `/healthz` adds:

```json
{
  "checks": {
    "neurocore": "ok",
    "audience_profiles": {
      "cached": ["developer_longform", "business_owner_shorts"],
      "lastFetchAt": "2026-05-18T14:00:00Z"
    },
    "workspace_root": {
      "configured": true,
      "writable": true,
      "path": "F:\\drek-workspace"
    }
  }
}
```

## 10. Testing Strategy

Inherits v1 §10. v2 additions:

- **AudienceProfile contract tests:** Mock Neurocore endpoints. Verify DREK's client correctly handles list/get/cache/error paths.
- **Format profile registry tests:** Assert each format profile satisfies the `FormatProfile` interface. Assert default `claude_code_build_along` has the expected beats and runtime range.
- **Composition prompt tests:** For each `(formatProfileId, audienceProfileId)` pair shipped at launch, render the system prompt and assert it includes both blocks in the correct order, with no overlap or duplication.
- **Per-engine-step unit tests:** Each of the 7 new engine steps gets the same shape of tests as v1's engine steps (happy path, LLM error retry, bad JSON, audience-unavailable, plan-status-invalid).
- **State machine tests:** Verify extended plan transitions table (§4.3). Negative tests for invalid transitions.
- **Integration tests:**
  - End-to-end `youtube_advanced` plan: pipeline brief → score → promote → analyze → match → scenes → hooks → shot list → titles → thumbnails → shorts → finalize → publish metadata → export. With mocked LLM provider.
  - v1 cover-letter plan still works unchanged (regression).
  - v1 `youtube_lite` plan still works after enum rename (regression).
  - Workspace folder creation + scene file export.
  - Recording session logging + coverage computation.
- **Migration test:** `scripts/migrate-youtube-to-youtube-lite.ts` run against a Firestore emulator with v1 fixture data; verify all `youtube` plans become `youtube_lite` and no other field changes.

**Target coverage:** v1 maintains 308+ tests. v2 should add ~150-200 tests (8 new engine steps × ~6 tests each + entity CRUD × ~8 each + new view tests + integration). Total post-v2: ~500 tests.

## 11. Deployment and Rollout

Inherits v1 §11. v2-specific:

### v2 Deployment Sequence

1. **Pre-deployment** — Neurocore-side AudienceProfile endpoints deployed (M14 Track A complete). Seed profiles loaded. Composite indexes built. Smoke-tested via `curl`.
2. **DREK deployment:**
   - Stop the DREK service: `nssm stop DREK`
   - `git pull` on the Windows host
   - `npm install` (in case any new deps were added)
   - `npm run build`
   - Run migration: `node dist/scripts/migrate-youtube-to-youtube-lite.js`
   - Deploy Firestore index changes: `firebase deploy --only firestore:indexes --project red-tool-8193c`
   - Update `.env` with new `WORKSPACE_ROOT` value
   - Start the service: `nssm start DREK`
3. **Verification:** Health check returns `ok` with new sections (`audience_profiles`, `workspace_root`). Smoke-create a `youtube_advanced` plan end-to-end with one pipeline brief, verify all 11 engine steps execute, export bundles to workspace folder.

### Per-Milestone Rollout

Each milestone (M14-M24) is independently deployable. Strategy: deploy after each milestone passes its status gate. No batching of multiple milestones into one deploy. This preserves the v1 pattern of frequent small deploys.

### Rollback

- Same `nssm stop` then `git revert` + redeploy pattern as v1.
- Firestore data: v2 adds new collections; rollback to v1 ignores them. No data loss for v1 capability.
- Migration rollback: the `youtube → youtube_lite` rename has a reverse script (`scripts/migrate-youtube-lite-to-youtube.ts`). Bidirectional and idempotent.

## 12. Implementation Plan

### Prerequisites

| Item | Owner | Status | Blocks |
|------|-------|--------|--------|
| Neurocore AudienceProfile entity + endpoints | Tony Stark | Not started — M14 Track A | All v2 generation steps |
| `WORKSPACE_ROOT` env var configured on Rick's Windows host | Rick | Pending | Workspace module, exports |
| 2 seed AudienceProfiles approved by Rick | Rick | Pending — drafted in §4.8 above | M14 Track A completion |

### DREK v2 Milestones

Numbered continuing from v1's M0-M13. Each milestone is independently deployable with passing tests.

| Milestone | Description | Deliverable | Dependencies | Effort |
|-----------|-------------|-------------|-------------|--------|
| **M14** (Track A) | Neurocore AudienceProfile entity, Zod schema, Firestore CRUD, 4 endpoints (list/get/create/patch), composite index, seed-profile script, tests | Neurocore deploy + 2 profiles live | Profile content approved by Rick | ~6 hours |
| **M14** (Track B) | DREK Neurocore client extension (`audience-profiles.ts`), in-memory cache, error types, format profile registry skeleton with `claude_code_build_along` only, contract tests | DREK consumer plumbing complete | M14 Track A scaffolded | ~6 hours |
| **M15** | Deliverable entity (Firestore schema + CRUD), Plan refactor (`youtube_advanced` type, extended status enum, extended transition table), migration script (`youtube → youtube_lite`), regression tests | DB layer ready for v2 capability | M14 | ~6 hours |
| **M16** | Intake module: PipelineBrief entity + CRUD, `/intake` views, scoring LLM call (Call 11), promote-to-plan flow, queue depth indicator | Rick can paste briefs, score, promote | M14, M15 | ~8 hours |
| **M17** | Brief & Episode Planner (extends v1's detect-requirements engine for `youtube_advanced`), Episode Outline with format-profile beats (extends v1's generate-scenes) | Rick can generate a plan with format-tagged scenes | M14, M15 | ~6 hours |
| **M18** | Hook Engineering (Call 5 engine step, `/plans/:id/workshop/hooks` selection UI), Script Writing extension (write-scripts honors format + audience + selected hook) | Rick picks a hook and generates scripts | M17 | ~6 hours |
| **M19** | Shot list generation (Call 6 engine step), Scene card UI extension for shot list rendering + HTMX inline edit | Every scene has rendered shot list; editable | M17 | ~6 hours |
| **M20** | Title & Thumbnail Workshop (Calls 7 + 8 engine steps, workshop UIs, selection persistence) | Rick picks title and thumbnail concept | M15 | ~8 hours |
| **M21** | Workspace module (folder creation, open-folder route, path validation), Recording session entity + log form + coverage indicator on scene cards | New plans create folders; Rick logs footage; coverage visible | M15 | ~6 hours |
| **M22** | Publishing metadata generation (Call 10), `/deliverables/:id/publish` view, copy-to-clipboard export bundle | Rick generates and exports YouTube upload package | M18, M20 | ~5 hours |
| **M23** | Shorts Extractor (Call 9 engine step, candidate review UI, Deliverable creation on approve), per-Short title/thumbnail/metadata flow | 3-5 Shorts candidates per plan; approval creates Deliverables; per-Short publishing | M22 | ~8 hours |
| **M24** | End-to-end integration tests (full happy path: brief → finalize → publish for long-form + 2 Shorts), `script.published` signal emission, README + CHANGELOG update, v2 release tag | v2 production-ready | All above | ~6 hours |

**Total estimated v2 build effort:** ~77 hours (~10 working days at full focus). Real-world calendar with subagent parallelization: ~12 weeks (M14 → M24, one milestone per week with buffer).

**Critical path:** M14 (both tracks) → M15 → M17 → M18 → M19 → M22 → M23 → M24. M16 (intake) is parallelizable after M15. M20 is parallelizable after M15. M21 is parallelizable after M15.

## 13. Environment Variables

Inherits v1's vars. v2 additions:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `WORKSPACE_ROOT` | yes | — | Absolute path to the directory where per-plan folders are created (e.g., `F:\drek-workspace`) |
| `AUDIENCE_PROFILE_CACHE_TTL_MS` | no | `0` (process lifetime) | Override AudienceProfile cache TTL. Default keeps profiles cached forever until process restart. |
| `FORMAT_PROFILE_DEFAULT_ID` | no | `claude_code_build_along` | Default format profile for new `youtube_advanced` plans |

No removals or breaking changes to v1 env vars.

## 14. File Structure — v2 Additions

```
drek/
├── src/
│   ├── intake/                        # NEW — pipeline brief sourcing module
│   │   ├── service.ts                 # CRUD + stage transitions + promote-to-plan
│   │   └── scoring.ts                 # Call 11 — brief scoring LLM step
│   ├── workspace/                     # NEW — on-disk folder management
│   │   ├── paths.ts                   # path validation, slug generation
│   │   └── service.ts                 # create / get / export / validate-root
│   ├── footage/                       # NEW — recording session ledger
│   │   └── service.ts                 # log / list / coverage / delete
│   ├── neurocore/
│   │   └── audience-profiles.ts       # NEW — AudienceProfile client + cache
│   ├── engine/
│   │   ├── format-profiles/           # NEW — TypeScript constants registry
│   │   │   ├── types.ts               # FormatProfile, FormatProfileBeat interfaces
│   │   │   ├── claude-code-build-along.ts   # Default profile (full)
│   │   │   ├── tutorial.ts
│   │   │   ├── case-study.ts
│   │   │   ├── comparison.ts
│   │   │   ├── essay-opinion.ts
│   │   │   ├── listicle.ts
│   │   │   ├── reaction-review.ts
│   │   │   └── index.ts               # FORMAT_PROFILES registry + getFormatProfile()
│   │   ├── compose-prompt.ts          # NEW — buildSystemPrompt() (v1 rules vs format+audience)
│   │   ├── generate-hook-variants.ts  # NEW — Call 5
│   │   ├── generate-shot-list.ts      # NEW — Call 6
│   │   ├── generate-title-variants.ts # NEW — Call 7
│   │   ├── generate-thumbnail-concepts.ts # NEW — Call 8
│   │   ├── extract-shorts.ts          # NEW — Call 9
│   │   └── generate-publish-metadata.ts # NEW — Call 10
│   ├── db/
│   │   ├── deliverables.ts            # NEW
│   │   ├── pipeline-briefs.ts         # NEW
│   │   ├── hook-drafts.ts             # NEW
│   │   ├── title-concepts.ts          # NEW
│   │   ├── thumbnail-concepts.ts      # NEW
│   │   ├── publish-metadata.ts        # NEW
│   │   ├── recording-sessions.ts      # NEW
│   │   └── schemas.ts                 # EXTENDED — new schemas + Plan/Scene additive fields
│   ├── routes/
│   │   ├── intake.tsx                 # NEW
│   │   ├── deliverables.tsx           # NEW
│   │   ├── footage.tsx                # NEW
│   │   ├── workshop.tsx               # NEW — hooks/titles/thumbnails selection routes
│   │   ├── publish.tsx                # NEW
│   │   ├── plan.tsx                   # EXTENDED — adds v2 engine step routes
│   │   └── scenes.tsx                 # EXTENDED — adds shot-list partials
│   └── views/
│       ├── intake.tsx                 # NEW
│       ├── deliverable-bundle.tsx     # NEW
│       ├── deliverable-detail.tsx     # NEW
│       ├── workshop.tsx               # NEW — hook/title/thumbnail card grids
│       ├── publish.tsx                # NEW
│       ├── footage.tsx                # NEW
│       ├── scene-card.tsx             # EXTENDED — shot list section
│       └── plan-detail.tsx            # EXTENDED — deliverables + workshop sections
├── scripts/
│   ├── migrate-youtube-to-youtube-lite.ts          # NEW — one-time migration
│   ├── migrate-youtube-lite-to-youtube.ts          # NEW — rollback companion
│   └── seed-audience-profiles.ts                   # NEW — runs in Neurocore repo, not here
├── tests/
│   ├── intake/                        # NEW
│   ├── workspace/                     # NEW
│   ├── footage/                       # NEW
│   ├── neurocore/audience-profiles.test.ts  # NEW
│   ├── engine/format-profiles/        # NEW — registry tests
│   ├── engine/compose-prompt.test.ts  # NEW
│   ├── engine/generate-hook-variants.test.ts  # NEW (and 6 sibling files for other v2 calls)
│   └── integration/v2-full-pipeline.test.ts   # NEW — end-to-end youtube_advanced
```

v1 file layout preserved entirely. v2 additions slot in alongside v1 files without renaming any v1 module.

## 15. Open Questions

The PRD §17 listed open questions deliberately deferred to this tech spec. Resolved here:

| PRD Question | Resolution in this Tech Spec |
|--------------|------------------------------|
| Exact LLM prompt format for AudienceProfile + FormatProfile composition | §4.5 (prompt block order), §4.6 (`buildSystemPrompt()` interface) |
| Caching strategy for AudienceProfile fetches | §4.2 Component F (in-memory `Map`, process lifetime, cleared on error) |
| Workspace folder path validation regex + Windows gotchas | §4.2 Component I (slug regex, path.resolve + within-root verification); long-path handling via Node 20 native support, no UNC path special-casing in v2 |
| Status transition table for the extended plan status enum | §4.3 (extended transition table additions) |
| HTMX swap patterns for new card-grid selection UIs | Inherited from v1 patterns: `hx-swap="outerHTML"` on card-level updates; selection PATCH returns updated card with `selected` class toggled |
| DB migration path for renaming `youtube` → `youtube_lite` | §4.7 (script-based, deployment sequence in §11) |
| Test fixture strategy for AudienceProfile | §10 (mock Neurocore in unit + integration; real fetch only in manual QA against live Neurocore) |
| Beat-importance heuristic for Shorts extraction | §4.5 Call 9 (hardcoded weights per beat type, LLM uses as input not filter) |

### Genuinely unresolved (escalating to Rick)

| Question | Why it's open | Default I'll use if not answered before M21 |
|---|---|---|
| **`WORKSPACE_ROOT` value on Rick's Windows host** | Drive letter / folder choice is Rick's call. Affects backup, OneDrive sync interference, antivirus path exclusions. | `F:\drek-workspace` (matches existing DREK code project layout per CLAUDE.md) |
| **Should the v2 deploy stop the service mid-day or wait for a low-use window?** | DREK is single-user. Likely fine to deploy whenever. Worth a heads-up. | Deploy whenever Rick is not actively planning a video |
| **Seed AudienceProfile content approval** | I drafted both profiles in §4.8 based on the channel master doc + Misa's content strategy. Rick needs to read and approve before they go live. | Ship as drafted; iterate after first 3 episodes |

---

*Traced from: PRD-drek-v2-youtube-2026-05-18.md (commit 7dc4a59), DREK YouTube gap analysis (8 gaps), YouTube Channel Master Document (16 sections + 14-module proposal), 2026-05-18 discovery room decisions L-1 through L-7, Lisa's PRD review, Nami's funnel math. Extends TECH-SPEC-drek-2026-05-15.md. All v1 architectural decisions remain in force except where explicitly extended here.*
