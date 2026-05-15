# Discovery Brief — DREK: AI Video Director

**Date:** 2026-05-14 (revised)
**Participants:** Rick (product owner), Lisa (discovery lead), Tony Stark (engineering), Light (PM), Misa (content strategy)
**Status:** Draft — revised
**Confidence:** High. All critical sections settled. Tech stack locked.

---

## 1. Problem Space

- **The problem:** Rick regularly needs to create two types of videos: (1) Loom cover letter videos demonstrating specific technical capabilities to hiring managers, and (2) YouTube videos targeting potential clients who want AI systems and automations built for them. Both require significant pre-production work — choosing which projects to feature, which features to highlight, scripting the full video, and planning shot composition. This mental load is currently unassisted, slowing down video production and reducing quality.

- **Who experiences it:** Rick — solo AI automation consultant who needs videos as proof-of-work for job applications and as a client acquisition channel.

- **Current workarounds:** Rick manually reviews job listing requirements, mentally maps them to his projects, plans shots ad-hoc, writes scripts from scratch, and records without a structured plan. For YouTube, the process is similar — topic selection, audience framing, scripting, and recording are all manual with no tooling support.

- **Why now:** (1) Prospect Intelligence is generating a growing volume of job listings, many requiring video demonstrations. Manual planning doesn't scale. (2) Rick is launching a YouTube channel targeting potential clients who want AI systems built — a repeatable content pipeline needs both a planning and scripting layer. (3) Neurocore's projects layer (just shipped) provides the underlying project knowledge that makes intelligent video planning and script generation feasible for the first time.

- **Evidence quality:** Settled

---

## 2. Users and Context

### Primary User
- **Who they are:** Rick — solo AI automation consultant. Builds agentic systems, RAG, internal tools. Creates videos to demonstrate capabilities to potential clients (cover letters) and to attract clients who want AI systems built (YouTube).
- **Context of use:** Rick has just ingested a job listing in PI that requires a video demonstration, OR Rick is planning a YouTube video on a specific AI automation topic. He needs to quickly plan what to show, how, and in what order — then get a full script he can follow while recording.
- **What success looks like:** Video planning and scripting takes minutes instead of hours. Plans are specific enough and scripts polished enough that Rick can open Loom, follow the script, and record in one or two takes. The AI selects the right projects and features to highlight based on the requirement and writes in Rick's spoken voice.
- **What makes them leave:** Plans that are generic or useless, requiring Rick to redo the planning manually. Scripts that sound robotic or don't match Rick's voice. Slow or unreliable responses. System that doesn't understand his actual projects or their demo-ready features.

### YouTube Audience Model
- **Primary audience:** Potential clients — business owners, founders, ops leads who want AI systems and automations built for their businesses. They watch Rick's videos to evaluate whether he can build what they need. Content should lead with business outcomes, cost savings, and operational improvements.
- **Secondary audience:** Practitioners and aspiring builders who naturally congregate around technical AI content. They'll watch for learning and inspiration. DREK should not optimize for this audience, but content should remain technically credible enough to not repel them.
- **Default orientation:** Client-buyer perspective unless Rick explicitly overrides per-video. DREK should frame project showcases as "here's what this does for a business" not "here's how I built this."

### Anti-Users
- **Who this is NOT for:** Video editors, general content creators, teams.
- **Why excluding them matters:** DREK is optimized for a single user's project portfolio and workflow. Multi-user features would add complexity without value.

- **Evidence quality:** Settled

---

## 3. Proposed Solution Shape

- **Product type:** Web application (server-rendered UI + API) running as a standalone service.
- **Core interaction model:** Planning and scripting tool. Rick inputs requirements (auto-detected from PI listings via Neurocore signals, or manual topic entry). DREK outputs structured video plans as scene cards with shot descriptions AND full scripts in Rick's spoken voice.
- **Key differentiator:** Deep integration with Neurocore's project knowledge graph and voice profile. DREK doesn't just plan generic videos — it knows Rick's actual projects, their features, tech stacks, and demo-readiness, matches requirements to the right project demonstrations, and writes scripts that sound like Rick talking.
- **Delivery model:** Self-hosted on Rick's VPS alongside Neurocore and PI. Localhost API access.
- **Evidence quality:** Settled

---

## 4. Prior Art and Competitive Landscape

*Not explored in the discovery conversation. Competitive analysis below added by Lisa — not from discovery conversation.*

### Direct Competitors

None identified. No existing tool combines project portfolio knowledge with AI-powered video pre-production planning and script writing for technical demonstrations.

### Adjacent / Indirect Solutions

| Product | Strengths | Weaknesses | Relevance |
|---------|-----------|------------|-----------|
| Loom AI | Built into Loom; auto-chapters, summaries | Post-recording only — no pre-production planning | Complementary, not competing |
| Descript | AI storyboarding + video editing | General-purpose; no project knowledge integration | Different scope — DREK is pre-production only |
| Storyboarder (Wonder Unit) | Open-source storyboard tool | No AI, no project knowledge, designed for film | Wrong domain — film storyboarding vs screen recording |

### Key Takeaways
- No tool exists that combines project portfolio knowledge with video planning + scripting for technical demonstrations
- The value is in the Neurocore integration, not in generic video planning features
- Existing tools solve editing/post-production; DREK solves pre-production (planning + scripting)

- **Evidence quality:** Leaning — competitive comparison from agent knowledge, not independent research

---

## 5. Technical Feasibility

- **Platform/architecture direction:** Standalone TypeScript service. DREK is a consumer of two upstream services:
  - **Neurocore** — project knowledge, Rick's profile/voice (written + spoken), signal hub for PI listing notifications
  - **PI (via Neurocore signals)** — job listing data as input triggers. PI signals Neurocore when new listings are ingested; DREK subscribes to relevant Neurocore signals. No direct PI↔DREK coupling.

- **Key technical constraints:**
  - **Neurocore dependency:** DREK cannot function at full capability without Neurocore's project data. Five gaps must be resolved in Neurocore first (see `GAP-SPEC-drek-prerequisites.md` in the Neurocore repo): (1) DREK-specific task types in injection profiles (~30 min), (2) project-status temporal cron (~2-4 hours), (3) narrative/demo-readiness metadata in crawl schema (~1-2 hours), (4) spoken-voice profile for script generation (~2-3 hours), (5) PI signal consumption endpoint for listing-triggered mode (~1-2 hours).
  - **LLM for planning and scripting:** Provider abstraction with two implementations — Claude CLI and Codex CLI. Config flag selects the active provider. Both invoked via `child_process.spawn`. This lets Rick shift providers when necessary.
  - **Text-only for v1:** No image generation, video rendering, or screen capture. Output is text-based scene cards, scripts, and shoot instructions. Architecture should accommodate future image generation (storyboard visuals) without requiring a rewrite.

- **Known hard problems:**
  - **Requirement-to-project matching quality:** The LLM must correctly interpret job listing requirements (e.g., "show automation work relating to lead pipelines") and match them to the right projects in Neurocore's registry. Quality depends on how well Neurocore's project data captures demonstrable features.
  - **Two-mode planning divergence:** Cover letter and YouTube videos have fundamentally different composition rules, pacing, tone, and success criteria. The planning engine must cleanly separate these modes without blending them into a bland middle ground.
  - **Script voice fidelity:** Scripts must sound like Rick talking, not like AI-generated copy. This depends on Neurocore's spoken-voice profile quality (Gap 4 in the Neurocore gap spec).

- **Technology preferences or constraints:**
  - Language: TypeScript 5.x
  - Runtime: Node.js 20.x LTS
  - Framework: Hono 4.x
  - Database: Firestore (own Firebase project, separate from Neurocore — following the app-isolation pattern)
  - LLM: Provider abstraction — `ClaudeCLIProvider` + `CodexCLIProvider`, selected via config flag
  - Deployment: pm2 + nginx on Rick's VPS, co-located with Neurocore and PI
  - Build tool: Claude Code (not Barker)

- **Evidence quality:** Settled

### Tech Stack Options

Rick asked for options rather than defaulting to Neurocore's stack. Three options presented:

| Option | Framework | Strengths | Weaknesses | Best When |
|--------|-----------|-----------|------------|-----------|
| A | **Hono 4.x** (Node.js) | Shared deployment/CI with Neurocore, lightweight, fast, Rick already knows it | Minimal UI primitives — scene card interactivity requires custom JS | UI is forms and lists, minimal drag/drop |
| B | **FastAPI** (Python) | Strong ML/AI ecosystem if DREK later adds image gen, clean async | Adds Python to Rick's deployment stack, context-switch from TS, Neurocore client needs porting | Future image generation is a priority, or DREK needs heavy ML processing |
| C | **Next.js 15** (React) | Rich interactive UI out of the box, server components for planning, React ecosystem for scene card editor | Heavier runtime, more complex deployment, overkill if scene cards are simple | Scene card UI needs drag-to-reorder, inline edit, visual timeline, rich interactivity |

**Blocking question:** How interactive does the scene card UI need to be? If it's forms + lists + read-only cards, Hono is the right pick. If Rick wants drag-to-reorder, inline editing, visual timeline preview — Next.js makes more sense. FastAPI only makes sense if future image generation becomes a near-term priority.

---

## 6. Scope and Boundaries

### In Scope (v1)

- **Listing ingestion via Neurocore signals** — receive notifications when PI ingests job listings with video requirements (via polling endpoint, v1)
- **Video requirement detection** — analyze listing requirements to identify what needs to be filmed
- **Project matching** — query Neurocore to identify which projects and features to showcase for a given requirement
- **Two planning modes:**
  - **Cover letter mode** — evaluative audience (hiring managers/recruiters), <2 minute target, trust-and-credibility focus, clean demonstration of exact skills requested, no personality flourishes
  - **YouTube mode** — primary audience: potential clients wanting AI systems built, 8-15 minute target, business-outcomes-first framing, storytelling structure (problem → cost/pain → solution → result), Rick's personality and spoken voice carry the delivery. Secondary audience (practitioners) naturally served by technical credibility.
- **Full script writing** — DREK generates complete spoken-word scripts per scene in Rick's voice, not just outlines or bullet points. Scripts include spoken transitions, emphasis cues, and pacing notes.
- **Scene card generation** — structured shot-by-shot plan with description, framing notes (e.g., "medium shot, screenshare, terminal visible"), and complete script per scene
- **Target runtime input** — first-class field on every plan. Rick specifies exact target runtime per video (not just mode defaults). DREK calibrates scene count and script density accordingly.
- **User constraints** — Rick provides per-plan constraints (headless only, screenshare only, specific project focus, audience override, etc.)
- **Exportable shoot instructions** — document output that Rick references while recording on Loom
- **Scene cards UI** — web interface for reviewing, reordering, and editing scene cards and scripts
- **Manual topic input** — for YouTube videos not triggered by job listings
- **LLM provider abstraction** — interface pattern with `ClaudeCLIProvider` and `CodexCLIProvider` implementations, config flag selects active provider

### Explicitly Out of Scope (v1)

- **Image/storyboard generation** — text descriptions only; no AI image generation for v1
- **Loom API integration** — DREK is a planning/scripting tool; no integration with recording platforms
- **Video editing/post-production** — DREK is pre-production only
- **Multi-user support** — single user (Rick)
- **Direct PI↔DREK coupling** — all PI data flows through Neurocore as signal hub
- **Voice/audio synthesis** — no TTS; scripts are text for Rick to read aloud
- **Marketing site or brand assets** — internal tool, no public presence
- **Webhook-based signal consumption** — v1 uses polling; webhook deferred to v2

### Deferred (v2+)

- **AI-generated storyboard images** — visual previews of planned shots using image generation. Architecture should accommodate this without rewrite: scene cards should have an optional `storyboardImageUrl` field from v1, populated as null.
- **Webhook signal consumption** — Neurocore pushes to DREK when a video-requiring listing is ingested, replacing polling
- **Loom integration** — auto-create Loom projects with scene descriptions and scripts pre-loaded
- **Template library** — reusable planning templates for common video types (e.g., "3-minute app walkthrough", "10-minute build tutorial")
- **Performance analytics** — track which planned videos were actually recorded, correlate with viewer engagement metrics
- **Additional video types** — future video categories beyond cover letter and YouTube may require image generation for storyboarding

- **Evidence quality:** Settled

---

## 7. Constraints and Risks

### Hard Constraints

- **Neurocore gap work must complete first** — Five gaps, ~1 day of Neurocore-side work. Detailed in `GAP-SPEC-drek-prerequisites.md` (Neurocore repo).
- **Single user only** — no multi-tenant architecture
- **Build tool: Claude Code** — no Barker orchestration, iterative file modification
- **Instructional clarity over artistic expression** — all DREK-planned videos serve instructional or showcase purposes. Artistic range is secondary. This constrains the planning engine's composition rules.
- **Client-buyer default for YouTube** — YouTube mode defaults to framing content for potential clients wanting AI systems built. Practitioner framing is an explicit override, not the default.

### Key Risks

| Risk | Likelihood | Impact | Mitigation Discussed |
|------|-----------|--------|---------------------|
| Neurocore project data too shallow for quality project matching | Medium | High | Five-gap enrichment plan (task types, temporal cron, narrative metadata, spoken voice, PI signals). Minimum data per project: name, category tags, demonstrable features with interface type and demo-readiness, tech stack, status. |
| Requirement-to-project matching produces irrelevant suggestions | Medium | Medium | Rick reviews all plans before recording. LLM has full project feature data via Neurocore. Quality improves as Neurocore's project registry grows. |
| Two planning modes blend into generic middle-ground output | Low | High | Misa defined distinct composition rules, success criteria, and audience psychology per mode. Implemented as separate planning profiles, not parameterized variants of one template. |
| Scripts don't sound like Rick talking | Medium | High | Depends on spoken-voice profile quality (Neurocore Gap 4). Mitigated by Option A (manual seed from Rick's own spoken transcripts). Rick edits early scripts to calibrate. |
| DREK depends on Neurocore uptime for listing-triggered planning | Medium | Medium | Same VPS, localhost calls — network failure unlikely. If Neurocore is unreachable, DREK can still do manual-input planning but cannot auto-detect listing requirements. |
| Image generation deferred too long, architecture doesn't accommodate it | Low | Medium | v1 scene card schema includes nullable `storyboardImageUrl` field. Provider abstraction pattern extensible to image gen providers. |

### Open Questions

| # | Question | Owner | Depends on | Status |
|---|----------|-------|-----------|--------|
| OQ-1 | Optimal YouTube video length for Rick's audience | Rick | Post-launch audience data | Resolved — Default 8-15 minutes per Misa's recommendation; adjustable per plan. Rick refines after publishing first videos. |
| OQ-2 | Will DREK ever generate editing instructions (cuts, transitions, B-roll callouts)? | Rick | Post-v1 usage patterns | Resolved — Explicitly out of scope for v1. Deferred to v2+. |
| OQ-3 | How interactive is the scene card UI? (determines framework choice) | Rick | — | Resolved — Light assessed that interactive richness has low ROI for DREK (3-5 cover letter scenes, 8-12 YouTube scenes; move-up/down + inline textarea covers all needs). Hono 4.x selected. Rick asked for this assessment and did not override. |
| OQ-4 | Spoken-voice profile source material approach | Rick | — | **Open** — Option A: Rick provides spoken transcript samples (higher fidelity). Option B: Derive from written voice profile (lower effort). See Neurocore Gap 4. |

---

## 8. Key Decisions Log

| Decision | Rationale | Made By | Date |
|----------|-----------|---------|------|
| D-1: Two distinct planning modes (cover letter vs YouTube) | Fundamentally different audiences, pacing, tone, and success criteria. Cover letter = evaluative, <2min, credibility. YouTube = client-acquisition, 8-15min, business outcomes. Blending them would produce mediocre output for both. | Rick (confirmed Misa's framing) | 2026-05-14 |
| D-2: Neurocore owns all project knowledge, DREK queries it | Clean separation of concerns — Neurocore is the information layer, DREK is the planning + scripting layer. Avoids duplicating project data across apps. | Rick | 2026-05-14 |
| D-3: PI→Neurocore→DREK signal routing (hub-and-spoke) | PI already signals Neurocore via its signals route. DREK subscribes to Neurocore signals rather than coupling directly to PI. Neurocore is the hub; PI and DREK are spokes. | Tony (proposed), team consensus | 2026-05-14 |
| D-4: Text-only scene planning for v1, architecture accommodates future image gen | Rick: "for now I only need text descriptions" but "in the near future, I might add other types of videos... those future videos may require image generation. At the very least storyboards for the planning phase." v1 is text-only; schema includes nullable storyboard fields. | Rick | 2026-05-14 |
| D-5: Single user (Rick only) | Internal tool for Rick's personal video production workflow. No multi-user requirements. | Rick | 2026-05-14 |
| D-6: Framework — Hono 4.x | Rick requested options. Three presented (Hono, FastAPI, Next.js). Light assessed DREK's scene card volume and interaction patterns don't justify Next.js complexity. Hono + HTMX covers all realistic interactions. FastAPI only wins if local image gen becomes v1 scope (it's not). Rick asked for this assessment and did not override. | Light (assessed), Rick (accepted) | 2026-05-14 |
| D-7: pm2 + nginx on Rick's VPS | Same deployment target as Neurocore and PI. Co-location enables localhost API calls with zero latency, no TLS overhead on internal calls. | Tony (confirmed) | 2026-05-14 |
| D-8: Build via Claude Code, not Barker | Consistent with Rick's build approach across all current projects. Iterative file modification expected. | Rick | 2026-05-14 |
| D-9: Neurocore gap work completes before DREK build | Five Neurocore-side changes required. ~1 day total. All changes are Neurocore work, not DREK work. Detailed in separate gap spec. | Tony (proposed), Rick (confirmed cron lives in Neurocore) | 2026-05-14 |
| D-10: Instructional clarity over artistic expression | All videos planned by DREK serve instructional or showcase purposes. Artistic range is constrained to be secondary to clarity. | Rick | 2026-05-14 |
| D-11: Repository — `Lezzur/drek` | Repo exists on GitHub. Follows convention of `Lezzur/neurocore`, `Lezzur/prospect-intelligence`. | Rick (repo pre-created) | 2026-05-14 |
| D-12: Database — Firestore (own Firebase project) | Follows Neurocore's app-isolation pattern. DREK stores video plans, scene cards, scripts, user constraints — document-oriented data fits Firestore. | Lisa (default) | 2026-05-14 |
| D-13: Auth — None for v1 | Single user, localhost access only, same VPS as Neurocore. Auth adds complexity without security value in this context. | Lisa (default) | 2026-05-14 |
| D-14: LLM provider abstraction — Claude CLI + Codex CLI | Interface pattern: `LLMProvider` with `ClaudeCLIProvider` and `CodexCLIProvider` implementations. Config flag selects active provider. Rick: "I want you to plan for an additional Codex CLI so I can shift providers when necessary." | Rick | 2026-05-14 |
| D-15: No analytics for v1 | Internal single-user tool. Rick observes quality directly. No tracking infrastructure needed. | Lisa (default) | 2026-05-14 |
| D-16: Desktop web UI only (Chrome) | Scene cards and planning UI are desktop-only. No mobile responsive design needed for an internal planning tool. | Lisa (default) | 2026-05-14 |
| D-17: No brand assets or design system | Internal tool. Functional/utilitarian UI. No logo, brand colors, or custom typography. System fonts. | Lisa (default) | 2026-05-14 |
| D-18: Full script writing in scope | Rick: "I actually want Drek to handle script writing." DREK generates complete spoken-word scripts per scene, not just outlines or planning notes. | Rick | 2026-05-14 |
| D-19: YouTube audience = potential clients, not practitioners | Rick: "I want to target potential clients, people who actually want the ai systems/automations that I will showcase." Practitioners are secondary. DREK defaults to client-buyer perspective unless overridden. | Rick | 2026-05-14 |
| D-20: Polling for v1, webhook for v2 (PI signal consumption) | v1: DREK polls Neurocore's pending-video endpoint on a cron. v2: Neurocore pushes to DREK webhook. Polling is simpler, and same-VPS latency is negligible. Cover letter batch workflow confirms polling fits Rick's usage pattern. | Tony (proposed), Rick (confirmed batch pattern) | 2026-05-14 |
| D-21: Target runtime is a first-class input field | Rick specifies exact target runtime per video, not just mode defaults (2min/8-15min). DREK calibrates scene count and script density to fit. | Rick | 2026-05-14 |

---

## 9. Recommendation

- **Proceed to specs?** Yes, with one caveat.
- **No blocking caveats.** All open questions resolved. Neurocore gap work (D-9) can start immediately.
- **Non-blocking caveat:** OQ-4 (spoken-voice source material) doesn't block the DREK spec — it blocks Neurocore Gap 4 implementation.
- **Neurocore gap work:** Detailed in a separate document (`GAP-SPEC-drek-prerequisites.md` in the Neurocore repo). Five gaps, ~1 day total. Can proceed in parallel with DREK spec writing.
- **Suggested spec focus:** Heavy on **Tech Spec** (Neurocore integration contract, two-mode planning engine, script generation pipeline, LLM provider abstraction, scene card data model) and **PRD** (feature-level detail for scene card UX, script editing workflow, planning workflow, constraint input). UI Design is lightweight — functional dashboard, no brand work. No Copy stage needed (internal tool). No Barker plan (Claude Code build).
- **Suggested timeline:** Neurocore gaps (~1 day, can start immediately). DREK spec writing (1-2 days, can parallel with gap work). DREK build (1-2 weeks via Claude Code after spec + gaps complete).
