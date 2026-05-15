# DREK — Technical Specification

**Author:** Tony Stark
**Status:** Draft
**Last Updated:** 2026-05-15
**Reviewers:** @lisa (PRD), @light (PM), @shikamaru (review)
**PRD Reference:** PRD-drek-2026-05-15.md
**Neurocore Gap Spec:** GAP-SPEC-drek-prerequisites.md (Neurocore repo)

---

## 1. Overview

DREK is a standalone TypeScript web service that automates video pre-production for Rick — a solo AI automation consultant who creates cover letter demos and YouTube showcases. Given a job listing (via Neurocore signal polling) or a manual topic, DREK queries Neurocore for project knowledge, matches requirements to Rick's portfolio, generates structured scene cards with full spoken-word scripts, and exports shoot instructions. The hard problems are: (1) two fundamentally different planning modes (cover letter vs YouTube) that must not blend, (2) script generation that sounds like Rick talking (not AI-generated copy), and (3) runtime-calibrated scene composition that respects a target duration.

## 2. Context and Background

- **Current system state.** Rick plans videos manually — reviewing listing requirements, mentally mapping them to projects, writing scripts from scratch, and recording without a structured plan. No tooling assists pre-production.
- **Problem.** PI generates a growing volume of listings requiring video demos. Manual planning takes ~1 hour per video and produces inconsistent quality. Rick is launching a YouTube channel targeting potential clients; a repeatable pipeline needs both planning and scripting.
- **Motivation.** Neurocore's projects layer (just shipped) provides the underlying project knowledge. DREK is the first non-PI consumer of Neurocore, validating the hub-and-spoke architecture.
- **Constraints.** Single user (Rick). Build via Claude Code, not Barker. No auth for v1 (localhost only). Desktop Chrome only. Five Neurocore gaps must ship before DREK can function at full capability.
- **Related systems.** Neurocore (project knowledge, voice profiles, signal hub), PI (job listing source via Neurocore signals), Firestore (DREK's own project), Claude CLI / Codex CLI (LLM providers).

## 3. Goals and Non-Goals

### Goals

- Standalone HTTP service with server-rendered UI, deployable independently of Neurocore and PI.
- Two planning modes (cover letter, YouTube) with completely separate composition rules — no shared template, no parameterized blending.
- Full spoken-word script generation per scene, calibrated to target runtime at ~150 wpm.
- Scene card UI with HTMX-powered reorder, inline edit, and delete — no full page reloads for card interactions.
- LLM provider abstraction: swap Claude CLI ↔ Codex CLI via config flag without code changes.
- Exportable shoot instructions (HTML + plain text) that Rick references while recording.

### Non-Goals

- Multi-user or multi-tenant. Single Rick user, no auth.
- Image/storyboard generation. Text-only scene cards in v1 (schema has nullable `storyboardImageUrl` for v2).
- Video editing, post-production, or Loom API integration.
- Direct PI↔DREK coupling. All PI data flows through Neurocore.
- Webhook-based signal consumption. Polling only in v1.
- Mobile or responsive design. Desktop Chrome only.
- Analytics or tracking infrastructure.

## 4. Proposed Architecture

### 4.1 High-Level Design

```
                          ┌────────────────────────────────┐
                          │            DREK                 │
                          │                                │
  Browser ───── HTTP ────▶│  ┌──────────┐  ┌────────────┐ │
  (Rick)                  │  │  Hono    │  │  Planning   │ │
                          │  │  Routes  │  │  Engine     │ │
                          │  │  + HTMX  │  │            │ │
                          │  └────┬─────┘  └─────┬──────┘ │
                          │       │              │        │
                          │  ┌────┴──────────────┴──────┐ │
                          │  │     LLM Provider         │ │
                          │  │  ┌─────────┐ ┌────────┐  │ │
                          │  │  │Claude   │ │Codex   │  │ │
                          │  │  │CLI      │ │CLI     │  │ │
                          │  │  └─────────┘ └────────┘  │ │
                          │  └──────────────────────────┘ │
                          │       │                       │
                          │  ┌────┴─────┐                 │
                          │  │Firestore │                 │
                          │  │(drek-db) │                 │
                          │  └──────────┘                 │
                          └───────┬────────────────────────┘
                                  │ localhost HTTP
                          ┌───────▼────────────────────────┐
                          │         Neurocore               │
                          │  /v1/memory/context             │
                          │  /v1/signals/pending (Gap 5)    │
                          └────────────────────────────────┘
```

**Four primary call paths:**

1. **UI → Hono routes.** Browser makes standard HTTP requests + HTMX partial requests. Hono renders HTML server-side. HTMX handles card reorder, inline edit, delete without full page reloads.
2. **Planning Engine → Neurocore.** HTTP calls to `POST /v1/memory/context` for project data, voice profiles, and identity. HTTP calls to the pending-signals endpoint (Gap 5) for listing polling.
3. **Planning Engine → LLM Provider.** `child_process.spawn` calls to Claude CLI or Codex CLI for requirement detection, project matching, scene generation, and script writing.
4. **Planning Engine → Firestore.** CRUD operations on plans and scenes. All state persisted after each step — no data loss on browser close or server restart.

### 4.2 Component Details

#### Component A: HTTP Server (Hono)

- **Responsibility:** Route handling, HTML rendering, HTMX partial responses, static asset serving.
- **Technology:** Hono 4.x on `@hono/node-server`. TypeScript 5.x. Node.js 20.x LTS.
- **Rendering:** Server-side HTML via JSX (Hono's built-in JSX support) or template literals. No client-side framework. HTMX 2.x loaded from a vendored JS file for dynamic interactions.
- **Scaling:** Single instance. pm2 for process management and auto-restart.

#### Component B: Planning Engine

- **Responsibility:** Orchestrates the full planning pipeline: requirement detection → project matching → scene generation → script writing. Each step is a separate function that calls the LLM provider and persists results to Firestore.
- **Technology:** Pure TypeScript module. No framework dependency — receives parsed request data, returns structured results.
- **Composition rules:** Two separate rule sets (cover letter, YouTube) stored as typed constants, not database config. Each rule set defines: audience, tone, structure template, anti-patterns, pacing guidance. Rules are injected into LLM system prompts.
- **Runtime calibration:** Target runtime → target word count (runtime × 150/60 wpm) → scene count range → per-scene word budget. The LLM receives these constraints in the system prompt.

#### Component C: LLM Provider Abstraction

- **Responsibility:** Uniform interface for LLM calls. Swappable providers via config.
- **Technology:** TypeScript interface + two implementations.

```typescript
interface LLMProvider {
  generate(params: {
    systemPrompt: string;
    userPrompt: string;
    maxTokens?: number;
  }): Promise<{ text: string; usage?: { inputTokens: number; outputTokens: number } }>;
}
```

- **ClaudeCLIProvider:** Spawns `claude` CLI via `child_process.spawn`. Passes prompts via stdin, collects stdout. Parses structured output.
- **CodexCLIProvider:** Spawns `codex` CLI via `child_process.spawn`. Same interface, different binary and flag conventions.
- **Selection:** `LLM_PROVIDER=claude|codex` env var. Read once at startup. Application-wide, not per-request.
- **Error handling:** Spawn failures, non-zero exit codes, and timeouts (configurable, default 120s) surface as typed errors to the planning engine. The engine surfaces these to the UI with a retry option.

#### Component D: Neurocore Client

- **Responsibility:** HTTP client for all Neurocore API calls. Handles auth, retries, and graceful degradation.
- **Technology:** Native `fetch` (Node 20 built-in). No HTTP client library needed.

**Calls made:**

| Call | Neurocore Endpoint | Purpose | Gap |
|------|-------------------|---------|-----|
| `getProjectContext` | `POST /v1/memory/context` with `taskType: 'videoPlanning'` | Retrieve project data for requirement matching | Gap 1 |
| `getVoiceProfile` | `POST /v1/memory/context` with `taskType: 'contentBrief'` | Retrieve spoken-voice profile for script generation | Gap 4 |
| `getIdentity` | `POST /v1/memory/context` with `taskType: 'projectShowcase'` | Retrieve Rick's professional identity for intros/closings | Gap 1 |
| `pollPendingSignals` | `GET /v1/signals/pending?appId=drek&since={timestamp}` | Poll for new PI listings | Gap 5 |
| `ackSignals` | `POST /v1/signals/ack` | Mark consumed signals | Gap 5 |

**Auth:** Bearer token stored in `NEUROCORE_TOKEN` env var.

**Graceful degradation:**
- Neurocore unreachable → polling paused, project matching disabled (Rick selects projects manually), scripts use generic voice with warning displayed.
- Timeout: 10s per call, 1 retry with 2s backoff, then degrade.

#### Component E: Polling Service

- **Responsibility:** Background cron that polls Neurocore for new PI signals. Creates pending plan entries in Firestore.
- **Technology:** `setInterval` with configurable period (default: 30 minutes). Runs in the same Node process — no separate worker.

**Behavior:**
1. Call `pollPendingSignals` with timestamp of last successful poll.
2. For each returned signal: check if a plan already exists for that listing ID (idempotency).
3. Listings flagged as requiring video → create plan with status `awaiting_review`.
4. All other listings → store as available listings (separate collection, `available_listings`).
5. Call `ackSignals` for all consumed signal IDs.
6. Update last-poll timestamp in Firestore config doc.
7. On error: log, skip, retry on next cycle.

**Manual poll:** "Check now" button triggers the same function outside the cron cycle. Mutex prevents concurrent polls.

### 4.3 Data Model

**Firestore project:** `drek-prod` (Rick to create before build).

#### Collection: `plans`

| Field | Type | Constraints | Description |
|-------|------|-------------|-------------|
| id | string | PK, auto-generated | Unique plan identifier |
| type | `'cover_letter'` \| `'youtube'` | required | Planning mode |
| status | enum | required | `awaiting_review` \| `dismissed` \| `requirements_reviewed` \| `projects_matched` \| `scenes_generated` \| `finalized` \| `exported` |
| title | string | required | Plan title (from listing or manual input) |
| sourceListingId | string \| null | optional | PI listing ID if listing-triggered |
| sourceListingText | string \| null | optional | Raw listing text if listing-triggered |
| requirements | Requirement[] | default: [] | Detected or manual requirements |
| matchedProjects | MatchedProject[] | default: [] | Confirmed project selections |
| targetRuntimeSeconds | number | required, min: 30, max: 3600 | User-specified target runtime |
| estimatedRuntimeSeconds | number | default: 0 | Calculated from scene scripts |
| userConstraints | string \| null | optional | Free-text per-plan constraints |
| createdAt | Timestamp | required | Plan creation time |
| updatedAt | Timestamp | required | Last modification time |
| exportedAt | Timestamp \| null | optional | Last shoot instructions export |

**Indexes:**
- `plans_status_type`: composite on `(status, type)` — dashboard filtering.
- `plans_createdAt`: descending — dashboard default sort.
- `plans_sourceListingId`: unique where not null — idempotency on polling.

**Subcollection: `plans/{planId}/scenes`**

| Field | Type | Constraints | Description |
|-------|------|-------------|-------------|
| id | string | PK, auto-generated | Scene identifier |
| order | number | required, 1-based | Ordinal position |
| title | string | required | Short descriptive label |
| description | string | required | What happens in this scene |
| framingNotes | string | required | Camera/screen framing instructions |
| script | string | required | Complete spoken-word text |
| emphasisCues | string[] | default: [] | Words/phrases to stress |
| pacingNotes | string | default: '' | Pacing instructions |
| transitionNote | string | default: '' | Bridge to next scene |
| estimatedDurationSeconds | number | required | Based on script word count at ~150 wpm |
| projectRef | string \| null | optional | Neurocore project slug |
| storyboardImageUrl | string \| null | always null in v1 | Reserved for v2 image generation |

**Indexes:**
- `scenes_order`: ascending — display order within a plan.

**Subcollection rationale:** Scenes are always accessed in the context of a plan. Subcollection keeps plan reads lightweight (no scene data loaded until needed) and scene reordering is a subcollection-scoped batch write.

#### Collection: `available_listings`

| Field | Type | Description |
|-------|------|-------------|
| id | string | PK — same as PI listing ID |
| title | string | Listing title |
| company | string | Company name |
| summary | string | Brief listing summary |
| rawText | string | Full listing text from PI |
| receivedAt | Timestamp | When DREK received it from Neurocore |
| selectedAt | Timestamp \| null | When Rick selected it for planning |
| planId | string \| null | Created plan ID if selected |

**Purpose:** Listings that didn't auto-create plans (no video requirement flag). Rick browses these and can manually select any to create a cover letter plan.

#### Collection: `config`

Single document `polling` storing:

| Field | Type | Description |
|-------|------|-------------|
| lastPollAt | Timestamp | Last successful poll time |
| pollingEnabled | boolean | Cron toggle |
| pollingIntervalMs | number | Cron interval (default: 1800000 = 30 min) |

### 4.4 API Design (Internal Routes)

DREK is a server-rendered web app, not a headless API. Routes serve HTML pages and HTMX partials. Listed here for implementation clarity.

#### Page Routes

| Method | Path | Renders |
|--------|------|---------|
| GET | `/` | Dashboard — plan list with filters, "Check now" button, new plan buttons |
| GET | `/plans/:id` | Plan detail — scene cards view with reorder/edit/delete controls |
| GET | `/plans/:id/export` | Shoot instructions — printable/copyable document |
| GET | `/plans/new/cover-letter` | New cover letter plan form (listing pre-filled if `?listingId=`) |
| GET | `/plans/new/youtube` | New YouTube plan form (manual topic input) |
| GET | `/listings` | Available listings browser |

#### Action Routes (form submissions + HTMX)

| Method | Path | Action |
|--------|------|--------|
| POST | `/plans` | Create plan (from form submission) |
| POST | `/plans/:id/analyze` | Trigger requirement detection (LLM call) |
| POST | `/plans/:id/match` | Trigger project matching (LLM call) |
| POST | `/plans/:id/generate` | Trigger scene + script generation (LLM call) |
| POST | `/plans/:id/dismiss` | Set plan status to `dismissed` |
| POST | `/plans/:id/finalize` | Set plan status to `finalized` |
| POST | `/poll` | Manual "Check now" — trigger immediate Neurocore poll |
| POST | `/listings/:id/select` | Create plan from available listing |

#### HTMX Partial Routes (return HTML fragments, not full pages)

| Method | Path | Returns |
|--------|------|---------|
| PATCH | `/plans/:id/scenes/:sceneId` | Updated scene card partial (inline edit save) |
| POST | `/plans/:id/scenes/:sceneId/move-up` | Reordered scene list partial |
| POST | `/plans/:id/scenes/:sceneId/move-down` | Reordered scene list partial |
| DELETE | `/plans/:id/scenes/:sceneId` | Updated scene list partial (scene removed) |
| POST | `/plans/:id/scenes` | New blank scene card partial |
| PATCH | `/plans/:id/requirements` | Updated requirements section partial |
| PATCH | `/plans/:id/projects` | Updated project matches section partial |

**HTMX conventions:**
- `HX-Trigger` response header for toast notifications (success/error).
- `HX-Retarget` for error states that replace the card with an error indicator.
- All HTMX responses return HTML fragments targeting `id`-based swap targets.
- `hx-swap="outerHTML"` as default swap strategy for card-level updates.
- `hx-indicator` on LLM-powered actions (analyze, match, generate) showing a spinner.

### 4.5 LLM Prompt Architecture

DREK makes four distinct LLM calls per plan. Each has a specific system prompt, user prompt structure, and expected output format.

#### Call 1: Requirement Detection

**Input:** Raw listing text.
**System prompt:** "You are analyzing a job listing to extract video demonstration requirements. Return a JSON array of requirements..."
**Output:** `Requirement[]` — `{ skill: string, category: string, priority: 'must_show' | 'nice_to_show', evidence: string }`
**Used by:** Cover letter flow only. YouTube skips this step.

#### Call 2: Project Matching

**Input:** Requirements (or topic for YouTube) + Neurocore project context (from `getProjectContext`).
**System prompt:** Includes mode-specific framing. Cover letter: "Match projects that directly demonstrate the required skills." YouTube: "Match projects that best illustrate the business value of [topic] for potential clients."
**Output:** `MatchedProject[]` — `{ projectSlug: string, projectName: string, matchedFeatures: string[], relevanceScore: number, suggestedDemoSequence: string }`

#### Call 3: Scene Generation

**Input:** Confirmed requirements + confirmed projects + target runtime + user constraints + composition rules (mode-specific).
**System prompt:** Full composition rules block (Section 8 of PRD, verbatim). Target word count calculated from runtime. Scene count guidance based on mode.
**Output:** `Scene[]` (without full scripts — titles, descriptions, framing notes, estimated durations, project refs).

#### Call 4: Script Writing

**Input:** Generated scenes + spoken-voice profile (from `getVoiceProfile`) + Rick's identity (from `getIdentity`) + composition rules.
**System prompt:** "Write complete spoken-word scripts for each scene in Rick's voice. Use the voice profile below to match his spoken patterns..."
**Output:** Per-scene: `{ script: string, emphasisCues: string[], pacingNotes: string, transitionNote: string }`

**Why four calls, not one:** Token budget management. A single mega-prompt would need to hold listing text + full project data + composition rules + voice profile + generate all scenes + all scripts. That's easily 50k+ tokens of context and output. Four focused calls keep each under 15k context, produce more consistent structured output, and let us display intermediate results (requirements → matches → scenes → scripts) so Rick can review and correct at each step.

**Structured output parsing:** All LLM responses are expected as JSON. The provider wraps the user prompt in a JSON-output instruction. Responses are parsed with `JSON.parse`. On parse failure: retry once with an explicit "respond ONLY with valid JSON" instruction appended. On second failure: surface error to UI with retry button.

### 4.6 Composition Rules Implementation

Composition rules are TypeScript constants, not database records:

```typescript
type PlanningMode = 'cover_letter' | 'youtube';

interface CompositionRules {
  mode: PlanningMode;
  audience: string;
  tone: string;
  pacing: string;
  structureTemplate: string;    // multi-line template for system prompt
  rules: string[];              // bullet points injected into system prompt
  antiPatterns: string[];       // "DO NOT" instructions
  defaultRuntimeSeconds: number;
  typicalSceneRange: [number, number];
  wordsPerMinute: number;       // ~150 for both, but configurable per mode
}

const COVER_LETTER_RULES: CompositionRules = { ... };
const YOUTUBE_RULES: CompositionRules = { ... };
```

**Why constants, not config:** These rules are prompt engineering — they define how the LLM behaves. Changing them is a code change that should be reviewed and tested, not a runtime config toggle. Rick doesn't need to edit them via UI.

## 5. Alternatives Considered

### Option A: Next.js full-stack (rejected)

- **Description:** React-based SPA with server components. Rich drag-and-drop scene editor.
- **Pros:** Interactive scene card UI out of the box. React ecosystem for complex UI state.
- **Cons:** Overkill for 3-12 scene cards. Hydration complexity. Two rendering paradigms (server + client). Heavier deployment. Rick doesn't need a creative canvas — he needs a review/edit workflow.
- **Why rejected:** Light assessed that move-up/down buttons + inline textarea covers all realistic scene card interactions. HTMX handles this without client-side framework overhead.

### Option B: Python/FastAPI (rejected)

- **Description:** Python backend for stronger AI/ML ecosystem. Better path to image generation in v2.
- **Pros:** PIL, Stable Diffusion bindings, LiteLLM for multi-provider abstraction.
- **Cons:** Adds Python to Rick's deployment stack. Context-switching between TS and Python codebases. Neurocore client needs porting. Different deployment tooling.
- **Why rejected:** v1 is text-only. Image generation is v2+ and may use external APIs (not local ML inference). The LLM provider abstraction is simple enough in TypeScript. Maintaining one language across all services has higher value than a hypothetical future ML library.

### Option C: Single LLM call for full plan generation (rejected)

- **Description:** One mega-prompt that takes listing + projects + rules and outputs a complete plan with scripts in one shot.
- **Pros:** Simpler code. One round-trip.
- **Cons:** Massive context window required (50k+). No intermediate review points — Rick can't correct requirements before project matching or adjust matches before scene generation. Output consistency degrades with prompt size. Harder to debug which step went wrong.
- **Why rejected:** The four-step pipeline gives Rick control at each decision point and keeps each LLM call focused and debuggable.

### Decision

Hono 4.x + HTMX + four-step LLM pipeline. Maximizes Rick's control over the planning process while keeping the stack consistent with Neurocore.

## 6. Security Considerations

- **Authentication:** None. Single user, localhost access only. nginx proxies to `127.0.0.1:PORT` — no public exposure.
- **Authorization:** N/A — no multi-user.
- **Data protection:** Plan and scene data stored in Firestore (Google-managed encryption at rest). No PII beyond Rick's professional information (already in Neurocore). Service account key stored as env var, not committed.
- **Input validation:** All form inputs validated server-side with Zod schemas before processing. LLM prompts are constructed server-side from validated inputs — no user-supplied strings executed as code or injected into shell commands.
- **CLI injection prevention:** LLM provider passes prompts via stdin to `child_process.spawn` (not `exec`). No shell interpolation. Binary path is a config constant, not user input.
- **Secrets management:** Two secrets — `NEUROCORE_TOKEN` and `GOOGLE_APPLICATION_CREDENTIALS` (Firestore service account). Both env vars, managed via pm2 ecosystem config.

## 7. Performance and Scalability

| Metric | Target | Rationale |
|--------|--------|-----------|
| Dashboard page load | < 2s | Server-rendered HTML, Firestore query for plan list |
| Scene cards page load | < 2s | Plan doc + subcollection query |
| HTMX interactions (reorder, inline edit) | < 500ms round-trip | Firestore write + HTML fragment render |
| LLM: Requirement detection | < 30s | Single focused prompt, structured JSON output |
| LLM: Project matching | < 30s | Neurocore context + matching prompt |
| LLM: Scene generation | < 60s | Composition rules + scene structure |
| LLM: Script writing | < 120s | Longest call — full scripts for all scenes |
| Neurocore poll round-trip | < 5s | HTTP call + Firestore writes for new plans |

**Scaling strategy:** Not applicable. Single user, single instance. If DREK ever needs to handle concurrent users, the path is horizontal replicas with shared Firestore — but that's a v-never concern.

**Caching:** No caching layer. Every Neurocore call is fresh (project data may have changed). LLM calls are inherently non-cacheable (different inputs each time). Firestore has its own connection pooling.

## 8. Reliability and Failure Handling

### Dependency Failure Matrix

| Dependency | Failure Mode | Detection | Fallback | Recovery |
|-----------|-------------|-----------|----------|----------|
| Neurocore | Unreachable (timeout/5xx) | 10s timeout + 1 retry | Polling paused. Project matching disabled — Rick selects manually. Scripts use generic voice with warning. | Auto-recovers on next successful call. |
| Firestore | Connection error | Firebase SDK error event | Request fails with error page. No data loss — prior steps already persisted. | Auto-reconnect via Firebase SDK. |
| Claude CLI | Spawn failure / non-zero exit | `child_process` error event / exit code | Error displayed on the relevant step with retry button. Plan stays at current status. | Rick clicks retry. |
| Codex CLI | Same as Claude CLI | Same | Same | Same |
| Claude CLI | Timeout (>120s) | `setTimeout` kills process | Same as spawn failure | Same |
| LLM output | Invalid JSON | `JSON.parse` throws | Retry once with stricter JSON instruction. On second failure, show error with retry. | Rick clicks retry. |

### Data Durability

- Plan state persisted to Firestore after each pipeline step. Browser close or server restart loses zero data.
- Scene edits auto-save on blur via HTMX PATCH. Each edit is a Firestore write — no client-side state that could be lost.
- Polling state (last poll timestamp) persisted to Firestore config doc. Server restart resumes polling from last known timestamp.

### Process Management

- pm2 manages the Node process. Auto-restart on crash. Max 3 restarts in 30s before stopping (prevents crash loops).
- `setInterval`-based polling survives within-process restarts (pm2 restarts the full process, which re-initializes the interval).

## 9. Observability

### Logging

- **Format:** Structured JSON via `pino`. Fields: `timestamp`, `level`, `msg`, `requestId`, `planId`, `step`, `durationMs`.
- **Key events:**
  - Poll cycle: start, signal count, plans created, errors
  - LLM call: start, provider, prompt size (tokens), response size, duration, success/failure
  - Plan state transition: `{planId, from, to, trigger}`
  - Scene edit: `{planId, sceneId, field, durationMs}`
  - Neurocore call: endpoint, status, duration, degraded flag
- **Log level:** `info` for business events, `warn` for degradation, `error` for failures. No `debug` in production unless `LOG_LEVEL=debug` env var set.

### Health Check

`GET /healthz` returns:
```json
{
  "status": "ok",
  "checks": {
    "firestore": "ok",
    "neurocore": "ok",
    "llm_provider": "claude",
    "polling": { "enabled": true, "lastPollAt": "2026-05-15T14:00:00Z" }
  }
}
```

Status `degraded` if Neurocore is unreachable. Status `error` if Firestore is down.

### Metrics

No dedicated metrics infrastructure for v1 (single user, internal tool). Logs are the observability layer. If needed later, `pino` structured logs can be parsed by any log aggregator.

## 10. Testing Strategy

- **Unit tests:** Composition rule selection, runtime calibration (target seconds → word count → scene count range), LLM output parsing, Firestore document mapping. Framework: Vitest.
- **Integration tests:** Full planning pipeline with mocked LLM provider (returns canned JSON). Verifies: plan state transitions, scene CRUD, Firestore persistence, polling creates plans from signals.
- **LLM provider tests:** Verify `ClaudeCLIProvider` and `CodexCLIProvider` correctly spawn the binary, pass stdin, parse stdout. Mock `child_process.spawn`.
- **HTMX interaction tests:** Verify partial routes return correct HTML fragments with expected `id` attributes and `hx-*` attributes. Lightweight — just assert the response HTML structure.
- **Manual QA:** Rick generates 3 cover letter plans and 2 YouTube plans end-to-end. Evaluates: project match relevance, script voice fidelity, runtime accuracy, export readability.

**No load testing** — single user, internal tool.

## 11. Deployment and Rollout

### Infrastructure Setup

1. Rick creates Firebase project `drek-prod` and generates service account key.
2. Service account key stored as `GOOGLE_APPLICATION_CREDENTIALS` env var in pm2 ecosystem config.
3. Neurocore app token for DREK stored as `NEUROCORE_TOKEN` env var.
4. nginx config: new `server` block proxying `drek.localhost` (or port-based) to `127.0.0.1:PORT`.

### pm2 Ecosystem Config

```javascript
// ecosystem.config.js
module.exports = {
  apps: [{
    name: 'drek',
    script: 'dist/index.js',
    env: {
      NODE_ENV: 'production',
      PORT: '3003',
      LLM_PROVIDER: 'claude',
      NEUROCORE_URL: 'http://localhost:3001',
      NEUROCORE_TOKEN: '...',
      GOOGLE_APPLICATION_CREDENTIALS: '/path/to/drek-prod-sa.json',
      POLLING_INTERVAL_MS: '1800000',
      LLM_TIMEOUT_MS: '120000',
    }
  }]
};
```

### Rollout Strategy

Single deploy. No canary, no feature flags, no staged rollout. This is a greenfield single-user internal tool. Deploy, verify manually, iterate.

### Rollback

- `pm2 stop drek` → service offline, no user impact (internal tool).
- `git revert` + redeploy for code issues.
- Firestore data is append-only (plans are never auto-deleted) — bad data can be manually cleaned.

## 12. Implementation Plan

### Prerequisites (Neurocore — separate track)

| Gap | Description | Effort | Dependency |
|-----|-------------|--------|------------|
| 1 | DREK task types in injection profiles | ~30 min | None |
| 2 | Project-status temporal cron | ~2-4 hours | None |
| 3 | Narrative/demo-readiness metadata in crawl schema + re-crawl | ~1-2 hours | None |
| 4 | Spoken-voice profile | ~2-3 hours | Gap 3 (needs narrative hooks in project data) |
| 5 | PI signal consumption endpoint | ~1-2 hours | None |

**Recommended build order:** Gap 1 → Gap 3 + re-crawl → Gap 5 → Gap 4 → Gap 2.

### DREK Milestones

| Milestone | Description | Deliverable | Dependencies | Effort |
|-----------|-------------|-------------|-------------|--------|
| M0 | Project scaffold | TypeScript project, Hono server, Firestore connection, pm2 config, health check endpoint, pino logging | Firebase project created | ~2 hours |
| M1 | LLM provider abstraction | `LLMProvider` interface, `ClaudeCLIProvider`, `CodexCLIProvider`, env-based selection, error handling, timeout | Claude CLI + Codex CLI installed on VPS | ~2 hours |
| M2 | Neurocore client | HTTP client with auth, all 5 call types (3 existing endpoints + 2 Gap 5 endpoints), graceful degradation, retry logic | Neurocore Gap 1 + Gap 5 shipped | ~3 hours |
| M3 | Data model + CRUD | Firestore collections (plans, scenes, available_listings, config), Zod schemas, create/read/update operations | M0 | ~3 hours |
| M4 | Planning engine — requirement detection | Call 1 (requirement detection), LLM prompt + output parsing, plan status transition to `requirements_reviewed` | M1, M3 | ~3 hours |
| M5 | Planning engine — project matching | Call 2 (project matching), Neurocore context query, LLM prompt + output parsing, plan status transition to `projects_matched` | M2, M4 | ~3 hours |
| M6 | Planning engine — scene + script generation | Call 3 (scene generation) + Call 4 (script writing), composition rules injection, runtime calibration, plan status transition to `scenes_generated` | M5, Neurocore Gap 4 | ~4 hours |
| M7 | Dashboard UI | Plan list page, filters (type, status), "Check now" button, new plan buttons, notification indicators, dismiss action | M3 | ~4 hours |
| M8 | Plan detail + scene cards UI | Scene card display, HTMX reorder (move-up/down), inline edit (textarea on click, auto-save on blur), delete with confirmation, add scene, runtime bar | M6, M7 | ~6 hours |
| M9 | Polling service | Background cron, Neurocore signal polling, plan creation from video-required listings, available_listings population, manual poll trigger, mutex | M2, M3 | ~3 hours |
| M10 | New plan forms | Cover letter form (listing pre-fill, manual entry), YouTube form (topic, description, constraints, runtime), form validation | M4, M7 | ~3 hours |
| M11 | Export shoot instructions | HTML and plain text export, scene data assembly, staleness detection (plan modified since last export), print-friendly layout | M8 | ~3 hours |
| M12 | Available listings browser | Listings page, select-to-plan action, link to created plan | M9, M10 | ~2 hours |
| M13 | Integration testing + polish | End-to-end tests with mocked LLM, UI polish, error states, loading indicators, runtime bar styling | All above | ~4 hours |

**Total estimated DREK build effort:** ~45 hours (~5-6 working days).

**Critical path:** M0 → M1 → M2 → M3 → M4 → M5 → M6 → M8 → M11. The UI milestones (M7, M8, M10, M12) can partially overlap with engine work once M3 lands.

## 13. Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | no | `3003` | HTTP server port |
| `NODE_ENV` | no | `development` | Environment flag |
| `LLM_PROVIDER` | yes | — | `claude` or `codex` |
| `LLM_TIMEOUT_MS` | no | `120000` | Max time for LLM call before kill |
| `NEUROCORE_URL` | yes | — | Neurocore base URL (e.g., `http://localhost:3001`) |
| `NEUROCORE_TOKEN` | yes | — | Bearer token for Neurocore API |
| `GOOGLE_APPLICATION_CREDENTIALS` | yes | — | Path to Firestore service account JSON |
| `POLLING_INTERVAL_MS` | no | `1800000` | Signal polling interval (30 min) |
| `POLLING_ENABLED` | no | `true` | Enable/disable background polling |
| `LOG_LEVEL` | no | `info` | Pino log level |

## 14. File Structure

```
drek/
├── src/
│   ├── index.ts                    # Hono server, pm2 entry point, polling init
│   ├── routes/
│   │   ├── dashboard.ts            # GET / — plan list
│   │   ├── plan.ts                 # GET/POST /plans/:id — detail + actions
│   │   ├── scenes.ts               # HTMX partials — scene CRUD
│   │   ├── listings.ts             # GET /listings — available listings
│   │   ├── export.ts               # GET /plans/:id/export
│   │   └── health.ts               # GET /healthz
│   ├── engine/
│   │   ├── detect-requirements.ts  # LLM Call 1
│   │   ├── match-projects.ts       # LLM Call 2
│   │   ├── generate-scenes.ts      # LLM Call 3
│   │   ├── write-scripts.ts        # LLM Call 4
│   │   └── composition-rules.ts    # COVER_LETTER_RULES, YOUTUBE_RULES constants
│   ├── providers/
│   │   ├── types.ts                # LLMProvider interface
│   │   ├── claude-cli.ts           # ClaudeCLIProvider
│   │   ├── codex-cli.ts            # CodexCLIProvider
│   │   └── index.ts                # Factory — reads LLM_PROVIDER env, returns provider
│   ├── neurocore/
│   │   ├── client.ts               # Neurocore HTTP client
│   │   └── types.ts                # Neurocore response types
│   ├── db/
│   │   ├── firestore.ts            # Firestore init + connection
│   │   ├── plans.ts                # Plan CRUD operations
│   │   ├── scenes.ts               # Scene CRUD operations
│   │   ├── listings.ts             # Available listings CRUD
│   │   └── schemas.ts              # Zod schemas for all collections
│   ├── polling/
│   │   └── service.ts              # Polling cron + manual trigger
│   ├── views/
│   │   ├── layout.ts               # Base HTML layout (head, body wrapper)
│   │   ├── dashboard.ts            # Dashboard page template
│   │   ├── plan-detail.ts          # Plan detail page template
│   │   ├── scene-card.ts           # Scene card component (full + partial)
│   │   ├── export-view.ts          # Shoot instructions template
│   │   ├── listings-view.ts        # Available listings template
│   │   └── components/             # Shared UI components (runtime bar, status badge, etc.)
│   └── lib/
│       ├── runtime-calc.ts         # Target runtime → word count → scene range
│       └── logger.ts               # Pino logger config
├── test/
│   ├── engine/                     # Unit tests for planning engine
│   ├── providers/                  # Provider spawn/parse tests
│   ├── db/                         # Firestore operation tests
│   └── integration/                # Full pipeline tests with mocked LLM
├── static/
│   ├── htmx.min.js                 # Vendored HTMX 2.x
│   └── style.css                   # Minimal utilitarian styles
├── ecosystem.config.js             # pm2 config
├── tsconfig.json
├── package.json
└── vitest.config.ts
```

## 15. Open Questions

None. All blocking questions resolved in the discovery brief and PRD.

---

*Traced from: PRD-drek-2026-05-15.md (commit e1243d7), DISCOVERY-drek.md (commit 2529c23), GAP-SPEC-drek-prerequisites.md (Neurocore repo, commit 5fbb7db). All technical decisions map to discovery decisions D-1 through D-21.*
