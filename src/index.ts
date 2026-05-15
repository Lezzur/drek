import { serve } from '@hono/node-server';
import { createApp } from './server.js';
import { getEnv } from './env.js';
import { logger } from './logger.js';
import { getDb } from './db/firestore.js';
import { startScheduler } from './lib/scheduler.js';
import { refreshModelCatalog } from './models/catalog.js';
import { makePollingJob } from './polling/service.js';

const env = getEnv();
const app = createApp();

serve(
  { fetch: app.fetch, port: env.PORT },
  (info) => {
    logger.info(
      { port: info.port, env: env.NODE_ENV, projectId: env.GCP_PROJECT_ID },
      'drek listening',
    );

    // Prime the Firestore gRPC connection so the first request doesn't pay
    // the cold-connect cost. Mirrors Neurocore's warmup pattern. Best-effort —
    // a missing credential file or auth glitch shouldn't take down the server,
    // just disable Firestore-backed routes until it's fixed (health check will
    // surface the failure).
    if (env.NODE_ENV !== 'test') {
      try {
        const t0 = Date.now();
        void getDb()
          .collection('_warmup')
          .limit(1)
          .get()
          .then(() => logger.info({ ms: Date.now() - t0 }, 'firestore warmup complete'))
          .catch((err) => logger.warn({ err }, 'firestore warmup failed'));
      } catch (err) {
        logger.warn({ err: (err as Error).message }, 'firestore init failed; running without it');
      }

      // Schedulers: model-catalog refresh + listing-poll. Both interval-based.
      // The poll job reads its enabled flag from Firestore (config/polling)
      // so Rick can toggle without redeploy.
      startScheduler([
        {
          name: 'model-catalog-refresh',
          intervalMs: env.MODEL_REFRESH_INTERVAL_HOURS * 60 * 60 * 1000,
          run: async () => { await refreshModelCatalog(); },
        },
        makePollingJob(),
      ]);

      // One-shot startup refresh ~30s after boot so the catalog populates on
      // a fresh deploy without waiting for the first interval tick. Best-effort.
      setTimeout(() => {
        void refreshModelCatalog().catch((err) =>
          logger.warn({ err }, 'startup model refresh failed'),
        );
      }, 30_000);
    }
  },
);
