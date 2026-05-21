import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';

vi.mock('../../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() },
}));

import { createFakeFirestore, type FakeFirestore } from '../db/fake-firestore.js';
import { runPollCycle, _resetCycleMutexForTests } from '../../src/polling/service.js';
import { findPlanByListing } from '../../src/db/plans.js';
import { getListing } from '../../src/db/listings.js';
import { patchPollingConfig, readPollingConfig } from '../../src/db/config.js';
import {
  NeurocoreError,
  type NeurocoreClient,
  type PendingListing,
} from '../../src/neurocore/index.js';

let fake: FakeFirestore;
const asDb = () => fake as unknown as Firestore;

interface ClientStub {
  client: NeurocoreClient;
  pollCalls: number;
  acks: string[];
  ackFailures: Set<string>; // memoryIds that should throw when acked
}

function makeClient(
  listingsOrError: PendingListing[] | { throws: Error },
  opts?: { ackFailures?: string[] },
): ClientStub {
  const stub: ClientStub = {
    pollCalls: 0,
    acks: [],
    ackFailures: new Set(opts?.ackFailures ?? []),
    client: null as unknown as NeurocoreClient,
  };
  stub.client = {
    async pollPendingSignals() {
      stub.pollCalls++;
      if ('throws' in listingsOrError) throw listingsOrError.throws;
      return listingsOrError;
    },
    async ackSignal(memoryId: string) {
      if (stub.ackFailures.has(memoryId)) {
        throw new NeurocoreError('SERVER_ERROR', '/v1/signals/.../ack', 'ack failed', 500);
      }
      stub.acks.push(memoryId);
    },
    async getProjectContext() {
      throw new Error('not used in polling tests');
    },
    async getVoiceProfile() {
      throw new Error('not used in polling tests');
    },
    async sendApprovedScript() {
      throw new Error('not used in polling tests');
    },
  } as unknown as NeurocoreClient;
  return stub;
}

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
});

describe('runPollCycle — happy path', () => {
  it('creates a plan + available_listings entry per new listing and acks', async () => {
    const l = listing({ memoryId: 'mem_1', listingId: 'lst_1' });
    const stub = makeClient([l]);
    const result = await runPollCycle({ client: stub.client, db: asDb() });

    expect(result.fetched).toBe(1);
    expect(result.createdPlans).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.acked).toBe(1);
    expect(stub.acks).toEqual(['mem_1']);
    expect(stub.pollCalls).toBe(1);

    const plan = await findPlanByListing('lst_1', asDb());
    expect(plan?.sourceListingId).toBe('lst_1');
    expect(plan?.title).toBe('Backend Engineer at Acme');
    expect(plan?.status).toBe('awaiting_review');
    expect(plan?.targetRuntimeSeconds).toBe(120);

    const avail = await getListing('lst_1', asDb());
    expect(avail?.title).toBe('Backend Engineer at Acme');
  });

  it('records lastPollAt after the cycle', async () => {
    const stub = makeClient([]);
    await runPollCycle({ client: stub.client, db: asDb() });
    const cfg = await readPollingConfig(asDb());
    expect(cfg.lastPollAt).toBeInstanceOf(Date);
  });

  it('handles an empty batch cleanly', async () => {
    const stub = makeClient([]);
    const result = await runPollCycle({ client: stub.client, db: asDb() });
    expect(result.fetched).toBe(0);
    expect(result.createdPlans).toBe(0);
    expect(result.acked).toBe(0);
  });
});

describe('runPollCycle — dedup', () => {
  it('skips listings that already have a plan, still acks them', async () => {
    const l1 = listing({ memoryId: 'mem_1', listingId: 'lst_1' });

    // Pre-create the plan so the cycle sees it as existing.
    const stub = makeClient([l1]);
    await runPollCycle({ client: stub.client, db: asDb() }); // first cycle creates it

    // Second cycle re-receives the same listing (server hasn't honored the ack
    // yet in real life, or DREK is being redelivered).
    const stub2 = makeClient([l1]);
    const result = await runPollCycle({ client: stub2.client, db: asDb() });

    expect(result.fetched).toBe(1);
    expect(result.createdPlans).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.acked).toBe(1);
  });
});

describe('runPollCycle — disabled', () => {
  it('no-ops when pollingEnabled is false but still bumps lastPollAt', async () => {
    await patchPollingConfig({ pollingEnabled: false }, asDb());
    const stub = makeClient([listing()]);
    const result = await runPollCycle({ client: stub.client, db: asDb() });
    expect(result.disabled).toBe(true);
    expect(result.fetched).toBe(0);
    expect(stub.pollCalls).toBe(0); // didn't even hit Neurocore
    const cfg = await readPollingConfig(asDb());
    expect(cfg.lastPollAt).toBeInstanceOf(Date);
  });
});

describe('runPollCycle — Neurocore failure', () => {
  it('returns zero counts when Neurocore is unreachable', async () => {
    const stub = makeClient({
      throws: new NeurocoreError('UNREACHABLE', '/v1/signals/pending-video', 'down'),
    });
    const result = await runPollCycle({ client: stub.client, db: asDb() });
    expect(result.fetched).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.acked).toBe(0);
    expect(result.disabled).toBe(false);
  });
});

describe('runPollCycle — partial failure isolation', () => {
  it('one bad listing does not abort the rest of the batch', async () => {
    // Listing 2 is missing listingId — processListing will throw for it.
    const l1 = listing({ memoryId: 'mem_1', listingId: 'lst_1' });
    const l2 = listing({ memoryId: 'mem_2', listingId: null });
    const l3 = listing({ memoryId: 'mem_3', listingId: 'lst_3' });
    const stub = makeClient([l1, l2, l3]);
    const result = await runPollCycle({ client: stub.client, db: asDb() });
    expect(result.fetched).toBe(3);
    expect(result.createdPlans).toBe(2);
    expect(result.failed).toBe(1);
    // Only the good ones get acked (we don't ack the failed one — let it
    // re-deliver so a retry can pick it up).
    expect(result.acked).toBe(2);
    expect(stub.acks).toEqual(['mem_1', 'mem_3']);
  });

  it('ack failure does not break the cycle — listing is still counted as created', async () => {
    const l = listing({ memoryId: 'mem_1', listingId: 'lst_1' });
    const stub = makeClient([l], { ackFailures: ['mem_1'] });
    const result = await runPollCycle({ client: stub.client, db: asDb() });
    expect(result.createdPlans).toBe(1);
    expect(result.acked).toBe(0); // ack failed, but listing processed locally
    // Plan should exist — local side succeeded.
    expect(await findPlanByListing('lst_1', asDb())).not.toBeNull();
  });
});

describe('runPollCycle — concurrency', () => {
  it('a concurrent cycle is skipped (mutex)', async () => {
    let resolveFirst: () => void = () => {};
    const slow = new Promise<PendingListing[]>((resolve) => {
      resolveFirst = () => resolve([listing({ memoryId: 'mem_1', listingId: 'lst_1' })]);
    });
    const slowClient: NeurocoreClient = {
      async pollPendingSignals() {
        return slow;
      },
      async ackSignal() {},
      async getProjectContext() {
        throw new Error('not used');
      },
      async getVoiceProfile() {
        throw new Error('not used');
      },
      async sendApprovedScript() {
        throw new Error('not used');
      },
    } as unknown as NeurocoreClient;

    const a = runPollCycle({ client: slowClient, db: asDb() });
    // Second concurrent call should bail immediately.
    const b = await runPollCycle({ client: slowClient, db: asDb() });
    expect(b.fetched).toBe(0);

    // Now let the first finish.
    resolveFirst();
    const aRes = await a;
    expect(aRes.fetched).toBe(1);
  });
});
