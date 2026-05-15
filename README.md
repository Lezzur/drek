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

TypeScript 5 · Node 20 · Hono 4 · Firestore · Claude CLI / Codex CLI · pm2

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

## Production

pm2 ecosystem config in `ecosystem.config.js`. Co-located with Neurocore + PI
on the same VPS — localhost calls between services.

```bash
npm run build
pm2 start ecosystem.config.js
```
