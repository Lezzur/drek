import { Hono } from 'hono';
import { refreshModelConfig } from '../engine/model-config.js';
import { logger } from '../logger.js';

const app = new Hono();

/**
 * POST /admin/refresh-model-config
 *
 * Triggers an immediate model-config cache refresh from Neurocore. Use this
 * after updating model selections in the Neurocore Settings UI — DREK's
 * 15-minute auto-refresh will pick it up eventually, but this makes the
 * change instant without a restart.
 */
app.post('/admin/refresh-model-config', async (c) => {
  try {
    await refreshModelConfig();
    logger.info('model-config: manually refreshed via admin endpoint');
    return c.json({ refreshed: true });
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'model-config: manual refresh failed');
    return c.json({ refreshed: false, error: 'Internal server error' }, 500);
  }
});

export default app;
