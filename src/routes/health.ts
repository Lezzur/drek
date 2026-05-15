import { Hono } from 'hono';
import { getDb } from '../db/firestore.js';
import { logger } from '../logger.js';

const app = new Hono();

/**
 * GET /healthz — liveness + readiness.
 *
 * Returns 200 with check details when everything's healthy. Returns 503 with
 * the same shape (status='degraded') when Firestore is unreachable, so load
 * balancers / pm2 / uptime monitors can detect actual outages without
 * misinterpreting a slow boot.
 */
app.get('/healthz', async (c) => {
  let firestore: 'ok' | 'error' = 'ok';
  let firestoreError: string | null = null;

  try {
    const t0 = Date.now();
    await getDb().collection('_warmup').limit(1).get();
    logger.debug({ ms: Date.now() - t0 }, 'firestore healthcheck');
  } catch (err) {
    firestore = 'error';
    firestoreError = (err as Error).message;
  }

  const allOk = firestore === 'ok';
  const body = {
    status: allOk ? 'ok' : 'degraded',
    service: 'drek',
    uptime: process.uptime(),
    checks: {
      firestore,
      ...(firestoreError ? { firestoreError } : {}),
    },
  };

  return c.json(body, allOk ? 200 : 503);
});

export default app;
