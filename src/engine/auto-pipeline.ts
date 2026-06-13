import type { Firestore } from 'firebase-admin/firestore';
import { logger } from '../logger.js';
import { getPlan, listPlans, patchPlan } from '../db/plans.js';
import { readPollingConfig } from '../db/config.js';
import { withPlanLock } from '../lib/plan-locks.js';
import { runPipeline } from './pipeline.js';
import type { NeurocoreClient } from '../neurocore/index.js';
import type { Plan, PollingConfig } from '../db/schemas.js';

/**
 * Auto-pipeline — the background worker that turns polled listings into
 * ready-to-record scripts without Rick clicking anything.
 *
 * Why this exists: a month of production data showed 61/67 plans parked
 * at awaiting_review and exactly one that ever got scenes. The pipeline
 * worked; the *workflow* didn't — every plan required a manual
 * "Run pipeline" click that blocks a browser tab for minutes of CLI LLM
 * calls. Cover-letter listings decay in days, so by the time anyone
 * clicked, the listing was dead. The fix is to run the pipeline the
 * moment a listing is ingested, serially, in the background.
 *
 * Design:
 *   - In-process FIFO, one pipeline at a time. The CLI providers are
 *     heavyweight subprocesses with their own retry + circuit breaker;
 *     serial execution keeps load sane and failure blast-radius small.
 *   - `pipelineState` on the Plan doc ('idle'|'queued'|'running'|'failed')
 *     is the UI's window into the queue, and makes crashes recoverable:
 *     on boot, anything stuck in queued/running is re-enqueued.
 *   - Eligibility is config-gated (config/polling): `autoRunPipeline`
 *     toggles the whole behavior; `autoRunMaxAgeDays` is the fresh
 *     window — listings older than that are dead and never auto-run.
 *   - Single-process app (NSSM service), so an in-memory queue + the
 *     per-plan lock is sufficient; no distributed coordination needed.
 */

export interface AutoPipelineOptions {
  db?: Firestore;
  client?: NeurocoreClient;
}

// Statuses the v1 pipeline can legally advance. Anything else (dismissed,
// scenes_generated and beyond) is skipped at execution time — the plan may
// have moved while queued.
const RUNNABLE_STATUSES: ReadonlySet<string> = new Set([
  'awaiting_review',
  'requirements_reviewed',
  'projects_matched',
]);

const queue: string[] = [];
const queued = new Set<string>();
let draining = false;

/** True when `plan` is something the auto-pipeline should pick up on its
 *  own: a fresh, untouched, polled cover letter. (Manual enqueues via the
 *  UI bypass this — Rick can queue anything runnable.) */
export function isAutoRunEligible(plan: Plan, cfg: PollingConfig, now = new Date()): boolean {
  if (plan.type !== 'cover_letter') return false;
  if (plan.status !== 'awaiting_review') return false;
  if (plan.pipelineState !== 'idle') return false;
  const ageMs = now.getTime() - plan.createdAt.getTime();
  return ageMs <= cfg.autoRunMaxAgeDays * 24 * 60 * 60 * 1000;
}

/**
 * Add a plan to the pipeline queue. Returns false when it's already
 * queued/running or the plan isn't in a runnable status. Marks the doc
 * `queued` before returning so the UI reflects it immediately.
 */
export async function enqueuePipeline(
  planId: string,
  opts: AutoPipelineOptions = {},
): Promise<boolean> {
  if (queued.has(planId)) return false;
  const plan = await getPlan(planId, opts.db);
  if (!plan) return false;
  if (!RUNNABLE_STATUSES.has(plan.status)) return false;
  queued.add(planId);
  queue.push(planId);
  await patchPlan(planId, { pipelineState: 'queued', pipelineError: null }, opts.db);
  logger.info({ planId, depth: queue.length }, 'auto-pipeline: enqueued');
  void drain(opts);
  return true;
}

/** Queue depth + in-flight flag, surfaced on the dashboard. */
export function pipelineQueueStats(): { depth: number; draining: boolean } {
  return { depth: queue.length, draining };
}

async function drain(opts: AutoPipelineOptions): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    for (;;) {
      const planId = queue.shift();
      if (planId === undefined) break;
      try {
        await runOne(planId, opts);
      } finally {
        queued.delete(planId);
      }
    }
  } finally {
    draining = false;
  }
}

async function runOne(planId: string, opts: AutoPipelineOptions): Promise<void> {
  const plan = await getPlan(planId, opts.db);
  if (!plan) return;
  if (!RUNNABLE_STATUSES.has(plan.status)) {
    // Dismissed (or otherwise advanced) while waiting — quietly stand down.
    await patchPlan(planId, { pipelineState: 'idle' }, opts.db);
    logger.info({ planId, status: plan.status }, 'auto-pipeline: skipped, not runnable');
    return;
  }
  await patchPlan(planId, { pipelineState: 'running' }, opts.db);
  const t0 = Date.now();
  try {
    const result = await withPlanLock(planId, () => runPipeline(planId, opts));
    await patchPlan(planId, { pipelineState: 'idle', pipelineError: null }, opts.db);
    logger.info(
      {
        planId,
        ms: Date.now() - t0,
        scenes: result.scriptsResult.scenes.length,
        degraded: result.matchResult.degraded || result.scriptsResult.degraded,
      },
      'auto-pipeline: plan completed',
    );
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    await patchPlan(planId, { pipelineState: 'failed', pipelineError: message }, opts.db).catch(
      () => undefined,
    );
    logger.warn({ planId, ms: Date.now() - t0, err: message }, 'auto-pipeline: plan failed');
  }
}

/**
 * Boot pass. Two jobs:
 *   1. Crash recovery — plans stuck in queued/running from a previous
 *      process re-enter the queue.
 *   2. Backfill — fresh awaiting_review cover letters that never ran
 *      (service was down when they were polled, or auto-run was off)
 *      get queued, newest first.
 * Both respect the `autoRunPipeline` config switch; recovery of plans Rick
 * queued manually still happens even when auto-run is off, since those
 * carry an explicit queued/running state.
 */
export async function recoverAndBackfill(
  opts: AutoPipelineOptions = {},
): Promise<{ recovered: number; backfilled: number }> {
  const cfg = await readPollingConfig(opts.db);
  const { plans } = await listPlans({ limit: 200 }, opts.db);

  let recovered = 0;
  for (const p of plans) {
    if (p.pipelineState === 'queued' || p.pipelineState === 'running') {
      // Reset to idle first so enqueuePipeline's own bookkeeping applies
      // cleanly; enqueue re-marks it queued.
      await patchPlan(p.id, { pipelineState: 'idle' }, opts.db);
      const fresh = await getPlan(p.id, opts.db);
      if (fresh && RUNNABLE_STATUSES.has(fresh.status)) {
        if (await enqueuePipeline(p.id, opts)) recovered++;
      }
    }
  }

  let backfilled = 0;
  if (cfg.autoRunPipeline) {
    const eligible = plans
      .filter((p) => isAutoRunEligible(p, cfg))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    for (const p of eligible) {
      if (await enqueuePipeline(p.id, opts)) backfilled++;
    }
  }

  if (recovered > 0 || backfilled > 0) {
    logger.info({ recovered, backfilled }, 'auto-pipeline: boot recovery complete');
  }
  return { recovered, backfilled };
}

/** Test seam — drop all queue state. */
export function _resetAutoPipelineForTests(): void {
  queue.length = 0;
  queued.clear();
  draining = false;
}

/** Test seam — await until the queue is fully drained. */
export async function _awaitDrainForTests(): Promise<void> {
  while (draining || queue.length > 0) {
    await new Promise((r) => setTimeout(r, 5));
  }
}
