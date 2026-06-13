import { Hono } from 'hono';
import { getDb } from '../db/firestore.js';
import { logger } from '../logger.js';
import { queueDepth, deadLetterCount } from '../neurocore/write-queue.js';
import { pipelineQueueStats } from '../engine/auto-pipeline.js';
import { getYouTubeClient } from '../youtube/client.js';

const app = new Hono();

/**
 * GET /healthz — liveness + readiness.
 *
 * Returns 200 with check details when everything's healthy. Returns 503 with
 * the same shape (status='degraded') when Firestore is unreachable, so load
 * balancers / pm2 / uptime monitors can detect actual outages without
 * misinterpreting a slow boot.
 *
 * Neurocore write-queue depth + dead-letter count are surfaced as soft
 * signals — a non-zero dead-letter count never flips the response to 503,
 * but it does flip `checks.neurocoreWriteQueue` to `warn` so monitoring
 * dashboards can page on it independently.
 */
app.get('/healthz', async (c) => {
  let firestore: 'ok' | 'error' = 'ok';

  try {
    const t0 = Date.now();
    await getDb().collection('_warmup').limit(1).get();
    logger.debug({ ms: Date.now() - t0 }, 'firestore healthcheck');
  } catch (err) {
    firestore = 'error';
    // Log the real Firestore error for operators, but never put it in the
    // unauthenticated /healthz body — it can leak project id, gRPC status,
    // or a missing-index URL to anyone who can reach the endpoint.
    logger.error({ err: (err as Error).message }, 'firestore healthcheck failed');
  }

  const writeQueueDepth = queueDepth();
  const deadLetters = await deadLetterCount();

  // YouTube client — soft signal. Not-configured is acceptable in dev
  // and never flips to 503; quota over 80% surfaces as 'warn'.
  let youtubeConfigured = false;
  let youtubeQuotaUtil = 0;
  try {
    const yt = getYouTubeClient();
    youtubeConfigured = yt.isConfigured();
    youtubeQuotaUtil = yt.quotaSnapshot().utilization;
  } catch {
    // Constructor would only throw on a real env validation failure
    // — treat as 'not configured' for health-check purposes.
  }
  const youtubeStatus: 'ok' | 'warn' | 'not_configured' = !youtubeConfigured
    ? 'not_configured'
    : youtubeQuotaUtil >= 0.8
      ? 'warn'
      : 'ok';

  const allOk = firestore === 'ok';
  const body = {
    status: allOk ? 'ok' : 'degraded',
    service: 'drek',
    uptime: process.uptime(),
    checks: {
      firestore,
      neurocoreWriteQueue: deadLetters > 0 ? ('warn' as const) : ('ok' as const),
      neurocoreWriteQueueDepth: writeQueueDepth,
      neurocoreDeadLetterCount: deadLetters,
      youtube: youtubeStatus,
      youtubeQuotaUtilization: Math.round(youtubeQuotaUtil * 100) / 100,
      // Auto-pipeline: depth counts plans waiting; active means one is
      // mid-generation right now. Soft signals, never flip to 503.
      autoPipelineQueueDepth: pipelineQueueStats().depth,
      autoPipelineActive: pipelineQueueStats().draining,
    },
  };

  return c.json(body, allOk ? 200 : 503);
});

export default app;
