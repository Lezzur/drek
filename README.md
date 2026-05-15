# DREK — AI Video Director

Pre-production planning and scripting for Rick's video workflow. DREK takes a
job listing (via Neurocore signal polling) or a manual topic, queries Neurocore
for the right projects, generates scene cards with full spoken-word scripts,
and exports shoot instructions you record from.

Specs live next to the code:

- [`DISCOVERY-drek.md`](./DISCOVERY-drek.md) — problem space, decisions
- [`PRD-drek-2026-05-15.md`](./PRD-drek-2026-05-15.md) — features, user flows, data model
- [`TECH-SPEC-drek-2026-05-15.md`](./TECH-SPEC-drek-2026-05-15.md) — architecture, milestones

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

## Test coverage

```bash
npm test
```

300+ tests covering: env validation, all four LLM provider error paths,
Neurocore client retry + auth + timeout, Firestore CRUD + scene reorder
+ plan transition rules, every engine step's happy/retry/failure paths,
polling cycle (dedup, partial failure, mutex, disabled state, ack
failure), HTML views (every page + HTMX partial), and end-to-end
integration of the full pipeline including a polling-triggered run
and mid-pipeline failure recovery (skipScenes=true).

