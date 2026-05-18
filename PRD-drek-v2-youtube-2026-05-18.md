# PRD — DREK v2: YouTube Channel Operating System

**Date:** 2026-05-18
**Author:** Tony Stark (PRD lead)
**Status:** Draft
**Predecessor PRD:** `PRD-drek-2026-05-15.md`
**Format:** Agent-Optimized Spec (consumer: Claude Code)
**Repository:** `Lezzur/drek` (extends v1 in place — no new repo)
**Discovery inputs:**
- "DREK gaps for YouTube" critique (8 numbered gaps)
- YouTube Channel Master Document (16 sections + 14-module proposal)
- Multi-agent room decisions from 2026-05-18 (Lisa, Shikamaru, Misa, Nami, Dee)

---

## 0. Decisions Locked Before This PRD

The following decisions were made in the discovery room before this PRD was drafted. They are the load-bearing constraints:

| ID | Decision | Rationale |
|----|----------|-----------|
| L-1 | Extend DREK in place — no new repo | Reuses Plan/Scene/Script CRUD, LLM provider abstraction, Neurocore client, polling cron, model catalog, HTMX UI, NSSM service, 308-test harness. One mental model, one deployment, one voice profile. |
| L-2 | AudienceProfile is a first-class **Neurocore** entity, not a DREK entity | Per Rick: "Neurocore carries the common-denominator information that this app, and other apps that connect to Neurocore, can, will and should share." Future blog/email/podcast generators reuse the same profiles. |
| L-3 | Developer-first content strategy | Long-form for developers/learners (subscriber + community revenue + referral pipeline). Shorts for discovery + algorithm fuel. Long-form CTA optimization is priority #1 because long-form generates 3.3× revenue per video at one-quarter the views (Nami's funnel math). |
| L-4 | AudienceProfile binds at the **deliverable** level, not the project level | One project (build) produces multiple deliverables (long video + 3 Shorts + lead magnet), each with its own audience binding and CTA style. |
| L-5 | Section 16.17 ("tool builds itself on camera as episode 1") is dropped | Rick will build out the full v2 before filming. No recursion risk, no v0.1 vs v1 split. |
| L-6 | Existing DREK cover-letter mode is preserved untouched | v2 adds capability; it does not remove. Cover-letter workflow shipped in v1 keeps functioning unchanged. |
| L-7 | Existing `youtube` plan type is renamed `youtube_lite` and remains usable; a new `youtube_advanced` plan type ships with the full v2 capability surface | Preserves backwards compatibility with finalized plans. Migration is a single field rename, not a data conversion. |

---

## 1. Problem Statement

DREK v1 shipped a pre-production planning tool for two video modes: cover-letter Looms and lightweight YouTube videos. The cover-letter mode is genuinely useful — Rick has the full pipeline (listing → requirements → projects → scenes → scripts → shoot instructions). The YouTube mode works but is the bare minimum: a single `YOUTUBE_RULES` composition template, scene cards with framing notes only, no title/thumbnail support, no B-roll spec, no Shorts derivation, no publishing artifacts.

Rick is launching a YouTube channel as a high-ticket client acquisition channel. The channel format is "documented Claude Code builds sourced from real job boards." The channel master document and gap analysis both make the same point: **DREK's current YouTube mode plans the script. It does not plan the video.** The eight specific gaps:

1. **Titles and thumbnails** — the #1 click determinant. DREK produces zero artifacts for either.
2. **Hook engineering** — the first 15 seconds is its own discipline (pattern interrupt, bold claim, retention question, story cold-open). DREK currently treats the opening as a sub-bullet of scene 1.
3. **Video format diversity** — YouTube isn't one format. Tutorial, case study, comparison, listicle, build-along, essay — each has its own composition rules. DREK has one `YOUTUBE_RULES` constant.
4. **Shot list / B-roll per scene** — `framingNotes` is one free-text field. A useful scene has primary shot, B-roll list, screenshots to pull, on-screen text overlays, cut points.
5. **Chapters + description + tags + pinned comment** — standard YouTube upload-form artifacts. DREK produces none.
6. **Shorts/Reels extraction** — same project, vertical re-cut. Would 2-3× output for ~0 extra planning cost. Scene data is already there, just needs a different composition profile.
7. **Performance feedback loop** — voice profile only calibrates from script edits. It should also ingest retention/CTR data so it learns which scripts actually held viewers.
8. **External research** — drawing only from Neurocore projects limits YouTube to "stuff Rick has built." Tutorial/explainer videos need competitor scan, trending search context.

Additionally, the channel master document identifies upstream and downstream operational gaps that DREK touches but doesn't own today: project sourcing/scoring (Module 1), project workspace state machine (Module 2), recording/footage manifest (Module 5), publishing checklist (Module 8), lead capture (Module 10), analytics feedback (Module 11), community/paid content bridge (Module 12).

**DREK v2 solves the YouTube-channel-operating-system problem.** It extends the existing planning core with the eight content gaps above, adds the upstream (sourcing) and downstream (publishing, Shorts, footage tracking) workflow modules, and introduces a reusable AudienceProfile abstraction in Neurocore that future apps can also consume. The cover-letter pipeline shipped in v1 remains untouched.

---

## 2. Users

### 2.1 Primary User: Rick

Same as v1. Solo AI automation consultant. Builds and ships Claude-Code-driven software for clients and now also for a YouTube channel that doubles as a client acquisition funnel.

**Context of use for v2:** Rick has a queue of vetted Upwork/Freelancer briefs (Module 1 output). For each brief he wants to take to video, he creates a `youtube_advanced` plan in DREK. DREK plans the full episode: format selection → audience binding → titles/thumbnails → hook variants → scene cards with shot lists → scripts → publishing metadata → Shorts derivation. Rick edits, finalizes, exports, records, uploads.

**Success:** Episode planning takes <30 minutes (currently undefined — no episode has shipped). Rick presses record without needing additional research, mockup work, or script restructuring. Every long-form publishes with 3 Shorts derived from the same plan. Every upload form is fully populated from a single export.

**Failure:** Generated titles get lower CTR than Rick's manual attempts. Format profiles produce mode-blended scripts. Shorts extractor selects wrong moments. Publishing metadata is generic enough that Rick rewrites it manually. Rick gets to the recording session and discovers he needs B-roll he didn't plan for.

### 2.2 YouTube Audience Model

The channel serves two audiences via different deliverables from the same project. This shapes DREK's data model (per-deliverable AudienceProfile binding) and output (different CTAs, different pacing, different hooks per artifact).

**Long-form audience: Developers and learners**

- **Who:** AI/automation practitioners, junior-to-senior developers learning Claude Code, agency owners evaluating tooling, technical decision-makers researching for their teams.
- **Why they watch:** Want to see how Rick thinks through a real build. Value the technical depth and the prompt/response dialogue. Will sit through 25-35 minutes if it's structured.
- **Conversion path:** Subscribe → paid community ($X/month) → referrals to clients in their network. Per Nami: ~$5,000 expected revenue per long-form in year 1; grows to ~$20,000 per video in year 2 as algorithm trust builds.

**Shorts audience: Business owners + algorithm fuel**

- **Who:** Founders, ops leads, agency owners who scroll Shorts during downtime. Also the YouTube algorithm itself — Shorts feed the long-form discovery.
- **Why they watch:** Want quick proof that this person can build the thing they need. Will not sit through 30 minutes — Shorts are the trust delta.
- **Conversion path:** Watch Shorts → see pricing moment or demo reveal → click through to landing page → book consultation. Per Nami: ~$1,500 expected revenue per Short in year 1, plus the subscriber growth that compounds into long-form viewership.

### 2.3 The AudienceProfile Abstraction

Rick's directive: the tool should support arbitrary future audiences (different channels, different content types) via a template system. AudienceProfile is the Neurocore entity that captures everything a script writer needs to know about who the script is targeting. See section 7.1 for schema.

This is the v2 generalization of v1's hardcoded `audience_primary` / `audience_secondary` constants. The cover-letter mode in v1 was implicitly bound to a "hiring managers" audience; the YouTube mode to "potential clients." v2 makes the binding explicit and reusable.

### 2.4 Anti-Users

DREK v2 is still not for video editors, general content creators, multi-person production teams, or anyone whose workflow doesn't terminate in "Rick presses record." It remains a single-user planning tool optimized for Rick's projects, Rick's voice, Rick's channel.

---

## 3. Success Metrics

| Metric | Target | Measurement | Measurable at |
|--------|--------|-------------|---------------|
| Planning time per long-form episode | <30 minutes from "create plan" to "export shoot instructions" | Self-reported elapsed time per `youtube_advanced` plan | Post-launch (after 3+ episodes planned) |
| Recording-readiness rate | Rick records from the plan without needing additional research, mockups, or script restructuring on ≥80% of episodes | Self-reported flag per episode in the plan record | Post-launch (after 5+ episodes recorded) |
| Title CTR delta | Generated titles match or beat Rick's manual title attempts on CTR within 30 days of upload | YouTube Analytics CTR per video, compared to baseline Rick-authored titles from comparable thumbnails | Post-launch (after 5+ episodes published + 30 days) |
| Shorts derivation ratio | ≥3 Shorts derived from each long-form plan, automatically suggested by DREK | Count of `short_clip` deliverables per long-form plan | Launch |
| Publishing checklist completion | 100% of metadata fields (title, description, chapters, tags, pinned comment) populated automatically before Rick reviews | Inspection of `publish_metadata` per finalized plan | Launch |
| AudienceProfile reuse | At least 2 distinct AudienceProfiles in use within 30 days of v2 launch (developer-long-form, business-owner-shorts) | Count of distinct profiles bound to deliverables | Launch + 30 days |
| Hook variant acceptance | Rick selects a generated hook variant (rather than writing his own) on ≥70% of plans | Ratio per `youtube_advanced` plan | Post-launch (after 10+ plans) |
| Format profile match | Rick does not change the auto-selected format profile after generation on ≥60% of plans | Ratio per plan history | Post-launch (after 10+ plans) |

---

## 4. Features

### 4.1 AudienceProfile System (Neurocore-backed)

**What:** A reusable, named profile that captures who a script is written for. Lives in Neurocore as a first-class entity. DREK reads via the existing Neurocore client.

**Behavior:**
- Neurocore exposes `GET /v1/audience-profiles` (list) and `GET /v1/audience-profiles/:id` (single).
- DREK fetches profile when needed for prompt construction. Caches per-plan-session.
- A profile describes: watchPersona, painPoints, buyingTriggers, voiceGuidelines, hookPatterns, pacingRules, ctaStyle.
- Profiles are created/edited via Neurocore's existing admin UI (Neurocore work, not DREK work). DREK consumes only.
- Two profiles ship at v2 launch: `developer_longform` and `business_owner_shorts`. Both seeded by Rick or by an initial migration.
- A plan's deliverables each bind to one AudienceProfile. The script writer LLM call injects the profile into the system prompt verbatim (no inference).

**States (in DREK):**
- **Profile fetched:** Plan deliverable references a profile by ID. DREK loads it before any generation step that needs it.
- **Profile unavailable:** Neurocore down or profile deleted. Generation step shows a hard error. Rick must select a different profile or wait for Neurocore. No fallback to generic voice — the whole point is targeted output.

**Priority:** P0 — Must have. Blocks everything downstream.

---

### 4.2 Format Profiles (DREK-local registry)

**What:** A registry of YouTube-format-specific composition rule sets, equivalent in role to v1's `COVER_LETTER_RULES` and `YOUTUBE_RULES`, but pluggable and selectable per plan.

**Behavior:**
- Format profiles ship as TypeScript constants in `src/engine/format-profiles/`. No Firestore storage in v1 — they are code.
- Each profile defines: name, displayName, description, sceneRange (min/max), runtimeRange (min/max seconds), hookGuidelines, structureTemplate (named beats), pacingRules (wpm, sentence length), shotConventions, antipatterns.
- v2 ships with the following format profiles:
  - `claude_code_build_along` (default for Rick's channel — maps to "The Gauntlet" structure from the channel master doc)
  - `tutorial` (step-by-step how-to)
  - `case_study` (results-led, problem→solution→outcome)
  - `comparison` (X vs Y, with criteria)
  - `essay_opinion` (single argument, expository)
  - `listicle` (N things, fast-paced)
  - `reaction_review` (commentary on external content — used rarely)
- A `youtube_advanced` plan selects exactly one format profile at creation time.
- Format profile + AudienceProfile + projects together drive every generation step in the plan pipeline.

**States:**
- **Profile selected:** Plan records `formatProfileId`. All generation prompts include the profile constant.
- **Profile changed mid-plan:** Triggers regeneration prompt. Existing scenes/scripts may not match new format rules; DREK warns and lets Rick choose: keep + regenerate scripts only, or wipe + regenerate from scratch.

**Priority:** P0 — Must have. Direct fix for gap #3 (video format diversity).

---

### 4.3 Project Pipeline & Sourcing (Module 1, light)

**What:** A queue of candidate video briefs sourced from Upwork/Freelancer/manual paste. Rick scores each against a rubric, marks it vetted, and promotes to a DREK plan.

**Behavior:**
- New view: `/pipeline`. Lists all `pipeline_brief` records.
- Per record: title, company (nullable), source URL, raw brief text, scoring fields (visual outcome 1-5, story potential 1-5, scope fit 1-5, target audience match 1-5), aggregate score, stage.
- Stages: `candidate` → `vetted` → `selected` → `in_production` → `published` → `retired`. Transitions are explicit (button-driven, not LLM-driven).
- "Score this brief" button — calls LLM with the rubric and the brief text, returns suggested scores Rick can accept or override.
- "Promote to plan" button on `vetted` briefs — creates a `youtube_advanced` plan pre-filled with the brief text, advances the brief to `selected`.
- Queue depth indicator: if `vetted + candidate` count < 3, dashboard shows a warning ("Pipeline thin — source more briefs").
- Manual brief paste: dedicated form. URL ingestion via PI listings already exists in v1 — extended in v1.1 to surface non-video-required listings here too.

**States:**
- **Empty queue:** Dashboard shows pipeline warning. New brief form prominent.
- **Healthy queue:** Default state. Brief list sortable by score, by stage, by date added.
- **Scoring in progress:** LLM call running. Spinner per brief.
- **Stage transition:** Button click → DB write → row updates inline via HTMX.

**Priority:** P0 — Must have. Closes the channel-doc Section 15.1 gap (no pre-Phase-1 pipeline exists).

---

### 4.4 Project Workspace (Module 2)

**What:** Each plan gets a deterministic folder structure on disk, a state-machine status, and a dashboard surface showing where it is across all phases.

**Behavior:**
- On plan creation, DREK generates a project folder: `{config.workspaceRoot}/{planId}-{slug}/`. Subfolders: `brief/`, `briefs/`, `scripts/`, `shotlist/`, `recordings/`, `assets/`, `exports/`. (DREK does not create the recordings; this is the directory Rick will point his recorder at.)
- The folder path is stored on the plan record. Rick can open it from the plan detail UI ("Open folder" button — invokes OS file explorer via local route).
- The plan dashboard already exists (v1 §4.13). v2 extends it with: phase indicator (Pipeline / Planned / Scripts ready / Shot list ready / Footage logged / Published), Shorts count badge, next-action indicator ("Next: write hooks", "Next: log footage", etc.).
- The state machine extends v1's plan status enum (see §7.3).

**States:**
- **Folder created:** Subfolders exist. Plan record has `workspacePath`.
- **Folder missing:** If the workspace root is unavailable (Windows drive disconnected), DREK surfaces an error but does not block planning. Generation still proceeds; only folder-export actions fail.

**Priority:** P0 — Must have.

---

### 4.5 Brief & Episode Planner (extends v1 §4.2)

**What:** v1's "detect requirements" step extended for `youtube_advanced` plans. Same engine call, different prompt: produces episode requirements (topic angle, anti-topic, technical scope, intended takeaway) instead of cover-letter requirements (skills, tools, time constraints).

**Behavior:**
- When a `youtube_advanced` plan is created from a pipeline brief, DREK calls the LLM with the brief, the format profile, and the AudienceProfile.
- Output structured fields: episodeAngle, antiAngle (what this episode is NOT about), technicalScope (what gets shown vs deferred), intendedTakeaway (one-sentence viewer outcome), risksToFlag (where the build might go wrong on camera).
- Rick reviews, edits, confirms. Plan status transitions to `requirements_reviewed`.

**Priority:** P0 — Must have.

---

### 4.6 Episode Outline & Segment Template (Module 4, extends v1 §4.6)

**What:** Scene cards generation extended for the format profile's structure template. Output is the long-form episode skeleton with per-beat duration targets.

**Behavior:**
- LLM call receives: format profile structure template, AudienceProfile pacing rules, target runtime, matched projects, episode angle.
- Output is a sequence of scenes (5-12 typically for `claude_code_build_along`), each tagged with the beat name from the format profile (e.g., `cold_open`, `problem`, `war_room`, `build_reel`, `breakdown`, `demo`, `outro`).
- Each scene carries v1 fields (title, description, framingNotes, projectRef) plus v2 fields (beatTag, brollItems[], shotListItems[], onScreenTextOverlays[], cutPoints[]).
- Runtime bar shows estimated vs target — v1 behavior, no change.

**Priority:** P0 — Must have.

---

### 4.7 Hook Engineering (gap #2)

**What:** A separate LLM call dedicated to producing the first 15 seconds of the video. Generates 3-4 hook variants per plan. Rick picks one before the rest of the script generates.

**Behavior:**
- New engine step `generate-hook-variants`. Runs after scene outline generation, before script writing.
- Input: format profile hook guidelines, AudienceProfile hookPatterns, episode angle, technical scope, target runtime.
- Output: 3-4 hook variants, each labeled by hook archetype (`pattern_interrupt`, `bold_claim`, `retention_question`, `story_cold_open`, `demo_first`). Each variant is a 30-60 word draft of the first 10-15 seconds of script.
- Variants displayed in the plan UI as selectable cards. Rick picks one. Selection persists to the plan.
- The selected hook becomes the script for scene 1 (overrides whatever scene 1 would have generated).
- Script writer for remaining scenes (4.8) is told the hook was already written and structures the rest accordingly.

**States:**
- **Generating:** Spinner. ~20-30s LLM call.
- **Variants ready:** 3-4 cards displayed, click-to-select.
- **Hook selected:** Selection persisted. Other variants kept visible (Rick can re-pick later).
- **Regenerate variants:** Button on the hook section to fetch a new set if none of the current variants land.

**Priority:** P0 — Must have. Direct fix for gap #2.

---

### 4.8 Script Writing with Format & Audience Awareness (extends v1 §4.5)

**What:** v1's script writer enhanced to take format profile + AudienceProfile + selected hook as inputs.

**Behavior:**
- Same engine call (LLM Call 4 in v1 terminology), modified prompt.
- Inputs: scenes, AudienceProfile voice/pacing/CTA guidelines, format profile pacing rules and anti-patterns, selected hook (for scene 1, override behavior), Neurocore voice profile (Gap 4).
- Output: per-scene scripts with v1 fields (script text, emphasis cues, pacing notes, transition notes), unchanged.
- Cover-letter mode continues to call the v1 prompt (untouched). The format-aware prompt is gated on `plan.type === 'youtube_advanced'`.

**Priority:** P0 — Must have.

---

### 4.9 B-roll / Shot List per Scene (gap #4)

**What:** Per-scene structured shot list and B-roll suggestion, replacing v1's single `framingNotes` free-text field.

**Behavior:**
- New engine step `generate-shot-list`. Runs after scripts are written (so the LLM can reference the script when suggesting what to film).
- Per scene, output:
  - **primaryShot** (object): type (`screenshare` | `terminal` | `headshot` | `diagram_overlay` | `asset_static` | `asset_animated`), description (what's on screen).
  - **brollItems** (array): each item has type, description, source (`record_during_scene` | `pull_from_finished_demo` | `reuse_from_episode` | `generate_with_tool`), durationSeconds.
  - **onScreenTextOverlays** (array): textContent, timingHint (e.g., "first 3 seconds", "during line 4-5"), styleHint (`callout` | `quote` | `chapter_marker` | `footnote`).
  - **cutPoints** (array): line/phrase boundaries in the script where the editor should cut.
- Rendered in the scene card UI as a collapsible "Shot list" section. Each item is inline-editable (HTMX, same pattern as v1 scene cards).

**States:**
- **Generating:** Per-scene spinner during the shot list LLM call.
- **Generated:** Each scene card now has a populated shot list section.
- **Edit mode:** Per-item HTMX swap, save on blur.

**Priority:** P0 — Must have. Direct fix for gap #4. This is what moves DREK from "follow the script" to "I know exactly what to film."

---

### 4.10 Title & Thumbnail Workshop (Module 7, gap #1)

**What:** Per plan, generate 5-10 title variants and 3-5 thumbnail concepts. Rick picks one of each. They become inputs to the publishing metadata (4.12).

**Behavior:**

**Title generation:**
- Engine step `generate-title-variants`. Runs after script generation.
- Inputs: format profile, AudienceProfile, episode angle, hook archetype.
- Output: 5-10 title variants, each tagged by title archetype (`curiosity_gap`, `specificity`, `payoff_promise`, `controversy_hook`, `numbered_listicle`, `question_format`, `before_after`).
- Each variant includes: titleText (≤70 chars, YouTube cap is 100 but optimal is shorter), archetype, predictedClickability (LLM-estimated 1-10 with a one-line reasoning), keywordsSurfaced.
- Rick picks one. Selection persists. Other variants stay visible.

**Thumbnail generation:**
- Engine step `generate-thumbnail-concepts`. Runs after title selection.
- Inputs: selected title, format profile, hook archetype, primary project visuals available.
- Output: 3-5 thumbnail concepts, each described in structured form (not image — image generation is v3 deferred):
  - `composition` (e.g., "split: terminal left, headshot right")
  - `textHook` (≤4 words, large text)
  - `expression` (if headshot: emotion)
  - `colorPalette` (suggested 2-3 hex values)
  - `assets` (what visual elements need to be captured/pulled)
  - `concept` (one-sentence summary)
- Rick picks one concept. The chosen concept becomes the brief for whatever tool he uses to produce the actual thumbnail (Figma, Photoshop, AI image gen, etc.) — DREK does not produce the image file in v2.

**States:**
- **Generating titles / thumbnails:** Spinner.
- **Variants ready:** Cards displayed for selection.
- **Selection persisted:** Chosen variant highlighted.
- **Regenerate:** Button per workshop section.

**Priority:** P0 — Must have. Direct fix for gap #1, the single biggest CTR determinant.

---

### 4.11 Recording & Footage Manifest (Module 5)

**What:** A per-plan ledger of recording sessions and the footage files they produced.

**Behavior:**
- New view on plan detail: "Footage" tab.
- Per-recording-session record: dateRecorded, sessionType (`build_session` | `demo_session` | `reflection` | `b_roll` | `screen_capture`), filePath (relative to workspace root), durationSeconds, segmentsCovered (array of scene IDs).
- Manual entry only in v2 (no auto-discovery from filesystem watcher).
- Recording form: "Log a recording session" → fill fields → save. <30 seconds per entry per the channel doc requirement.
- Dashboard surface: per plan, show "X recording sessions logged, Y minutes total". For scenes that have no footage logged, show a warning indicator.

**States:**
- **No recordings:** Empty state with "Log first recording" CTA.
- **Recordings logged:** List displayed sorted by date, with segment coverage map.
- **Missing coverage:** Scenes not yet covered by any logged recording highlighted in the scene card view.

**Priority:** P0 — Must have.

---

### 4.12 Publishing Metadata (Module 8, gap #5)

**What:** Auto-generated YouTube upload-form package: description, chapters, tags, pinned comment.

**Behavior:**
- Engine step `generate-publishing-metadata`. Runs after Rick finalizes the plan.
- Inputs: selected title, episode angle, scripts, scene beat tags (used for chapter markers), AudienceProfile CTA style.
- Outputs:
  - **description** — opening hook line (uses pinned-comment-eligible phrasing), 2-3 paragraph body, CTA block (consultation link + community link + relevant affiliate links), timestamp list auto-generated from scene durations.
  - **chapters** — array of `{timestampSeconds, label}` derived from scenes tagged with chapter-eligible beats.
  - **tags** — array of 10-15 YouTube tags pulled from format profile + episode angle + tech stack.
  - **pinnedComment** — 1-2 sentence question or hot-take prompting first-comment engagement.
  - **endScreenSuggestion** — 1 sentence on what to point to next (related episode, community, lead magnet).
- All fields displayed in the "Publishing" tab on the plan detail page. Inline-editable.
- Exportable as a plain-text bundle Rick can paste into YouTube Studio in one go.

**States:**
- **Generating:** Spinner during LLM call.
- **Ready for review:** All fields populated, editable inline.
- **Exported:** Plain-text bundle generated, copy-to-clipboard button surfaces.

**Priority:** P0 — Must have. Direct fix for gap #5.

---

### 4.13 Shorts Extractor (Module 9, gap #6)

**What:** From the long-form plan, automatically suggest 3-5 Short-format clips, each a 60-90 second vertical re-cut of a moment in the long-form.

**Behavior:**
- Engine step `extract-short-candidates`. Runs after long-form script is written.
- Inputs: long-form scripts (with scene beat tags), beat-importance heuristics (Oh Shit Moment, Architecture Decision, Demo Reveal, Pricing Moment per the channel master doc), `business_owner_shorts` AudienceProfile.
- For each candidate:
  - Source scene reference
  - Suggested cut start/end (line or word range in the source script)
  - Reworked 60-90 second script (different hook, different CTA — calibrated to Shorts audience)
  - Thumbnail concept (Shorts thumbnails are different — taller aspect, simpler)
  - Title (Shorts titles are shorter and punchier than long-form)
  - Vertical reframing notes (how to crop the source footage)
- Each candidate is a separate Deliverable record bound to the same plan but with `business_owner_shorts` AudienceProfile.
- Rick reviews, approves, edits, dismisses. Approved Shorts get their own publishing metadata (4.12 runs per-deliverable).

**States:**
- **Generating:** Spinner.
- **Candidates ready:** 3-5 cards, each with approve/dismiss/edit buttons.
- **Approved:** Promoted to deliverable, status visible on plan dashboard.

**Priority:** P0 — Must have. Direct fix for gap #6. 3× output for ~0 additional planning cost.

---

### 4.14 Deliverable Bundle View

**What:** Per plan, a unified view of all deliverables (long-form + N Shorts + any future formats), their status, and per-deliverable artifacts.

**Behavior:**
- New section on plan detail: "Deliverables".
- List of deliverable cards, each showing: kind (`long_form` | `short_clip` | `lead_magnet` | future), AudienceProfile binding, status (draft / scripts-ready / metadata-ready / exported), thumbnail concept summary, title.
- Click a deliverable → opens its full edit view (scene cards or short-cut view, metadata, publishing checklist).
- Export-all button: produces a bundle ZIP (or, given Windows, a folder) with one subfolder per deliverable containing its shoot instructions + metadata text.

**Priority:** P0 — Must have. Per-deliverable model only works if there's a UI surface for it.

---

## 5. User Flows

### 5.1 Sourcing → Plan Creation

1. Rick has saved Upwork searches. Periodically pastes 3-5 candidate briefs into DREK's pipeline view.
2. For each brief, clicks "Score" — LLM returns suggested scoring against the rubric. Rick accepts or overrides.
3. Briefs scoring ≥ threshold get marked `vetted`. Rick maintains a queue depth of ≥ 3 vetted briefs.
4. When ready to plan an episode, Rick promotes a vetted brief: clicks "Promote to plan" → selects format profile from dropdown → DREK creates a `youtube_advanced` plan pre-populated with the brief text, AudienceProfile defaulted to `developer_longform`, format profile applied.

### 5.2 Long-Form Episode Planning (end-to-end)

1. From a freshly-promoted plan, Rick clicks "Detect episode requirements." LLM call runs (extends v1 §4.2). Outputs episode angle, anti-angle, technical scope, intended takeaway, risks. Rick reviews + confirms.
2. Rick clicks "Match projects" (v1 behavior). Neurocore returns ranked projects. Rick confirms selection.
3. Rick clicks "Generate scenes." LLM produces 5-12 scenes tagged by format profile beat names with target durations.
4. Rick clicks "Generate hook variants." 3-4 hooks returned. Rick picks one.
5. Rick clicks "Generate scripts." LLM writes scripts per scene, using AudienceProfile voice + selected hook + format profile pacing.
6. Rick clicks "Generate shot list." LLM produces primary shot, B-roll, on-screen text, cut points per scene.
7. Rick reviews + edits inline. Marks plan as ready for title/thumbnail.
8. Rick clicks "Generate titles." 5-10 title variants. Picks one.
9. Rick clicks "Generate thumbnails." 3-5 thumbnail concepts. Picks one.
10. Rick clicks "Generate Shorts candidates." 3-5 Short clips suggested. Reviews, approves N, edits as needed.
11. Rick clicks "Finalize plan." DREK transitions the long-form to `finalized`.
12. Rick clicks "Generate publishing metadata." LLM produces description, chapters, tags, pinned comment.
13. Rick clicks "Export deliverable bundle." DREK writes shoot instructions + metadata to the project workspace folder.
14. Rick records (multiple sessions over multiple days). For each session, logs a recording-manifest entry tied to the scenes covered.
15. Rick edits the video (outside DREK). Uploads to YouTube. Pastes publishing metadata into the upload form. Schedules the post.
16. For each approved Short candidate, Rick repeats steps 11-15 against the Short deliverable (separate scripts/thumbnails/metadata, smaller surface).

### 5.3 Recording Session Manifest Update

1. After a recording session, Rick opens the plan's "Footage" tab.
2. Clicks "Log recording session."
3. Fills: date, session type, file path (or path glob), duration, scenes covered (multi-select from the plan's scene list).
4. Saves. Coverage indicator updates on the scene cards.
5. If any scenes still show "no footage," Rick knows what to record next session.

### 5.4 Pre-Upload Publishing Checklist Review

1. Rick opens the deliverable's "Publishing" tab.
2. Reviews title, description, chapters, tags, pinned comment.
3. Edits inline as needed (HTMX auto-save).
4. Clicks "Copy upload bundle." Plain-text version goes to clipboard.
5. Switches to YouTube Studio. Pastes into the upload form. Uploads thumbnail (which Rick produced separately based on the chosen concept). Publishes.

---

## 6. Neurocore Integration Contract — v2 Deltas

### 6.1 New Neurocore Endpoints Required

| Endpoint | Purpose | New for v2? |
|----------|---------|-------------|
| `GET /v1/audience-profiles` | List all defined AudienceProfiles | New |
| `GET /v1/audience-profiles/:id` | Fetch a single AudienceProfile by ID | New |
| `POST /v1/audience-profiles` | Create a new profile (Rick-driven, via Neurocore admin UI) | New (Neurocore work, not DREK work) |
| `PATCH /v1/audience-profiles/:id` | Update an existing profile | New |
| `POST /v1/signals/script.published` | DREK reports a published deliverable (long-form or Short) with its title, hook variant, thumbnail concept, and YouTube URL | New (extends v1's `script.approved` signal pattern) |
| `GET /v1/analytics/video/:youtubeUrl` | Optional v2.1: Neurocore proxies YouTube Analytics for the published video, returns retention/CTR data DREK can ingest for the voice profile feedback loop (gap #7) | Deferred to v2.1 |

### 6.2 AudienceProfile Schema (Neurocore side)

This is the schema Neurocore must implement. DREK consumes via the existing client; this section is a contract reference.

```
AudienceProfile {
  id: string                          // ap_developer_longform, ap_business_owner_shorts
  name: string                        // "Developer / Learner — Long-form"
  description: string                 // one-paragraph who this is and why
  watchPersona: string                // 1-2 paragraph behavioral profile
  painPoints: string[]                // what they're suffering
  buyingTriggers: string[]            // what makes them act (subscribe, share, book)
  voiceGuidelines: {
    tone: string                      // "authoritative-warm"
    vocabulary: string                // "technical-but-accessible"
    sentenceLengthGuide: string       // "mix short and medium; avoid runs of long sentences"
    taboos: string[]                  // phrases/topics to never use
  }
  hookPatterns: string[]              // ["start with the failed first attempt", "ask a question whose answer is paradoxical"]
  pacingRules: {
    wordsPerMinute: number            // 150 for long-form, 175 for Shorts
    avgSentenceWords: number
    densityNote: string               // "leave 1-2 second pauses after big claims"
  }
  ctaStyle: {
    type: string                      // "subscribe_and_long_form" | "consultation_book" | "community_join" | "lead_magnet_download"
    phrasing: string                  // verbatim example CTA copy
    placement: string                 // "final 15 seconds" | "first 5 seconds and final 5 seconds"
  }
  createdAt: timestamp
  updatedAt: timestamp
}
```

### 6.3 LLM Prompt Injection of AudienceProfile

When DREK calls any LLM step that produces audience-facing copy (scripts, hook variants, titles, thumbnails, descriptions, pinned comments, Shorts cuts), the system prompt includes an `<audience_profile>` block constructed from the fetched profile. The profile is injected verbatim — DREK does not interpret or summarize it.

### 6.4 Graceful Degradation

v1's graceful degradation rules still apply. New v2 rule: if AudienceProfile is unavailable, the dependent generation step **hard-errors** instead of falling back. The whole purpose of v2 is targeted output; generating a "generic voice" script silently defeats the system. Rick will see a clear error and either retry once Neurocore is back or pick a different (still-cached) profile.

---

## 7. Data Model — v2 Deltas

### 7.1 AudienceProfile (Neurocore, see 6.2)

Lives in Neurocore. DREK fetches by ID. No DREK-local copy.

### 7.2 Plan — extended

| Field | Type | New in v2? | Description |
|-------|------|------------|-------------|
| `id` | string | — | unchanged |
| `type` | `"cover_letter"` \| `"youtube_lite"` \| `"youtube_advanced"` | extended | `youtube` renamed `youtube_lite`; `youtube_advanced` is the new v2 type |
| `status` | enum | extended (see 7.3) | More statuses to cover hook generation, shot list generation, title selection, etc. |
| `formatProfileId` | string \| null | New | Null for `cover_letter` and `youtube_lite`. Required for `youtube_advanced`. |
| `pipelineBriefId` | string \| null | New | Reference to the source `PipelineBrief` if this plan was promoted from the sourcing module |
| `workspacePath` | string \| null | New | Absolute path to the project folder on disk |
| `deliverableIds` | string[] | New | Ordered list of Deliverable record IDs |
| `selectedHookVariantId` | string \| null | New | Reference to the chosen `HookDraft` |
| `selectedTitleVariantId` | string \| null | New | Reference to the chosen `TitleConcept` |
| `selectedThumbnailConceptId` | string \| null | New | Reference to the chosen `ThumbnailConcept` |
| `publishMetadataId` | string \| null | New | Reference to the `PublishMetadata` record (lives per Deliverable; this is convenience for the long-form one) |
| `sourceListingId` | string \| null | — | unchanged |
| `requirements` | object[] | extended | For `youtube_advanced`: episodeAngle, antiAngle, technicalScope, intendedTakeaway, risksToFlag |
| `matchedProjects` | object[] | — | unchanged |
| `targetRuntimeSeconds` | number | — | unchanged |
| `userConstraints` | string \| null | — | unchanged |
| `estimatedRuntimeSeconds` | number | — | unchanged |
| `createdAt` | timestamp | — | unchanged |
| `updatedAt` | timestamp | — | unchanged |
| `exportedAt` | timestamp \| null | — | unchanged |

### 7.3 Plan Status Enum — extended

v1 statuses preserved:
`awaiting_review`, `dismissed`, `requirements_reviewed`, `projects_matched`, `scenes_generated`, `finalized`, `exported`

v2 additions (apply only to `youtube_advanced`):
`hooks_generated`, `hook_selected`, `scripts_generated` (replaces `scenes_generated` for v2 — v1 type keeps old name), `shot_list_generated`, `titles_generated`, `title_selected`, `thumbnails_generated`, `thumbnail_selected`, `shorts_extracted`, `metadata_generated`

Status transition table to be defined in tech spec. Key constraint: every transition is unidirectional except `regenerate-X` actions which revert to the prior state and re-run.

### 7.4 New entity: PipelineBrief

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Auto-generated |
| `title` | string | Brief title |
| `company` | string \| null | Sourcing company name |
| `sourceUrl` | string \| null | Original Upwork/Freelancer/etc URL |
| `rawText` | string | Pasted brief content |
| `score` | object | `{visualOutcome: 1-5, storyPotential: 1-5, scopeFit: 1-5, audienceMatch: 1-5, aggregate: number}` |
| `scoringRationale` | string | LLM's one-paragraph reasoning for the suggested scores |
| `stage` | enum | `candidate \| vetted \| selected \| in_production \| published \| retired` |
| `promotedPlanId` | string \| null | If promoted, the plan ID |
| `createdAt` | timestamp | |
| `updatedAt` | timestamp | |

### 7.5 New entity: Deliverable

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Auto-generated |
| `planId` | string | Parent plan reference |
| `kind` | enum | `long_form \| short_clip \| lead_magnet \| blog_post (deferred)` |
| `audienceProfileId` | string | Neurocore AudienceProfile reference |
| `title` | string | This deliverable's title (long-form uses Plan's selectedTitle; Shorts have their own) |
| `status` | enum | `draft \| scripts_ready \| metadata_ready \| exported \| published` |
| `scriptOverrideSceneIds` | string[] \| null | For Shorts: which scenes from the long-form this is derived from. Null for long_form. |
| `customScripts` | object[] \| null | For Shorts: reworked scripts that aren't direct cuts of the long-form |
| `selectedTitleVariantId` | string \| null | |
| `selectedThumbnailConceptId` | string \| null | |
| `publishMetadataId` | string \| null | |
| `youtubeUrl` | string \| null | Populated after publish, used by script.published signal |
| `publishedAt` | timestamp \| null | |
| `createdAt` | timestamp | |
| `updatedAt` | timestamp | |

### 7.6 Scene — extended

| Field | Type | New in v2? | Description |
|-------|------|------------|-------------|
| (v1 fields) | | | All preserved unchanged |
| `beatTag` | string \| null | New | Format-profile beat name this scene serves (e.g., `cold_open`, `war_room`) |
| `brollItems` | object[] | New | See 4.9 |
| `shotListItems` | object[] | New | See 4.9 |
| `onScreenTextOverlays` | object[] | New | See 4.9 |
| `cutPoints` | object[] | New | See 4.9 |

### 7.7 New entity: HookDraft

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | |
| `planId` | string | |
| `archetype` | enum | `pattern_interrupt \| bold_claim \| retention_question \| story_cold_open \| demo_first` |
| `scriptText` | string | 30-60 word draft of the first 10-15 seconds |
| `predictedRetention` | string | LLM-estimated 1-line rationale for why this hook should hold viewers |
| `selected` | boolean | True for the one Rick picked; false for the rest |
| `createdAt` | timestamp | |

### 7.8 New entity: TitleConcept

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | |
| `deliverableId` | string | |
| `titleText` | string | ≤70 chars |
| `archetype` | enum | `curiosity_gap \| specificity \| payoff_promise \| controversy_hook \| numbered_listicle \| question_format \| before_after` |
| `predictedClickability` | number | 1-10 LLM estimate |
| `reasoning` | string | One-line why this title might work |
| `keywordsSurfaced` | string[] | YouTube SEO keywords this title naturally surfaces |
| `selected` | boolean | |
| `createdAt` | timestamp | |

### 7.9 New entity: ThumbnailConcept

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | |
| `deliverableId` | string | |
| `composition` | string | Layout description |
| `textHook` | string | ≤4 words, large overlay text |
| `expression` | string \| null | Headshot emotion, if any |
| `colorPalette` | string[] | 2-3 hex values |
| `assetsRequired` | string[] | Source materials needed |
| `conceptSummary` | string | One-sentence description |
| `selected` | boolean | |
| `createdAt` | timestamp | |

### 7.10 New entity: PublishMetadata

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | |
| `deliverableId` | string | |
| `description` | string | Full description block including timestamps and CTAs |
| `chapters` | object[] | `[{timestampSeconds, label}]` |
| `tags` | string[] | 10-15 YouTube tags |
| `pinnedComment` | string | 1-2 sentence engagement prompt |
| `endScreenSuggestion` | string | What to point to next |
| `generatedAt` | timestamp | |
| `lastEditedAt` | timestamp \| null | |

### 7.11 New entity: RecordingSession

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | |
| `planId` | string | |
| `dateRecorded` | timestamp | |
| `sessionType` | enum | `build_session \| demo_session \| reflection \| b_roll \| screen_capture` |
| `filePath` | string | Absolute path or glob |
| `durationSeconds` | number | |
| `scenesCovered` | string[] | Scene IDs this footage feeds |
| `notes` | string \| null | Free-text — what went wrong, what to redo |
| `createdAt` | timestamp | |

---

## 8. Composition Rules — Format Profile Registry

Format profiles ship as TypeScript constants. The registry lives at `src/engine/format-profiles/`. The `claude_code_build_along` profile (Rick's default) is sketched here as the reference template. Other profiles follow the same shape.

### 8.1 `claude_code_build_along` Format Profile (reference)

```
NAME: claude_code_build_along
DISPLAY: Claude Code Build-Along
DESCRIPTION: Faceless, screen-recorded build of a real client brief using Claude Code. Conversation-angle: the dialogue with Claude IS the show. Pulls structure from "The Gauntlet" alternative in the channel master document.

SCENE_RANGE: 5-7 scenes (one per beat)
RUNTIME_RANGE: 1500-2100 seconds (25-35 minutes)

STRUCTURE (named beats — each scene tags itself with one):
1. cold_open (30s): flash the finished demo, no context, cut to black + title
2. problem (4-5min): read the brief, pull out the real problem
3. war_room (8min): brainstorm + architecture in one fast segment, diagram building live
4. build_reel (10min): fast-cut Claude Code session, narration over the interesting moments
5. breakdown (4min): walk through finished system AFTER the build
6. demo (4min): clean live run, no cuts
7. outro (1min): honest reflection + pricing moment + CTA

HOOK GUIDELINES:
- Cold open must be FROM the finished product, not a setup line.
- Prefer demo_first or pattern_interrupt archetypes. Avoid bold_claim — comes across as marketing.
- The first 5 words must land.

SHOT CONVENTIONS:
- Primary shot is always screenshare (terminal, Claude Code, or browser).
- Headshot only used in outro (reflection segment).
- Diagram overlays are first-class — every architecture decision gets a visualized callout.
- Cut points: every 8-15 seconds during build_reel.

PACING:
- 150 wpm baseline.
- Build_reel allows faster cuts; war_room allows slower deliberation.
- No filler ("um", "uh", "basically", "essentially"). Filler-word linter would help here (deferred to v3).

ANTI-PATTERNS:
- Opening with "Hey guys, today we're going to..."
- Showing the brief without first showing the result that came from it
- Architecture diagram never finishes drawing on screen — viewer needs to see the completed shape
- Narrating what Claude is doing while it does it — narrate intent and outcome, let the action play
- Outro that doesn't land a pricing moment

CTA POLICY: Outro CTA is consultation booking + community join. Long-form-CTA optimization is the priority per Nami's funnel math (3.3× revenue per video vs Shorts).
```

### 8.2 Other Format Profiles (sketches — full text in code)

- `tutorial`: How-to format. Structure: setup → step-by-step → result → variations. Pacing 175 wpm. Strict on "show then explain" order.
- `case_study`: Results-led. Structure: outcome → problem → approach → result-revisited. Heavy on numbers/screenshots.
- `comparison`: X vs Y. Structure: criteria → contender A → contender B → verdict. Symmetrical scene budget.
- `essay_opinion`: Single argument. Structure: thesis → evidence → counterargument → conclusion. Tone allows more personality.
- `listicle`: N things. Strict per-item structure. Pacing fast (200 wpm). Short scenes (60s each).
- `reaction_review`: Commentary on external content. Used rarely. Requires clip licensing care.

### 8.3 AudienceProfile Composition with Format Profile

The AudienceProfile (Neurocore-side) and the FormatProfile (DREK-side) compose in the LLM prompt:

- Format profile defines **structure** (beats, scene count, runtime ranges, hook guidelines, shot conventions, antipatterns)
- AudienceProfile defines **voice** (tone, vocabulary, pacing wpm, CTA style, hookPatterns specific to the audience)
- Both are injected into the system prompt verbatim, with format profile first (structure), then audience profile (voice).

---

## 9. Non-Functional Requirements

Inherits v1 §9 entirely. New v2-specific additions:

### 9.1 Performance

| Metric | Target |
|--------|--------|
| Hook variant generation | <30 seconds for 3-4 variants |
| Title variant generation | <30 seconds for 5-10 variants |
| Thumbnail concept generation | <20 seconds for 3-5 concepts |
| Shot list generation (per plan, all scenes) | <60 seconds |
| Shorts extraction (3-5 candidates) | <90 seconds |
| Publishing metadata generation | <30 seconds |

### 9.2 Reliability

- All v2 engine steps are independently retriable (same pattern as v1).
- Failure of any single step leaves the plan at the prior status — no partial-write corruption.
- Pipeline brief scoring failure does not block manual scoring.

### 9.3 Security

Inherits v1. New: workspace folder paths are validated against a configured `workspaceRoot` allowlist before any filesystem operation — no path traversal.

### 9.4 UI/UX

Inherits v1 (system fonts, monochrome + accent, HTMX-driven, desktop Chrome only). New v2-specific:

- Deliverable cards use a distinct visual tag per kind (long_form, short_clip) so the dashboard scan-reads cleanly.
- Title and thumbnail workshop UI uses card-grid layout for selection rather than radio list (more visual choice).
- Hook variant selection UI shows the archetype label prominently — Rick should be picking by archetype as much as by content.

---

## 10. Technical Constraints

Inherits v1 §10 entirely. No new constraints. Specifically:
- TypeScript 5.x, Node 20, Hono 4.x, Firestore, NSSM
- HTMX for interactivity
- LLM provider abstraction (Claude CLI + Codex CLI), now with the new model selection capability shipped post-v1
- No image generation in v2 (thumbnail concepts are text-only); deferred to v3
- No filesystem watcher (manual recording-session entry in v2)
- No YouTube API integration in v2 (analytics deferred to v2.1, upload deferred indefinitely)

---

## 11. Scope Boundaries

### 11.1 In Scope (v2)

From the 14-module list in the channel master document, sections 16.1-16.14:

| # | Module | v2 Scope |
|---|--------|----------|
| 1 | Pipeline & Sourcing | In — light version (paste, score, queue, promote) |
| 2 | Project Workspace | In — folder + state machine + dashboard |
| 3 | Brief & PRD Generator | In — extends v1 §4.2 for episode requirements |
| 4 | Episode Outline & Segment Template | In — extends v1 §4.6 with format-profile beats |
| 5 | Recording & Footage Manifest | In |
| 6 | Script & Voiceover Helper | In — extends v1 §4.5 with format + audience awareness |
| 7 | Thumbnail & Title Workshop | In |
| 8 | Publishing Checklist & Metadata | In |
| 9 | Shorts Extractor | In |
| 10 | Lead & CRM Layer | **Out — v2.1 or later** |
| 11 | Analytics & Feedback Loop | **Out — v2.1 (requires YouTube Analytics API integration)** |
| 12 | Community & Paid Content Bridge | **Out — v3 (depends on Skool launch)** |
| 13 | Contract & Legal | **Out — v3 (depends on case-study client pipeline)** |
| 14 | Time & Cost Tracker | **Out — v3** |

Plus from the 8 gaps in the DREK critique:

| Gap | v2 Scope |
|-----|----------|
| 1: Titles and thumbnails | In (§4.10) |
| 2: Hook engineering | In (§4.7) |
| 3: Video format diversity | In (§4.2, format profile registry) |
| 4: Shot list / B-roll | In (§4.9) |
| 5: Chapters + description + tags + pinned comment | In (§4.12) |
| 6: Shorts/Reels extraction | In (§4.13) |
| 7: Performance feedback loop | **Partial — script.published signal ships (6.1), but YouTube Analytics ingestion deferred to v2.1** |
| 8: External research | **Out — v2.1 (Exa.ai or similar provider abstraction needed)** |

### 11.2 Out of Scope (v2)

- Image generation (thumbnails ship as text concepts; v3 may add AI image gen integration)
- YouTube API integration (no upload automation, no analytics ingestion)
- Filesystem watcher for auto-discovering footage files (manual entry only)
- Lead/CRM layer (Module 10)
- Skool/community integration (Module 12)
- Contract & legal templates (Module 13)
- Time & cost tracker (Module 14)
- Teleprompter mode
- Filler-word linter
- Editor handoff doc with rough EDL
- External research (Exa.ai-style competitor scan)
- Multi-user, auth, mobile, responsive design — same v1 boundaries

### 11.3 Deferred (v2.1, v3, v4+)

- **v2.1:** YouTube Analytics ingestion (gap #7 full closure), Lead/CRM layer (Module 10), External research (gap #8)
- **v3:** Thumbnail image generation, Community/paid content bridge (Module 12), Contract templates (Module 13), Time tracker (Module 14), Teleprompter mode, Filler-word linter, Editor handoff EDL
- **v4+:** YouTube API upload automation, multi-channel support, multi-user

---

## 12. Assumptions and Risks

### 12.1 Assumptions

| Assumption | Impact if wrong | Fallback |
|------------|----------------|----------|
| AudienceProfile injected verbatim into prompts produces noticeably-targeted output | Scripts will read generic and AudienceProfile won't justify its complexity | Iterate on profile content with Rick after first 3 episodes. Add a prompt-quality eval suite. |
| Rick maintains a vetted pipeline of ≥3 briefs before promoting to plan | Pipeline starves and DREK becomes a per-brief tool rather than a channel-operating tool | Pipeline queue depth warning on dashboard. Optional v2.1: PI cross-pollination into pipeline. |
| Title/thumbnail LLM-generated concepts are useful starting points (not necessarily ship-ready) | Rick rewrites every title/thumbnail manually, defeating the workshop | Track selection rate (success metric). If <60%, redesign prompts and consider few-shot examples from high-CTR YouTube data. |
| Shorts derivation finds the right moments (Oh Shit, Demo Reveal, Pricing) | Generated Shorts feel arbitrary or miss the strongest beats | Beat-importance heuristic is configurable. If quality is low after 5 plans, add a manual "mark this moment" feature in the scene card UI. |
| Format profiles cover ~80% of Rick's actual video types | Rick keeps wanting a format the registry doesn't have | Adding a new format profile is a TypeScript file. Low cost to extend. |
| Nami's funnel math holds approximately in year 1 (~$5k/long-form, ~$1.5k/Short) | Revenue projections are wrong; channel-as-business case shifts | The architecture doesn't depend on the numbers — only the prioritization does. Re-prioritize toward whichever artifact actually converts. |

### 12.2 Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Workspace folder paths are platform-fragile (Windows path handling, OneDrive sync interference, antivirus locks) | Medium | Medium | Validate `workspaceRoot` on startup. Surface clear errors. Allow override per-plan. |
| AudienceProfile is implemented in Neurocore on a schedule independent of DREK v2 | High | High | Block v2 launch on AudienceProfile API availability. Write a stub Neurocore contract test. Spec the Neurocore work as a gap doc parallel to v1's. |
| Format profile composition produces mode-blended output (e.g., tutorial pacing leaks into build-along) | Medium | Medium | Anti-pattern lists in each profile are aggressive. Add eval cases per profile that test for blending. |
| The 9-module v2 scope is too large to ship in 90 days | Medium | High | Strict P0/P1 split (§14). P0 ships first; P1 modules (Recording Manifest, Publishing Metadata, Shorts Extractor) can slip to v2.1 without breaking the core planning workflow. |
| Shorts CTAs require behavioral data DREK doesn't yet have | Low | Low | Ship Shorts CTAs based on AudienceProfile guidance only in v2; revisit after first 5 published Shorts with real data. |
| Title/thumbnail predicted-clickability estimates are LLM hallucination | Medium | Low | Display them as advisory only. Don't auto-select based on them. v2.1 analytics ingestion provides ground truth. |

---

## 13. Dependencies

| Dependency | Type | Status | Blocks |
|------------|------|--------|--------|
| Neurocore AudienceProfile entity + endpoints | Neurocore change | Not started | All v2 generation steps |
| Neurocore `script.published` signal handler | Neurocore change | Not started | v2.1 feedback loop |
| DREK v1 shipped and stable | Prerequisite | Done (M0-M13 + post-M13 LLM settings + pipeline route) | v2 build |
| Workspace root configured on Rick's Windows host | Operational | Pending Rick | Module 2, Module 5, exports |
| YouTube Analytics API access (v2.1) | External | Not started | Gap #7 full closure |
| External research provider (Exa.ai or similar) | External | Not started | Gap #8, v2.1 |
| All v1 Neurocore gaps (1-5) | Inherited | Done in Neurocore main | All planning quality |

---

## 14. Prioritization Summary

### P0 — Must Have (v2 launch blockers)

- AudienceProfile system (4.1) — Neurocore-side blocking
- Format profile registry (4.2)
- Pipeline & Sourcing — light version (4.3)
- Project Workspace folder + state (4.4)
- Brief & Episode Planner (4.5)
- Episode Outline with format-profile beats (4.6)
- Hook Engineering with variants (4.7)
- Script Writing with format + audience awareness (4.8)
- B-roll / Shot List per scene (4.9)
- Title & Thumbnail Workshop (4.10)
- Publishing Metadata (4.12)
- Shorts Extractor (4.13)
- Deliverable Bundle View (4.14)
- Plan status enum extension (7.3)
- Deliverable entity (7.5)
- All new entities (7.4, 7.7-7.11)

### P1 — Should Have (high value, not launch blockers)

- Recording & Footage Manifest (4.11) — can ship in v2.0.1 if scope pressure; Rick can track footage in a spreadsheet for the first 1-2 episodes
- `script.published` signal emission (6.1) — needed before v2.1 analytics work but not strictly needed for v2 to be useful
- LLM-suggested pipeline brief scoring (4.3) — Rick can score manually if the LLM step slips

### P2 — Could Have (v2.1+)

- YouTube Analytics ingestion (gap #7 closure)
- Lead/CRM layer (Module 10)
- External research integration (gap #8)
- Filler-word linter
- Asset bundle export

---

## 15. Milestone Breakdown (90-day plan)

Numbered continuing from v1's M0-M13. Each milestone is a deployable unit with passing tests.

| Milestone | Scope | Duration | Status gate |
|-----------|-------|----------|-------------|
| M14 | AudienceProfile entity + endpoints (Neurocore side); DREK client extension to fetch profiles; format profile registry skeleton with `claude_code_build_along` only | Week 1-2 | Neurocore unit + DREK integration tests pass; profile fetch verified |
| M15 | Deliverable entity + Plan refactor (`youtube_advanced` type, status enum extension); Plan-detail UI shows "Deliverables" section (empty for now) | Week 2-3 | All v1 tests still pass; new schema migration covered |
| M16 | Pipeline & Sourcing module (PipelineBrief entity, /pipeline view, scoring LLM step, promote-to-plan flow) | Week 3-4 | Rick can paste a brief, get a score, promote it to a plan |
| M17 | Brief & Episode Planner (Module 3 extension for `youtube_advanced`); Episode Outline with beat tags (Module 4 extension) | Week 4-5 | Rick can generate a plan with format-tagged scenes |
| M18 | Hook Engineering (variants step, selection UI); Script Writing with format + audience awareness (existing engine call modified) | Week 5-6 | Rick can pick a hook and generate scripts that respect format + audience |
| M19 | B-roll / Shot List per scene (engine step, scene card UI extension) | Week 6-7 | Every scene has shot list rendered + inline-editable |
| M20 | Title & Thumbnail Workshop (engine steps, workshop UI) | Week 7-8 | Rick can pick title and thumbnail concept; both persist |
| M21 | Project Workspace folder integration (folder creation, open-folder route, workspace path validation); Recording & Footage Manifest (entity, log form, coverage indicator) | Week 8-9 | New plans create folders on disk; Rick can log footage and see coverage |
| M22 | Publishing Metadata generation (engine step, Publishing tab UI, copy-to-clipboard export) | Week 9-10 | Rick can generate and export a full publishing bundle |
| M23 | Shorts Extractor (engine step, candidate review UI, deliverable creation flow) | Week 10-11 | Per plan, 3-5 Shorts candidates generated; approval creates Deliverables |
| M24 | End-to-end integration tests covering long-form + Shorts + publishing; `script.published` signal emission; documentation update; v2 release tag | Week 11-12 | Full happy-path integration test passes; README + CHANGELOG updated; tagged release |

**Soft launch trigger:** M24 passing. Rick uses v2 to plan episode 1 off-camera. If episode 1 ships smoothly through DREK, v2 is production-validated. If gaps surface during episode 1, those become v2.0.1 hotfixes before episode 2 is planned.

---

## 16. Glossary — v2 additions

| Term | Definition |
|------|-----------|
| **AudienceProfile** | Neurocore entity describing who a script is written for. Includes voice, pacing, hooks, CTAs. Bound per deliverable in DREK. |
| **Format Profile** | DREK-local TypeScript constant describing the structural rules for a video format (build-along, tutorial, case study, etc.). Selected per plan. |
| **Deliverable** | A single shippable artifact derived from a plan (one long-form, or one of N Shorts, or future formats). Each binds to its own AudienceProfile. |
| **Beat tag** | Format-profile-defined name for a scene's role in the structure (e.g., `cold_open`, `war_room`, `outro`). |
| **Hook variant** | One of 3-4 LLM-generated drafts of the first 10-15 seconds of a video, tagged by archetype. |
| **Title concept** | One of 5-10 LLM-generated title candidates, tagged by archetype and with predicted clickability. |
| **Thumbnail concept** | Text-only structured description of a thumbnail (composition, hook text, palette, assets) used as a brief for whatever tool actually produces the image. |
| **Shorts candidate** | A 60-90 second clip suggestion derived from the long-form plan, with its own script, hook, title, and thumbnail concept. Becomes a Deliverable when approved. |
| **Pipeline brief** | A candidate video brief sourced from Upwork/Freelancer/manual paste, scored against the rubric, queued for promotion to a plan. |
| **Workspace path** | Per-plan folder on disk where briefs, scripts, shot lists, recordings, assets, and exports live. |
| **Recording session** | One contiguous recording event logged manually by Rick after he records. Carries file path, duration, and the scenes it covers. |
| **Publishing metadata** | The full YouTube upload-form bundle: title, description, chapters, tags, pinned comment. Generated per deliverable. |
| **`claude_code_build_along`** | The default format profile for Rick's primary channel. Implements "The Gauntlet" structure from the channel master document. |
| **`developer_longform`** | The AudienceProfile shipped at v2 launch for the long-form developer/learner audience. |
| **`business_owner_shorts`** | The AudienceProfile shipped at v2 launch for the Shorts business-owner audience. |
| **`script.published`** | New Neurocore signal DREK emits when a deliverable is published, carrying the YouTube URL and metadata for downstream feedback-loop ingestion. |

---

## 17. Open Questions for Tech Spec

These are explicitly left for the tech spec (not the PRD) to resolve:

- Exact LLM prompt format for AudienceProfile + FormatProfile composition
- Caching strategy for AudienceProfile fetches across a plan-edit session
- Workspace folder path validation regex + Windows-specific gotchas (long paths, OneDrive sync)
- Status transition table for the extended plan status enum
- HTMX swap patterns for the new card-grid selection UIs (hook, title, thumbnail)
- Database migration path for renaming `youtube` → `youtube_lite`
- Test fixture strategy for AudienceProfile (mock Neurocore vs real fetch in integration tests)
- Beat-importance heuristic implementation for Shorts extraction (LLM judgment vs scoring rubric vs hybrid)

---

*Traced from: 2026-05-18 discovery room decisions (L-1 through L-7), DREK gap analysis doc (8 gaps), YouTube Channel Master Document (16 sections + 14-module proposal), Nami's funnel math, Misa's developer-first content strategy. Extends `PRD-drek-2026-05-15.md`. All v1 requirements and decisions remain in force except where explicitly extended here.*
