# Changelog

All notable changes to DREK are documented here.

## v2.1.0 — 2026-05-21

DREK v2.1: content substrate. Turns DREK from "one-channel pre-production"
into the first writer for a cross-app content layer. Three new shared
entities in Neurocore (`TechStackProfile`, `ContentCatalog`, `StackPerformance`),
batch brief intake, a Brief Transformer that lifts 3.0+ briefs to 5.0-grade,
and the YouTube read-only client that feeds analytics back into the loop.
See [`TECH-SPEC-drek-v2.1-content-substrate-2026-05-19.md`](./TECH-SPEC-drek-v2.1-content-substrate-2026-05-19.md)
for the design.

### Added

- **Batch intake (M25)** — multi-row form at `/intake/batch/new` accepting
  up to 25 briefs in one paste. Parallel LLM scoring with 3-call
  concurrency, persist-first semantics, atomic Firestore batch write,
  HTMX polling on the overview page.
- **TechStackProfile (M26)** — Neurocore-hosted catalog of build
  technologies. Replaces DREK's local TypeScript constants. DREK reads
  on transform via `src/neurocore/tech-stacks.ts`; seeds shipped with
  the Neurocore repo (10 stacks: vapi, retell, n8n, zapier, make,
  claude_code_cli, cursor, supabase, firebase, twilio).
- **Intake list UX (M26.5)** — multi-select checkboxes + score column +
  status column on `/intake`. Bulk retire/delete actions with 50-row cap.
- **Brief Transformer / Call 11.5 (M29)** — `POST /intake/:briefId/transform`
  promotes briefs with strong technical fit (scopeFit + audienceMatch ≥ 3.5)
  but weak narrative axes (visualOutcome < 3.0 OR storyPotential < 3.0)
  into 5.0-grade briefs. LLM rewrites the brief, pins a tech stack from
  the Neurocore registry, then re-scores via Call 11. Drift detection
  warns when the transformer rewrites facts vs framing.
- **ContentCatalog (M27 + M28)** — one shared record per published
  Deliverable in Neurocore, queryable by Nami's outreach, the website
  portfolio, lead-qualification, and future apps. DREK writes on publish
  via a durable in-process queue (`src/neurocore/write-queue.ts`) backed
  by `$WORKSPACE_ROOT/.neurocore-queue.jsonl` so a service restart doesn't
  lose writes. Exponential backoff, dead-letter after 5 attempts.
- **YouTube client (M30)** — read-only `src/youtube/` module wraps Data
  + Analytics APIs. OAuth refresh-token flow with in-memory access-token
  cache, automatic 401 rotation, per-process quota counter (warns at 80%,
  refuses at 95%), empty-channel graceful handling for brand-new channels.
- **StackPerformance (M31)** — Neurocore entity capturing per-tech-stack
  aggregated metrics (videoCount, avgViews, avgWatchTimeSeconds, avgCtr).
  Nightly DREK cron `src/cron/refresh-stack-performance.ts` runs at 04:00
  UTC, iterates ContentCatalog, pulls YouTube analytics, aggregates by
  primaryTechStackId, upserts the registry. Brief Transformer prompt picks
  up the resulting CHANNEL HISTORY block + Rick's tie-break rule (popular
  stacks STAY popular; only niche stacks get the underdog bias).
- **Healthz expansions** — `/healthz` now surfaces `neurocoreWriteQueueDepth`,
  `neurocoreDeadLetterCount`, `youtube` configured state, and
  `youtubeQuotaUtilization`. Soft signals; never flip the response to 503.

### Schema (additive)

```typescript
// PipelineBrief — four new nullable fields, no migration needed:
batchId: string | null = null;
transformedBriefText: string | null = null;
transformedScore: BriefScore | null = null;
pinnedTechStack: { primary, supporting[], rationale } | null = null;
```

Three new top-level Neurocore collections: `tech_stack_profiles`,
`content_catalog`, `stack_performance`. All read-restricted to authenticated
apps; writes admin-only (TechStackProfile) or DREK-only (ContentCatalog,
StackPerformance).

### Required env vars (additive)

```
YOUTUBE_CLIENT_ID        # OAuth client (Web application type)
YOUTUBE_CLIENT_SECRET    # OAuth secret
YOUTUBE_REFRESH_TOKEN    # Mint via OAuth Playground (one-time)
YOUTUBE_CHANNEL_ID       # UC... — find at studio.youtube.com → Settings
YOUTUBE_DAILY_QUOTA      # Optional, default 10_000
YOUTUBE_TIMEOUT_MS       # Optional, default 30_000
```

A verification script is included: `npx tsx scripts/verify-youtube-oauth.ts`.

### Firestore indexes (DREK)

```json
{ "collectionGroup": "pipeline_briefs", "fields": [
    { "fieldPath": "batchId", "order": "ASCENDING" },
    { "fieldPath": "createdAt", "order": "ASCENDING" }
] }
```

Deploy with `firebase deploy --only firestore:indexes`.

### Firestore indexes (Neurocore)

Three composite indexes on `content_catalog`:
- `(sourceApp, publishedAt DESC)` — recent activity feed
- `(primaryTechStackId, publishedAt DESC)` — per-stack lookups
- `(audienceProfileId, publishedAt DESC)` — per-audience lookups

### Migration

None — every schema change is additive with `null` defaults. Existing
v2.0 briefs/plans/deliverables continue to work; M29's Transform button
just doesn't show up for them (no pinnedTechStack on the source brief).

## v2.0.0 — 2026-05-18

DREK v2: YouTube Channel Operating System. Extends DREK from "writes
scripts for Rick's videos" to "runs a YouTube channel end-to-end." See
[`PRD-drek-v2-youtube-2026-05-18.md`](./PRD-drek-v2-youtube-2026-05-18.md)
and [`TECH-SPEC-drek-v2-youtube-2026-05-18.md`](./TECH-SPEC-drek-v2-youtube-2026-05-18.md)
for the design.

### Added

- **New plan type: `youtube_advanced`** — drives the full v2 pipeline.
  Sits alongside `cover_letter` (v1) and `youtube_lite` (v1, renamed).
- **9 new modules** from the channel master document: intake (pipeline
  brief sourcing + LLM scoring), workspace folder management, format
  profile registry, hook engineering, shot list generation,
  title/thumbnail workshop, publishing metadata, Shorts extractor,
  footage manifest.
- **7 new LLM calls (Calls 5-11)**: hook variants, shot list, title
  variants, thumbnail concepts, Shorts extraction, publishing metadata,
  brief scoring. All retry-once on bad JSON or validation failure;
  plan/deliverable status never advances on failure.
- **AudienceProfile composition** — every v2 LLM call pulls a
  Neurocore-hosted AudienceProfile (`developer_longform` for long-form,
  `business_owner_shorts` for Shorts) and stitches it into the system
  prompt alongside the format profile. Hard error if the profile is
  unreachable — no "generic voice" fallback.
- **Format profile registry** — local TypeScript constants describing
  episode shape (beats, runtime range, scene range, pacing). Ships
  with `claude_code_build_along`; the other 6 profiles defer to v2.1.
- **change-format wipe-and-revert flow** — Rick can swap the format
  profile mid-flight. Per spec §4.9 this wipes scenes + hook drafts +
  title/thumbnail concepts + short_clip Deliverables in one Firestore
  batch and reverts the plan to `projects_matched`. Recording sessions
  are preserved. Refused after the plan is exported or published.
- **Workspace folder module** — per-plan directory at
  `$WORKSPACE_ROOT/<planId>-<slug>/` with subdirs `brief/ briefs/
  scripts/ shotlist/ recordings/ assets/ exports/`. Slug validation
  rejects traversal, Windows reserved names, and over-length inputs;
  all writes are atomic (temp + rename) with lstat-based symlink
  rejection and a 10MB content cap.
- **Deliverable entity** — sits between Plan and the per-artifact
  scenes/scripts/metadata. One long-form Deliverable per plan
  (created in the same batch as the plan); N short_clip Deliverables
  per plan (created when Rick approves Shorts candidates). Each
  Deliverable runs its own title + thumbnail + publishing-metadata
  flow.
- **Hook workshop** — Rick reviews 3-4 LLM-generated hook variants in
  a card-grid UI and picks one. The selected hook becomes scene 1's
  script verbatim when `write-scripts` runs.
- **Title workshop** — 5-10 title variants per Deliverable with
  archetype tags + predicted clickability scores.
- **Thumbnail workshop** — 3-5 text-only thumbnail concepts (composition
  + textHook + colorPalette + assetsRequired). Image production stays
  in Figma/Photoshop/Canva — DREK only briefs.
- **Publishing metadata workshop** — description (1-5 paragraphs,
  ≤5000 chars), chapters with server-computed timestamps + LLM-named
  labels, 10-15 SEO tags, pinned engagement comment, end-screen
  suggestion. Plain-text bundle endpoint
  (`/deliverables/:id/publish/bundle`) is paste-ready for YouTube
  Studio.
- **Shorts extractor** — 3-5 candidate Shorts from the long-form
  scripts using a hardcoded beat-importance heuristic
  (demo=10, outro=8, cold_open=7, war_room=6, problem/build_reel=5,
  breakdown=4) as ranking input (NOT a hard filter — the LLM can
  override). Candidates are ephemeral (held in a 1-hour in-process
  cache); approval materializes a `short_clip` Deliverable bound to
  `business_owner_shorts`.
- **Recording session manifest** — `footage` tab tracks per-scene
  coverage. Files-on-disk are never auto-deleted; sessions are
  metadata-only.
- **Deliverable bundle view** — `/plans/:id/deliverables` shows every
  artifact for a plan (long-form + Shorts), with per-card status,
  audience binding, selected title/thumb, and an "Export all"
  button that writes shoot-instructions HTML + plain text + publish
  bundle + metadata JSON for every Deliverable in one click.
- **`script.published` Neurocore signal** — fires when Rick marks a
  Deliverable as published with a YouTube URL. Payload includes the
  selected hook archetype + title archetype + thumbnail composition
  so Neurocore can correlate creative choices with eventual viewcounts.
  Fire-and-forget — local publish never blocks on signal failure.
  Idempotency key is per-deliverable.
- **YouTube URL allowlist** — `YOUTUBE_URL_REGEX` restricts the
  published URL to `https://(www\.)?youtube.com|youtu.be` (per
  tech-spec security section). Non-matching URLs throw
  `InvalidYouTubeUrlError` → 400.
- **Intake module** — pipeline briefs scored by LLM (`PipelineBrief`
  entity, `BriefScore` aggregate). Promote-to-plan creates the Plan +
  long_form Deliverable + workspace folder atomically.
- **`WORKSPACE_ROOT` env var** — required for `youtube_advanced` plans.
  Health-checked via `validateWorkspaceRoot()`.
- **End-to-end integration tests** — `tests/integration/v2-full-pipeline.test.ts`
  covers the long-form happy path through publish, Shorts
  per-deliverable flow, change-format wipe-and-revert, AudienceProfile
  unavailability, signal-failure non-fatal, and URL allowlist
  enforcement. Hermetic (fake Firestore, scripted LLM, captured
  Neurocore client, tmp WORKSPACE_ROOT per test).

### Changed

- **`youtube` plan type renamed to `youtube_lite`** — one-time backfill
  via `scripts/migrate-youtube-to-youtube-lite.ts`. Idempotent.
  Existing data preserved.
- **Plan schema** — additive only. New nullable fields
  (`formatProfileId`, `pipelineBriefId`, `workspacePath`,
  `selectedHookVariantId`, `selectedTitleVariantId`,
  `selectedThumbnailConceptId`) default to `null` on v1 documents so
  no migration is required.
- **Scene schema** — additive only. New nullable fields (`beatTag`,
  `primaryShot`, `brollItems`, `shotListItems`, `onScreenTextOverlays`,
  `cutPoints`) default to `null`/`[]` on v1 documents.
- **Plan state machine** — added 9 new statuses, plus transition
  paths. v1 cover_letter and youtube_lite plans never visit the new
  statuses; their flow is unchanged.

### Backwards compatibility

- **Cover-letter pipeline is byte-for-byte identical to v1.** All
  cover-letter tests pass unchanged. No v2 routes touched, no
  format/audience profile loaded.
- **`youtube_lite` runs the v1 pipeline.** The rename is the only
  difference.
- **All v1 Zod schemas parse v2 documents.** Additive-only invariant
  enforced at the data layer.

### Pre-existing test breaks (carried over from v1)

15 tests across 5 files fail on a clean checkout. None introduced by
v2 work — see `/home/node/.claude/projects/-workspaces-tony-stark/memory/drek_v1_preexisting_test_breaks.md`:

- `tests/providers/factory.test.ts` (5) — `getLLMProvider()` became
  async in commit `c945653` but tests still call `.name` on the
  returned Promise. Trivial fix.
- `tests/polling/service.test.ts` (1 type error), `tests/integration/full-pipeline.test.ts`
  (1 type error) — `PendingListing` got new optional nullable fields
  that the v1 fixtures don't supply.
- `tests/views/plan-detail.test.tsx` (6), `tests/views/dashboard.test.tsx`
  (2), `tests/views/export.test.tsx` (1), `tests/views/new-plan.test.tsx`
  (1) — UI tests check for old literal hex colors / old button copy
  that drifted during the v2 rebuild.

### Deferred to v2.1

- Format profiles other than `claude_code_build_along` (tutorial,
  case_study, comparison, essay_opinion, listicle, reaction_review).
- Direct-create new-plan form for `youtube_advanced` (current path
  is intake-only).
- Image-generation thumbnails (current: text-only concept briefs).
- External research / arc tracking.
