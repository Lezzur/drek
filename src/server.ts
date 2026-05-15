import { Hono } from 'hono';
import { logger as honoLogger } from 'hono/logger';
import { logger } from './logger.js';
import health from './routes/health.js';
import models from './routes/models.js';
import dashboard from './routes/dashboard.js';

/**
 * Build the Hono app. Kept as a factory so tests can construct fresh instances
 * with isolated state.
 */
export function createApp(): Hono {
  const app = new Hono();

  app.use('*', honoLogger((msg) => logger.info({ http: msg }, 'http')));

  app.onError((err, c) => {
    logger.error({ err: err.message, stack: err.stack, path: c.req.path }, 'unhandled error');
    return c.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
      500,
    );
  });

  app.notFound((c) =>
    c.json(
      { error: { code: 'NOT_FOUND', message: `${c.req.method} ${c.req.path} not found` } },
      404,
    ),
  );

  app.route('/', health);
  app.route('/', models);
  app.route('/', dashboard);

  return app;
}
