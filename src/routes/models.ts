import { Hono } from 'hono';
import { getCatalog } from '../models/catalog.js';

const app = new Hono();

/**
 * GET /v1/models — return the cached model catalog. Always 200, even when
 * fetches failed: the response includes per-provider `fetched`/`error` so
 * the dashboard can show "fetch failed, falling back to env" without DREK
 * itself going degraded.
 */
app.get('/v1/models', async (c) => {
  const catalog = await getCatalog();
  return c.json(catalog);
});

export default app;
