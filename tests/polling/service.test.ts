import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';

vi.mock('../../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() },
}));

const fakeEnv = {
  PORT: 3003,
  NODE_ENV: 'test' as const,
  GCP_PROJECT_ID: 'drek-test',
  LOG_LEVEL: 'silent' as const,
  LLM_PROVIDER: 'claude' as const,
  LLM_TIMEOUT_MS: 120_000,
  CLAUDE_BIN: 'claude',
  CLAUDE_MODEL: 'claude-sonnet-4-5',
  CODEX_BIN: 'codex',
  CODEX_MODEL: 'gpt-5-codex',
  NEUROCORE_URL: 'http://localhost:3100',
  NEUROCORE_TOKEN: 'test-token',
  NEUROCORE_TIMEOUT_MS: 50,
  WORKSPACE_ROOT: '/tmp/drek-test',
  POLLING_INTERVAL_MS: 60_000,
};
vi.mock('../../src/env.js', () => ({
  getEnv: () => fakeEnv,
  loadEnv: () => fakeEnv,
}));

// State for the mocked shared client. Each test resets these via beforeEach.
const sharedState = {
  pendingListings: [] as PendingListing[],
  pendingError: null as Error | null,
  ackCalls: [] as string[],
  ackFailures: new Set<string>(),
  pollCalls: 0,
  // Inject a "slow" poll for the mutex test.
  slowPollPromise: null as Promise<PendingListing[]> | null,
};

vi.mock('../../src/neurocore/_shared.js', () => ({
  getSharedClient: vi.fn(async () => ({
    pollPendingListings: vi.fn(async () => {
      sharedState.pollCalls++;
      if (sharedState.slowPollPromise) return sharedState.slowPollPromise;
      if (sharedState.pendingError) throw sharedState.pendingError;
      return sharedState.pendingListings;
    }),
    ackPendingListing: vi.fn(async (memoryId: string) => {
      if (sharedState.ackFailures.has(memoryId)) {
        throw Object.assign(new Error('ack failed'), { code: 'INTERNAL', status: 500 });
      }
      sharedState.ackCalls.push(memoryId);
    }),
    createPollingLoop: <T,>(config: import('@lezzur/neurocore-client').PollingLoopConfig<T>) => {
      // Inline a faithful runOnce impl mirroring what the shared loop does.
      // The shared client's polling.ts is already tested upstream; we only
      // need the contract here, not the full implementation, to keep test
      // wiring simple.
      return {
        async runOnce() {
          let enabled = true;
          try {
            enabled = await config.getEnabledFlag();
          } catch {
            enabled = false;
          }
          const startedAt = new Date().toISOString();
          if (!enabled) {
            const stats = {
              startedAt,
              finishedAt: startedAt,
              enabled: false,
              itemsFetched: 0,
              itemsProcessed: 0,
              itemsAcked: 0,
              itemsLeftPending: 0,
              itemsErrored: 0,
              unreachable: false,
            };
            config.onCycleComplete?.(stats);
            return stats;
          }
          let items: T[];
          try {
            items = await config.pollFn();
          } catch {
            const stats = {
              startedAt,
              finishedAt: new Date().toISOString(),
              enabled: true,
              itemsFetched: 0,
              itemsProcessed: 0,
              itemsAcked: 0,
              itemsLeftPending: 0,
              itemsErrored: 0,
              unreachable: true,
            };
            config.onCycleComplete?.(stats);
            return stats;
          }
          let itemsAcked = 0;
          let itemsLeftPending = 0;
          let itemsErrored = 0;
          for (const item of items) {
            let outcome: 'ack' | 'leave-pending';
            try {
              outcome = await config.processItem(item);
            } catch {
              itemsErrored++;
              itemsLeftPending++;
              continue;
            }
            if (outcome === 'ack') {
              try {
                await config.ackFn(config.getItemId(item));
                itemsAcked++;
              } catch {
                itemsErrored++;
                itemsLeftPending++;
              }
            } else {
              itemsLeftPending++;
            }
          }
          const stats = {
            startedAt,
            finishedAt: new Date().toISOString(),
            enabled: true,
            itemsFetched: items.length,
            itemsProcessed: items.length,
            itemsAcked,
            itemsLeftPending,
            itemsErrored,
            unreachable: false,
          };
          config.onCycleComplete?.(stats);
          return stats;
        },
        start: () => {},
        stop: async () => {},
        status: () => ({ running: false, lastCycleAt: null, lastCycleStats: null }),
      } as import('@lezzur/neurocore-client').PollingLoop;
    },
  })),
  _resetSharedClientForTests: vi.fn(),
}));

import { createFakeFirestore, type FakeFirestore } from '../db/fake-firestore.js';
import { runPollCycle, _resetCycleMutexForTests } from '../../src/polling/service.js';
import { findPlanByListing } from '../../src/db/plans.js';
import { getListing } from '../../src/db/listings.js';
import { patchPollingConfig, readPollingConfig } from '../../src/db/config.js';
import { NeurocoreError, type PendingListing } from '../../src/neurocore/index.js';

let fake: FakeFirestore;
const asDb = () => fake as unknown as Firestore;

function listing(overrides?: Partial<PendingListing>): PendingListing {
  return {
    memoryId: `mem_${Math.random().toString(36).slice(2, 8)}`,
    listingId: `lst_${Math.random().toString(36).slice(2, 8)}`,
    listingTitle: 'Backend Engineer at Acme',
    listingText: 'Show automation work on lead pipelines',
    company: 'Acme',
    role: 'Backend Engineer',
    videoRequirements: 'Show automation work on lead pipelines',
    keySkills: ['ts', 'automation'],
    url: 'https://example.com/jobs/1',
    ingestedAt: '2026-05-15T00:00:00Z',
    ...overrides,
  };
}

beforeEach(() => {
  fake = createFakeFirestore();
  _resetCycleMutexForTests();
  sharedState.pendingListings = [];
  sharedState.pendingError = null;
  sharedState.ackCalls = [];
  sharedState.ackFailures = new Set();
  sharedState.pollCalls = 0;
  sharedState.slowPollPromise = null;
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('runPollCycle — happy path', () => {
  it('creates a plan + available_listings entry per new listing and acks', async () => {
    const l = listing({ memoryId: 'mem_1', listingId: 'lst_1' });
    sharedState.pendingListings = [l];
    const result = await runPollCycle({ db: asDb() });

    expect(result.fetched).toBe(1);
    expect(result.createdPlans).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.acked).toBe(1);
    expect(sharedState.ackCalls).toEqual(['mem_1']);
    expect(sharedState.pollCalls).toBe(1);

    const plan = await findPlanByListing('lst_1', asDb());
    expect(plan?.sourceListingId).toBe('lst_1');
    expect(plan?.title).toBe('Backend Engineer at Acme');
    expect(plan?.status).toBe('awaiting_review');
    expect(plan?.targetRuntimeSeconds).toBe(120);

    const avail = await getListing('lst_1', asDb());
    expect(avail?.title).toBe('Backend Engineer at Acme');
  });

  it('records lastPollAt after the cycle', async () => {
    sharedState.pendingListings = [];
    await runPollCycle({ db: asDb() });
    // recordPoll is fire-and-forget inside onCycleComplete; let microtasks flush.
    await new Promise((r) => setTimeout(r, 5));
    const cfg = await readPollingConfig(asDb());
    expect(cfg.lastPollAt).toBeInstanceOf(Date);
  });

  it('handles an empty batch cleanly', async () => {
    sharedState.pendingListings = [];
    const result = await runPollCycle({ db: asDb() });
    expect(result.fetched).toBe(0);
    expect(result.createdPlans).toBe(0);
    expect(result.acked).toBe(0);
  });
});

describe('runPollCycle — dedup', () => {
  it('skips listings that already have a plan, still acks them', async () => {
    const l1 = listing({ memoryId: 'mem_1', listingId: 'lst_1' });
    sharedState.pendingListings = [l1];
    await runPollCycle({ db: asDb() });

    // Second cycle re-receives the same listing.
    sharedState.ackCalls = [];
    sharedState.pendingListings = [l1];
    const result = await runPollCycle({ db: asDb() });

    expect(result.fetched).toBe(1);
    expect(result.createdPlans).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.acked).toBe(1);
  });
});

describe('runPollCycle — disabled', () => {
  it('no-ops when pollingEnabled is false but still bumps lastPollAt', async () => {
    await patchPollingConfig({ pollingEnabled: false }, asDb());
    sharedState.pendingListings = [listing()];
    const result = await runPollCycle({ db: asDb() });
    expect(result.disabled).toBe(true);
    expect(result.fetched).toBe(0);
    expect(sharedState.pollCalls).toBe(0);
    await new Promise((r) => setTimeout(r, 5));
    const cfg = await readPollingConfig(asDb());
    expect(cfg.lastPollAt).toBeInstanceOf(Date);
  });
});

describe('runPollCycle — Neurocore failure', () => {
  it('returns zero counts when Neurocore is unreachable', async () => {
    sharedState.pendingError = new NeurocoreError(
      'UNREACHABLE',
      '/v1/signals/pending-video',
      'down',
    );
    const result = await runPollCycle({ db: asDb() });
    expect(result.fetched).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.acked).toBe(0);
    expect(result.disabled).toBe(false);
  });
});

describe('runPollCycle — partial failure isolation', () => {
  it('one bad listing does not abort the rest of the batch', async () => {
    const l1 = listing({ memoryId: 'mem_1', listingId: 'lst_1' });
    const l2 = listing({ memoryId: 'mem_2', listingId: null });
    const l3 = listing({ memoryId: 'mem_3', listingId: 'lst_3' });
    sharedState.pendingListings = [l1, l2, l3];
    const result = await runPollCycle({ db: asDb() });
    expect(result.fetched).toBe(3);
    expect(result.createdPlans).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.acked).toBe(2);
    expect(sharedState.ackCalls).toEqual(['mem_1', 'mem_3']);
  });

  it('ack failure does not break the cycle — listing is still counted as created', async () => {
    const l = listing({ memoryId: 'mem_1', listingId: 'lst_1' });
    sharedState.pendingListings = [l];
    sharedState.ackFailures = new Set(['mem_1']);
    const result = await runPollCycle({ db: asDb() });
    expect(result.createdPlans).toBe(1);
    expect(result.acked).toBe(0);
    expect(await findPlanByListing('lst_1', asDb())).not.toBeNull();
  });
});

describe('runPollCycle — concurrency', () => {
  it('a concurrent cycle is skipped (mutex)', async () => {
    let resolveFirst: () => void = () => {};
    sharedState.slowPollPromise = new Promise<PendingListing[]>((resolve) => {
      resolveFirst = () => resolve([listing({ memoryId: 'mem_1', listingId: 'lst_1' })]);
    });

    const a = runPollCycle({ db: asDb() });
    const b = await runPollCycle({ db: asDb() });
    expect(b.fetched).toBe(0);

    resolveFirst();
    const aRes = await a;
    expect(aRes.fetched).toBe(1);
  });
});
