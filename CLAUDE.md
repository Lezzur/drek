# DREK

AI video director — pre-production planning and scene scripting.

## Service

- **URL:** http://localhost:3003/
- **Process manager:** NSSM (Windows service)
- **Commands:** `nssm start DREK` / `nssm stop DREK` / `nssm restart DREK`
- **Logs:** `F:\claude-code\claude_projects\drek\logs\service.log`

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
