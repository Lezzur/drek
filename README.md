# DREK — AI Video Director

Pre-production planning and scripting for Rick's video workflow. DREK takes a
job listing (via Neurocore signal polling) or a manual topic, queries Neurocore
for the right projects, generates scene cards with full spoken-word scripts,
and exports shoot instructions you record from.

Specs live next to the code:

- [`DISCOVERY-drek.md`](./DISCOVERY-drek.md) — problem space, decisions
- [`PRD-drek-2026-05-15.md`](./PRD-drek-2026-05-15.md) — v1 features, user flows, data model
- [`TECH-SPEC-drek-2026-05-15.md`](./TECH-SPEC-drek-2026-05-15.md) — v1 architecture, milestones
- [`PRD-drek-v2-youtube-2026-05-18.md`](./PRD-drek-v2-youtube-2026-05-18.md) — v2 YouTube channel operating system
- [`TECH-SPEC-drek-v2-youtube-2026-05-18.md`](./TECH-SPEC-drek-v2-youtube-2026-05-18.md) — v2 architecture, 9 module additions
- [`TECH-SPEC-drek-v2.1-content-substrate-2026-05-19.md`](./TECH-SPEC-drek-v2.1-content-substrate-2026-05-19.md) — v2.1 cross-app content substrate, Brief Transformer, YouTube client
- [`CHANGELOG.md`](./CHANGELOG.md) — release notes

## Stack

TypeScript 5 · Node 20 · Hono 4 · Firestore · Claude CLI / Codex CLI · NSSM
(Windows Service)

DREK runs on the same Windows host as PI and Neurocore — co-located so every
inter-service call is localhost. NSSM wraps the Node process as a Windows
service (no pm2; PI hit ghost-process and port-lock issues on Windows).

DREK is a Neurocore consumer. It does not talk to PI directly — all PI signals
flow through Neurocore as the hub-and-spoke pattern (Discovery D-3).

## Quick start

```bash
npm install
cp .env.example .env
# fill in GCP_PROJECT_ID + point GOOGLE_APPLICATION_CREDENTIALS at your
# Firebase service-account JSON for the DREK project (separate from Neurocore)

npm run dev          # tsx watch
npm run build        # tsc compile to dist/
npm run start        # node dist/index.js
npm test             # vitest
npm run typecheck    # tsc --noEmit
npm run lint         # eslint
```

## Layout

```
src/
├── index.ts             # entry — starts Hono server, schedulers, warms Firestore
├── server.ts            # Hono app factory
├── env.ts               # zod-validated env (lazy via getEnv())
├── logger.ts            # pino structured JSON logging
├── db/                  # Firestore CRUD + Zod schemas
│   ├── firestore.ts     # Firebase Admin init
│   ├── schemas.ts       # Plan, Scene, AvailableListing, PollingConfig
│   ├── plans.ts         # plan CRUD + transition rules
│   ├── scenes.ts        # scene subcollection CRUD + reorder
│   ├── listings.ts      # available_listings CRUD
│   └── config.ts        # polling config read/patch
├── providers/           # LLM provider abstraction
│   ├── types.ts         # LLMProvider interface + LLMProviderError
│   ├── cli-runner.ts    # hardened subprocess wrapper (timeout/retry/circuit)
│   ├── claude-cli.ts    # Claude CLI provider
│   ├── codex-cli.ts     # OpenAI Codex CLI provider
│   └── index.ts         # memoized factory (LLM_PROVIDER env)
├── neurocore/           # Neurocore HTTP client
│   ├── client.ts        # 5 methods: context, voice, poll, ack, send-script
│   ├── errors.ts        # NeurocoreError + retry heuristic
│   └── types.ts
├── engine/              # planning pipeline — the four LLM calls
│   ├── detect-requirements.ts  # Call 1: extract video requirements
│   ├── match-projects.ts       # Call 2: pick projects to feature
│   ├── generate-scenes.ts      # Call 3: produce scene cards (no scripts)
│   ├── write-scripts.ts        # Call 4: write spoken scripts + composite
│   ├── composition-rules.ts    # COVER_LETTER_RULES / YOUTUBE_RULES + runtime calc
│   ├── json-utils.ts           # tolerant JSON extractor (fence-stripping, etc.)
│   └── errors.ts               # PlanningEngineError
├── polling/             # background cron that pulls listings from Neurocore
│   └── service.ts
├── models/              # model catalog refresh cron (Anthropic + OpenAI)
│   ├── anthropic.ts
│   ├── openai.ts
│   ├── catalog.ts
│   ├── store.ts
│   └── types.ts
├── lib/scheduler.ts     # in-process interval/cron scheduler
├── views/               # Hono JSX + HTMX server-rendered UI
│   ├── layout.tsx       # shared HTML shell + CSS
│   ├── dashboard.tsx    # plan list + Check now + filters
│   ├── plan-detail.tsx  # plan view with runtime bar + action strip
│   ├── scene-card.tsx   # scene card + list, HTMX-driven
│   ├── new-plan.tsx     # cover letter + YouTube forms
│   ├── export.tsx       # printable shoot instructions
│   └── listings.tsx     # available listings browser
└── routes/              # Hono route handlers
    ├── health.ts        # GET /healthz
    ├── models.ts        # GET /v1/models
    ├── dashboard.tsx    # GET /, POST /poll, POST /plans/:id/dismiss
    ├── plan.tsx         # GET /plans/:id + analyze/match/generate/finalize
    ├── scenes.tsx       # HTMX partials for scene editing
    ├── new-plan.tsx     # /plans/new/cover-letter, /plans/new/youtube
    ├── export.tsx       # /plans/:id/export, /plans/:id/export.txt
    └── listings.tsx     # /listings
```

Health check: `curl http://localhost:3003/healthz`

## Production (Windows + NSSM)

```powershell
# One-time: install nssm.exe on PATH (e.g., via choco install nssm or manual).
# Then, from a PowerShell run as Administrator:
cd F:\claude-code\claude_projects\drek
npm install
npm run build
.\scripts\nssm-setup.ps1
```

`scripts/nssm-setup.ps1` registers DREK as a Windows service named `DREK`,
points it at `dist/index.js`, rotates logs at 10 MB into `logs/`, and tails the
health endpoint to confirm it's up. Re-running the script tears down and
reinstalls the service — safe to run after each `npm run build`.

For dev iteration use `npm run dev` interactively, not the service.

## How a video gets made

```
PI ingests a listing
    │
    ▼
PI emits listing.ingested signal to Neurocore
    │
    ▼
DREK polling cron (or "Check now" button) discovers it
    │
    ▼
DREK creates a Plan (awaiting_review) + ack to Neurocore
    │
    ▼
Rick clicks Analyze requirements  →  LLM Call 1   →  requirements_reviewed
    │
    ▼
Rick clicks Match projects        →  LLM Call 2   →  projects_matched
    │   (Neurocore inlines PI's per-listing fit-score insight —
    │    proposalHooks, businessProfile, quickWins, redFlags)
    ▼
Rick clicks Generate              →  LLM Calls 3+4 → scenes_generated
    │
    ▼
Rick edits scene cards (click-to-edit, HTMX auto-save)
    │
    ▼
Rick clicks Finalize              →  finalized
    │   (DREK sends approved scripts back to Neurocore as
    │    spoken-voice training data — Gap 4 Phase 2 feedback loop)
    ▼
Rick clicks Export shoot instructions → exported
    │
    ▼
Loom open. Rick records from the printed/screen-side shoot instructions.
```

YouTube plans skip Call 1 (no listing to analyze) and start directly
in `requirements_reviewed`. Everything else is identical.

## v2 — YouTube Channel Operating System

v2 extends DREK from "writes scripts" to "runs a YouTube channel." The
existing v1 surface (cover-letter + youtube-lite plans) is unchanged.
The new `youtube_advanced` plan type drives a 9-module pipeline:

| Module | What it produces |
|---|---|
| **Intake** | Pipeline briefs scored by LLM (`PipelineBrief` entity) — promote-to-plan creates the Plan + long-form Deliverable in one batch |
| **Workspace** | Per-plan folder under `$WORKSPACE_ROOT/<planId>-<slug>/` with subdirs `brief/ briefs/ scripts/ shotlist/ recordings/ assets/ exports/` (security-hardened: traversal-rejecting slug regex, atomic temp+rename writes, lstat symlink rejection, 10MB cap) |
| **Format profiles** | Local TypeScript registry of episode-shape templates (`claude_code_build_along` ships; 6 more deferred to v2.1). Plus AudienceProfile from Neurocore — every v2 LLM call composes both via `buildSystemPrompt({ formatProfile, audienceProfile })` |
| **Hook engineering** | 3-4 hook variants per episode, Rick picks one; scene 1's script becomes the selected hook verbatim |
| **Shot list** | Per-scene primary shot + B-roll + on-screen text + cut points, batched per plan |
| **Title workshop** | 5-10 title variants per Deliverable (long-form + per Short); Rick picks |
| **Thumbnail workshop** | 3-5 text-only thumbnail concepts (composition + textHook + palette + assetsRequired) — actual image production stays in Figma/Photoshop/Canva |
| **Publishing metadata** | Description + chapters (timestamps auto-computed from scene durations, labels LLM-named) + 10-15 tags + pinned comment + end-screen suggestion. Plain-text bundle paste-ready for YouTube Studio |
| **Shorts extractor** | 3-5 candidate Shorts from the long-form scripts using a hardcoded beat-importance heuristic; approving a candidate spawns a short_clip Deliverable bound to `business_owner_shorts` audience |
| **Footage manifest** | Recording session log with per-scene coverage tracking |

When Rick marks a Deliverable as published with a YouTube URL,
DREK fires `script.published` to Neurocore (best-effort — local
publish never blocks on signal failure) including the
selectedHookArchetype / selectedTitleArchetype / selectedThumbnail
composition so Neurocore can correlate creative choices with
eventual performance.

### How a YouTube episode gets made (v2)

```
Brief in intake (manual paste OR future Neurocore signal)
    │
    ▼  Call 11: LLM scoring (visualOutcome / storyPotential / scopeFit / audienceMatch)
Rick promotes to youtube_advanced plan
    │  (one batch: Plan + long-form Deliverable + workspace folder)
    ▼
Call 1 (v2): episode requirements from brief
    │
    ▼
Call 2: project matches from Neurocore catalog
    │
    ▼
Call 3 (v2): scene cards tagged with format-profile beats
    │
    ▼
Call 5: hook variants → Rick picks one in the Hook Workshop
    │
    ▼
Call 4 (v2): scripts written, scene 1 = selected hook verbatim
    │
    ▼
Call 6: shot list (primary + B-roll + cut points + on-screen text)
    │
    ▼
Call 7: title variants → Rick picks one in the Title Workshop
    │
    ▼
Call 8: thumbnail concepts → Rick picks one in the Thumbnail Workshop
    │
    ▼
Call 9: Shorts extraction → Rick approves N → each becomes a Deliverable
    │
    ▼  (Rick edits scripts in workshop UIs, logs recording sessions as he shoots)
Rick finalizes plan
    │
    ▼
Call 10: publishing metadata (description + chapters + tags + pinned + endscreen)
    │
    ▼
Per Deliverable: title → thumbnail → publish metadata → export bundle
    │
    ▼
Rick uploads to YouTube, pastes URL into "Mark as published"
    │
    ▼
script.published signal → Neurocore (audience+hook+title+thumb correlated with future viewcounts)
```

### v2 env additions

| Var | Purpose |
|---|---|
| `WORKSPACE_ROOT` | Absolute path to the per-plan workspace root (Rick's setup: `F:\drek-workspace`). Must exist and be writable. Health-checked via `validateWorkspaceRoot()`. |

### v2 status enum additions

The Plan state machine adds 9 statuses (only reachable from
`youtube_advanced` plans; v1 plans never visit them):

```
hooks_generated → hook_selected → shot_list_generated →
titles_generated → title_selected → thumbnails_generated →
thumbnail_selected → shorts_extracted → finalized →
metadata_generated → exported
```

### Format-profile / mode-blending guarantee

`buildSystemPrompt()` is the single composition gate. It asserts that
exactly one of `{v1CompositionRules}` OR `{formatProfile +
audienceProfile}` is provided — if both or neither are passed it
throws `PromptCompositionError`. This makes v1↔v2 mode-blending
impossible by construction.

## Test coverage

```bash
npm test
```

800+ tests covering: env validation, all four LLM provider error paths,
Neurocore client retry + auth + timeout + script.published signal,
Firestore CRUD + scene reorder + plan transition rules, every engine
step's happy/retry/failure paths (v1 + v2), polling cycle (dedup,
partial failure, mutex, disabled state, ack failure), workspace
security (path traversal, slug validation, atomic writes,
WORKSPACE_ROOT health), HTML views (every page + HTMX partial,
including all v2 workshop UIs), and end-to-end integration of both
the v1 pipeline AND the full v2 youtube_advanced flow
(`tests/integration/v2-full-pipeline.test.ts`: long-form happy path,
Shorts per-deliverable, change-format wipe-and-revert, AudienceProfile
unavailability, published-signal failure non-fatal, URL allowlist
enforcement).

