# DREK

AI video director — pre-production planning and scene scripting.

## Service

- **URL:** http://localhost:3003/
- **Process manager:** NSSM (Windows service)
- **Commands:** `nssm start DREK` / `nssm stop DREK` / `nssm restart DREK`
- **Logs:** `F:\claude-code\claude_projects\drek\logs\service.log`

## Deploying

DREK runs `node dist/index.js`. A bare `git pull` does NOT update
the running service — `dist/` has to be rebuilt. Use the script:

```powershell
.\scripts\deploy.ps1
```

That runs `git pull` → `npm run build` → `nssm restart DREK` → hits
`/healthz` to verify. Flags: `-SkipPull`, `-SkipBuild`, `-SkipRestart`
for the rebuild-only / restart-only / pull-only cases.

**Never skip the build step manually.** New UI/route/engine code lives
in `src/`; the NSSM service reads `dist/`. Pull-then-restart without
rebuild keeps the old compiled code running and "no changes appeared"
becomes a 30-minute investigation.

## Firebase / Firestore

- **Display name:** DREK
- **Project ID:** `red-tool-8193c` (permanent GCP ID — was originally "red tool", repurposed for DREK)
- **Service account key:** `gcp-key.json` (gitignored)
- **Indexes:** defined in `firestore.indexes.json`, deploy with `firebase deploy --only firestore:indexes`

## v2 surface (YouTube Channel Operating System)

- **Specs:** [`PRD-drek-v2-youtube-2026-05-18.md`](./PRD-drek-v2-youtube-2026-05-18.md), [`TECH-SPEC-drek-v2-youtube-2026-05-18.md`](./TECH-SPEC-drek-v2-youtube-2026-05-18.md)
- **WORKSPACE_ROOT env var** required for `youtube_advanced` plans (Rick's host: `F:\drek-workspace`). Must exist + be writable. Health-checked via `validateWorkspaceRoot()`.
- **Plan types:** `cover_letter` (v1) · `youtube_lite` (v1, renamed from `youtube`) · `youtube_advanced` (v2)
- **v2 status enum additions:** `hooks_generated` · `hook_selected` · `shot_list_generated` · `titles_generated` · `title_selected` · `thumbnails_generated` · `thumbnail_selected` · `shorts_extracted` · `metadata_generated`. v1 plan types never visit these.
- **Composition gate:** `src/engine/compose-prompt.ts:buildSystemPrompt()` asserts exactly one of `{v1CompositionRules}` OR `{formatProfile + audienceProfile}` is passed — throws `PromptCompositionError` on mix.
- **AudienceProfile source:** Neurocore (`src/neurocore/audience-profiles.ts`). Two seeds must exist: `developer_longform` and `business_owner_shorts` — seed via Neurocore's `scripts/seed-audience-profiles.ts`.
- **Format profile registry:** Local TypeScript constants in `src/engine/format-profiles/`. Only `claude_code_build_along` ships in v2; the other 6 (tutorial, case_study, comparison, essay_opinion, listicle, reaction_review) defer to v2.1.
- **Workspace security:** All filesystem paths go through `src/workspace/paths.ts:resolveSubdirPath()` (slug-validated, ALLOWED_SUBDIRS-gated, traversal-rejecting, Windows-reserved-name-rejecting). Writes are atomic temp+rename with lstat symlink rejection and a 10MB content cap.
- **Migration:** Existing `type: 'youtube'` plans are migrated to `type: 'youtube_lite'` via `scripts/migrate-youtube-to-youtube-lite.ts` (idempotent).

## v2.1 surface (Content Substrate)

- **Spec:** [`TECH-SPEC-drek-v2.1-content-substrate-2026-05-19.md`](./TECH-SPEC-drek-v2.1-content-substrate-2026-05-19.md)
- **Brief Transformer:** `POST /intake/:briefId/transform` lifts 3.0+ briefs with weak narrative axes (visualOutcome < 3.0 OR storyPotential < 3.0) AND strong technical fit (scopeFit + audienceMatch ≥ 3.5) into 5.0-grade briefs. Pins a tech stack from Neurocore's `tech_stack_profiles` registry. Re-scores via Call 11 post-rewrite; drift > 0.5 on technical axes warn-logs.
- **Batch intake:** Multi-row form at `/intake/batch/new` (max 25 briefs/submit). Atomic Firestore batch write, parallel LLM scoring (3 concurrent), HTMX-polled overview.
- **Cross-app entities (in Neurocore):**
  - `tech_stack_profiles` — curated build-tech registry. DREK reads on transform.
  - `content_catalog` — one row per published Deliverable; DREK writes via durable queue.
  - `stack_performance` — per-tech-stack aggregated YouTube metrics; nightly cron writes, transformer reads for the CHANNEL HISTORY prompt block.
- **YouTube client (read-only):** `src/youtube/`. OAuth via env (`YOUTUBE_CLIENT_ID/SECRET/REFRESH_TOKEN/CHANNEL_ID`). Quota counter warns at 80%, refuses at 95% of `YOUTUBE_DAILY_QUOTA` (default 10K).
- **Nightly cron:** `src/cron/refresh-stack-performance.ts` runs at 04:00 UTC. Aggregates analytics per tech stack into Neurocore.
- **Durable Neurocore writes:** `src/neurocore/write-queue.ts` — in-memory + JSONL persistence at `$WORKSPACE_ROOT/.neurocore-queue.jsonl`. Exponential backoff (1/2/4/8/16s), dead-letter at `.neurocore-queue-dead.jsonl` after 5 attempts. Surfaced via `/healthz`.
- **OAuth provisioning:** One-time manual via OAuth Playground (see CHANGELOG.md "Required env vars"). Verify with `npx tsx scripts/verify-youtube-oauth.ts`. Skip the `yt-analytics-monetary` scope — sensitive, requires app verification.
