# Discovery Brief — DREK: AI Video Director

**Date:** 2026-05-14
**Participants:** Rick (product owner), Lisa (discovery lead), Tony Stark (engineering), Light (PM), Misa (content strategy)
**Status:** Draft
**Confidence:** High
(All critical sections settled. Architecture, integration pattern, planning modes, tech stack, and scope locked. No pending questions blocking downstream spec work.)

---

## 1. Problem Space

- **The problem:** Rick regularly needs to create two types of videos: (1) Loom cover letter videos demonstrating specific technical capabilities to hiring managers, and (2) YouTube tutorials teaching practical AI automation. Both require significant pre-production planning — choosing which projects to feature, which features to highlight, how to present them, scripting, and shot composition. This mental load is currently unassisted, slowing down video production and reducing quality.

- **Who experiences it:** Rick — solo AI automation consultant who needs videos as proof-of-work for job applications and as content for audience building.

- **Current workarounds:** Rick manually reviews job listing requirements, mentally maps them to his projects, plans shots ad-hoc, and records without a structured plan. For YouTube, the process is similar — topic selection, planning, and recording are all manual with no tooling support.

- **Why now:** (1) Prospect Intelligence is generating a growing volume of job listings, many requiring video demonstrations. Manual planning doesn't scale. (2) Rick is launching a YouTube channel focused on practical AI automation — a repeatable content pipeline needs a planning layer. (3) Neurocore's projects layer (just shipped) provides the underlying project knowledge that makes intelligent video planning feasible for the first time.

- **Evidence quality:** Settled

---

## 2. Users and Context

### Primary User
- **Who they are:** Rick — solo AI automation consultant. Builds agentic systems, RAG, internal tools. Creates videos to demonstrate capabilities to potential clients (cover letters) and to build authority with a practitioner audience (YouTube).
- **Context of use:** Rick has just ingested a job listing in PI that requires a video demonstration, OR Rick is planning a YouTube tutorial on a specific AI automation topic. He needs to quickly plan what to show, how, and in what order — then go record.
- **What success looks like:** Video planning takes minutes instead of hours. Plans are specific enough that Rick can open Loom, follow the plan, and record in one or two takes. The AI selects the right projects and features to highlight based on the requirement.
- **What makes them leave:** Plans that are generic or useless, requiring Rick to redo the planning manually. Slow or unreliable responses. System that doesn't understand his actual projects or their demo-ready features.

### Anti-Users
- **Who this is NOT for:** Video editors, general content creators, teams.
- **Why excluding them matters:** DREK is optimized for a single user's project portfolio and workflow. Multi-user features would add complexity without value.

- **Evidence quality:** Settled

---

## 3. Proposed Solution Shape

- **Product type:** Web application (server-rendered UI + API) running as a standalone service.
- **Core interaction model:** Planning/composition tool. Rick inputs requirements (auto-detected from PI listings via Neurocore signals, or manual topic entry). DREK outputs structured video plans as scene cards with shot descriptions, scripts, and presentation notes.
- **Key differentiator:** Deep integration with Neurocore's project knowledge graph. DREK doesn't just plan generic videos — it knows Rick's actual projects, their features, tech stacks, and demo-readiness, and matches requirements to the right project demonstrations.
- **Delivery model:** Self-hosted on Rick's VPS alongside Neurocore and PI. Localhost API access.
- **Evidence quality:** Settled

---

## 4. Prior Art and Competitive Landscape

*Not explored in the discovery conversation. Competitive analysis below added by Lisa — not from discovery conversation.*

### Direct Competitors

None identified. No existing tool combines project portfolio knowledge with AI-powered video pre-production planning for technical demonstrations.

### Adjacent / Indirect Solutions

| Product | Strengths | Weaknesses | Relevance |
|---------|-----------|------------|-----------|
| Loom AI | Built into Loom; auto-chapters, summaries | Post-recording only — no pre-production planning | Complementary, not competing |
| Descript | AI storyboarding + video editing | General-purpose; no project knowledge integration | Different scope — DREK is pre-production only |
| Storyboarder (Wonder Unit) | Open-source storyboard tool | No AI, no project knowledge, designed for film | Wrong domain — film storyboarding vs screen recording |

### Key Takeaways
- No tool exists that combines project portfolio knowledge with video planning for technical demonstrations
- The value is in the Neurocore integration, not in generic video planning features
- Existing tools solve editing/post-production; DREK solves pre-production planning

- **Evidence quality:** Leaning — competitive comparison from agent knowledge, not independent research

---

## 5. Technical Feasibility

- **Platform/architecture direction:** Standalone Node.js + TypeScript + Hono HTTP server. Same architecture pattern as Neurocore. DREK is a consumer of two upstream services:
  - **Neurocore** — project knowledge, Rick's profile/voice, signal hub for PI listing notifications
  - **PI (via Neurocore signals)** — job listing data as input triggers. PI signals Neurocore when new listings are ingested; DREK subscribes to relevant Neurocore signals. No direct PI↔DREK coupling.

- **Key technical constraints:**
  - **Neurocore dependency:** DREK cannot function at full capability without Neurocore's project data. Three gaps must be resolved in Neurocore first: (1) DREK-specific task types in injection profiles (~30 min), (2) project-status temporal cron (~2-4 hours), (3) narrative/demo-readiness metadata in crawl schema (~1-2 hours).
  - **LLM for planning:** Claude CLI via `child_process.spawn` (Claude Max subscription, same as Neurocore). Used for: requirement analysis, project-to-requirement matching, scene composition, script generation.
  - **No media processing:** DREK is text-only. No image generation, video rendering, or screen capture. It's a planning tool — output is text-based scene cards and documents.

- **Known hard problems:**
  - **Requirement-to-project matching quality:** The LLM must correctly interpret job listing requirements (e.g., "show automation work relating to lead pipelines") and match them to the right projects in Neurocore's registry. Quality depends on how well Neurocore's project data captures demonstrable features.
  - **Two-mode planning divergence:** Cover letter and YouTube videos have fundamentally different composition rules, pacing, tone, and success criteria. The planning engine must cleanly separate these modes without blending them into a bland middle ground.

- **Technology preferences or constraints:**
  - Language: TypeScript 5.x
  - Runtime: Node.js 20.x LTS
  - Framework: Hono 4.x (matching Neurocore)
  - Database: Firestore (own Firebase project, separate from Neurocore — following the app-isolation pattern)
  - LLM: Claude CLI via `child_process.spawn` (Claude Max subscription)
  - Deployment: pm2 + nginx on Rick's VPS, co-located with Neurocore and PI
  - Build tool: Claude Code (not Barker)

- **Evidence quality:** Settled

---

## 6. Scope and Boundaries

### In Scope (v1)

- **Listing ingestion via Neurocore signals** — receive notifications when PI ingests job listings with video requirements
- **Video requirement detection** — analyze listing requirements to identify what needs to be filmed
- **Project matching** — query Neurocore to identify which projects and features to showcase for a given requirement
- **Two planning modes:**
  - **Cover letter mode** — evaluative audience (hiring managers/recruiters), <2 minute target, trust-and-credibility focus, clean demonstration of exact skills requested, no personality flourishes
  - **YouTube tutorial mode** — practitioner audience, 8-15 minute target, authority-and-followability focus, storytelling structure (problem → attempt → solution → result), personality and pacing matter
- **Scene card generation** — structured shot-by-shot plan with description, framing notes (e.g., "medium shot, screenshare, terminal visible"), and script outline per scene
- **User constraints** — Rick provides per-plan constraints (headless only, screenshare only, specific project focus, time limit, etc.)
- **Exportable shoot instructions** — document output that Rick references while recording on Loom
- **Scene cards UI** — web interface for reviewing, reordering, and editing scene cards
- **Manual topic input** — for YouTube videos not triggered by job listings

### Explicitly Out of Scope

- **Image/storyboard generation** — text descriptions only; no AI image generation
- **Loom API integration** — DREK is a planning tool; no integration with recording platforms
- **Video editing/post-production** — DREK is pre-production only
- **Multi-user support** — single user (Rick)
- **Direct PI↔DREK coupling** — all PI data flows through Neurocore as signal hub
- **Voice/audio planning** — no TTS, no audio script generation beyond text
- **Marketing site or brand assets** — internal tool, no public presence

### Deferred (v2+)

- **AI-generated storyboard images** — visual previews of planned shots using image generation
- **Loom integration** — auto-create Loom projects with scene descriptions pre-loaded
- **Template library** — reusable planning templates for common video types (e.g., "3-minute app walkthrough", "10-minute build tutorial")
- **Performance analytics** — track which planned videos were actually recorded, correlate with viewer engagement metrics

- **Evidence quality:** Settled

---

## 7. Constraints and Risks

### Hard Constraints

- **Neurocore gap work must complete first** — DREK task types, project-status temporal cron, narrative/demo metadata. ~1 day of Neurocore-side work before DREK build starts.
- **Single user only** — no multi-tenant architecture
- **Build tool: Claude Code** — no Barker orchestration, iterative file modification
- **Instructional clarity over artistic expression** — all DREK-planned videos serve instructional or showcase purposes. Artistic range is secondary. This constrains the planning engine's composition rules.

### Key Risks

| Risk | Likelihood | Impact | Mitigation Discussed |
|------|-----------|--------|---------------------|
| Neurocore project data too shallow for quality project matching | Medium | High | Three-gap enrichment plan (task types, temporal cron, narrative metadata). Lisa defined minimum data requirements per project: name, category tags, demonstrable features with interface type and demo-readiness, tech stack, status. |
| Requirement-to-project matching produces irrelevant suggestions | Medium | Medium | Rick reviews all plans before recording. LLM has full project feature data via Neurocore. Quality improves as Neurocore's project registry grows and gets richer. |
| Two planning modes blend into generic middle-ground output | Low | High | Misa defined distinct composition rules, success criteria, and audience psychology per mode. Implemented as separate planning profiles, not parameterized variants of one template. |
| DREK depends on Neurocore uptime for listing-triggered planning | Medium | Medium | Same VPS, localhost calls — network failure unlikely. If Neurocore is unreachable, DREK can still do manual-input planning (YouTube mode) but cannot auto-detect listing requirements. |

### Open Questions

| # | Question | Owner | Depends on | Status |
|---|----------|-------|-----------|--------|
| OQ-1 | Optimal YouTube tutorial length for Rick's audience | Rick | Post-launch audience data | Resolved — Default 8-15 minutes per Misa's recommendation based on practitioner content norms; adjustable per plan. Rick refines after publishing first videos. |
| OQ-2 | Will DREK ever generate editing instructions (cuts, transitions, B-roll callouts)? | Rick | Post-v1 usage patterns | Resolved — Explicitly out of scope for v1. Deferred to v2+ based on whether Rick finds planning-only output sufficient. |

---

## 8. Key Decisions Log

| Decision | Rationale | Made By | Date |
|----------|-----------|---------|------|
| D-1: Two distinct planning modes (cover letter vs YouTube) | Fundamentally different audiences, pacing, tone, and success criteria. Cover letter = evaluative, <2min, credibility. YouTube = educational, 8-15min, followability. Blending them would produce mediocre output for both. | Rick (confirmed Misa's framing) | 2026-05-14 |
| D-2: Neurocore owns all project knowledge, DREK queries it | Clean separation of concerns — Neurocore is the information layer, DREK is the planning layer. Avoids duplicating project data across apps. | Rick | 2026-05-14 |
| D-3: PI→Neurocore→DREK signal routing (hub-and-spoke) | PI already signals Neurocore via its signals route. DREK subscribes to Neurocore signals rather than coupling directly to PI. Neurocore is the hub; PI and DREK are spokes. | Tony (proposed), team consensus | 2026-05-14 |
| D-4: Text-only scene planning for v1 | Rick: "for now I only need text descriptions." No AI image generation. Reduces scope and complexity. Image generation deferred to v2+. | Rick | 2026-05-14 |
| D-5: Single user (Rick only) | Internal tool for Rick's personal video production workflow. No multi-user requirements. | Rick | 2026-05-14 |
| D-6: Node/TypeScript/Hono stack | Shared deployment tooling, shared CI config patterns, Rick maintains via Claude Code without context-switching between frameworks. Matches Neurocore stack. | Tony (confirmed) | 2026-05-14 |
| D-7: pm2 + nginx on Rick's VPS | Same deployment target as Neurocore and PI. Co-location enables localhost API calls with zero latency, no TLS overhead on internal calls. | Tony (confirmed) | 2026-05-14 |
| D-8: Build via Claude Code, not Barker | Consistent with Rick's build approach across all current projects. Iterative file modification expected. | Rick (implied from Neurocore pattern, team confirmed) | 2026-05-14 |
| D-9: Neurocore gap work completes before DREK build | Three Neurocore-side changes required: (1) DREK task types in injection profiles, (2) project-status temporal cron for freshness, (3) narrative/demo-readiness metadata in crawl schema. ~1 day total. All changes are Neurocore work, not DREK work. | Tony (proposed), Rick (confirmed cron lives in Neurocore) | 2026-05-14 |
| D-10: Instructional clarity over artistic expression | All videos planned by DREK serve instructional or showcase purposes. Artistic range is constrained to be secondary to clarity. | Rick | 2026-05-14 |
| D-11: Repository — `Lezzur/drek` | Repo exists on GitHub. Follows convention of `Lezzur/neurocore`, `Lezzur/prospect-intelligence`. | Rick (repo pre-created) | 2026-05-14 |
| D-12: Database — Firestore (own Firebase project) | Follows Neurocore's app-isolation pattern (each app owns its own Firestore project). DREK stores video plans, scene cards, user constraints — document-oriented data fits Firestore. Default chosen by Lisa; reversible. | Lisa (default) | 2026-05-14 |
| D-13: Auth — None for v1 | Single user, localhost access only, same VPS as Neurocore. Auth adds complexity without security value in this context. | Lisa (default) | 2026-05-14 |
| D-14: LLM — Claude CLI via child_process.spawn | Same pattern as Neurocore. Claude Max subscription absorbs cost. | Lisa (default, following Neurocore pattern) | 2026-05-14 |
| D-15: No analytics for v1 | Internal single-user tool. Rick observes quality directly. No tracking infrastructure needed. | Lisa (default) | 2026-05-14 |
| D-16: Desktop web UI only (Chrome) | Scene cards and planning UI are desktop-only. No mobile responsive design needed for an internal planning tool. | Lisa (default) | 2026-05-14 |
| D-17: No brand assets or design system | Internal tool. Functional/utilitarian UI. No logo, brand colors, or custom typography. System fonts. | Lisa (default) | 2026-05-14 |

---

## 9. Recommendation

- **Proceed to specs?** Yes
- **If caveats:** Neurocore gap work (D-9) must be completed or in-flight before DREK's tech spec is finalized, since the tech spec needs to reference concrete Neurocore API response shapes for DREK-specific task types.
- **Suggested spec focus:** Heavy on **Tech Spec** (Neurocore integration contract, two-mode planning engine architecture, scene card data model) and **PRD** (feature-level detail for scene card UX, planning workflow, constraint input). UI Design is lightweight — functional dashboard, no brand work. No Copy stage needed (internal tool). No Barker plan (Claude Code build).
- **Suggested timeline pressure:** DREK is blocked on Neurocore gaps (~1 day). Once cleared, DREK is a moderate build — core planning logic + lightweight UI. Estimated 1-2 weeks via Claude Code.
