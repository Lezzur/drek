import { Hono } from 'hono';
import { logger as honoLogger } from 'hono/logger';
import { logger } from './logger.js';
import admin from './routes/admin.js';
import health from './routes/health.js';
import models from './routes/models.js';
import dashboard from './routes/dashboard.js';
import plan from './routes/plan.js';
import workshop from './routes/workshop.js';
import scenes from './routes/scenes.js';
import newPlan from './routes/new-plan.js';
import exportRoutes from './routes/export.js';
import listings from './routes/listings.js';
import settings from './routes/settings.js';
import intake from './routes/intake.js';
import deliverables from './routes/deliverables.js';
import footage from './routes/footage.js';
import publish from './routes/publish.js';
import shorts from './routes/shorts.js';

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

  app.route('/', admin);
  app.route('/', health);
  app.route('/', models);
  // New-plan forms must be mounted BEFORE plan detail so /plans/new/... beats
  // the /plans/:id wildcard. Scene partials must come before plan detail for
  // the same reason — more-specific paths win.
  app.route('/', intake);
  app.route('/', newPlan);
  app.route('/', scenes);
  // Export routes mounted before plan-detail so /plans/:id/export.txt
  // and /plans/:id/export both win against /plans/:id wildcard.
  app.route('/', exportRoutes);
  // Workshop routes must come BEFORE plan so /plans/:id/workshop/hooks
  // wins against the /plans/:id wildcard.
  app.route('/', workshop);
  app.route('/', deliverables);
  app.route('/', publish);
  app.route('/', shorts);
  app.route('/', footage);
  app.route('/', plan);
  app.route('/', listings);
  app.route('/', settings);
  app.route('/', dashboard);

  return app;
}
