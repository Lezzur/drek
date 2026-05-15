import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';

vi.mock('../../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() },
}));

import { createFakeFirestore, type FakeFirestore } from './fake-firestore.js';
import {
  readPollingConfig,
  patchPollingConfig,
  recordPoll,
} from '../../src/db/config.js';
import { DEFAULT_POLLING_CONFIG } from '../../src/db/schemas.js';

let fake: FakeFirestore;
const asDb = () => fake as unknown as Firestore;

beforeEach(() => {
  fake = createFakeFirestore();
});

describe('readPollingConfig', () => {
  it('returns defaults when the doc does not exist yet', async () => {
    const cfg = await readPollingConfig(asDb());
    expect(cfg).toEqual(DEFAULT_POLLING_CONFIG);
  });

  it('round-trips a written config', async () => {
    await patchPollingConfig(
      { pollingEnabled: false, pollingIntervalMs: 10 * 60_000 },
      asDb(),
    );
    const cfg = await readPollingConfig(asDb());
    expect(cfg.pollingEnabled).toBe(false);
    expect(cfg.pollingIntervalMs).toBe(10 * 60_000);
  });
});

describe('patchPollingConfig', () => {
  it('merges — fields not in the patch are preserved', async () => {
    await patchPollingConfig({ pollingEnabled: false }, asDb());
    await patchPollingConfig({ pollingIntervalMs: 5 * 60_000 }, asDb());
    const cfg = await readPollingConfig(asDb());
    expect(cfg.pollingEnabled).toBe(false);
    expect(cfg.pollingIntervalMs).toBe(5 * 60_000);
  });
});

describe('recordPoll', () => {
  it('sets lastPollAt to now without touching the other fields', async () => {
    await patchPollingConfig(
      { pollingEnabled: false, pollingIntervalMs: 7 * 60_000 },
      asDb(),
    );
    await recordPoll(asDb());
    const cfg = await readPollingConfig(asDb());
    expect(cfg.lastPollAt).toBeInstanceOf(Date);
    expect(cfg.pollingEnabled).toBe(false);
    expect(cfg.pollingIntervalMs).toBe(7 * 60_000);
  });
});
