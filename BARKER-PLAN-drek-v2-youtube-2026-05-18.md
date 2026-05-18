# Barker Build Plan — DREK v2 (YouTube Channel Operating System)

**Plan author:** Tony Stark
**Date:** 2026-05-18
**PRD:** `PRD-drek-v2-youtube-2026-05-18.md` (commit `7dc4a59`)
**Tech Spec:** `TECH-SPEC-drek-v2-youtube-2026-05-18.md` (commit `f7fb871`)
**Target repo:** `Lezzur/drek` (extends v1 in place — no new repo)
**Predecessor v1 specs at repo root (for reference patterns):** `PRD-drek-2026-05-15.md`, `TECH-SPEC-drek-2026-05-15.md`, `README.md`, `CLAUDE.md`

**Scope:** Translates tech-spec milestones M14 Track B through M24 into a parallel build plan. M14 Track A (Neurocore-side `AudienceProfile` CRUD + endpoints + 2 seed profiles) is a **separate Barker plan against the Neurocore repo** and must complete before Phase 3 of this plan runs. M14 Track B (DREK consumer plumbing) is Phase 1 here.

```yaml
project:
  name: "drek-v2"
  description: "DREK v2 — YouTube Channel Operating System (AudienceProfile, format profiles, intake, workspace, footage manifest, hook engineering, shot list, title/thumbnail workshop, publishing metadata, Shorts extractor)"
  working_directory: "."

input_files:
  - path: "PRD-drek-v2-youtube-2026-05-18.md"
    alias: "prd"
    description: "v2 PRD — features, audience model, deliverable artifact model, scope boundaries, milestones"
  - path: "TECH-SPEC-drek-v2-youtube-2026-05-18.md"
    alias: "tech-spec"
    description: "v2 tech spec — component model, data schemas, route table, LLM call architecture, change-format flow"
  - path: "TECH-SPEC-drek-2026-05-15.md"
    alias: "v1-tech-spec"
    description: "v1 tech spec — reference patterns DREK already implements (LLM provider, Neurocore client, polling, HTMX, NSSM, Firestore conventions)"
  - path: "PRD-drek-2026-05-15.md"
    alias: "v1-prd"
    description: "v1 PRD — reference for plan/scene semantics and cover-letter workflow that v2 must preserve"
  - path: "CLAUDE.md"
    alias: "claude-md"
    description: "Service runtime facts — port 3003, NSSM service name DREK, Firebase project red-tool-8193c"
  - path: "README.md"
    alias: "readme"
    description: "Stack overview — TypeScript 5 / Node 20 / Hono 4 / Firestore / Claude CLI / Codex CLI / NSSM"

phases:
  # ============================================================
  # PHASE 1 — Foundation (M14 Track B)
  # AudienceProfile client + format profile registry skeleton
  # ============================================================
  - id: "phase-1"
    name: "Foundation — Neurocore consumer + format registry skeleton"
    description: "DREK-side plumbing for AudienceProfile fetch + format profile registry with claude_code_build_along as the only fully-defined profile. Six other profiles ship as stubs in Phase 3."
    phase_check: "npm run typecheck && npm run lint"
    tasks:
      - id: "p1-ap-client"
        name: "AudienceProfile Neurocore client + cache"
        model: "opus"
        depends_on: []
        estimated_minutes: 20
        context_sources:
          - alias: "tech-spec"
            sections: ["4.2"]
          - alias: "tech-spec"
            sections: ["6"]
          - alias: "prd"
            sections: ["7.1"]
        prompt: |
          Add an AudienceProfile client to DREK at src/neurocore/audience-profiles.ts.

          Read src/neurocore/client.ts and src/neurocore/types.ts to understand the
          existing Neurocore client conventions (bearer auth, retry, error types,
          fetch wrapper). The new client extends the same pattern.

          Define and export:
          - The AudienceProfile TypeScript interface matching the tech-spec section 4.2 Component F schema exactly
          - listAudienceProfiles(): Promise<AudienceProfile[]>
          - getAudienceProfile(id: string): Promise<AudienceProfile>
          - clearAudienceProfileCache(): void  (exposed for tests + manual flush)
          - AudienceProfileNotFoundError, AudienceProfileUnavailableError error subclasses extending the existing NeurocoreError pattern

          Cache: in-memory Map<string, AudienceProfile> keyed by profile ID. On
          successful get/list, populate cache. On ANY fetch failure (timeout,
          5xx, 404, JSON parse error) invalidate the affected cache entry
          before throwing — so the next attempt re-fetches. Default fetch
          timeout 10s, 1 retry with 2s backoff (match existing Neurocore
          client config).

          Endpoint paths:
          - GET {NEUROCORE_URL}/v1/audience-profiles
          - GET {NEUROCORE_URL}/v1/audience-profiles/:id

          Hardening requirements:
          - Bearer auth via NEUROCORE_TOKEN env (read via getEnv() — never log token)
          - Validate response shape with Zod before caching (define audienceProfileSchema)
          - Reject empty/malformed responses with AudienceProfileUnavailableError
          - 404 responses throw AudienceProfileNotFoundError (NOT cached)
          - Never throw a fallback profile — caller must handle the error explicitly
          - All function-level docstrings explaining the cache contract

          Also write tests at tests/neurocore/audience-profiles.test.ts using
          vitest with fetch mocking (follow the pattern in
          tests/neurocore/client.test.ts):
          - Happy path: list returns array; get returns single; both cache
          - Cache hit: second get(id) does not call fetch
          - 404 throws AudienceProfileNotFoundError and does NOT cache
          - 5xx throws AudienceProfileUnavailableError after retry exhaustion
          - Timeout aborts and throws AudienceProfileUnavailableError
          - Malformed JSON throws AudienceProfileUnavailableError
          - clearAudienceProfileCache() empties cache; subsequent get re-fetches
          - Zod rejection (missing required field) throws AudienceProfileUnavailableError
        expected_files:
          - "src/neurocore/audience-profiles.ts"
          - "tests/neurocore/audience-profiles.test.ts"
        done_check: "test -f src/neurocore/audience-profiles.ts && test -f tests/neurocore/audience-profiles.test.ts"

      - id: "p1-format-types"
        name: "Format profile interface + registry skeleton"
        model: "sonnet"
        depends_on: []
        estimated_minutes: 10
        context_sources:
          - alias: "tech-spec"
            sections: ["4.2"]
          - alias: "tech-spec"
            sections: ["8"]
        prompt: |
          Create the format profile registry skeleton at src/engine/format-profiles/.

          Files to create:
          - src/engine/format-profiles/types.ts — FormatProfile and FormatProfileBeat
            interfaces exactly per tech-spec section 4.2 Component G
          - src/engine/format-profiles/index.ts — FORMAT_PROFILES record + getFormatProfile()
            function (throws on unknown id)
          - tests/engine/format-profiles/index.test.ts

          The interfaces must match the tech spec exactly. The registry skeleton
          should import all 7 profile constants by name even though only
          claude_code_build_along is implemented in Phase 1 — the other 6 will be
          stubbed as TODO files in Phase 3. For Phase 1, the registry only exports
          claude_code_build_along; the other 6 imports are commented out with a
          TODO note pointing to Phase 3.

          Hardening requirements:
          - getFormatProfile(id: string) throws FormatProfileNotFoundError on unknown id
          - The error type is exported from types.ts
          - FORMAT_PROFILES is `Readonly<Record<string, FormatProfile>>`
          - Tests assert: registry contains claude_code_build_along; getFormatProfile
            with unknown id throws; FormatProfileNotFoundError name and message are
            descriptive
        expected_files:
          - "src/engine/format-profiles/types.ts"
          - "src/engine/format-profiles/index.ts"
          - "tests/engine/format-profiles/index.test.ts"
        done_check: "test -f src/engine/format-profiles/types.ts && test -f src/engine/format-profiles/index.ts"

      - id: "p1-format-build-along"
        name: "claude_code_build_along format profile (full)"
        model: "opus"
        depends_on: ["p1-format-types"]
        estimated_minutes: 15
        context_sources:
          - alias: "tech-spec"
            sections: ["8.1"]
        prompt: |
          Implement the claude_code_build_along format profile constant at
          src/engine/format-profiles/claude-code-build-along.ts.

          Read src/engine/format-profiles/types.ts to know the FormatProfile shape.

          The profile encodes "The Gauntlet" structure from the channel master doc:
          cold_open (30s), problem (4-5min), war_room (8min), build_reel (10min),
          breakdown (4min), demo (4min), outro (1min). Total runtime 1500-2100s,
          scene range 5-7.

          Implement all fields from the tech-spec section 8.1 reference:
          - 7 beats with name, targetDurationSeconds, description, shotConventions
          - hookGuidelines: multi-line prompt block per the spec ("cold open must
            be FROM the finished product, not a setup line", "first 5 words must
            land", preferred archetypes demo_first/pattern_interrupt, avoid
            bold_claim because it reads as marketing)
          - pacingRules: 150 wpm baseline, sentenceLengthGuide "mix short and
            medium; build_reel faster, war_room slower"
          - shotConventions per beat (primary shot is screenshare except outro
            which uses headshot; diagram overlays first-class)
          - antiPatterns array per the spec ("Hey guys, today we're going to...",
            "Showing brief without first showing the result", "Diagram never
            finishes drawing", "Narrating what Claude is doing while it does it",
            "Outro that doesn't land a pricing moment")
          - ctaPolicy string per spec (outro CTA = consultation booking +
            community join; long-form CTA optimization is priority per Nami's
            funnel math 3.3x revenue per video)

          Also register this profile in src/engine/format-profiles/index.ts by
          uncommenting the import and adding it to the FORMAT_PROFILES record.

          Hardening requirements:
          - All durations are positive integers
          - All arrays non-empty (assert in a Zod schema if convenient; otherwise
            in a unit test)
          - The constant is exported as `export const claude_code_build_along: FormatProfile`
          - Display name uses sentence case ("Claude Code Build-Along")

          Add a test in tests/engine/format-profiles/claude-code-build-along.test.ts
          asserting the profile validates against the FormatProfile interface,
          has 7 beats in the expected order, beats sum to a target runtime within
          the runtimeRange, and is registered in FORMAT_PROFILES.
        expected_files:
          - "src/engine/format-profiles/claude-code-build-along.ts"
          - "src/engine/format-profiles/index.ts"
          - "tests/engine/format-profiles/claude-code-build-along.test.ts"
        done_check: "test -f src/engine/format-profiles/claude-code-build-along.ts"

  # ============================================================
  # PHASE 2 — Data Layer (M15)
  # Schema extensions + new entities + migration + CRUD
  # ============================================================
  - id: "phase-2"
    name: "Data layer — schemas, migration, CRUD"
    description: "Extend Plan/Scene schemas additively, add 7 new entity schemas + extended status transition table, ship one-time youtube→youtube_lite migration script with rollback companion, and CRUD modules for Deliverable, PipelineBrief, RecordingSession, and the 4 subcollection types."
    phase_check: "npm run typecheck"
    tasks:
      - id: "p2-schemas-core"
        name: "Schema — Plan/Scene additive fields + extended status enum + transitions"
        model: "opus"
        depends_on: ["p1-format-types"]
        estimated_minutes: 25
        context_sources:
          - alias: "tech-spec"
            sections: ["4.3"]
          - alias: "tech-spec"
            sections: ["4.7"]
        prompt: |
          Extend src/db/schemas.ts with v2 additive fields and the extended
          plan status enum + transition table.

          READ src/db/schemas.ts FIRST. It currently defines: PLAN_TYPES
          ['cover_letter', 'youtube'], PLAN_STATUSES (7 v1 statuses), planSchema,
          sceneSchema, etc. Do NOT remove or rename anything that exists; v2 is
          purely additive.

          Changes:

          1) Rename the existing 'youtube' enum value to 'youtube_lite' and add
             'youtube_advanced'. Final: PLAN_TYPES = ['cover_letter',
             'youtube_lite', 'youtube_advanced'] as const.

          2) Add v2 status values to PLAN_STATUSES (additive, appended after
             existing values): 'hooks_generated', 'hook_selected',
             'shot_list_generated', 'titles_generated', 'title_selected',
             'thumbnails_generated', 'thumbnail_selected', 'shorts_extracted',
             'metadata_generated'.

          3) Add v2 transitions to the PLAN_TRANSITIONS table per tech-spec
             section 4.3 (the V2_PLAN_TRANSITIONS_ADDITIONS block). Merge them
             into the existing PLAN_TRANSITIONS constant.

          4) Extend planSchema with additive fields (all nullable / defaulted so
             v1 documents continue to validate):
             - formatProfileId: z.string().nullable().default(null)
             - pipelineBriefId: z.string().nullable().default(null)
             - workspacePath: z.string().nullable().default(null)
             - selectedHookVariantId: z.string().nullable().default(null)
             - selectedTitleVariantId: z.string().nullable().default(null)
             - selectedThumbnailConceptId: z.string().nullable().default(null)

          5) Extend sceneSchema with additive fields (all defaulted):
             - beatTag: z.string().nullable().default(null)
             - primaryShot: z.object({ type: z.enum(SCENE_INTERFACE_TYPES), description: z.string() }).nullable().default(null)
             - brollItems, shotListItems, onScreenTextOverlays, cutPoints: z.array(z.object({...})).default([])
             (Define the inner object shapes per tech-spec section 4.3 "Extended Collection: plans/{planId}/scenes" — each is a small object literal.)

          6) Update planPatchSchema to include the new editable plan-level fields
             (formatProfileId, the three selectedXxx fields). Leave
             pipelineBriefId and workspacePath out of patch (set only at creation).

          7) Update planCreateSchema to accept formatProfileId optional (required
             at the route layer when type='youtube_advanced').

          8) Confirm isAllowedPlanTransition() works against the extended table
             without modification (it should — the table lookup is generic).

          Hardening requirements:
          - All new fields default-validate against v1 documents (no breaking
            change). Add a regression test confirming a v1-shaped Plan object
            (no v2 fields) parses cleanly through planSchema.
          - Document each new field with a JSDoc comment naming the v2 feature
            it serves.
          - The renamed PLAN_TYPES preserves array order ['cover_letter',
            'youtube_lite', 'youtube_advanced'] so any reads relying on order
            are deterministic.

          Tests to add in tests/db/schemas.test.ts (or create the file if it
          doesn't exist):
          - v1 Plan document (without v2 fields) parses through planSchema with
            new fields defaulting to null
          - v1 Scene document (without v2 fields) parses through sceneSchema
          - All new v2 status values are accepted by planSchema
          - isAllowedPlanTransition validates each new v2 transition listed in
            the additions table
          - Invalid v2 transitions are rejected (e.g., requirements_reviewed →
            hooks_generated direct jump should fail)
        expected_files:
          - "src/db/schemas.ts"
          - "tests/db/schemas.test.ts"
        done_check: "test -f src/db/schemas.ts && npm run typecheck"

      - id: "p2-schemas-entities"
        name: "Schema — 7 new v2 entities"
        model: "opus"
        depends_on: ["p2-schemas-core"]
        estimated_minutes: 20
        context_sources:
          - alias: "tech-spec"
            sections: ["4.3"]
        prompt: |
          Add Zod schemas for the 7 new v2 entities to src/db/schemas.ts.
          READ src/db/schemas.ts FIRST (it was just extended in p2-schemas-core —
          append new entity sections after the existing ones).

          For each entity, define: the schema, the inferred TypeScript type,
          plus optional create/patch schema variants where they materially
          differ from the base schema. Follow the v1 conventions you see in the
          existing file for plans / scenes / availableListings.

          Entities to add (each per tech-spec section 4.3):
          1) DELIVERABLE_KINDS ['long_form', 'short_clip', 'lead_magnet'] +
             DELIVERABLE_STATUSES ['draft', 'scripts_ready', 'metadata_ready',
             'exported', 'published'] + deliverableSchema + deliverableCreateSchema
          2) BRIEF_STAGES ['candidate', 'vetted', 'selected', 'in_production',
             'published', 'retired'] + briefScoreSchema (visualOutcome,
             storyPotential, scopeFit, audienceMatch all 1-5 ints, aggregate
             number) + pipelineBriefSchema + pipelineBriefCreateSchema (raw
             text capped at 50_000 chars)
          3) HOOK_ARCHETYPES const tuple + hookDraftSchema
          4) TITLE_ARCHETYPES const tuple + titleConceptSchema (titleText max
             70 chars, predictedClickability 1-10)
          5) thumbnailConceptSchema (textHook max 4 words enforced with a
             regex test in the schema, colorPalette array of 1-5 hex strings
             matching ^#[0-9a-fA-F]{6}$)
          6) publishMetadataSchema — chapters array of {timestampSeconds,
             label}, tags array length 1-20
          7) RECORDING_SESSION_TYPES ['build_session', 'demo_session',
             'reflection', 'b_roll', 'screen_capture'] + recordingSessionSchema
             (scenesCovered array length >=1, durationSeconds positive int)

          Hardening requirements:
          - All ID fields are z.string().min(1)
          - All timestamp fields are z.date() (caller converts Firestore
            Timestamp to Date before passing in, same as v1's pattern)
          - All bounded numbers (clickability, scores, durations) have z.int()
            and explicit min/max
          - Where a sensible default exists (selected=false, etc.) include it

          Tests to add to tests/db/schemas.test.ts:
          - One happy-path parse test per entity
          - One bounds violation per entity (e.g., titleText 71 chars rejected;
            colorPalette with bad hex rejected; brief raw text > 50k rejected;
            score outside 1-5 rejected)
        expected_files:
          - "src/db/schemas.ts"
          - "tests/db/schemas.test.ts"
        done_check: "npm run typecheck"

      - id: "p2-migrate-script"
        name: "Migration script — youtube → youtube_lite (+ rollback)"
        model: "opus"
        depends_on: ["p2-schemas-core"]
        estimated_minutes: 15
        context_sources:
          - alias: "tech-spec"
            sections: ["4.7"]
          - alias: "tech-spec"
            sections: ["11"]
        prompt: |
          Implement the one-time idempotent migration scripts at:
          - scripts/migrate-youtube-to-youtube-lite.ts
          - scripts/migrate-youtube-lite-to-youtube.ts (rollback companion)

          Read src/db/firestore.ts to understand Firebase Admin init. Read
          src/db/plans.ts to understand the existing CRUD conventions.

          Each script:
          - Initializes Firebase Admin via the same path as the runtime
            (GOOGLE_APPLICATION_CREDENTIALS env)
          - Queries `plans` collection where `type == 'youtube'` (or
            'youtube_lite' for the rollback)
          - For each matched document, updates ONLY the `type` field — no
            other fields touched
          - Logs the count of updated documents
          - Idempotent: running twice produces no extra writes (because the
            query won't match anything the second time)
          - Exits with code 0 on success, 1 on any error

          Both scripts are runnable via `node dist/scripts/migrate-...js`
          after a build, so they live under scripts/ and emit to dist/scripts/
          (verify the tsconfig output structure already supports this — if it
          doesn't, add a build:scripts npm script to package.json).

          Hardening requirements:
          - Use a batch write capped at 400 operations per batch (Firestore
            limit is 500, leave headroom)
          - On any batch failure, log the failed document IDs and exit 1
            without continuing
          - Print a dry-run mode summary first ("Would update N documents")
            unless --execute flag is passed; require explicit --execute to
            actually write
          - Refuse to run if NODE_ENV is unset OR GOOGLE_APPLICATION_CREDENTIALS
            is unset, with a clear error
          - Never log document data; only log counts and ids

          Add a test at tests/scripts/migration.test.ts using the existing fake
          Firestore (tests/db/fake-firestore.ts):
          - Seeds 5 v1-shaped plans (3 with type='youtube', 2 with type='cover_letter')
          - Runs the migrate-up script (call its exported main() function directly,
            avoiding the CLI shell)
          - Asserts 3 plans now have type='youtube_lite', the 2 cover_letter
            plans untouched
          - Running migrate-up again is a no-op (count = 0)
          - Running migrate-down reverts the 3 plans back to type='youtube'

          Refactor each script to export its main function so the test can
          invoke it without spawning a subprocess.
        expected_files:
          - "scripts/migrate-youtube-to-youtube-lite.ts"
          - "scripts/migrate-youtube-lite-to-youtube.ts"
          - "tests/scripts/migration.test.ts"
        done_check: "test -f scripts/migrate-youtube-to-youtube-lite.ts && test -f scripts/migrate-youtube-lite-to-youtube.ts"

      - id: "p2-crud-deliverables"
        name: "CRUD — Deliverable (+ subcollections)"
        model: "sonnet"
        depends_on: ["p2-schemas-entities"]
        estimated_minutes: 20
        context_sources:
          - alias: "tech-spec"
            sections: ["4.3"]
          - alias: "v1-tech-spec"
            sections: ["4.3"]
        prompt: |
          Implement CRUD modules for the Deliverable entity and its three
          subcollections at:
          - src/db/deliverables.ts (top-level CRUD)
          - src/db/title-concepts.ts (subcollection under each deliverable)
          - src/db/thumbnail-concepts.ts (subcollection)
          - src/db/publish-metadata.ts (single doc 'current' under each deliverable)

          READ src/db/plans.ts and src/db/scenes.ts first — match their
          conventions exactly: optional `db: Firestore` parameter for test
          injection, Zod-validated reads and writes, Timestamp→Date conversion
          at the boundary, batch writes for atomic multi-doc operations.

          Public functions per file (all accept optional `db?: Firestore` last
          arg):

          src/db/deliverables.ts:
          - createDeliverable(planId, input: DeliverableCreate): Promise<Deliverable>
          - getDeliverable(id): Promise<Deliverable | null>
          - listDeliverablesForPlan(planId, opts?: { kind?: DeliverableKind }): Promise<Deliverable[]>
          - findLongFormDeliverable(planId): Promise<Deliverable> (throws DeliverableNotFoundError if none — used by plan-level convenience routes per tech-spec section 4.2 Component K invariant)
          - updateDeliverable(id, patch: DeliverablePatch): Promise<void>
          - deleteDeliverable(id): Promise<void> (cascades subcollections via batch)

          src/db/title-concepts.ts and src/db/thumbnail-concepts.ts:
          - createConcept(deliverableId, input): Promise<Concept>
          - listConceptsForDeliverable(deliverableId): Promise<Concept[]>
          - setSelectedConcept(deliverableId, conceptId): Promise<void> (toggles `selected` flag — flips the newly selected one to true and every other in the same deliverable to false, atomic via batch)
          - getSelectedConcept(deliverableId): Promise<Concept | null>
          - deleteAllForDeliverable(deliverableId): Promise<void>

          src/db/publish-metadata.ts:
          - upsertPublishMetadata(deliverableId, input): Promise<PublishMetadata>
          - getPublishMetadata(deliverableId): Promise<PublishMetadata | null>
          - deletePublishMetadata(deliverableId): Promise<void>

          Export DeliverableNotFoundError from src/db/deliverables.ts.

          Hardening requirements:
          - All writes validated through their Zod schemas before persistence
          - All reads validated through Zod after fetch (defends against
            corrupted documents from older deploys)
          - setSelectedConcept uses Firestore batch for atomicity
          - Cascade deletes use batch with the 400-op chunking guard from p2-migrate-script
          - No function returns Firestore-specific types (Timestamp, etc.) —
            convert at the boundary

          Tests at:
          - tests/db/deliverables.test.ts (CRUD + cascade + findLongForm + DeliverableNotFoundError)
          - tests/db/title-concepts.test.ts (CRUD + setSelected atomic toggle + multi-concept switching)
          - tests/db/thumbnail-concepts.test.ts (mirror title-concepts pattern)
          - tests/db/publish-metadata.test.ts (upsert overwrites cleanly)
          Use the existing tests/db/fake-firestore.ts.
        expected_files:
          - "src/db/deliverables.ts"
          - "src/db/title-concepts.ts"
          - "src/db/thumbnail-concepts.ts"
          - "src/db/publish-metadata.ts"
          - "tests/db/deliverables.test.ts"
          - "tests/db/title-concepts.test.ts"
          - "tests/db/thumbnail-concepts.test.ts"
          - "tests/db/publish-metadata.test.ts"
        done_check: "test -f src/db/deliverables.ts && test -f src/db/publish-metadata.ts"

      - id: "p2-crud-misc"
        name: "CRUD — PipelineBrief, HookDraft, RecordingSession"
        model: "sonnet"
        depends_on: ["p2-schemas-entities"]
        estimated_minutes: 20
        context_sources:
          - alias: "tech-spec"
            sections: ["4.3"]
        prompt: |
          Implement CRUD modules at:
          - src/db/pipeline-briefs.ts
          - src/db/hook-drafts.ts (subcollection under each plan)
          - src/db/recording-sessions.ts

          READ src/db/plans.ts for conventions (optional db arg, Zod
          validation, batch writes, no Firestore types at the boundary).

          Functions:

          src/db/pipeline-briefs.ts:
          - createPipelineBrief(input: PipelineBriefCreate): Promise<PipelineBrief>
          - listPipelineBriefs(opts?: { stage?: BriefStage; limit?: number; sortBy?: 'aggregate' | 'updatedAt' }): Promise<PipelineBrief[]>
          - getPipelineBrief(id): Promise<PipelineBrief | null>
          - updatePipelineBrief(id, patch): Promise<void>  (allows score, stage, scoringRationale, promotedPlanId)
          - countByStage(): Promise<Record<BriefStage, number>>  (used by the queue depth indicator)

          src/db/hook-drafts.ts (subcollection: plans/{planId}/hook_drafts):
          - createHookDraft(planId, input): Promise<HookDraft>
          - listHookDraftsForPlan(planId): Promise<HookDraft[]>
          - setSelectedHookDraft(planId, hookId): Promise<void>  (atomic toggle — same pattern as title concepts)
          - getSelectedHookDraft(planId): Promise<HookDraft | null>
          - deleteAllHookDraftsForPlan(planId): Promise<void>

          src/db/recording-sessions.ts:
          - logRecordingSession(input: RecordingSessionCreate): Promise<RecordingSession>
          - listSessionsForPlan(planId): Promise<RecordingSession[]>  (sorted by dateRecorded desc)
          - deleteRecordingSession(id): Promise<void>
          - computeSceneCoverage(planId): Promise<Record<string, { covered: boolean; sessionIds: string[] }>>
            (read all sessions for the plan, fold into the {sceneId → coverage} map; cheap to recompute on read)

          Hardening requirements:
          - countByStage runs as a single Firestore aggregation if available;
            otherwise a query per stage. Document the choice.
          - computeSceneCoverage handles the case where a recording session
            references a sceneId that no longer exists (renamed in a regeneration);
            those references are silently dropped from the coverage map.
          - All listing functions cap at limit=200 by default.

          Tests at:
          - tests/db/pipeline-briefs.test.ts (CRUD + filter by stage + count + sort)
          - tests/db/hook-drafts.test.ts (CRUD + atomic selection toggle)
          - tests/db/recording-sessions.test.ts (log + list + coverage computation
            including the dangling-sceneId edge case)
          Use tests/db/fake-firestore.ts.
        expected_files:
          - "src/db/pipeline-briefs.ts"
          - "src/db/hook-drafts.ts"
          - "src/db/recording-sessions.ts"
          - "tests/db/pipeline-briefs.test.ts"
          - "tests/db/hook-drafts.test.ts"
          - "tests/db/recording-sessions.test.ts"
        done_check: "test -f src/db/pipeline-briefs.ts && test -f src/db/recording-sessions.ts"

      - id: "p2-firestore-indexes"
        name: "Firestore composite indexes"
        model: "sonnet"
        depends_on: ["p2-crud-deliverables", "p2-crud-misc"]
        estimated_minutes: 5
        context_sources:
          - alias: "tech-spec"
            sections: ["4.3"]
        prompt: |
          Add the v2 composite indexes to firestore.indexes.json:

          - pipeline_briefs: (stage ASC, updatedAt DESC)
          - pipeline_briefs: (stage ASC, score.aggregate DESC)
          - deliverables: (planId ASC) — single-field indexes are auto-created
            by Firestore for top-level fields, so this MAY not be needed; only
            add if Firestore CLI flags it
          - deliverables: (status ASC, updatedAt DESC)
          - recording_sessions: (planId ASC, dateRecorded DESC)

          READ the existing firestore.indexes.json first — preserve all v1
          indexes; only append v2 entries.

          No tests required — the file is a Firebase config artifact validated
          by Firebase CLI on deploy.
        expected_files:
          - "firestore.indexes.json"
        done_check: "test -f firestore.indexes.json"

  # ============================================================
  # PHASE 3 — Engine core extensions (M14 completion + 6 remaining format profiles)
  # ============================================================
  - id: "phase-3"
    name: "Engine core — compose-prompt, format profile fill-out, v1 engine extensions"
    description: "buildSystemPrompt() composition function gates v1 vs v2 paths; the 6 remaining format profiles ship with minimum-viable structure; v1 engine steps (match-projects, generate-scenes, write-scripts) accept optional format+audience injection so future v2 calls can layer onto them."
    phase_check: "npm run typecheck && npm run lint"
    tasks:
      - id: "p3-compose-prompt"
        name: "compose-prompt — gate v1 vs v2 prompt construction"
        model: "opus"
        depends_on: ["p1-ap-client", "p1-format-build-along", "p2-schemas-core"]
        estimated_minutes: 20
        context_sources:
          - alias: "tech-spec"
            sections: ["4.5"]
          - alias: "tech-spec"
            sections: ["4.6"]
        prompt: |
          Create src/engine/compose-prompt.ts implementing the buildSystemPrompt()
          function exactly per tech-spec section 4.6.

          Signature:
            buildSystemPrompt(opts: {
              v1CompositionRules?: CompositionRules;
              formatProfile?: FormatProfile;
              audienceProfile?: AudienceProfile;
              taskInstructions: string;
            }): string

          Read src/engine/composition-rules.ts to know the v1 CompositionRules
          interface. Read src/engine/format-profiles/types.ts and
          src/neurocore/audience-profiles.ts for the v2 types.

          Behavior:
          - Render v1CompositionRules block (if present) via existing helper or
            inline template, matching the format v1 engine steps already emit
          - Render formatProfile block (if present) — beats listed in order
            with target durations, hook guidelines verbatim, pacing rules,
            shot conventions, anti-patterns listed, ctaPolicy verbatim
          - Render audienceProfile block (if present) — full schema rendered
            verbatim into XML-like wrapper <audience_profile>...</audience_profile>
            for clear delimitation in the LLM prompt
          - Concatenate blocks with '\n\n---\n\n' separator, then append
            taskInstructions

          Assert at function boundary: exactly one of {v1CompositionRules} OR
          {formatProfile + audienceProfile} must be provided. Other
          combinations throw PromptCompositionError (defined in same file).
          This prevents accidental mode-blending.

          Hardening requirements:
          - PromptCompositionError messages enumerate the offending option set
            for fast debugging
          - taskInstructions is required (rejected if empty)
          - If formatProfile is set without audienceProfile (or vice versa),
            throw with a clear message ("v2 prompt composition requires BOTH
            formatProfile and audienceProfile")
          - Block headers use stable strings ("=== FORMAT PROFILE ===",
            "=== AUDIENCE PROFILE ===", "=== TASK INSTRUCTIONS ===") so engine
            tests can assert presence without brittle whitespace matching

          Tests at tests/engine/compose-prompt.test.ts:
          - v1 path: only v1CompositionRules + taskInstructions → output
            contains v1 block headers + instructions, no v2 headers
          - v2 path: both formatProfile + audienceProfile + taskInstructions →
            output contains both v2 headers (format first, audience second per
            spec), no v1 headers
          - Mixing (v1Rules + formatProfile) → throws PromptCompositionError
          - formatProfile alone (no audience) → throws PromptCompositionError
          - Empty taskInstructions → throws
          - Render order assertion: format profile block precedes audience
            profile block (load-bearing per tech-spec)
        expected_files:
          - "src/engine/compose-prompt.ts"
          - "tests/engine/compose-prompt.test.ts"
        done_check: "test -f src/engine/compose-prompt.ts"

      - id: "p3-format-rest"
        name: "Format profiles — tutorial, case_study, comparison, essay_opinion, listicle, reaction_review"
        model: "sonnet"
        depends_on: ["p1-format-build-along"]
        estimated_minutes: 25
        context_sources:
          - alias: "tech-spec"
            sections: ["8.2"]
        prompt: |
          Implement the 6 remaining format profile constants. Each lives in
          its own file under src/engine/format-profiles/:

          - tutorial.ts (step-by-step how-to; pacing 175 wpm; "show then explain")
          - case-study.ts (results-led; structure outcome→problem→approach→result-revisited; heavy on numbers/screenshots)
          - comparison.ts (X vs Y; criteria→A→B→verdict; symmetrical scene budget)
          - essay-opinion.ts (single argument; thesis→evidence→counterargument→conclusion; personality-allowed)
          - listicle.ts (N things; per-item structure; pacing 200 wpm; short scenes 60s each)
          - reaction-review.ts (commentary on external content; rare use; flag licensing care in anti-patterns)

          Each profile must implement the full FormatProfile interface from
          src/engine/format-profiles/types.ts. Read src/engine/format-profiles/claude-code-build-along.ts
          as the reference for what "full" looks like.

          Minimum viable: 4-7 beats per profile (whatever fits the structure),
          plausible runtime range, plausible hook guidelines, pacing rules,
          short shot conventions, at least 3 anti-patterns each, plain ctaPolicy.
          Don't overthink — these can be tuned after first real-world use.

          Register all 6 in src/engine/format-profiles/index.ts by adding their
          imports + entries to FORMAT_PROFILES. The registry should now expose
          7 profiles total (build-along + these 6).

          Hardening requirements: same as p1-format-build-along (positive
          durations, non-empty arrays, exported names match file names).

          Add a single sweep test at tests/engine/format-profiles/registry.test.ts:
          - All 7 profiles are registered
          - Each profile passes the same interface-shape assertion as
            claude_code_build_along
          - getFormatProfile() returns the right profile by id for all 7
        expected_files:
          - "src/engine/format-profiles/tutorial.ts"
          - "src/engine/format-profiles/case-study.ts"
          - "src/engine/format-profiles/comparison.ts"
          - "src/engine/format-profiles/essay-opinion.ts"
          - "src/engine/format-profiles/listicle.ts"
          - "src/engine/format-profiles/reaction-review.ts"
          - "src/engine/format-profiles/index.ts"
          - "tests/engine/format-profiles/registry.test.ts"
        done_check: "test -f src/engine/format-profiles/tutorial.ts && test -f src/engine/format-profiles/listicle.ts"

      - id: "p3-engine-v1-extensions"
        name: "v1 engine steps — accept format + audience injection"
        model: "opus"
        depends_on: ["p3-compose-prompt"]
        estimated_minutes: 25
        context_sources:
          - alias: "tech-spec"
            sections: ["4.5"]
          - alias: "tech-spec"
            sections: ["4.6"]
        prompt: |
          Modify three existing v1 engine steps so they accept optional
          formatProfileId + audienceProfileId. When both are provided, they
          route the prompt through buildSystemPrompt() v2 path. When neither
          is provided (existing v1 plan types), they keep the existing v1 path.

          Files to modify:
          - src/engine/match-projects.ts
          - src/engine/generate-scenes.ts
          - src/engine/write-scripts.ts

          READ each file first to understand its current signature, prompt
          construction, and LLM call shape. The change is:

          1. Add two new optional parameters to the engine step's main
             function: { formatProfileId?: string; audienceProfileId?: string }
          2. When both are present:
             a. Fetch the FormatProfile from src/engine/format-profiles/index.ts
                via getFormatProfile()
             b. Fetch the AudienceProfile from src/neurocore/audience-profiles.ts
                via getAudienceProfile()
             c. Construct the system prompt via buildSystemPrompt() v2 path
                (formatProfile + audienceProfile + taskInstructions)
          3. When neither is present:
             a. Use the existing v1 composition rules (COVER_LETTER_RULES /
                YOUTUBE_RULES)
             b. Construct via buildSystemPrompt() v1 path
                (v1CompositionRules + taskInstructions)
          4. If exactly one is present, throw an error — partial v2 config is
             a bug.
          5. Error propagation: AudienceProfileUnavailableError /
             AudienceProfileNotFoundError must surface to the caller without
             swallowing — the engine step does not fall back to generic voice.

          Hardening requirements:
          - All existing v1 test cases must still pass unchanged — these are
             additive parameters with safe defaults
          - The format+audience pair is asserted in the function (not just at
             the route layer) so engine-level callers can't accidentally
             produce mode-blended output
          - The v2 path includes the AudienceProfile's pacingRules.wordsPerMinute
             when calculating word budgets, overriding the v1 default of 150

          Tests:
          - Extend existing tests/engine/*.test.ts files for each step
          - Add a new v2-path test per step: stub LLM + fixture format profile
            + fixture audience profile, assert the rendered system prompt
            contains both blocks via the stable headers from p3-compose-prompt
          - Add a partial-config test per step: passing only formatProfileId
            (or only audienceProfileId) throws
          - Confirm v1 paths produce byte-identical prompts to the v1
            implementation (snapshot test if convenient)
        expected_files:
          - "src/engine/match-projects.ts"
          - "src/engine/generate-scenes.ts"
          - "src/engine/write-scripts.ts"
          - "tests/engine/match-projects.test.ts"
          - "tests/engine/generate-scenes.test.ts"
          - "tests/engine/write-scripts.test.ts"
        done_check: "npm run typecheck"

  # ============================================================
  # PHASE 4 — Intake module (M16)
  # ============================================================
  - id: "phase-4"
    name: "Intake — pipeline brief sourcing + scoring + promote-to-plan"
    description: "Module 1 from the channel master doc: paste a brief, score it via LLM or manually, queue it, promote to a youtube_advanced plan with audience binding."
    phase_check: "npm run typecheck && npm run lint"
    tasks:
      - id: "p4-intake-service"
        name: "Intake service — CRUD + state machine + promote"
        model: "sonnet"
        depends_on: ["p2-crud-misc", "p2-crud-deliverables", "p3-engine-v1-extensions"]
        estimated_minutes: 20
        context_sources:
          - alias: "tech-spec"
            sections: ["4.2"]
          - alias: "tech-spec"
            sections: ["4.3"]
        prompt: |
          Implement src/intake/service.ts wrapping the pipeline brief CRUD
          (from src/db/pipeline-briefs.ts) with explicit state machine
          transitions and a promote-to-plan flow.

          Public functions:
          - createBrief(input: PipelineBriefCreate): Promise<PipelineBrief>
            (delegate to db.createPipelineBrief, stage='candidate')
          - listBriefs(opts): Promise<PipelineBrief[]> (delegate, expose stage/sort)
          - getBrief(id): Promise<PipelineBrief>
          - updateBriefScore(id, score: BriefScore, rationale?: string): Promise<void>
          - transitionBriefStage(id, toStage: BriefStage): Promise<void>
          - promoteBriefToPlan(briefId, opts: {
              formatProfileId: string;
              audienceProfileId: string;
            }): Promise<{ planId: string; deliverableId: string }>

          Stage transitions allowed: candidate → vetted → selected →
          in_production → published → retired. Backward to 'retired' allowed
          from any stage. Define a STAGE_TRANSITIONS table and an
          isAllowedStageTransition() helper; throw InvalidStageTransitionError
          on illegal transitions.

          promoteBriefToPlan implementation — CRITICAL invariant per tech-spec
          section 4.2 Component K:
          1. Read src/db/plans.ts and src/db/deliverables.ts.
          2. Validate the brief is at stage 'vetted' (or 'candidate' with score
             present — per Rick's "LLM scoring on day 1" directive, score must
             exist before promote).
          3. In a single Firestore batch:
             a. Create a Plan with type='youtube_advanced', formatProfileId,
                pipelineBriefId=briefId, status='awaiting_review', title from
                brief.title, target runtime from format profile defaults
             b. Create a Deliverable with kind='long_form', planId=newPlanId,
                audienceProfileId, status='draft', title from brief.title
             c. Update the brief with promotedPlanId and stage='selected'
          4. Partial-failure semantics: a Firestore batch is atomic, so partial
             failure leaves nothing persisted. Return the new planId +
             deliverableId. If the batch throws, log + rethrow.

          Hardening requirements:
          - Validate audienceProfileId by attempting getAudienceProfile() first
            — fail fast (before any writes) if the profile doesn't exist
          - Validate formatProfileId via getFormatProfile() — fail fast if unknown
          - Wrap the batch in a try/finally that logs success/failure with
            briefId, planId, deliverableId
          - Refuse to promote a brief that already has promotedPlanId set —
            throw BriefAlreadyPromotedError

          Tests at tests/intake/service.test.ts:
          - createBrief defaults to 'candidate' stage
          - Valid stage transitions accepted; invalid rejected
          - promoteBriefToPlan creates Plan + Deliverable in one batch
            (assert both exist after a successful call; assert brief stage
             advanced to 'selected')
          - Promote rejects if score missing (Rick's day-one rule)
          - Promote rejects if audienceProfileId unknown (mock the
            AudienceProfile client to throw AudienceProfileNotFoundError)
          - Promote rejects if formatProfileId unknown
          - Promote rejects if brief already promoted (BriefAlreadyPromotedError)
          - Promote idempotent on transient failures (since it's a batch,
            second attempt after a failure starts from scratch — assert no
            zombie plans created by simulating a failed first batch)
        expected_files:
          - "src/intake/service.ts"
          - "tests/intake/service.test.ts"
        done_check: "test -f src/intake/service.ts"

      - id: "p4-score-brief"
        name: "Engine step — score-brief (Call 11)"
        model: "opus"
        depends_on: ["p4-intake-service"]
        estimated_minutes: 15
        context_sources:
          - alias: "tech-spec"
            sections: ["4.5"]
        prompt: |
          Implement src/intake/scoring.ts containing the score-brief LLM call
          (Call 11 per tech-spec section 4.5).

          Read src/engine/match-projects.ts for the pattern of an LLM engine
          step (LLM provider call via getLLMProvider(), Zod-validated structured
          output, retry-once on bad JSON, typed errors).

          Public function:
            scoreBriefViaLLM(briefId: string, opts?: { db?: Firestore }): Promise<BriefScore & { rationale: string }>

          1. Load the brief via getPipelineBrief()
          2. Construct a system prompt asking the LLM to score against the
             rubric (visualOutcome, storyPotential, scopeFit, audienceMatch
             all 1-5 with concrete definitions per the channel master doc)
          3. Provide the brief raw text as user prompt
          4. Request structured JSON output with shape { visualOutcome,
             storyPotential, scopeFit, audienceMatch, aggregate, rationale }
          5. Parse with Zod; retry once on parse failure with stricter
             instruction
          6. Persist score + rationale via updatePipelineBrief()
          7. Return the score for the caller (route handler) to surface

          Scoring rubric definitions (include verbatim in system prompt):
          - visualOutcome (1-5): Will the finished build produce something
            visually compelling that holds the camera? 1 = boring backend.
            5 = stunning live demo.
          - storyPotential (1-5): Does the brief contain natural narrative
            arcs (failure→recovery, surprise solution, etc.)? 1 = flat. 5 =
            built-in drama.
          - scopeFit (1-5): Is this completable in a 4-hour Claude Code
            session? 1 = months of work. 5 = clean 2-4hr build.
          - audienceMatch (1-5): How well does this match the
            developer_longform audience (AI/automation practitioners)? 1 =
            wrong tribe. 5 = bullseye.
          - aggregate: arithmetic mean of the four, to one decimal.

          Hardening requirements:
          - LLM timeout 30s per spec
          - Bad JSON: retry once with stricter "respond ONLY with JSON
            matching this shape" prompt; second failure throws
            BriefScoringFailedError (defined here)
          - Brief raw text capped at 50KB before injection (defensive — the
            schema already enforces this on write)
          - Never persist invalid score (e.g., values outside 1-5) — Zod
            validation gates the write

          Tests at tests/intake/scoring.test.ts using the existing LLM
          provider mock pattern from tests/engine/:
          - Happy path: LLM returns valid score, persisted to brief, returned
          - Bad JSON first attempt, valid second attempt → succeeds, persists
          - Bad JSON twice → throws BriefScoringFailedError
          - Brief not found → throws (delegated from getPipelineBrief)
          - Score values outside 1-5 from LLM → Zod rejects, treated as bad
            JSON path (retry)
        expected_files:
          - "src/intake/scoring.ts"
          - "tests/intake/scoring.test.ts"
        done_check: "test -f src/intake/scoring.ts"

      - id: "p4-intake-routes"
        name: "Intake routes — /intake page + actions"
        model: "sonnet"
        depends_on: ["p4-score-brief"]
        estimated_minutes: 20
        context_sources:
          - alias: "tech-spec"
            sections: ["4.4"]
        prompt: |
          Implement src/routes/intake.tsx exposing all v2 intake routes
          per tech-spec section 4.4 "Page Routes (new)" + "Action Routes (new)"
          + the relevant HTMX partials.

          Read src/routes/plan.tsx and src/routes/dashboard.tsx for the existing
          route pattern (Hono router, JSX returns, HTMX partial routes that
          return HTML fragments).

          Routes to implement:

          Page routes (return full HTML pages):
          - GET /intake — pipeline brief list with stage filter ?stage=...
          - GET /intake/new — manual brief paste form
          - GET /intake/:briefId — brief detail + score + promote controls

          Action routes (form submissions, return redirect or HTMX partial):
          - POST /intake — create brief from form (title, sourceUrl?, rawText)
          - POST /intake/:briefId/score — trigger LLM scoring; returns the
            updated brief card partial via HTMX
          - POST /intake/:briefId/stage — transition stage (body: {stage})
          - POST /intake/:briefId/promote — promote to plan (body:
            {formatProfileId, audienceProfileId}); returns a redirect to the
            new plan detail page

          HTMX partial routes:
          - GET /intake/:briefId/score-form — manual score editor partial
          - PATCH /intake/:briefId — save manual score edits, return updated card

          Mount src/routes/intake.tsx in src/server.ts. READ src/server.ts
          first — match the route ordering convention (more-specific routes
          before wildcards).

          For the promote form: list available format profiles from
          FORMAT_PROFILES + audience profiles via listAudienceProfiles().
          Default the audience selector to 'developer_longform'.

          Hardening requirements:
          - All form inputs validated server-side with Zod (no raw req.body
            trust)
          - Reject non-form POSTs with 415
          - Surface BriefScoringFailedError, BriefAlreadyPromotedError,
            AudienceProfileNotFoundError as user-visible flash messages, not
            500 stack traces
          - All routes guard for valid briefId (404 with structured error if
            not found)
          - The promote form CSRF-guards by requiring the form to be loaded
            from /intake/:briefId first (this is single-user localhost so a
            real CSRF token isn't required, but a same-origin Referer check
            is a reasonable defensive layer — match v1's pattern, do not
            invent a new mechanism)

          Tests at tests/routes/intake.test.ts:
          - GET /intake renders the brief list
          - POST /intake creates a brief and redirects to /intake/:id
          - POST /intake/:id/score triggers scoring and returns updated card
          - POST /intake/:id/promote creates plan, returns redirect to
            /plans/:planId
          - Promote rejects unknown audience profile (404-renders the form
            with error)
        expected_files:
          - "src/routes/intake.tsx"
          - "src/server.ts"
          - "tests/routes/intake.test.ts"
        done_check: "test -f src/routes/intake.tsx"

      - id: "p4-intake-views"
        name: "Intake views — list, detail, new form"
        model: "sonnet"
        depends_on: ["p4-intake-routes"]
        estimated_minutes: 20
        context_sources:
          - alias: "tech-spec"
            sections: ["4.2"]
          - alias: "prd"
            sections: ["4.3"]
        prompt: |
          Implement the JSX views for the intake module:
          - src/views/intake.tsx — list + filters + queue depth indicator
          - src/views/intake-detail.tsx — brief detail with score panel +
            promote-to-plan form
          - src/views/intake-new.tsx — manual paste form

          Read src/views/dashboard.tsx and src/views/plan-detail.tsx for the
          existing JSX + HTMX conventions (Layout wrapper, status badges,
          HTMX attributes hx-get/hx-post/hx-target/hx-swap, system fonts,
          monochrome + accent color).

          intake.tsx (BriefListPage):
          - Stage filter pills (candidate, vetted, selected, in_production,
            published, retired) — clicking filters via ?stage= query
          - Queue depth indicator at top: count of {candidate + vetted}; if
            <3 show a warning banner ("Pipeline thin — source more briefs")
          - Table or card layout per brief: title, company, score aggregate,
            stage badge, action buttons (Score, Promote, Retire) wired to
            hx-post
          - "Add brief" button → /intake/new

          intake-detail.tsx (BriefDetailPage):
          - Brief title, company, sourceUrl link
          - Raw text in a collapsible <details> element
          - Score panel showing all 4 dimensions + aggregate + rationale, with
            an "Edit scores manually" toggle that swaps in an HTMX form
          - "Score with LLM" button (disabled if score already exists; offers
            "Re-score" instead)
          - Promote form: format profile dropdown, audience profile dropdown,
            "Promote to plan" submit button; submission goes to POST
            /intake/:briefId/promote

          intake-new.tsx (NewBriefForm):
          - Title field (required, max 200 chars)
          - Source URL field (optional, must look like a URL if provided)
          - Raw text textarea (required, max 50000 chars, character counter
            visible)
          - Company field (optional)
          - Submit goes to POST /intake

          Add a Dashboard nav link to /intake — modify src/views/layout.tsx
          if there's a shared nav bar; otherwise add a link at the top of
          dashboard.tsx.

          Hardening requirements (UI):
          - Loading skeletons via aria-busy attributes during HTMX requests
          - Error states for failed HTMX calls (htmx hx-on:htmx:responseError
            handler showing a toast)
          - Empty state for the brief list ("No briefs yet — paste your first
            from Upwork.")
          - Form validation errors echoed back inline (don't lose the user's
            input)
          - Character counter on the raw text textarea turns red at 95% of cap

          Tests at:
          - tests/views/intake.test.tsx — list renders, empty state, queue
            warning when <3
          - tests/views/intake-detail.test.tsx — score panel, promote form,
            HTMX attributes present
          - tests/views/intake-new.test.tsx — form fields, validation classes
          Use the existing view-test pattern from tests/views/.
        expected_files:
          - "src/views/intake.tsx"
          - "src/views/intake-detail.tsx"
          - "src/views/intake-new.tsx"
          - "tests/views/intake.test.tsx"
          - "tests/views/intake-detail.test.tsx"
          - "tests/views/intake-new.test.tsx"
        done_check: "test -f src/views/intake.tsx"

  # ============================================================
  # PHASE 5 — Episode planner + change-format (M17)
  # ============================================================
  - id: "phase-5"
    name: "Episode planner + change-format wipe-and-revert"
    description: "Extend requirement detection for youtube_advanced (episodeAngle, antiAngle, technicalScope, intendedTakeaway, risks). Episode outline with format-profile beat tags. Mid-plan format change wipe-and-revert flow per tech-spec §4.9."
    phase_check: "npm run typecheck"
    tasks:
      - id: "p5-detect-episode-requirements"
        name: "Engine step — episode requirements for youtube_advanced"
        model: "opus"
        depends_on: ["p3-engine-v1-extensions"]
        estimated_minutes: 15
        context_sources:
          - alias: "tech-spec"
            sections: ["4.5"]
          - alias: "prd"
            sections: ["4.5"]
        prompt: |
          Modify src/engine/detect-requirements.ts so it handles youtube_advanced
          plans differently from cover_letter plans. Read the file first to
          understand the existing v1 behavior.

          For type='youtube_advanced' plans, the engine step produces a
          different structured output:
            {
              episodeAngle: string,        // "what this episode IS about"
              antiAngle: string,           // "what this episode is NOT about"
              technicalScope: string,      // what gets shown vs deferred
              intendedTakeaway: string,    // one-sentence viewer outcome
              risksToFlag: string[]        // where the build might go wrong on camera
            }

          The system prompt is composed via buildSystemPrompt() v2 path
          (format profile + audience profile + task instructions). Task
          instructions describe the desired output schema with an example.

          For cover_letter and youtube_lite plans, behavior unchanged — the
          existing v1 path produces requirements[] as before.

          Storage: the structured episode-level output for youtube_advanced
          plans is stored on the plan record itself. Re-use the existing
          requirements field by encoding the structured output as a single
          requirement with category='episode_outline' and skill='full' and
          evidence=JSON-stringified-payload. This avoids a schema migration.
          (Note: a cleaner v2.1 refactor would extract this into a dedicated
          plan.episodeBrief field — flag this in a code comment as a known
          v2.1 cleanup item.)

          Hardening requirements:
          - Existing v1 tests must continue to pass byte-identically
          - youtube_advanced path fetches format + audience profile and asserts
            both present before LLM call
          - Bad JSON retry-once pattern from existing v1 detect-requirements
          - Plan must be at status 'awaiting_review' or 'requirements_reviewed'
            to invoke; otherwise throw InvalidPlanStatusError

          Tests at tests/engine/detect-requirements.test.ts (extend existing):
          - v1 cover_letter path unchanged
          - youtube_advanced path produces 5-field structured output via mock
            LLM
          - Missing format profile id throws
          - Missing audience profile id throws
        expected_files:
          - "src/engine/detect-requirements.ts"
          - "tests/engine/detect-requirements.test.ts"
        done_check: "npm run typecheck"

      - id: "p5-generate-scenes-beats"
        name: "Episode outline with format-profile beat tags"
        model: "opus"
        depends_on: ["p5-detect-episode-requirements", "p3-format-rest"]
        estimated_minutes: 20
        context_sources:
          - alias: "tech-spec"
            sections: ["4.5"]
          - alias: "prd"
            sections: ["4.6"]
        prompt: |
          Modify src/engine/generate-scenes.ts so the youtube_advanced path
          produces scenes tagged with format-profile beat names.

          For type='youtube_advanced' plans:
          1. Load the format profile via getFormatProfile(plan.formatProfileId)
          2. System prompt includes the format profile's beats array (with
             names + target durations) via buildSystemPrompt() v2 path
          3. The LLM produces N scenes (within formatProfile.sceneRange) where
             each scene carries beatTag — one of the format profile beat names
          4. Persist scenes with beatTag field populated
          5. Initial values for v2 scene fields not produced here (primaryShot,
             brollItems, shotListItems, onScreenTextOverlays, cutPoints) are
             defaulted to null/[] per the schema; they'll be populated by
             p7-shot-list later

          For cover_letter and youtube_lite: behavior unchanged.

          Hardening requirements:
          - LLM output validated: every scene's beatTag must be a known beat
            from the selected format profile; reject + retry on mismatch
          - Scene count must fall within formatProfile.sceneRange — reject +
            retry if out of range
          - Existing v1 tests continue to pass
          - Composition rules from v1 not used in the v2 path (no
            mode-blending — compose-prompt enforces this)

          Tests at tests/engine/generate-scenes.test.ts:
          - v1 cover_letter path unchanged
          - youtube_advanced path produces N scenes each tagged with a valid
            beat name
          - LLM output with unknown beatTag triggers retry
          - LLM output with scene count outside formatProfile.sceneRange
            triggers retry
        expected_files:
          - "src/engine/generate-scenes.ts"
          - "tests/engine/generate-scenes.test.ts"
        done_check: "npm run typecheck"

      - id: "p5-change-format-flow"
        name: "Mid-plan format change — wipe-and-revert"
        model: "opus"
        depends_on: ["p2-crud-deliverables", "p2-crud-misc", "p5-generate-scenes-beats"]
        estimated_minutes: 20
        context_sources:
          - alias: "tech-spec"
            sections: ["4.9"]
        prompt: |
          Implement the change-format flow per tech-spec section 4.9.

          Files:
          - src/engine/change-format.ts — service function performing the wipe
          - src/routes/plan.tsx — add POST /plans/:id/change-format route
          - src/views/plan-detail.tsx — add format selector with hx-confirm

          src/engine/change-format.ts public function:
            changePlanFormatProfile(planId: string, newFormatProfileId: string): Promise<void>

          Pre-conditions (each throws a typed error if violated):
          - Plan must exist and be type='youtube_advanced' (else
            UnsupportedPlanTypeError)
          - Plan status must NOT be 'exported' or 'published' (else
            CannotChangeFormatAfterPublishError)
          - newFormatProfileId must exist in FORMAT_PROFILES (else
            FormatProfileNotFoundError)

          No-op short-circuit: if plan.status is at or before
          'projects_matched', just update plan.formatProfileId and return
          without wiping (no scenes exist yet).

          Wipe scope (single Firestore batch):
          - Delete all docs in plans/{planId}/scenes
          - Delete all docs in plans/{planId}/hook_drafts
          - For the long_form Deliverable (via findLongFormDeliverable):
            - Delete all docs in title_concepts subcollection
            - Delete all docs in thumbnail_concepts subcollection
            - Delete the publish_metadata/current doc if present
            - Set selectedTitleVariantId, selectedThumbnailConceptId,
              publishMetadataId all to null
            - Set status to 'draft'
          - For every short_clip Deliverable (listDeliverablesForPlan
            kind=short_clip):
            - Delete the deliverable (cascades its subcollections via
              p2-crud-deliverables deleteDeliverable())
          - Reset on Plan: selectedHookVariantId, selectedTitleVariantId,
            selectedThumbnailConceptId all to null;
            estimatedRuntimeSeconds to 0; formatProfileId to
            newFormatProfileId; status to 'projects_matched'

          PRESERVED (do NOT touch):
          - The plan itself (only the listed fields change)
          - requirements + matchedProjects on the plan
          - pipelineBriefId, workspacePath, userConstraints, targetRuntimeSeconds
          - The long_form Deliverable record + its audienceProfileId
          - All recording_sessions for the plan

          Batch size guard: if total ops exceed 400, chunk into multiple
          batches but wrap in a Firestore transaction for atomicity (use
          db.runTransaction). On any error, leave the plan exactly as it was.

          Route POST /plans/:id/change-format:
          - Body: { formatProfileId: string }
          - Validates body with Zod
          - Calls changePlanFormatProfile
          - On success, returns HTMX redirect to /plans/:id
          - On typed errors, returns 4xx with structured error JSON for HTMX
            to display via the standard toast handler

          UI change in src/views/plan-detail.tsx — READ THE EXISTING FILE first:
          - The existing format profile display (read-only) becomes an editable
            dropdown when plan.status is at or before 'scenes_generated' AND
            plan.type === 'youtube_advanced'
          - Selecting a different value fires hx-post to /plans/:id/change-format
            with hx-confirm="Changing format wipes all scenes, scripts, hooks, titles, thumbnails, and Shorts for this plan. Recording sessions are preserved. Continue?"
          - When status is past 'scenes_generated' but not yet 'exported', the
            dropdown is still active (the wipe also reverts past states); when
            'exported' or 'published', the dropdown becomes disabled with a
            tooltip explaining why

          Tests at tests/engine/change-format.test.ts:
          - Happy path: wipes scenes/hooks/concepts/shorts; preserves
            requirements, projects, audience binding, recording sessions
          - Rejects when plan.type !== 'youtube_advanced'
          - Rejects when plan.status === 'exported' (and 'published')
          - No-op (only formatProfileId updates) when status is
            'projects_matched' or earlier
          - Reverts plan.status to 'projects_matched' from any later v2 status
          - Recording sessions persisted across the wipe
          - Unknown formatProfileId throws FormatProfileNotFoundError
        expected_files:
          - "src/engine/change-format.ts"
          - "src/routes/plan.tsx"
          - "src/views/plan-detail.tsx"
          - "tests/engine/change-format.test.ts"
        done_check: "test -f src/engine/change-format.ts"

  # ============================================================
  # PHASE 6 — Hook Engineering (M18)
  # ============================================================
  - id: "phase-6"
    name: "Hook engineering — variants + selection + script overlay"
    description: "Call 5 generates 3-4 hook variant drafts; Rick picks one; the selected hook is injected into the script writer for scene 1."
    phase_check: "npm run typecheck"
    tasks:
      - id: "p6-generate-hooks"
        name: "Engine step — generate-hook-variants (Call 5)"
        model: "opus"
        depends_on: ["p2-crud-misc", "p3-compose-prompt", "p5-detect-episode-requirements"]
        estimated_minutes: 18
        context_sources:
          - alias: "tech-spec"
            sections: ["4.5"]
          - alias: "prd"
            sections: ["4.7"]
        prompt: |
          Implement src/engine/generate-hook-variants.ts.

          Read src/engine/generate-scenes.ts for the v2 engine step pattern
          (load plan + format + audience, compose system prompt via
          buildSystemPrompt v2 path, LLM call with structured output, Zod
          validation, retry-once on bad JSON, persist via Firestore CRUD).

          Public function:
            generateHookVariants(planId: string): Promise<HookDraft[]>

          Pre-conditions:
          - Plan must be type='youtube_advanced' and status 'scenes_generated'
            (per the extended transition table)
          - Episode requirements + scenes must exist on the plan

          Steps:
          1. Load plan, format profile, audience profile
          2. System prompt via buildSystemPrompt() v2 path; task instructions
             ask for 3-4 hook variants per the prd 4.7 spec
          3. Inject context: episode angle, anti-angle, technical scope,
             target runtime, the format profile's hookGuidelines verbatim,
             the audience profile's hookPatterns verbatim
          4. Expected LLM output: JSON array of 3-4 objects, each with
             { archetype: HOOK_ARCHETYPE_VALUE, scriptText: string (30-60
             words), predictedRetention: string (1 sentence) }
          5. Validate each object with hookDraftSchema; retry-once on bad JSON
          6. Persist each as a HookDraft via createHookDraft() (selected=false
             on all of them initially)
          7. Transition plan status to 'hooks_generated' via updatePlan
          8. Return the persisted drafts

          Hardening requirements:
          - Reject if fewer than 3 or more than 5 variants (retry-once)
          - All archetype values must be in HOOK_ARCHETYPES
          - Reject if any scriptText is < 20 or > 80 words (retry-once with
            stricter word-count instruction)
          - On second failure, throw HookGenerationFailedError; plan status
            stays at 'scenes_generated' (no partial-write of hook_drafts —
            wipe any partial writes before throwing)
          - LLM timeout 30s per spec
          - Plan status invariant: NEVER advance status unless drafts persisted
            successfully

          Tests at tests/engine/generate-hook-variants.test.ts:
          - Happy path: mock LLM returns 4 valid variants; persisted; status
            advances
          - Bad JSON first attempt then valid → succeeds
          - Bad JSON twice → throws HookGenerationFailedError; status unchanged;
            no hook_drafts persisted
          - Plan at wrong status (e.g., 'requirements_reviewed') → throws
            InvalidPlanStatusError before LLM call
          - Word count violation triggers retry
          - Unknown archetype triggers retry
        expected_files:
          - "src/engine/generate-hook-variants.ts"
          - "tests/engine/generate-hook-variants.test.ts"
        done_check: "test -f src/engine/generate-hook-variants.ts"

      - id: "p6-select-hook"
        name: "Hook selection action + scripts overlay"
        model: "opus"
        depends_on: ["p6-generate-hooks", "p3-engine-v1-extensions"]
        estimated_minutes: 15
        context_sources:
          - alias: "tech-spec"
            sections: ["4.5"]
          - alias: "prd"
            sections: ["4.7"]
        prompt: |
          Two changes:

          1. Add a "select hook" service + route at:
             - src/engine/select-hook.ts — service function
             - Update src/routes/plan.tsx — add POST /plans/:id/select-hook

             Service signature:
               selectHook(planId: string, hookId: string): Promise<void>

             Behavior:
             - Validate plan is at status 'hooks_generated' or 'hook_selected'
               (re-selection allowed)
             - Validate hookId belongs to the plan
             - In a single batch:
               a. Toggle the selected flag on hook_drafts (this one true,
                  others false) — use setSelectedHookDraft from
                  src/db/hook-drafts.ts
               b. Update plan.selectedHookVariantId = hookId
               c. Update plan.status = 'hook_selected'

          2. Modify src/engine/write-scripts.ts to honor the selected hook
             when generating youtube_advanced scripts:

             - Read src/engine/write-scripts.ts FIRST.
             - For youtube_advanced plans, if plan.selectedHookVariantId is
               set, load the HookDraft via the subcollection CRUD
             - The selected hook's scriptText becomes the script for scene 1
               (the cold_open beat); the LLM is told scene 1 is already written
               and to start from scene 2
             - The system prompt explicitly includes the selected hook so the
               LLM can build narrative continuity
             - Cover_letter and youtube_lite paths unchanged

          Hardening requirements:
          - select-hook: refuse if plan not in valid status; refuse if hookId
            doesn't belong to plan; refuse if no hook with that id exists
          - write-scripts: if youtube_advanced AND status is past
            'shot_list_generated' AND no selectedHookVariantId, throw a
            descriptive error (shouldn't happen per the transition table but
            defensive)
          - The script-overlay logic preserves the v1 emphasisCues / pacingNotes
            / transitionNote shape on scene 1 — only the script text is taken
            from the hook; emphasis/pacing/transition for scene 1 are still
            LLM-generated based on the hook content

          Tests at:
          - tests/engine/select-hook.test.ts — happy path, wrong status,
            invalid hookId, re-selection allowed
          - tests/engine/write-scripts.test.ts — extend with: youtube_advanced
            with selected hook produces scene 1 script == hook.scriptText;
            scene 2+ generated by LLM; cover_letter path unchanged
        expected_files:
          - "src/engine/select-hook.ts"
          - "src/engine/write-scripts.ts"
          - "src/routes/plan.tsx"
          - "tests/engine/select-hook.test.ts"
          - "tests/engine/write-scripts.test.ts"
        done_check: "test -f src/engine/select-hook.ts"

      - id: "p6-hook-workshop-ui"
        name: "Hook workshop UI — variant card grid + selection"
        model: "sonnet"
        depends_on: ["p6-select-hook"]
        estimated_minutes: 15
        context_sources:
          - alias: "prd"
            sections: ["4.7"]
        prompt: |
          Implement the hook workshop UI:
          - src/views/workshop.tsx — exports HookWorkshopView component
          - src/routes/workshop.tsx — GET /plans/:id/workshop/hooks route
          - Update src/views/plan-detail.tsx — add a "Hook workshop" link
            visible when status >= 'hooks_generated'

          Read src/views/scene-card.tsx for the existing HTMX-driven selection
          pattern. Read src/views/plan-detail.tsx for layout conventions.

          HookWorkshopView:
          - Card grid (CSS grid 2-col on desktop) of HookDraft entries
          - Each card shows: archetype label (prominent), scriptText
            (large), predictedRetention (smaller, italicized)
          - The currently-selected card has a visible "selected" class +
            badge ("Currently selected")
          - Clicking an unselected card fires hx-post to
            /plans/:id/select-hook with body {hookId}, swap target the
            whole grid (returns the updated grid partial)
          - "Regenerate variants" button at the top fires hx-post to
            /plans/:id/generate-hooks (which triggers the engine step + a
            redirect back to the workshop)
          - Empty state if no drafts ("Generate hooks first")

          Mount the workshop route in src/server.ts.

          Hardening requirements (UI):
          - hx-confirm on the regenerate button ("This will discard the
            existing variants and generate a new set. Continue?")
          - Loading state via aria-busy during the regenerate request (which
            is ~30s)
          - Error toast on engine errors via the standard hx-on:htmx:responseError
            pattern from other v2 views
          - All hx-post buttons disabled while in flight

          Tests at:
          - tests/views/workshop.test.tsx — HookWorkshopView renders a grid;
            selected card highlighted; HTMX attributes present
          - tests/routes/workshop.test.ts — GET /plans/:id/workshop/hooks
            returns 200 with grid; 404 when plan id unknown
        expected_files:
          - "src/views/workshop.tsx"
          - "src/routes/workshop.tsx"
          - "src/views/plan-detail.tsx"
          - "src/server.ts"
          - "tests/views/workshop.test.tsx"
          - "tests/routes/workshop.test.ts"
        done_check: "test -f src/views/workshop.tsx && test -f src/routes/workshop.tsx"

  # ============================================================
  # PHASE 7 — Shot list (M19)
  # ============================================================
  - id: "phase-7"
    name: "Shot list — per-scene primary shot + B-roll + cuts + overlays"
    description: "Call 6 generates per-scene structured shot lists from all scripts in one batched call. Scene card UI extended with collapsible shot list section + HTMX inline edit per shot item."
    phase_check: "npm run typecheck"
    tasks:
      - id: "p7-generate-shot-list"
        name: "Engine step — generate-shot-list (Call 6, batched)"
        model: "opus"
        depends_on: ["p6-select-hook"]
        estimated_minutes: 20
        context_sources:
          - alias: "tech-spec"
            sections: ["4.5"]
          - alias: "prd"
            sections: ["4.9"]
        prompt: |
          Implement src/engine/generate-shot-list.ts.

          Read src/engine/generate-hook-variants.ts for the v2 engine step
          pattern.

          Public function:
            generateShotList(planId: string): Promise<void>

          Pre-conditions:
          - Plan type='youtube_advanced'; status 'hook_selected' (scripts
            written, hook chosen)
          - All scenes have non-empty script field

          Steps:
          1. Load plan, all scenes (sorted by order), format profile,
             audience profile
          2. System prompt via buildSystemPrompt() v2 path. Task instructions
             ask the LLM to return per-scene shot list data in a single
             batched call to preserve cross-scene shot coherence (e.g., the
             same B-roll asset shouldn't be re-suggested for two scenes)
          3. Inject context: all scenes' scripts indexed by sceneId + beatTag,
             format profile's shotConventions per beat, audience profile's
             pacing
          4. Expected LLM output: JSON array of N objects, each:
             {
               sceneId: string,                  // must match an existing scene
               primaryShot: { type: SceneInterfaceType, description: string },
               brollItems: [{ type, description, source, durationSeconds }],
               shotListItems: [{ type, description, source, durationSeconds }],
               onScreenTextOverlays: [{ textContent, timingHint, styleHint }],
               cutPoints: [{ scriptLineNumber, reason }]
             }
          5. Validate with extended sceneSchema (the v2 shot-list fields from
             p2-schemas-core); retry-once on bad JSON
          6. Update each scene via updateScene() — set only the shot-list
             fields, preserve script/title/etc.
          7. Transition plan status to 'shot_list_generated'

          Hardening requirements:
          - LLM must return one entry per scene; missing scenes trigger retry
          - Phantom sceneIds (not in the plan's scenes) silently dropped
            with a warn log (don't fail the whole call)
          - LLM timeout 60s per tech-spec performance section
          - Bad JSON twice → throws ShotListGenerationFailedError; scenes
            unchanged; status unchanged
          - The batched persist is wrapped in Firestore batch — partial
            failure leaves no half-updated scenes
          - On_screen_text overlays: textContent capped at 80 chars,
            styleHint validated against enum ('callout' | 'quote' |
            'chapter_marker' | 'footnote')

          Tests at tests/engine/generate-shot-list.test.ts:
          - Happy path: mock LLM returns N shot lists; all scenes updated;
            status advances
          - Phantom sceneId from LLM dropped silently
          - Missing scene in LLM output triggers retry
          - Bad JSON twice → throws + status unchanged
          - Plan at wrong status → throws InvalidPlanStatusError
        expected_files:
          - "src/engine/generate-shot-list.ts"
          - "tests/engine/generate-shot-list.test.ts"
        done_check: "test -f src/engine/generate-shot-list.ts"

      - id: "p7-shot-list-ui"
        name: "Scene card UI — shot list section + inline edit partials"
        model: "sonnet"
        depends_on: ["p7-generate-shot-list"]
        estimated_minutes: 20
        context_sources:
          - alias: "prd"
            sections: ["4.9"]
        prompt: |
          Extend the scene card UI to render and inline-edit the shot list
          fields.

          Files:
          - src/views/scene-card.tsx (EXTEND — read first)
          - src/routes/scenes.tsx (EXTEND — read first; add shot-list
            partial routes)

          UI additions to SceneCard:
          - Below the existing script display, a collapsible <details>
            section labeled "Shot list" that contains four sub-sections:
            primary shot, B-roll, on-screen text, cut points
          - primary shot: type badge + description; click description to
            inline-edit via textarea (HTMX hx-get to edit endpoint, hx-trigger
            blur save)
          - B-roll: list of items; each item has type pill + description
            + duration; click to edit; "Add B-roll item" button at bottom
          - on-screen text: list with text + timing + style; same edit pattern
          - cut points: list with line number + reason; same edit pattern
          - Each list item has a delete button (hx-delete with hx-confirm)
          - Collapsed by default; expanded if the scene was edited recently
            (track via a session cookie OR an open-state attribute, your
            choice — pick the simpler one)

          Routes in src/routes/scenes.tsx:
          - GET /plans/:id/scenes/:sceneId/shot-list/edit?field=primaryShot
            (or brollItems / shotListItems / onScreenTextOverlays / cutPoints)
            — returns the appropriate inline editor partial
          - PATCH /plans/:id/scenes/:sceneId/shot-list — body is the entire
            updated shot-list field; returns the updated card partial
          - POST /plans/:id/scenes/:sceneId/broll — append a blank B-roll item
          - DELETE /plans/:id/scenes/:sceneId/broll/:index — remove by index
          - Mirror POST + DELETE routes for shot-list-items, on-screen-text,
            cut-points

          Hardening requirements (UI + routes):
          - All PATCH/POST/DELETE routes validate the field name and item
            index server-side; out-of-range index returns 400
          - Inline editors have visible save/cancel buttons (cancel reverts
            via hx-get to the read-only display)
          - Each input has its own Zod schema validation echoed back as
            inline error on failure
          - On-screen text textContent capped at 80 chars with a visible counter
          - All actions are debounced where they auto-save on blur (200ms)

          Tests at:
          - tests/views/scene-card.test.tsx — extended for shot list section
            rendering, collapsed-by-default, HTMX attributes
          - tests/routes/scenes.test.ts — extended for the new partial routes
        expected_files:
          - "src/views/scene-card.tsx"
          - "src/routes/scenes.tsx"
          - "tests/views/scene-card.test.tsx"
          - "tests/routes/scenes.test.ts"
        done_check: "npm run typecheck"

      - id: "p7-shot-list-trigger"
        name: "Plan-level route — trigger generate-shot-list"
        model: "sonnet"
        depends_on: ["p7-generate-shot-list"]
        estimated_minutes: 5
        context_sources:
          - alias: "tech-spec"
            sections: ["4.4"]
        prompt: |
          Add POST /plans/:id/generate-shot-list to src/routes/plan.tsx.

          Read src/routes/plan.tsx first. Follow the pattern of the existing
          generate route (e.g., POST /plans/:id/generate or
          /plans/:id/generate-hooks if it was added in Phase 6).

          Behavior:
          - Call generateShotList(planId)
          - On success, redirect to /plans/:id with a flash success message
          - Surface ShotListGenerationFailedError as a user-visible flash error
          - Plan status invariants enforced at the service layer; route just
            translates errors to HTTP responses

          Add a button "Generate shot list" to src/views/plan-detail.tsx
          (in the action strip) — visible when status === 'hook_selected'.

          Hardening requirements: standard 400/500 envelope for non-2xx
          responses; do not leak stack traces.

          Tests at tests/routes/plan.test.ts (extend):
          - POST /plans/:id/generate-shot-list returns 302 on success
          - Returns 4xx with error JSON on engine failure
        expected_files:
          - "src/routes/plan.tsx"
          - "src/views/plan-detail.tsx"
          - "tests/routes/plan.test.ts"
        done_check: "npm run typecheck"

  # ============================================================
  # PHASE 8 — Title & Thumbnail Workshop (M20)
  # ============================================================
  - id: "phase-8"
    name: "Title & Thumbnail Workshop"
    description: "Calls 7 + 8 generate title variants and thumbnail concepts (text-only, structured) for the long-form Deliverable. Workshop UIs use card grid selection like the hook workshop."
    phase_check: "npm run typecheck"
    tasks:
      - id: "p8-generate-titles"
        name: "Engine step — generate-title-variants (Call 7)"
        model: "opus"
        depends_on: ["p2-crud-deliverables", "p3-compose-prompt", "p7-generate-shot-list"]
        estimated_minutes: 18
        context_sources:
          - alias: "tech-spec"
            sections: ["4.5"]
          - alias: "prd"
            sections: ["4.10"]
        prompt: |
          Implement src/engine/generate-title-variants.ts.

          Reference src/engine/generate-hook-variants.ts for the v2 engine
          step pattern.

          Public function:
            generateTitleVariants(deliverableId: string): Promise<TitleConcept[]>

          Operates per-deliverable so it can run for the long-form OR for any
          Short later. Pre-conditions:
          - Deliverable must exist
          - Parent plan must be type='youtube_advanced'
          - For long-form: plan status must be 'shot_list_generated' or later
            (per the extended transition table titles_generated requires
            shot_list_generated)
          - For Shorts: deliverable.kind === 'short_clip' and status === 'scripts_ready'

          Steps:
          1. Load deliverable, parent plan, format profile, audience profile
             (audience comes from deliverable.audienceProfileId)
          2. System prompt via buildSystemPrompt() v2 path
          3. Task instructions request 5-10 title variants. Inject: episode
             angle, selected hook archetype (from plan.selectedHookVariantId
             → HookDraft.archetype), format profile, audience profile pacing
          4. Expected LLM output: JSON array of 5-10 objects:
             { titleText (≤70 chars), archetype (TITLE_ARCHETYPES),
               predictedClickability (1-10), reasoning, keywordsSurfaced[] }
          5. Validate each with titleConceptSchema; retry-once on bad JSON
          6. Persist as TitleConcept records via createConcept()
             (deliverableId-scoped); selected=false on all
          7. If for the long-form: update parent plan.status to
             'titles_generated'

          Hardening requirements:
          - titleText > 70 chars rejected (matches schema)
          - Unknown archetype rejected (retry)
          - Variant count outside 5-10 → retry
          - LLM timeout 30s
          - Bad JSON twice → throws TitleGenerationFailedError; no partial
            persistence; status unchanged

          Tests at tests/engine/generate-title-variants.test.ts:
          - Happy path for long-form deliverable
          - Happy path for short_clip deliverable (status invariants differ)
          - Variant count out of range → retry
          - titleText over 70 chars → retry
          - Bad JSON twice → throws + no persistence
          - Wrong status → throws InvalidDeliverableStatusError
        expected_files:
          - "src/engine/generate-title-variants.ts"
          - "tests/engine/generate-title-variants.test.ts"
        done_check: "test -f src/engine/generate-title-variants.ts"

      - id: "p8-generate-thumbnails"
        name: "Engine step — generate-thumbnail-concepts (Call 8)"
        model: "opus"
        depends_on: ["p8-generate-titles"]
        estimated_minutes: 15
        context_sources:
          - alias: "tech-spec"
            sections: ["4.5"]
          - alias: "prd"
            sections: ["4.10"]
        prompt: |
          Implement src/engine/generate-thumbnail-concepts.ts.

          Reference src/engine/generate-title-variants.ts.

          Public function:
            generateThumbnailConcepts(deliverableId: string): Promise<ThumbnailConcept[]>

          Pre-condition: deliverable.selectedTitleVariantId must be set (the
          chosen title is an input to the prompt). For long-form parent plan
          status must be 'title_selected'.

          Steps:
          1. Load deliverable, selected title, parent plan, format profile,
             audience profile
          2. System prompt via buildSystemPrompt() v2 path
          3. Task instructions request 3-5 thumbnail concepts. THIS DOES NOT
             GENERATE IMAGES — text-only structured concepts per PRD 4.10.
             Inject: selected title text, format profile, hook archetype,
             available project visuals (string descriptions only, pulled from
             scenes' shotListItems where source includes 'screenshot' or
             'asset_static')
          4. Expected LLM output: JSON array of 3-5 objects:
             { composition, textHook (≤4 words), expression?, colorPalette
               (2-3 hex), assetsRequired[], conceptSummary }
          5. Validate with thumbnailConceptSchema; retry-once on bad JSON
          6. Persist as ThumbnailConcept records; selected=false on all
          7. If long-form: parent plan status → 'thumbnails_generated'

          Hardening requirements:
          - textHook > 4 words rejected (the schema enforces; if the LLM
            persists in violating, retry-once with stricter prompt)
          - colorPalette: validate each entry matches ^#[0-9a-fA-F]{6}$ (schema
            enforces); reject invalid hex
          - LLM timeout 20s (smaller output than titles)
          - Bad JSON twice → throws ThumbnailGenerationFailedError

          Tests at tests/engine/generate-thumbnail-concepts.test.ts:
          - Happy path (long-form)
          - textHook over 4 words triggers retry
          - Invalid hex in palette triggers retry
          - Wrong pre-condition (no selected title) throws
          - Bad JSON twice → throws
        expected_files:
          - "src/engine/generate-thumbnail-concepts.ts"
          - "tests/engine/generate-thumbnail-concepts.test.ts"
        done_check: "test -f src/engine/generate-thumbnail-concepts.ts"

      - id: "p8-workshop-routes-and-views"
        name: "Title + Thumbnail workshop routes + views"
        model: "sonnet"
        depends_on: ["p8-generate-thumbnails", "p6-hook-workshop-ui"]
        estimated_minutes: 20
        context_sources:
          - alias: "tech-spec"
            sections: ["4.4"]
        prompt: |
          Add title + thumbnail workshop views and routes, mirroring the
          hook workshop pattern from Phase 6.

          Files:
          - EXTEND src/views/workshop.tsx — add TitleWorkshopView and
            ThumbnailWorkshopView components alongside HookWorkshopView
          - EXTEND src/routes/workshop.tsx — add GET routes for title +
            thumbnail workshops
          - EXTEND src/routes/plan.tsx — add POST /plans/:id/generate-titles
            (for long-form) and POST /plans/:id/generate-thumbnails (for
            long-form) + per-deliverable equivalents at
            /deliverables/:deliverableId/generate-titles + /generate-thumbnails
          - EXTEND src/routes/deliverables.tsx (CREATE if it doesn't exist)
            — POST /deliverables/:deliverableId/select-title and
            /select-thumbnail actions that toggle the selected flag on the
            chosen concept (via setSelectedConcept in p2-crud-deliverables)
            and update deliverable.selectedTitleVariantId / selectedThumbnailConceptId

          Views (in workshop.tsx):
          - TitleWorkshopView: card grid, each card shows titleText
            (prominent), archetype label, predictedClickability bar (1-10
            visual), reasoning (smaller), keywords as tags. Click an
            unselected card → hx-post /deliverables/:id/select-title
          - ThumbnailWorkshopView: card grid, each card shows composition
            description, textHook (large overlay text mock), color palette
            swatches, assets required list, conceptSummary. Click to select.

          Plan detail UI extension: add workshop nav links visible at the
          appropriate status (titles workshop visible from 'titles_generated';
          thumbnails workshop visible from 'thumbnails_generated').

          Hardening requirements (UI):
          - Loading state during the ~20-30s LLM calls (regenerate buttons)
          - hx-confirm on regenerate ("Regenerate discards current variants")
          - Empty states with clear "Generate first" prompts
          - Selected concept card has visible distinction (border, badge)
          - All HTMX actions disable their button while in flight

          Tests at:
          - tests/views/workshop.test.tsx (extend) — title view, thumbnail
            view, selection swap
          - tests/routes/workshop.test.ts (extend) — GET routes
          - tests/routes/deliverables.test.ts (NEW or extend) — select-title /
            select-thumbnail actions
        expected_files:
          - "src/views/workshop.tsx"
          - "src/routes/workshop.tsx"
          - "src/routes/plan.tsx"
          - "src/routes/deliverables.tsx"
          - "src/views/plan-detail.tsx"
          - "src/server.ts"
          - "tests/views/workshop.test.tsx"
          - "tests/routes/workshop.test.ts"
          - "tests/routes/deliverables.test.ts"
        done_check: "test -f src/routes/deliverables.tsx"

  # ============================================================
  # PHASE 9 — Workspace + Footage Manifest (M21)
  # ============================================================
  - id: "phase-9"
    name: "Workspace folders + Recording Session Manifest"
    description: "Per-plan on-disk folder layout with path traversal protection. Recording session log + scene coverage indicator."
    phase_check: "npm run typecheck"
    tasks:
      - id: "p9-workspace-module"
        name: "Workspace module — path validation + folder creation"
        model: "opus"
        depends_on: ["p2-schemas-core"]
        estimated_minutes: 20
        context_sources:
          - alias: "tech-spec"
            sections: ["4.2"]
          - alias: "tech-spec"
            sections: ["6"]
          - alias: "prd"
            sections: ["4.4"]
        prompt: |
          Implement the workspace module — security-critical (path traversal
          surface area). Files:
          - src/workspace/paths.ts — pure path utilities + slug validation
          - src/workspace/service.ts — folder creation + export operations
          - src/env.ts (EXTEND) — add WORKSPACE_ROOT env var via getEnv()

          Read src/env.ts first to understand the lazy getEnv() pattern.

          paths.ts public functions:
          - validateSlug(slug: string): void  (throws InvalidSlugError if
            ^[a-z0-9-]+(\.[a-z]+)?$ doesn't match)
          - planSlug(plan: { id: string; title: string }): string  (deterministic
            slug from id + lowercased+kebabbed title; cap length at 80)
          - resolvePlanWorkspacePath(planId: string, slug: string): string
            (joins WORKSPACE_ROOT + `${planId}-${slug}`, calls path.resolve,
            then verifies the resolved path starts with WORKSPACE_ROOT —
            throws PathTraversalError if not)
          - resolveSubdirPath(workspacePath: string, subdir: string, filename?: string): string
            (validates subdir is one of the 7 allowlisted names: brief,
            briefs, scripts, shotlist, recordings, assets, exports; if
            filename present validates against the slug regex; resolves +
            verifies within workspacePath)

          service.ts public functions (all async):
          - createPlanWorkspace(planId, slug): Promise<{ path: string }>
            (creates the 7 subfolders via fs.mkdir recursive)
          - getPlanWorkspacePath(planId): Promise<string | null>  (reads from
            plan record's workspacePath field — does not touch the filesystem)
          - exportToWorkspace(planId, subdir, filename, content): Promise<string>
            (writes content to workspace; uses atomic write — write to a temp
            file in the same dir then rename)
          - validateWorkspaceRoot(): Promise<{ ok: boolean; reason?: string }>
            (used by healthz — confirms WORKSPACE_ROOT exists, is a directory,
            and is writable)

          env.ts addition: WORKSPACE_ROOT as required string with no default
          (DREK refuses to start if unset).

          Hardening requirements (this is the security-critical surface):
          - EVERY path operation goes through path.resolve() + within-root
            verification (use path.relative + check no leading '..')
          - validateSlug rejects: empty, traversal characters (../), Windows
            reserved names (CON, PRN, AUX, NUL, COM1-9, LPT1-9), absolute
            paths, paths with leading dots, anything not matching the regex
          - createPlanWorkspace fails gracefully if the workspace root is
            unavailable: returns a structured error, does NOT crash the process
          - exportToWorkspace size-caps content at 10MB (defensive)
          - Atomic write: write to '${target}.tmp-${random}' then fs.rename;
            on rename failure clean up the temp file
          - No symlink following (lstat + check before write to detect)
          - File modes: 0o644 for files, 0o755 for directories
          - Never log full content; log only path + size

          Tests at:
          - tests/workspace/paths.test.ts — slug validation (positive +
            negative cases including traversal attempts, reserved names, etc.);
            resolvePlanWorkspacePath catches '..' attempts; resolveSubdirPath
            rejects unknown subdirs
          - tests/workspace/service.test.ts — using a temp directory:
            createPlanWorkspace makes the 7 subfolders; exportToWorkspace
            writes + reads back; validateWorkspaceRoot returns ok for a
            writable dir, !ok for a non-existent path; atomic write recovers
            from rename failure (simulate via mocking)
        expected_files:
          - "src/workspace/paths.ts"
          - "src/workspace/service.ts"
          - "src/env.ts"
          - "tests/workspace/paths.test.ts"
          - "tests/workspace/service.test.ts"
        done_check: "test -f src/workspace/paths.ts && test -f src/workspace/service.ts"

      - id: "p9-workspace-integration"
        name: "Workspace integration — auto-create on plan creation + open-folder route"
        model: "sonnet"
        depends_on: ["p9-workspace-module", "p4-intake-service"]
        estimated_minutes: 10
        context_sources:
          - alias: "tech-spec"
            sections: ["4.2"]
        prompt: |
          Wire the workspace module into the plan creation flow.

          Changes:
          - Modify src/intake/service.ts: at the end of promoteBriefToPlan,
            after the batch write succeeds, call createPlanWorkspace(planId,
            planSlug(plan)). Persist the returned path to plan.workspacePath
            via updatePlan. If workspace creation throws, log + persist
            workspacePath=null but DO NOT throw — the plan + deliverable are
            already created and usable without a workspace.
          - Modify src/routes/plan.tsx (or wherever the manual youtube_advanced
            new-plan form handler lives): same workspace-create-on-success
            pattern after plan creation.
          - Modify src/routes/plan.tsx: add POST /plans/:id/open-workspace —
            invokes `explorer.exe` (on Windows) via child_process.spawn with
            shell:false on the workspace path. On non-Windows hosts, returns
            a 501 not-implemented (single-user on Windows is the only
            supported deployment per CLAUDE.md). Refuse if workspacePath is
            null.
          - Modify src/views/plan-detail.tsx: add an "Open folder" button
            visible when plan.workspacePath is non-null; disabled (with
            tooltip "Workspace not created — retry") when null. Add a "Retry
            create workspace" action that re-calls the workspace creation if
            previously failed.

          Hardening requirements:
          - The explorer.exe spawn is the only filesystem-launching action;
            it goes through paths.ts validation first
          - The retry-create action validates the plan exists + is
            youtube_advanced before attempting
          - Open-folder route is a no-op log (not an error) if invoked when
            workspacePath is null
          - Never pass workspacePath through string concatenation into a
            command — always use spawn args array

          Tests at tests/routes/plan.test.ts (extend):
          - POST /plans/:id/open-workspace returns 200 on Windows (mock
            platform); 501 on non-Windows
          - Refuses when workspacePath is null (404 or 400 with structured
            error)
          - Promote-with-workspace-failure path: assert plan still created
            with workspacePath=null (mock the workspace.createPlanWorkspace
            to throw)
        expected_files:
          - "src/intake/service.ts"
          - "src/routes/plan.tsx"
          - "src/views/plan-detail.tsx"
          - "tests/routes/plan.test.ts"
          - "tests/intake/service.test.ts"
        done_check: "npm run typecheck"

      - id: "p9-footage-manifest"
        name: "Recording sessions + scene coverage UI"
        model: "sonnet"
        depends_on: ["p2-crud-misc", "p9-workspace-integration"]
        estimated_minutes: 18
        context_sources:
          - alias: "tech-spec"
            sections: ["4.2"]
          - alias: "prd"
            sections: ["4.11"]
        prompt: |
          Implement the footage manifest UI surface around the existing
          src/db/recording-sessions.ts CRUD.

          Files:
          - src/views/footage.tsx — FootageTab + LogSessionForm + SessionList
          - src/routes/footage.tsx — page route + log/delete actions
          - Modify src/views/scene-card.tsx — add a small "Coverage" indicator
            per scene (green dot = covered, gray = not covered) based on
            computeSceneCoverage()
          - Modify src/views/plan-detail.tsx — add a "Footage" tab link
            (visible for all youtube_advanced plans regardless of status —
            Rick can log footage anytime)

          Routes:
          - GET /plans/:id/footage — renders FootageTab (current sessions
            list + coverage map + add form)
          - POST /plans/:id/recording-sessions — log a session
          - DELETE /recording-sessions/:id — delete by id (the delete action
            is global because we don't need planId for the lookup)

          LogSessionForm fields:
          - Date recorded (date picker, defaults to today)
          - Session type (select: build_session, demo_session, reflection,
            b_roll, screen_capture)
          - File path (text input; helper text says "workspace-relative or
            absolute path")
          - Duration (input in minutes; converted to seconds on submit)
          - Scenes covered (multi-select checkbox list of plan's scenes
            with their titles)
          - Notes (textarea, optional)
          - Submit button

          SessionList shows logged sessions sorted by date desc. Each row:
          date, type badge, duration, scenes-covered count, notes (truncated),
          delete button (hx-delete with hx-confirm).

          Coverage indicator on scene-card.tsx: small badge showing "covered"
          or "uncovered" via the coverage map fetched at plan-detail load
          time (passed down via props or fetched in the scene card route).
          Decide which is cheaper for the page render — match v1's prop-down
          pattern if scene cards are rendered server-side from the plan
          detail page.

          Hardening requirements:
          - Log form: scenesCovered required (>=1); file path required;
            duration positive integer; date not in the future
          - Delete confirm: "Delete this recording session log? Footage files
            on disk are NOT deleted."
          - Coverage indicator handles missing/empty session list gracefully
            (all scenes show 'uncovered')

          Tests at:
          - tests/views/footage.test.tsx — form renders, session list renders,
            empty state
          - tests/routes/footage.test.ts — POST creates, DELETE removes,
            coverage computation reflected in response
          - tests/views/scene-card.test.tsx (extend) — coverage indicator
            renders both states
        expected_files:
          - "src/views/footage.tsx"
          - "src/routes/footage.tsx"
          - "src/views/scene-card.tsx"
          - "src/views/plan-detail.tsx"
          - "src/server.ts"
          - "tests/views/footage.test.tsx"
          - "tests/routes/footage.test.ts"
          - "tests/views/scene-card.test.tsx"
        done_check: "test -f src/views/footage.tsx && test -f src/routes/footage.tsx"

  # ============================================================
  # PHASE 10 — Publishing metadata (M22)
  # ============================================================
  - id: "phase-10"
    name: "Publishing metadata generation + copy-to-clipboard export"
    description: "Call 10 generates description + chapters + tags + pinned comment + end-screen suggestion. Publishing tab UI surfaces all fields with inline edit and a one-click clipboard copy bundle."
    phase_check: "npm run typecheck"
    tasks:
      - id: "p10-generate-publish-metadata"
        name: "Engine step — generate-publish-metadata (Call 10)"
        model: "opus"
        depends_on: ["p8-generate-thumbnails", "p2-crud-deliverables"]
        estimated_minutes: 18
        context_sources:
          - alias: "tech-spec"
            sections: ["4.5"]
          - alias: "prd"
            sections: ["4.12"]
        prompt: |
          Implement src/engine/generate-publish-metadata.ts.

          Public function:
            generatePublishMetadata(deliverableId: string): Promise<PublishMetadata>

          Pre-conditions:
          - Deliverable exists
          - selectedTitleVariantId + selectedThumbnailConceptId both set
            (titles + thumbnails workshop complete)
          - For long-form: parent plan status === 'finalized'

          Steps:
          1. Load deliverable, plan, selected title, all scenes (for
             chapter markers from beatTag), audience profile (for CTA style)
          2. System prompt via buildSystemPrompt() v2 path
          3. Task instructions request a single structured PublishMetadata
             object. Inject:
             - Selected title text
             - Episode angle (from plan.requirements)
             - All scripts concatenated (cap at 30KB to keep prompt small)
             - Scene timings + beat tags (for chapters — chapter-eligible
               beats per format profile: cold_open, problem, war_room,
               build_reel, breakdown, demo, outro for build-along)
             - Audience profile CTA style
          4. Expected LLM output: PublishMetadata schema fields
          5. Validate; retry-once on bad JSON
          6. Persist via upsertPublishMetadata
          7. Update deliverable.publishMetadataId + status='metadata_ready'
          8. If long-form: parent plan status → 'metadata_generated'

          Chapter timing computation: take the running sum of
          scene.estimatedDurationSeconds for chapter-eligible scenes. The
          first chapter is always at 00:00. The LLM provides chapter labels;
          the timestamps are derived deterministically here, not requested
          from the LLM.

          Hardening requirements:
          - Tags array: enforce 10-15 length (retry if outside range)
          - Description includes the auto-computed timestamp list (we build
            this server-side from chapters before persistence)
          - pinnedComment ≤ 200 chars
          - LLM timeout 30s
          - Bad JSON twice → throws PublishMetadataGenerationFailedError;
            no partial persistence

          Tests at tests/engine/generate-publish-metadata.test.ts:
          - Happy path
          - Chapter timestamps deterministic (mock scenes with fixed
            durations, assert exact timestamps)
          - Bad JSON twice throws
          - Wrong pre-condition (no title/thumbnail) throws
          - Long-form vs short_clip status invariants
        expected_files:
          - "src/engine/generate-publish-metadata.ts"
          - "tests/engine/generate-publish-metadata.test.ts"
        done_check: "test -f src/engine/generate-publish-metadata.ts"

      - id: "p10-publish-ui"
        name: "Publishing tab + copy-to-clipboard bundle"
        model: "sonnet"
        depends_on: ["p10-generate-publish-metadata"]
        estimated_minutes: 15
        context_sources:
          - alias: "tech-spec"
            sections: ["4.4"]
          - alias: "prd"
            sections: ["4.12"]
        prompt: |
          Implement the publishing tab UI and the copy-to-clipboard export.

          Files:
          - src/views/publish.tsx — PublishMetadataView component
          - src/routes/publish.tsx — GET /deliverables/:id/publish + PATCH /publish-metadata + POST generate route + copy-bundle route
          - Update src/views/plan-detail.tsx — add "Publishing" tab link to
            the long-form deliverable section

          PublishMetadataView fields (all inline-editable HTMX, same pattern
          as the scene card script field):
          - Title (read-only — shows the selected title; "Change in Title
            workshop" link)
          - Description (large textarea, monospace; shows the full
            description block including timestamps)
          - Chapters (list of {timestamp, label} editable rows)
          - Tags (chip input — comma-separated, max 15)
          - Pinned comment (small textarea)
          - End-screen suggestion (textarea)
          - "Copy upload bundle" button (large, prominent)

          Copy bundle behavior: clicking "Copy upload bundle" fires a
          server-side route GET /deliverables/:id/publish/bundle that returns
          plain text formatted for paste-into-YouTube-Studio:

          ```
          === TITLE ===
          [title]

          === DESCRIPTION ===
          [description with timestamps]

          === CHAPTERS ===
          00:00 [label]
          02:30 [label]
          ...

          === TAGS ===
          tag1, tag2, tag3, ...

          === PINNED COMMENT ===
          [pinned comment]

          === END SCREEN ===
          [end screen suggestion]
          ```

          The view triggers clipboard copy client-side via a small inline
          <script> that fetches the bundle text + writes to navigator.clipboard
          + shows a "Copied!" flash.

          Plan detail page: tab link visible when long-form deliverable.status
          >= 'metadata_ready'. "Generate publishing metadata" button visible
          when long-form deliverable has title+thumbnail selected and metadata
          not yet generated.

          Hardening requirements (UI):
          - PATCH on metadata fields auto-saves on blur (debounced 200ms);
            updates lastEditedAt in DB
          - Tags input validates max length and reasonable character set
            ([a-zA-Z0-9 _-]+ per tag)
          - "Copy upload bundle" requires clipboard permission; fallback to
            showing the text in a modal users can manually copy if clipboard
            denied
          - Chapter timestamps validated: must be increasing; HH:MM:SS or
            MM:SS format

          Tests at:
          - tests/views/publish.test.tsx — view renders all fields, has
            HTMX attributes, copy button present
          - tests/routes/publish.test.ts — GET tab returns 200; PATCH
            updates fields; GET /publish/bundle returns plain text with all
            sections
        expected_files:
          - "src/views/publish.tsx"
          - "src/routes/publish.tsx"
          - "src/views/plan-detail.tsx"
          - "src/server.ts"
          - "tests/views/publish.test.tsx"
          - "tests/routes/publish.test.ts"
        done_check: "test -f src/views/publish.tsx && test -f src/routes/publish.tsx"

  # ============================================================
  # PHASE 11 — Shorts Extractor (M23)
  # ============================================================
  - id: "phase-11"
    name: "Shorts Extractor — candidate generation + per-Short workflow"
    description: "Call 9 produces 3-5 Short candidates from the long-form scripts. Approving a candidate creates a short_clip Deliverable bound to business_owner_shorts; each Short has its own title + thumbnail + publishing metadata flow."
    phase_check: "npm run typecheck"
    tasks:
      - id: "p11-extract-shorts"
        name: "Engine step — extract-shorts (Call 9)"
        model: "opus"
        depends_on: ["p10-generate-publish-metadata"]
        estimated_minutes: 22
        context_sources:
          - alias: "tech-spec"
            sections: ["4.5"]
          - alias: "prd"
            sections: ["4.13"]
        prompt: |
          Implement src/engine/extract-shorts.ts.

          Public function:
            extractShortsCandidates(planId: string): Promise<ShortCandidate[]>

          Where ShortCandidate is an in-memory type (not persisted directly —
          only persisted as Deliverable records when Rick approves a candidate):
            {
              id: string;                    // ephemeral id for selection
              sourceSceneIds: string[];
              cutWindow: { startLine: number; endLine: number };
              reworkedScript: string;
              hookText: string;
              verticalReframingNotes: string;
              suggestedTitleHint: string;
              suggestedThumbnailHint: string;
              beatImportanceScore: number;   // 1-10, sourced from the heuristic + LLM
            }

          Pre-conditions:
          - Plan type='youtube_advanced'
          - Long-form Deliverable status === 'metadata_ready' or later
          - Plan status === 'metadata_generated' or 'finalized'

          Beat-importance heuristic (hardcoded weights):
            const BEAT_WEIGHTS = {
              cold_open: 7,
              problem: 5,
              war_room: 6,
              build_reel: 5,
              breakdown: 4,
              demo: 10,         // demo reveal is the strongest Shorts moment
              outro: 8,         // pricing moment lives here
            };

          Steps:
          1. Load plan, long-form Deliverable, all scenes with scripts +
             beatTags, business_owner_shorts AudienceProfile (REQUIRED — if
             missing, throw a descriptive error pointing to the M14 Track A
             seed step)
          2. System prompt via buildSystemPrompt() v2 path with
             business_owner_shorts audience (NOT the long-form audience —
             Shorts target a different audience)
          3. Task instructions: produce 3-5 candidate Short clips. Inject:
             all scripts with sceneIds + beatTags + BEAT_WEIGHTS (as
             prioritization input, NOT a hard filter — the LLM can override
             a low-weight beat if the content is exceptional), guidance on
             60-90s reworked scripts, business-owner-Shorts CTA style
          4. Expected LLM output: JSON array of 3-5 objects matching the
             ShortCandidate shape (without id — we generate ids server-side)
          5. Validate each candidate; retry-once on bad JSON
          6. Return candidates with generated ephemeral ids; do NOT persist
             anything yet
          7. Update plan status to 'shorts_extracted'

          Approval flow (separate function in this file):
            approveShortCandidate(planId, candidate: ShortCandidate): Promise<{ deliverableId: string }>

          Behavior:
          - Validate plan exists + type='youtube_advanced'
          - In a single batch:
            - Create a short_clip Deliverable bound to business_owner_shorts
            - Set scriptOverrideSceneIds = candidate.sourceSceneIds
            - Set customScripts as a single-element array containing the
              reworked script
            - Title = candidate.suggestedTitleHint (Rick can rename later)
            - Status = 'scripts_ready'
          - Return the new deliverableId

          Hardening requirements:
          - reworkedScript word count: 150-225 (60-90s at 150-175 wpm) —
            retry if outside range
          - All sourceSceneIds must reference existing scenes; phantom IDs
            triggers retry
          - Candidate count outside 3-5 → retry
          - LLM timeout 90s per spec
          - approveShortCandidate is idempotent only by clientShortCandidate.id
            — but since candidates are ephemeral, the route layer must guard
            against double-submit (HTMX disabled button suffices for v2)
          - Plan status invariant: extract-shorts only advances status if at
            least one candidate is returned (zero candidates is a failure
            mode, surfaced via UI)

          Tests at tests/engine/extract-shorts.test.ts:
          - Happy path: mock LLM returns 4 candidates; returned + plan status
            advances; no Deliverables created at extraction time
          - approveShortCandidate creates a Deliverable with correct fields
          - Phantom sceneId triggers retry
          - Wrong word count triggers retry
          - Bad JSON twice → throws ShortsExtractionFailedError; status
            unchanged
          - business_owner_shorts unavailable → throws with helpful message
        expected_files:
          - "src/engine/extract-shorts.ts"
          - "tests/engine/extract-shorts.test.ts"
        done_check: "test -f src/engine/extract-shorts.ts"

      - id: "p11-shorts-ui"
        name: "Shorts candidate review UI + approval flow"
        model: "sonnet"
        depends_on: ["p11-extract-shorts"]
        estimated_minutes: 18
        context_sources:
          - alias: "prd"
            sections: ["4.13"]
        prompt: |
          Build the Shorts candidate review UI.

          Files:
          - src/views/shorts-candidates.tsx — ShortsCandidateView (grid of
            candidate cards)
          - src/routes/plan.tsx (EXTEND) — add POST /plans/:id/extract-shorts
            (triggers engine) + POST /plans/:id/approve-short (body: full
            candidate JSON; calls approveShortCandidate)
          - src/views/plan-detail.tsx (EXTEND) — add "Shorts workshop" section
            below the publish tab; visible when long-form metadata is ready

          Candidate cards show:
          - Beat importance score (1-10) as a visual bar
          - Source scene title(s) (looked up by sourceSceneIds)
          - Reworked script (large monospace textarea — editable)
          - Hook text (small, prominent)
          - Vertical reframing notes (italic)
          - Suggested title hint (small)
          - Suggested thumbnail hint (small)
          - Two buttons: "Approve" (creates Deliverable) and "Dismiss" (hides
            from view, ephemeral — candidates re-extracting wipes the
            dismissed flag)

          Candidates are NOT persisted as drafts — they're held in
          server-side session state (or just re-rendered every time the page
          loads via the engine call). Simplest implementation: keep
          candidates in a tiny in-memory cache keyed by planId, cleared
          when any candidate is approved/dismissed OR after 1 hour. Rick
          can re-extract to get fresh candidates.

          After approval, redirect to /plans/:planId/deliverables/:newDeliverableId
          where Rick can run the per-Short title + thumbnail + publishing
          metadata flow (Phase 8 + 10 routes already support deliverable-id
          parameter).

          Hardening requirements (UI):
          - "Extract shorts" button hx-confirm if extraction was already run
            in the session ("Re-extract will discard the current candidate
            set")
          - Loading state during the ~90s extraction call (large progress
            indicator)
          - Approved candidates show "Approved → opening deliverable..." brief
            flash before redirect
          - Edit-in-place on reworkedScript before approval (the approved
            candidate uses whatever text is in the textarea at click time)

          Tests at:
          - tests/views/shorts-candidates.test.tsx — view renders candidates,
            buttons present, beat score visible
          - tests/routes/plan.test.ts (extend) — POST extract-shorts triggers
            engine; POST approve-short creates Deliverable
        expected_files:
          - "src/views/shorts-candidates.tsx"
          - "src/routes/plan.tsx"
          - "src/views/plan-detail.tsx"
          - "tests/views/shorts-candidates.test.tsx"
          - "tests/routes/plan.test.ts"
        done_check: "test -f src/views/shorts-candidates.tsx"

  # ============================================================
  # PHASE 12 — Integration, signal, bundle view, polish (M24)
  # ============================================================
  - id: "phase-12"
    name: "Integration — signal emission, deliverable bundle view, end-to-end tests, README"
    description: "Wire script.published signal to Neurocore on deliverable publish. Add the Deliverable bundle view summarizing all artifacts for a plan. End-to-end integration test for the full youtube_advanced flow. README + CHANGELOG updates."
    phase_check: "npm run typecheck && npm run lint"
    tasks:
      - id: "p12-published-signal"
        name: "script.published signal emission"
        model: "sonnet"
        depends_on: ["p10-publish-ui", "p11-shorts-ui"]
        estimated_minutes: 12
        context_sources:
          - alias: "tech-spec"
            sections: ["6.1"]
          - alias: "tech-spec"
            sections: ["6"]
        prompt: |
          Implement Neurocore signal emission when a deliverable is marked
          as published.

          Files:
          - src/neurocore/client.ts (EXTEND) — add sendPublishedScript()
            method matching the existing sendApprovedScript() pattern
          - src/routes/deliverables.tsx (EXTEND) — add POST /deliverables/:id/publish
            action that takes a YouTube URL, marks status='published', and
            fires the signal
          - src/views/publish.tsx (EXTEND) — add a "Mark as published" form
            (YouTube URL input) shown when status='exported' (after the
            copy-bundle was used)

          Read src/neurocore/client.ts first — match the existing signal
          method pattern (auth, error types, retry).

          sendPublishedScript() payload:
          {
            signalType: 'script.published',
            planId: string,
            deliverableId: string,
            kind: 'long_form' | 'short_clip',
            audienceProfileId: string,
            youtubeUrl: string,
            title: string,
            selectedHookArchetype?: string,        // from plan's selected hook draft (long_form only)
            selectedTitleArchetype?: string,       // from the selected title concept
            selectedThumbnailComposition?: string, // from the selected thumbnail concept
            publishedAt: ISO string
          }

          The signal is sent fire-and-forget (best effort) — if Neurocore is
          unreachable, the deliverable is still marked published locally and
          the signal failure is logged but doesn't fail the route. This
          matches v1's sendApprovedScript pattern.

          YouTube URL validation: must match
          ^https://(www\\.)?(youtube\\.com|youtu\\.be)/[\\w?=&-]+$ per
          tech-spec security section. Reject otherwise with 400.

          Idempotency: use a deterministic idempotency key
          'drek-script-published-${deliverableId}' so retries collapse on
          Neurocore's side.

          Hardening requirements:
          - URL allowlist enforced at the route layer
          - Bearer token never logged
          - Signal failure logged at 'warn' level with deliverableId, never
            blocks the publish state transition
          - The mark-as-published route requires status='exported' as
            precondition

          Tests at:
          - tests/neurocore/client.test.ts (extend) — sendPublishedScript
            calls correct endpoint with correct payload; retry on 5xx;
            non-retryable on 4xx
          - tests/routes/deliverables.test.ts (extend) — POST publish with
            valid URL succeeds; invalid URL 400; status transitions to
            'published'; signal failure does not fail the route
        expected_files:
          - "src/neurocore/client.ts"
          - "src/routes/deliverables.tsx"
          - "src/views/publish.tsx"
          - "tests/neurocore/client.test.ts"
          - "tests/routes/deliverables.test.ts"
        done_check: "npm run typecheck"

      - id: "p12-bundle-view"
        name: "Deliverable bundle view + plan detail integration"
        model: "sonnet"
        depends_on: ["p10-publish-ui", "p11-shorts-ui", "p12-published-signal"]
        estimated_minutes: 15
        context_sources:
          - alias: "tech-spec"
            sections: ["4.4"]
          - alias: "prd"
            sections: ["4.14"]
        prompt: |
          Implement the Deliverable bundle view + per-deliverable detail
          page that ties together everything per plan.

          Files:
          - src/views/deliverable-bundle.tsx — DeliverableBundleView (list of
            all deliverables for a plan as cards with status, audience binding,
            chosen title preview, action links)
          - src/views/deliverable-detail.tsx — DeliverableDetailView (scenes
            display for the deliverable's subset, plus links to its title/
            thumbnail/publishing workshops)
          - src/routes/deliverables.tsx (EXTEND) — GET /plans/:id/deliverables
            (bundle view) + GET /plans/:id/deliverables/:deliverableId (detail
            view) + POST /plans/:id/deliverables/export-all (writes shoot
            instructions + metadata bundle text files into the workspace
            folder for every deliverable in the plan)
          - src/views/plan-detail.tsx (EXTEND) — add a prominent "Deliverables"
            section showing the bundle view inline or via a link

          DeliverableBundleView (per plan):
          - Card per deliverable
          - Long-form card prominent (full width or larger)
          - Shorts cards in a grid below
          - Each card: kind badge, audience binding label, status badge
            (using the same status badge component as plans),
            selected title (or "Untitled"), selected thumbnail concept
            summary, action buttons (Open, Publishing, Footage)
          - "Export all" button at the top (fires the export-all route)

          DeliverableDetailView (per deliverable):
          - For long_form: links to scene cards (existing view), hook/title/
            thumbnail workshops, publishing tab
          - For short_clip: shows the override script directly + scenes-covered
            mapping + links to its title/thumbnail/publishing workshops

          Export-all route: iterates plan deliverables; for each, write to
          the workspace's exports/{deliverableId}/ subfolder:
          - shoot-instructions.html (HTML format, same as v1's export view)
          - shoot-instructions.txt (plain text, same as v1)
          - publish-bundle.txt (the same plain text from p10's copy-bundle)
          - metadata.json (the structured PublishMetadata for archival)

          Hardening requirements (UI + routes):
          - Bundle view loads in <2s for plans with up to ~6 deliverables
          - Export-all reports per-deliverable success/failure (some may fail
            due to missing publish metadata; surface as warnings, don't abort
            the rest)
          - Workspace path null → export-all surfaces "Workspace not
            configured" error and stops without writing partial files
          - Empty bundle (no deliverables yet) shows clear empty state with
            link to extract Shorts or create long-form

          Tests at:
          - tests/views/deliverable-bundle.test.tsx — bundle renders with
            mixed deliverables; empty state; export button
          - tests/views/deliverable-detail.test.tsx — long_form view, short_clip
            view
          - tests/routes/deliverables.test.ts (extend) — bundle GET returns
            200; detail GET returns 200; export-all writes expected files
            (use a temp workspace)
        expected_files:
          - "src/views/deliverable-bundle.tsx"
          - "src/views/deliverable-detail.tsx"
          - "src/routes/deliverables.tsx"
          - "src/views/plan-detail.tsx"
          - "tests/views/deliverable-bundle.test.tsx"
          - "tests/views/deliverable-detail.test.tsx"
          - "tests/routes/deliverables.test.ts"
        done_check: "test -f src/views/deliverable-bundle.tsx"

      - id: "p12-new-plan-form"
        name: "Manual youtube_advanced new-plan form"
        model: "sonnet"
        depends_on: ["p4-intake-service", "p9-workspace-integration"]
        estimated_minutes: 10
        context_sources:
          - alias: "tech-spec"
            sections: ["4.2"]
        prompt: |
          Extend the new-plan form to support direct creation of
          youtube_advanced plans (not via the intake promote path) — Rick
          may want to plan an episode whose brief isn't in the intake module
          (e.g., his own idea, not from Upwork).

          Files:
          - src/views/new-plan.tsx (EXTEND — read first)
          - src/routes/new-plan.tsx (EXTEND or src/routes/plan.tsx if that's
            where POST /plans lives; check both)

          Add a "New YouTube Advanced Plan" form path (separate from the
          existing cover-letter and youtube-lite forms):
          - Title field
          - Format profile selector (dropdown of FORMAT_PROFILES; default
            claude_code_build_along)
          - Audience profile selector (default developer_longform)
          - Target runtime (defaults from format profile's runtimeRange mid)
          - Episode angle (textarea, optional — if blank, the engine step
            will produce it)
          - User constraints (optional)
          - Submit → POST /plans creates the Plan AND the long_form
            Deliverable in a single batch (per the same lifecycle invariant
            from tech-spec §4.2 Component K)

          Reuse the workspace-create-on-success pattern from
          p9-workspace-integration.

          Hardening requirements: same Zod validation, same audience/format
          existence checks as in the intake promote flow.

          Tests at tests/routes/new-plan.test.ts (extend):
          - POST /plans with type=youtube_advanced creates plan + long_form
            deliverable in one batch
          - Missing format profile id → 400
          - Missing audience profile id → 400 (or default to developer_longform
            if your form makes it optional)
        expected_files:
          - "src/views/new-plan.tsx"
          - "src/routes/new-plan.tsx"
          - "tests/routes/new-plan.test.ts"
        done_check: "npm run typecheck"

      - id: "p12-e2e-tests"
        name: "End-to-end integration tests — full youtube_advanced flow"
        model: "opus"
        depends_on: ["p12-published-signal", "p12-bundle-view", "p12-new-plan-form", "p5-change-format-flow"]
        estimated_minutes: 25
        context_sources:
          - alias: "tech-spec"
            sections: ["10"]
        prompt: |
          Write end-to-end integration tests covering the full youtube_advanced
          workflow with mocked LLM + Neurocore.

          Read tests/integration/full-pipeline.test.ts (the v1 E2E test) for
          the existing fixture pattern + mocking approach.

          Create tests/integration/v2-full-pipeline.test.ts with these
          scenarios:

          1. **Long-form happy path (intake → publish):**
             - Create a pipeline brief
             - Score it via LLM (mocked)
             - Promote to plan with claude_code_build_along + developer_longform
             - Verify plan + long_form Deliverable created in one batch
             - Verify workspace folder created
             - Run detect-episode-requirements → assert structured output stored
             - Run match-projects → projects matched
             - Run generate-scenes (v2 with beats) → scenes tagged with valid beats
             - Run generate-hook-variants → 4 variants persisted
             - Select hook → status advances
             - Run write-scripts → scene 1 == selected hook text
             - Run generate-shot-list → all scenes have shot list
             - Run generate-titles → 6 titles persisted on long-form deliverable
             - Select title → status advances
             - Run generate-thumbnails → 3 concepts persisted
             - Select thumbnail → status advances
             - Run extract-shorts → 3 candidates returned
             - Approve 2 candidates → 2 short_clip Deliverables created
             - Finalize plan
             - Run generate-publish-metadata for long-form
             - Mark long-form as exported then published with a YouTube URL
             - Verify script.published signal sent with correct payload

          2. **Shorts per-deliverable flow:**
             - Starting from a long-form with 2 approved Shorts (use the
               state from scenario 1 or set up directly)
             - For each Short: generate title, select, generate thumbnail,
               select, generate publishing metadata, mark published
             - Verify 2 separate script.published signals fired (one per
               Short) with kind='short_clip'

          3. **Change-format wipe-and-revert:**
             - Promote a brief → reach 'titles_generated' status
             - Change format profile (claude_code_build_along → tutorial)
             - Verify scenes, hook_drafts, title_concepts, thumbnail_concepts
               wiped; long_form Deliverable still exists with status=draft;
               recording sessions preserved; plan status reverted to
               'projects_matched'

          4. **Cover-letter regression:**
             - Create a cover_letter plan
             - Full pipeline runs as v1 (detect → match → generate)
             - Verify NO v2 routes touched (no Deliverable created, no
               format profile loaded, no audience profile loaded)
             - Verify scripts produced match v1 quality (snapshot test or
               structural assertions)

          5. **youtube_lite regression:**
             - Create a youtube_lite plan (renamed from old 'youtube')
             - Full pipeline runs as v1
             - Verify type is 'youtube_lite' throughout (migration didn't
               break the path)

          6. **AudienceProfile failure:**
             - Mock Neurocore audience-profiles endpoint to return 503
             - Attempt to generate hooks on a youtube_advanced plan
             - Assert AudienceProfileUnavailableError surfaces; plan status
               unchanged; no partial persistence

          7. **Change-format refused after publish:**
             - Set up a plan in 'published' state
             - Attempt change-format → asserts
               CannotChangeFormatAfterPublishError; state unchanged

          Use the same dynamic provider + fake Firestore pattern as v1's
          integration test. Mock Neurocore via a stubbed client implementation.

          Hardening requirements:
          - Tests must be hermetic (no external network calls, no real
            filesystem writes outside a tmpdir per test)
          - Use beforeEach to reset Firestore + provider state
          - Assert side effects positively (Deliverable created with exact
            audienceProfileId, etc.) not just that no error was thrown
        expected_files:
          - "tests/integration/v2-full-pipeline.test.ts"
        done_check: "test -f tests/integration/v2-full-pipeline.test.ts"

      - id: "p12-docs-update"
        name: "README + CHANGELOG + CLAUDE.md update"
        model: "sonnet"
        depends_on: ["p12-e2e-tests"]
        estimated_minutes: 10
        context_sources:
          - alias: "readme"
            sections: ["all"]
          - alias: "tech-spec"
            sections: ["1"]
        prompt: |
          Update the project documentation to reflect v2 capability.

          Files:
          - README.md (EXTEND — preserve all v1 content; append v2 section)
          - CHANGELOG.md (CREATE if missing; add v2.0.0 entry)
          - CLAUDE.md (EXTEND — add v2 service surface notes)

          README v2 additions:
          - New section "v2 — YouTube Channel Operating System" describing
            the youtube_advanced plan type at a high level
          - Brief mention of the 9 module additions (intake, workspace,
            format profiles, hook engineering, shot list, title/thumbnail
            workshop, publishing metadata, Shorts extractor, footage
            manifest)
          - Updated env var table including WORKSPACE_ROOT
          - "How a YouTube episode gets made" ASCII flow diagram (similar
            to v1's "How a video gets made" but covering the youtube_advanced
            path)

          CHANGELOG entry for v2.0.0:
          - Renamed youtube → youtube_lite (migration ships with deploy)
          - Added youtube_advanced plan type with full episode/Shorts/
            publishing pipeline
          - AudienceProfile + format profile composition
          - 7 new LLM calls + change-format wipe-and-revert flow
          - Workspace folder management + recording session manifest
          - script.published Neurocore signal
          - Reference any backwards-compatibility guarantees

          CLAUDE.md additions:
          - WORKSPACE_ROOT env var note
          - v2 status enum values (so future Claude Code sessions know about
            them)
          - Pointer to PRD-drek-v2-youtube-2026-05-18.md + TECH-SPEC-drek-v2-youtube-2026-05-18.md

          Hardening requirements: none (docs).

          No tests required for docs.
        expected_files:
          - "README.md"
          - "CHANGELOG.md"
          - "CLAUDE.md"
        done_check: "test -f README.md && test -f CHANGELOG.md"

validation:
  checks:
    - "npm install"
    - "npm run typecheck"
    - "npm run lint"
    - "npm run build"
    - "npm test"
  fix_budget: 5
  context_sources:
    - alias: "prd"
      sections: ["all"]
    - alias: "tech-spec"
      sections: ["all"]
  prompt: |
    After fixing any failing build / type check / test / lint errors,
    perform a hardening audit specific to the DREK v2 surface:

    Engine steps (src/engine/*.ts — Calls 5-11):
    - Every new engine step validates LLM output with Zod before persistence
    - Every new engine step retries-once on bad JSON, throws a typed error
      on second failure, and leaves plan/deliverable status UNCHANGED on
      failure (no half-written state)
    - Every v2 engine step fetches BOTH format profile AND audience profile
      and asserts both are present before the LLM call
    - LLM timeout values match tech-spec §7 targets
    - No mode-blending: buildSystemPrompt() asserts exactly one of (v1Rules)
      or (formatProfile + audienceProfile) is provided

    Routes (src/routes/*.tsx):
    - Every action route validates body with Zod
    - Every 4xx returns structured { error, field? } JSON
    - 415 returned for non-form POSTs
    - No stack traces leaked in any error response
    - HTMX partials return HTML fragments with correct hx-* targets

    Data layer:
    - All Zod schemas validate v1-shaped documents (additive-only invariant)
    - The migration scripts are idempotent (run-twice produces no extra writes)
    - All cascade deletes use batch with 400-op chunking
    - setSelectedConcept / setSelectedHookDraft are atomic (batch)

    Workspace module (security-critical):
    - Every filesystem path goes through path.resolve() + within-root check
    - Slug validation rejects traversal, reserved names, absolute paths
    - Atomic writes via temp+rename
    - No symlink following

    AudienceProfile client:
    - Cache invalidates on fetch failure (any throw path)
    - clearAudienceProfileCache exposed for tests + manual flush
    - No fallback to "generic voice" on profile failure — hard error

    Workshops (hook / title / thumbnail / Shorts):
    - All have empty states, loading states (aria-busy during LLM calls),
      error toast on failure
    - All hx-confirm on regenerate actions
    - Selected item visibly distinguished

    Neurocore client:
    - sendPublishedScript YouTube URL allowlist regex enforced
    - script.published signal is fire-and-forget (failure does not block
      local publish state transition)
    - Idempotency keys deterministic

    Cross-cutting:
    - No console.log; only pino logger
    - NEUROCORE_TOKEN never logged
    - workspacePath never logged in full when it contains sensitive
      patterns (it's just a folder path, but defensive)
    - Existing v1 tests still pass (regression — surface any v1 test
      failure as a critical bug, not a v2 hardening miss)

    If any audit item fails, fix and re-run the checks. Use the fix_budget
    of 5 cycles to converge.
```

---

## Dependency Graph (ASCII)

```
PHASE 1 (Foundation)
├── p1-ap-client ────┐
├── p1-format-types ─┴── p1-format-build-along ─┐
                                                │
PHASE 2 (Data layer) ───────────────────────────┤
├── p2-schemas-core ──┬── p2-schemas-entities ──┼── p2-crud-deliverables ──┐
│                     │                         ├── p2-crud-misc ──────────┤
│                     └── p2-migrate-script     │                          │
│                                               └── p2-firestore-indexes ──┤
                                                                           │
PHASE 3 (Engine core) ─────────────────────────────────────────────────────┤
├── p3-compose-prompt (needs p1-ap-client + p1-format-build-along + p2-core)│
├── p3-format-rest (extends format registry)                               │
└── p3-engine-v1-extensions (needs p3-compose-prompt) ─────────────────────┤
                                                                           │
PHASE 4 (Intake) ──────────────────────────────────────────────────────────┤
├── p4-intake-service (needs p2-crud + p3-engine) ────┐                    │
├── p4-score-brief (needs p4-intake-service) ─────────┤                    │
├── p4-intake-routes (needs p4-score-brief) ──────────┤                    │
└── p4-intake-views (needs p4-intake-routes)          │                    │
                                                       │                    │
PHASE 5 (Episode planner + change-format) ─────────────┤                    │
├── p5-detect-episode-requirements (needs p3-engine) ──┤                    │
├── p5-generate-scenes-beats (needs p5-detect + p3-format-rest)             │
└── p5-change-format-flow (needs p2-crud + p5-scenes)                       │
                                                                            │
PHASE 6 (Hook engineering) ─────────────────────────────────────────────────┤
├── p6-generate-hooks (needs p2-crud-misc + p3-compose + p5-detect)         │
├── p6-select-hook (needs p6-generate-hooks + p3-engine)                    │
└── p6-hook-workshop-ui (needs p6-select-hook)                              │
                                                                            │
PHASE 7 (Shot list) ────────────────────────────────────────────────────────┤
├── p7-generate-shot-list (needs p6-select-hook)                            │
├── p7-shot-list-ui (needs p7-generate-shot-list)                           │
└── p7-shot-list-trigger (needs p7-generate-shot-list)                      │
                                                                            │
PHASE 8 (Title + Thumbnail Workshop) ───────────────────────────────────────┤
├── p8-generate-titles (needs p2-crud-deliv + p3-compose + p7-shot-list)    │
├── p8-generate-thumbnails (needs p8-generate-titles)                       │
└── p8-workshop-routes-and-views (needs p8-thumbnails + p6-hook-workshop)   │
                                                                            │
PHASE 9 (Workspace + Footage) ──────────────────────────────────────────────┤
├── p9-workspace-module (needs p2-schemas-core)                             │
├── p9-workspace-integration (needs p9-workspace + p4-intake-service)       │
└── p9-footage-manifest (needs p2-crud-misc + p9-workspace-integration)     │
                                                                            │
PHASE 10 (Publishing metadata) ─────────────────────────────────────────────┤
├── p10-generate-publish-metadata (needs p8-thumbnails + p2-crud-deliv)     │
└── p10-publish-ui (needs p10-generate-publish-metadata)                    │
                                                                            │
PHASE 11 (Shorts Extractor) ────────────────────────────────────────────────┤
├── p11-extract-shorts (needs p10-publish-metadata)                         │
└── p11-shorts-ui (needs p11-extract-shorts)                                │
                                                                            │
PHASE 12 (Integration + polish) ────────────────────────────────────────────┘
├── p12-published-signal (needs p10-publish-ui + p11-shorts-ui)
├── p12-bundle-view (needs p10 + p11 + p12-signal)
├── p12-new-plan-form (needs p4-intake-service + p9-workspace-integration)
├── p12-e2e-tests (needs p12-signal + p12-bundle + p12-new-plan + p5-change-format)
└── p12-docs-update (needs p12-e2e-tests)
```

## Model Assignment Summary

| Model | Task count | Rationale |
|---|---|---|
| Opus | 17 | Schema design (3 tasks), all 7 new LLM engine steps (Calls 5-11), prompt composition function, change-format atomic batch, intake state machine for promote, migration script (atomicity-critical), workspace module (security-critical path handling), E2E integration tests (orchestration-heavy), v1 engine refactor (no mode-blending invariant) |
| Sonnet | 22 | CRUD modules following v1 plans.ts pattern, format profile constants (boilerplate after architecture), routes following v1 Hono pattern, JSX views following v1 HTMX pattern, Firestore index config, doc updates, smaller per-feature glue tasks |

Total: ~39 tasks. Tasks above ~25 min are flagged for potential further splitting if Lawliet's review surfaces them.

## Critical Path

p1-format-build-along → p3-compose-prompt → p3-engine-v1-extensions → p5-detect-episode-requirements → p5-generate-scenes-beats → p6-generate-hooks → p6-select-hook → p7-generate-shot-list → p8-generate-titles → p8-generate-thumbnails → p10-generate-publish-metadata → p11-extract-shorts → p12-e2e-tests → p12-docs-update.

The critical path is ~13 sequential tasks. Parallel tracks (intake, workspace, format-profile-rest) shorten wall-clock substantially.

## Notes for the Validator

- The v1 cover-letter and youtube_lite paths MUST continue to function unchanged. Several v1 tests will be touched (extended) but never removed; any failure of a v1 test is a regression, not a v2 hardening miss.
- The change-format flow (§4.9) is the highest-risk v2 surface — atomic batch across multiple subcollections. If the Validator surfaces partial-wipe bugs, those are P0 fixes.
- AudienceProfile cache invalidation behavior (auto-invalidate on Neurocore fetch failure, plus a `clearAudienceProfileCache()` for tests/manual flush) is the consolidated answer from Lisa's review — the Validator should verify all three sources of behavior align with this rule.
- The Neurocore-side AudienceProfile CRUD is a separate Barker plan against the Neurocore repo. This plan's M14 Track A dependency assumes it has shipped (Neurocore endpoints respond, 2 seed profiles loaded). Phase 1 of this plan WILL fail if that pre-condition isn't met — surface a clear error in that case.
