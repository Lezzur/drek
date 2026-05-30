import type { Firestore } from 'firebase-admin/firestore';
import { logger } from '../logger.js';
import {
  NeurocoreError,
  type PendingListing,
} from '../neurocore/index.js';
import { getSharedClient } from '../neurocore/_shared.js';
import { createPlan, findPlanByListing } from '../db/plans.js';
import { upsertListing } from '../db/listings.js';
import { readPollingConfig, recordPoll } from '../db/config.js';
import { getEnv } from '../env.js';
import type { CycleStats, PollingLoop, ProcessResult } from '@lezzur/neurocore-client';
import type { NeurocoreClient } from '../neurocore/client.js';

/**
 * Lazily import `createPollingLoop` from the shared package so we can build a
 * loop without instantiating a full shared client (which requires a token).
 * Used by the legacy `client` opt path in tests.
 */
async function getCreatePollingLoopNoSharedClient() {
  const mod = await import('@lezzur/neurocore-client');
  return mod.createPollingLoop;
}

/**
 * Polling service — DREK's background ingestion of PI listings from
 * Neurocore.
 *
 * **Phase 2c migration:** the cycle scaffold (mutex, pollFn → ackFn flow,
 * partial-failure isolation, ack-only-on-success, disabled-state no-op)
 * is now delegated to `@lezzur/neurocore-client`'s `createPollingLoop`.
 * DREK-specific behavior — Firestore-backed `pollingEnabled` flag,
 * `processListing` (find existing plan, create new plan, upsert into
 * available_listings), and `recordPoll(lastPollAt)` — moves into the
 * loop's callbacks (`getEnabledFlag`, `processItem`, `onCycleComplete`).
 *
 * The public API is preserved:
 *   - `runPollCycle(opts)` returns `PollCycleResult` for the M7 "Check now"
 *     button. Now backed by `loop.runOnce()` and translated.
 *   - `makePollingJob()` returns a scheduler Job for src/index.ts. Now
 *     wraps `runPollCycle` (which wraps `loop.runOnce`).
 *   - `_resetCycleMutexForTests()` disposes the memoized loop singleton.
 */

export interface PollCycleResult {
  /** Total listings returned by Neurocore for this cycle. */
  fetched: number;
  /** Listings that became new plans. */
  createdPlans: number;
  /** Listings that already had a plan and were skipped (still acked). */
  skipped: number;
  /** Listings that hit an error during processing. */
  failed: number;
  /** Listings successfully acked back to Neurocore. */
  acked: number;
  /** True if the cycle was a no-op because polling is disabled. */
  disabled: boolean;
  durationMs: number;
}

interface PollOptions {
  /** Optional Firestore override for tests. */
  db?: Firestore;
  /**
   * @deprecated Phase 2c migration kept this opt as a backward-compat
   * escape hatch for the integration tests in tests/integration/. The
   * production path uses the shared client via getSharedClient(); only
   * pass `client` when running tests that need to inject a stub
   * NeurocoreClient end-to-end. Phase 2d removes this option entirely
   * once the integration test is refactored to vi.mock the shared client.
   */
  client?: NeurocoreClient;
}

/** Test-injectable cycle counters. processListing populates these so the
 *  translation from CycleStats → PollCycleResult can split itemsErrored
 *  into created/skipped/failed properly. */
interface CycleAccumulator {
  createdPlans: number;
  skipped: number;
}

// Cross-call mutex so a manual "Check now" click during a scheduled tick
// doesn't double-process the same listings. The shared loop also has a
// per-instance mutex, but we build a fresh loop per call (for testability),
// so the cross-call guard lives at the runPollCycle boundary.
let cycleInFlight = false;

async function buildLoopReal(
  acc: CycleAccumulator,
  db: Firestore | undefined,
  legacyClient?: NeurocoreClient,
): Promise<PollingLoop> {
  // Defer env read so a missing env in tests doesn't blow up the legacy
  // path. intervalMs only matters for loop.start(); we always use
  // runOnce() here so it's effectively a placeholder for now.
  let intervalMs = 60_000;
  try {
    intervalMs = getEnv().POLLING_INTERVAL_MS;
  } catch {
    // Test environment without env vars — fall back to the placeholder.
  }
  // Legacy-client path (integration tests): skip getSharedClient so we
  // don't require a real Neurocore token. We still need a loop scaffold,
  // so we import createPollingLoop directly from the shared package.
  const nc = legacyClient ? null : await getSharedClient();
  const createLoop = nc
    ? nc.createPollingLoop.bind(nc)
    : await getCreatePollingLoopNoSharedClient();
  return createLoop<PendingListing>({
    intervalMs,
    pollFn: async () => {
      if (legacyClient) return legacyClient.pollPendingSignals();
      // Shape matches DREK's PendingListing because both mirror the
      // server's listings collection.
      return (await nc!.pollPendingListings()) as unknown as PendingListing[];
    },
    ackFn: async (id: string) => {
      if (legacyClient) {
        await legacyClient.ackSignal(id);
        return;
      }
      await nc!.ackPendingListing(id);
    },
    getItemId: (listing) => listing.memoryId,
    processItem: async (listing): Promise<ProcessResult> => {
      // Let exceptions propagate so the shared loop counts them as
      // itemsErrored. We log here for observability; the loop's own
      // log is generic.
      try {
        const outcome = await processListing(listing, db);
        if (outcome === 'created') acc.createdPlans++;
        else acc.skipped++;
        return 'ack';
      } catch (err) {
        logger.warn(
          {
            memoryId: listing.memoryId,
            listingId: listing.listingId,
            err: (err as Error).message,
          },
          'poll cycle: failed to process listing',
        );
        throw err;
      }
    },
    getEnabledFlag: async () => {
      const cfg = await readPollingConfig(db);
      return cfg.pollingEnabled;
    },
    onCycleComplete: () => {
      void recordPoll(db).catch((err) => {
        logger.warn({ err: (err as Error).message }, 'poll cycle: recordPoll failed');
      });
    },
  });
}

/**
 * Run one full poll cycle. Idempotent on the listing axis (existing plans
 * are skipped) and on the ack axis (Neurocore's ack is idempotent — DREK
 * sends a deterministic key).
 */
export async function runPollCycle(opts: PollOptions = {}): Promise<PollCycleResult> {
  if (cycleInFlight) {
    logger.info('poll-cycle skipped — another cycle is already running');
    return zeroResult(0, false);
  }
  cycleInFlight = true;
  const t0 = Date.now();
  try {
    const acc: CycleAccumulator = { createdPlans: 0, skipped: 0 };
    let loop: PollingLoop;
    try {
      loop = await buildLoopReal(acc, opts.db, opts.client);
    } catch (err) {
      if (err instanceof NeurocoreError) {
        logger.warn(
          { code: err.code, endpoint: err.endpoint, message: err.message },
          'poll cycle: neurocore unreachable (init)',
        );
      } else {
        logger.warn({ err: (err as Error).message }, 'poll cycle: failed to build loop');
      }
      return zeroResult(Date.now() - t0, false);
    }

    let stats: CycleStats;
    try {
      stats = await loop.runOnce();
    } catch (err) {
      logger.error(
        { err: (err as Error).message },
        'poll cycle: loop.runOnce threw unexpectedly',
      );
      return zeroResult(Date.now() - t0, false);
    }

    const durationMs = Date.now() - t0;
    if (!stats.enabled) {
      logger.info('poll cycle no-op — pollingEnabled is false');
      return zeroResult(durationMs, true);
    }
    if (stats.unreachable) {
      logger.warn('poll cycle: neurocore unreachable');
      return zeroResult(durationMs, false);
    }

    logger.info(
      {
        fetched: stats.itemsFetched,
        createdPlans: acc.createdPlans,
        skipped: acc.skipped,
        failed: stats.itemsErrored,
        acked: stats.itemsAcked,
        durationMs,
      },
      'poll cycle complete',
    );

    return {
      fetched: stats.itemsFetched,
      createdPlans: acc.createdPlans,
      skipped: acc.skipped,
      failed: stats.itemsErrored,
      acked: stats.itemsAcked,
      disabled: false,
      durationMs,
    };
  } finally {
    cycleInFlight = false;
  }
}

function zeroResult(durationMs: number, disabled: boolean): PollCycleResult {
  return {
    fetched: 0,
    createdPlans: 0,
    skipped: 0,
    failed: 0,
    acked: 0,
    disabled,
    durationMs,
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function processListing(
  listing: PendingListing,
  db?: Firestore,
): Promise<'created' | 'skipped'> {
  if (!listing.listingId) {
    throw new Error('listing has no listingId');
  }

  const existing = await findPlanByListing(listing.listingId, db);
  if (existing) {
    logger.debug(
      { listingId: listing.listingId, planId: existing.id },
      'plan already exists for listing; skipping create',
    );
    return 'skipped';
  }

  const title = buildPlanTitle(listing);
  const listingText = listing.listingText ?? listing.videoRequirements;

  await createPlan(
    {
      type: 'cover_letter',
      title,
      targetRuntimeSeconds: 120,
      sourceListingId: listing.listingId,
      sourceListingText: listingText,
      status: 'awaiting_review',
    },
    db,
  );

  await upsertListing(
    {
      id: listing.listingId,
      title,
      company: listing.company,
      summary: listing.videoRequirements,
      rawText: listingText,
    },
    db,
  );

  return 'created';
}

function buildPlanTitle(listing: PendingListing): string {
  if (listing.listingTitle) return listing.listingTitle;
  const role = listing.role ?? 'Role';
  const company = listing.company ?? 'Unknown company';
  return `${role} at ${company}`;
}

/** Reset the in-flight mutex. Test-only. */
export function _resetCycleMutexForTests(): void {
  cycleInFlight = false;
}

// ---------------------------------------------------------------------------
// Scheduler integration — exported for src/index.ts to register on boot.
// ---------------------------------------------------------------------------

/** Returns a scheduler Job for the polling cron. The interval comes from
 *  process env (POLLING_INTERVAL_MS); the enabled flag comes from
 *  Firestore (config/polling). Reading the flag at run time means Rick
 *  can toggle polling without a redeploy. */
export function makePollingJob() {
  const env = getEnv();
  return {
    name: 'drek-listing-poll',
    intervalMs: env.POLLING_INTERVAL_MS,
    run: async () => {
      try {
        await runPollCycle();
      } catch (err) {
        logger.error({ err: (err as Error).message }, 'poll cycle threw unhandled');
      }
    },
  };
}
