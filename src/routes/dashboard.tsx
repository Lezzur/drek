import { Hono } from 'hono';
import { z } from 'zod';
import { logger } from '../logger.js';
import { listPlans, patchPlan } from '../db/plans.js';
import { readPollingConfig } from '../db/config.js';
import { runPollCycle } from '../polling/service.js';
import { enqueuePipeline } from '../engine/auto-pipeline.js';
import { getNeurocoreClient } from '../neurocore/index.js';
import { DashboardPage, PollResult, staleCutoff } from '../views/dashboard.js';
import { PLAN_STATUSES, PLAN_TYPES, type PlanStatus, type PlanType } from '../db/schemas.js';

const app = new Hono();

const filterSchema = z.object({
  type: z.enum(PLAN_TYPES).optional(),
  status: z.enum(PLAN_STATUSES).optional(),
});

app.get('/', async (c) => {
  const queryParams = Object.fromEntries(new URL(c.req.url).searchParams);
  const filter = filterSchema.safeParse(queryParams);
  const f = filter.success ? filter.data : {};
  const { plans } = await listPlans({
    ...(f.type ? { type: f.type } : {}),
    ...(f.status ? { status: f.status } : {}),
    limit: 200,
  });
  const cfg = await readPollingConfig();
  const lastPollAt = cfg.lastPollAt ? cfg.lastPollAt.toISOString() : null;
  return c.html(
    <DashboardPage
      plans={plans}
      filter={f as { type?: PlanType; status?: PlanStatus }}
      lastPollAt={lastPollAt}
      freshWindowDays={cfg.autoRunMaxAgeDays}
    />,
  );
});

/**
 * POST /poll — manual "Check now" trigger. Runs one poll cycle and returns
 * an HTMX-friendly flash partial that auto-refreshes the dashboard one
 * second later (so Rick sees the newly ingested plans).
 */
app.post('/poll', async (c) => {
  try {
    const result = await runPollCycle();
    return c.html(
      <PollResult
        createdPlans={result.createdPlans}
        queuedPipelines={result.queuedPipelines}
        skipped={result.skipped}
        failed={result.failed}
        disabled={result.disabled}
      />,
    );
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'manual poll failed');
    return c.html(
      <PollResult createdPlans={0} queuedPipelines={0} skipped={0} failed={1} disabled={false} />,
    );
  }
});

/**
 * POST /plans/:id/dismiss — soft-skip a polled listing Rick doesn't want
 * to plan for. HTMX swaps the row out of the table on success.
 */
app.post('/plans/:id/dismiss', async (c) => {
  const id = c.req.param('id');
  try {
    await patchPlan(id, { status: 'dismissed' });
    return c.html('');
  } catch (err) {
    logger.warn({ id, err: (err as Error).message }, 'dismiss failed');
    return c.json({ error: 'dismiss failed' }, 500);
  }
});

/**
 * POST /plans/:id/queue-row — dashboard row action: hand a plan to the
 * background pipeline. Responds with a full-page refresh so the plan
 * moves into the "In pipeline" section.
 */
app.post('/plans/:id/queue-row', async (c) => {
  const id = c.req.param('id');
  try {
    await enqueuePipeline(id, { client: getNeurocoreClient() });
  } catch (err) {
    logger.warn({ id, err: (err as Error).message }, 'queue-row failed');
  }
  c.header('HX-Redirect', '/');
  return c.text('', 200);
});

/**
 * POST /plans/dismiss-stale — bulk-dismiss every awaiting_review plan
 * older than the fresh window. This is what clears a month of dead
 * listings in one click instead of 50.
 */
app.post('/plans/dismiss-stale', async (c) => {
  try {
    const cfg = await readPollingConfig();
    const cutoff = staleCutoff(cfg.autoRunMaxAgeDays);
    const { plans } = await listPlans({ status: 'awaiting_review', limit: 200 });
    let dismissed = 0;
    for (const p of plans) {
      if (p.createdAt.getTime() < cutoff.getTime() && p.pipelineState === 'idle') {
        await patchPlan(p.id, { status: 'dismissed' });
        dismissed++;
      }
    }
    logger.info({ dismissed }, 'bulk-dismissed stale plans');
    c.header('HX-Redirect', '/');
    return c.text('', 200);
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'dismiss-stale failed');
    return c.json({ error: 'dismiss-stale failed' }, 500);
  }
});

export default app;
