import { serve } from '@hono/node-server';
import { createApp } from './server.js';
import { getEnv } from './env.js';
import { logger } from './logger.js';
import { getDb } from './db/firestore.js';
import { startScheduler } from './lib/scheduler.js';
import { refreshModelCatalog } from './models/catalog.js';
import { makePollingJob } from './polling/service.js';
import { recoverAndBackfill } from './engine/auto-pipeline.js';
import { initializeWriteQueue } from './neurocore/write-queue.js';
import { refreshStackPerformance } from './cron/refresh-stack-performance.js';
import { dailyAt } from './lib/scheduler.js';
import { initModelConfigCache } from './engine/model-config.js';
import { createShutdownHandler } from './shutdown.js';

const env = getEnv();
const app = createApp();

const server = serve(
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
        // 04:00 UTC = quiet hours. Aggregates YouTube analytics into
        // Neurocore StackPerformance once a day. Best-effort: errors
        // are logged, never escalate to taking down the service.
        {
          name: 'refresh-stack-performance',
          matches: dailyAt(4, 0),
          run: async () => {
            try {
              await refreshStackPerformance();
            } catch (err) {
              logger.warn(
                { err: (err as Error).message },
                'refresh-stack-performance failed (next run in 24h)',
              );
            }
          },
        },
      ]);

      // One-shot startup refresh ~30s after boot so the catalog populates on
      // a fresh deploy without waiting for the first interval tick. Best-effort.
      setTimeout(() => {
        void refreshModelCatalog().catch((err) =>
          logger.warn({ err }, 'startup model refresh failed'),
        );
      }, 30_000);

      // Kick off model-config cache boot fetch (background, non-blocking).
      // DREK will fall back to env defaults if Neurocore is unreachable at boot.
      initModelConfigCache();

      // Auto-pipeline boot pass ~10s after start (lets Firestore warm up):
      // re-enqueue plans a crash left queued/running, and backfill fresh
      // awaiting_review listings that never ran. Best-effort.
      setTimeout(() => {
        void recoverAndBackfill().catch((err) =>
          logger.warn({ err: (err as Error).message }, 'auto-pipeline boot pass failed'),
        );
      }, 10_000);

      // Recover the Neurocore write queue from disk (if WORKSPACE_ROOT is set)
      // and start the 30s drain worker. Best-effort: a recovery failure
      // shouldn't take down the server, just disables durable retries until
      // the next boot.
      void initializeWriteQueue().catch((err) =>
        logger.warn({ err: (err as Error).message }, 'neurocore-write-queue init failed'),
      );
    }
  },
);

// Graceful shutdown: kill in-flight LLM children, stop accepting connections,
// then exit. See src/shutdown.ts for the (unit-tested) logic.
const shutdown = createShutdownHandler({ server });
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
