import type { Firestore } from 'firebase-admin/firestore';
import { logger } from '../logger.js';
import {
  getNeurocoreClient,
  NeurocoreError,
  type NeurocoreClient,
  type PendingListing,
} from '../neurocore/index.js';
import { createPlan, findPlanByListing } from '../db/plans.js';
import { upsertListing } from '../db/listings.js';
import { readPollingConfig, recordPoll } from '../db/config.js';
import { getEnv } from '../env.js';

/**
 * Polling service — DREK's background ingestion of PI listings from
 * Neurocore. Discovery brief D-20: v1 is poll-based; v2 might add a
 * webhook from Neurocore but the same-VPS latency makes 30-min polling
 * fine for the cover-letter batch workflow (PRD §5.3).
 *
 * Behavior per cycle:
 *   1. Read polling config (config/polling doc). If pollingEnabled is
 *      false, no-op and just bump lastPollAt.
 *   2. Call Neurocore.pollPendingSignals — returns video-requiring
 *      listings DREK hasn't acked yet.
 *   3. For each listing:
 *        - Look up by sourceListingId — if a plan already exists, skip.
 *        - Otherwise create a new plan in 'awaiting_review' status with
 *          sourceListingId + sourceListingText prefilled.
 *        - Also upsert into available_listings so the M12 listings page
 *          has the full PI context (company, role, raw text) for the
 *          "available listings" view.
 *        - Ack the signal via Neurocore.ackSignal so it drops out of
 *          future polls.
 *   4. Persist lastPollAt = now.
 *
 * Failures are isolated per-listing — one listing throwing doesn't abort
 * the whole cycle. The cycle returns counters so the caller (the "Check
 * now" button in M7) can show "3 new listings ingested" to Rick.
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

// Mutex so a manual "Check now" click during a scheduled tick doesn't
// double-process the same listings.
let cycleInFlight = false;

interface PollOptions {
  client?: NeurocoreClient;
  db?: Firestore;
}

/** Run one full poll cycle. Idempotent on the listing axis (existing plans
 *  are skipped) and on the ack axis (Neurocore's ack is idempotent — DREK
 *  sends a deterministic key). */
export async function runPollCycle(opts: PollOptions = {}): Promise<PollCycleResult> {
  if (cycleInFlight) {
    logger.info('poll-cycle skipped — another cycle is already running');
    return {
      fetched: 0,
      createdPlans: 0,
      skipped: 0,
      failed: 0,
      acked: 0,
      disabled: false,
      durationMs: 0,
    };
  }
  cycleInFlight = true;
  const t0 = Date.now();
  try {
    const cfg = await readPollingConfig(opts.db);
    if (!cfg.pollingEnabled) {
      await recordPoll(opts.db);
      logger.info('poll cycle no-op — pollingEnabled is false');
      return {
        fetched: 0,
        createdPlans: 0,
        skipped: 0,
        failed: 0,
        acked: 0,
        disabled: true,
        durationMs: Date.now() - t0,
      };
    }

    const client = opts.client ?? getNeurocoreClient();
    let listings: PendingListing[];
    try {
      listings = await client.pollPendingSignals();
    } catch (err) {
      if (err instanceof NeurocoreError) {
        logger.warn(
          { code: err.code, endpoint: err.endpoint, message: err.message },
          'poll cycle: neurocore unreachable',
        );
        return {
          fetched: 0,
          createdPlans: 0,
          skipped: 0,
          failed: 0,
          acked: 0,
          disabled: false,
          durationMs: Date.now() - t0,
        };
      }
      throw err;
    }

    let createdPlans = 0;
    let skipped = 0;
    let failed = 0;
    let acked = 0;

    for (const listing of listings) {
      let processed: 'created' | 'skipped' | null = null;
      try {
        processed = await processListing(listing, opts.db);
        if (processed === 'created') createdPlans++;
        else if (processed === 'skipped') skipped++;
      } catch (err) {
        failed++;
        logger.warn(
          {
            memoryId: listing.memoryId,
            listingId: listing.listingId,
            err: (err as Error).message,
          },
          'poll cycle: failed to process listing',
        );
        continue; // don't ack — let Neurocore return it next cycle
      }
      // Ack on success. Ack failure isn't fatal — local processing is done;
      // dedup on findPlanByListing handles a re-delivery harmlessly.
      try {
        await client.ackSignal(listing.memoryId);
        acked++;
      } catch (ackErr) {
        logger.warn(
          { memoryId: listing.memoryId, err: (ackErr as Error).message },
          'poll cycle: ack failed, will retry next cycle',
        );
      }
    }

    await recordPoll(opts.db);
    const durationMs = Date.now() - t0;
    logger.info(
      { fetched: listings.length, createdPlans, skipped, failed, acked, durationMs },
      'poll cycle complete',
    );
    return {
      fetched: listings.length,
      createdPlans,
      skipped,
      failed,
      acked,
      disabled: false,
      durationMs,
    };
  } finally {
    cycleInFlight = false;
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function processListing(
  listing: PendingListing,
  db?: Firestore,
): Promise<'created' | 'skipped'> {
  if (!listing.listingId) {
    // Should never happen given Gap 5's schema, but guard anyway.
    throw new Error('listing has no listingId');
  }

  // Dedup: don't create a second plan if one already exists for this listing.
  const existing = await findPlanByListing(listing.listingId, db);
  if (existing) {
    logger.debug(
      { listingId: listing.listingId, planId: existing.id },
      'plan already exists for listing; skipping create',
    );
    return 'skipped';
  }

  const title = buildPlanTitle(listing);
  await createPlan(
    {
      type: 'cover_letter',
      title,
      // Default 2-minute target — PRD §4.7 cover letter mode default.
      // Rick adjusts per-plan via the M8 runtime input.
      targetRuntimeSeconds: 120,
      sourceListingId: listing.listingId,
      sourceListingText: listing.videoRequirements,
      status: 'awaiting_review',
    },
    db,
  );

  // Also surface the full listing in available_listings so M12's browser
  // has the unfiltered PI context for manual selection later.
  await upsertListing(
    {
      id: listing.listingId,
      title,
      company: listing.company,
      summary: listing.videoRequirements,
      rawText: listing.videoRequirements,
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
