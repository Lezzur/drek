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
├── index.ts          # entry — starts Hono server, warms Firestore
├── server.ts         # Hono app factory
├── env.ts            # zod-validated env (loaded eagerly)
├── logger.ts         # pino structured JSON logging
├── db/firestore.ts   # Firebase Admin SDK init
└── routes/
    └── health.ts     # GET /healthz
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
