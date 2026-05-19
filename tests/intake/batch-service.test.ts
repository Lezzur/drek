import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFakeFirestore, type FakeFirestore } from '../db/fake-firestore.js';

// Mock the scoring engine — we don't want real LLM calls. We DO want to
// observe how many times it's invoked and with what concurrency.
const scoreBriefMock = vi.fn();
vi.mock('../../src/intake/scoring.js', () => ({
  scoreBriefViaLLM: (...args: unknown[]) => scoreBriefMock(...args),
}));

vi.mock('../../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() },
}));

import type { Firestore } from 'firebase-admin/firestore';
import {
  createBriefBatchWithScoring,
  getBriefBatch,
  scoreBriefBatchInBackground,
} from '../../src/intake/service.js';
import { createPipelineBrief } from '../../src/db/pipeline-briefs.js';

let db: FakeFirestore;
const asDb = () => db as unknown as Firestore;

beforeEach(() => {
  db = createFakeFirestore();
  scoreBriefMock.mockReset();
});

describe('createBriefBatchWithScoring', () => {
  it('persists all briefs in one shared batchId with stage=candidate', async () => {
    // Stub scoring so the fire-and-forget doesn't blow up.
    scoreBriefMock.mockResolvedValue(undefined);

    const result = await createBriefBatchWithScoring(
      {
        briefs: [
          { title: 'A', rawText: 'body a' },
          { title: 'B', rawText: 'body b' },
          { title: 'C', rawText: 'body c' },
        ],
      },
      asDb(),
    );

    expect(result.batchId).toMatch(/^batch_/);
    expect(result.briefs).toHaveLength(3);
    for (const b of result.briefs) {
      expect(b.batchId).toBe(result.batchId);
      expect(b.stage).toBe('candidate');
      expect(b.score).toBeNull();
    }
  });

  it('rejects empty batches', async () => {
    await expect(
      createBriefBatchWithScoring({ briefs: [] }, asDb()),
    ).rejects.toThrow(/at least one brief/i);
  });

  it('queues scoring fire-and-forget — returns before scoring completes', async () => {
    // Make scoring take a tick to verify the return happens first.
    let scoringStarted = false;
    scoreBriefMock.mockImplementation(async () => {
      scoringStarted = true;
      await new Promise((r) => setTimeout(r, 5));
    });

    const result = await createBriefBatchWithScoring(
      { briefs: [{ title: 'A', rawText: 'a' }] },
      asDb(),
    );
    expect(result.briefs).toHaveLength(1);
    // Allow microtask queue to drain so the fire-and-forget worker can start.
    await new Promise((r) => setImmediate(r));
    expect(scoringStarted).toBe(true);
  });
});

describe('scoreBriefBatchInBackground concurrency cap', () => {
  it('never runs more than `concurrency` LLM calls in flight', async () => {
    let inFlight = 0;
    let peakInFlight = 0;
    scoreBriefMock.mockImplementation(async () => {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 3));
      inFlight -= 1;
    });

    // Seed 10 briefs directly.
    const briefs = [];
    for (let i = 0; i < 10; i++) {
      briefs.push(
        await createPipelineBrief(
          { title: `Brief ${i}`, rawText: `body ${i}`, batchId: 'batch_x' },
          asDb(),
        ),
      );
    }

    await scoreBriefBatchInBackground(briefs, asDb(), { concurrency: 3 });
    expect(scoreBriefMock).toHaveBeenCalledTimes(10);
    expect(peakInFlight).toBeLessThanOrEqual(3);
  });

  it('per-brief failures are isolated — other briefs still score', async () => {
    scoreBriefMock.mockImplementation(async (briefId: string) => {
      if (briefId.endsWith('-fail')) throw new Error('LLM down');
    });

    const briefs = [
      await createPipelineBrief({ title: 'ok1', rawText: 'a', batchId: 'b' }, asDb()),
      await createPipelineBrief({ title: 'bad', rawText: 'b', batchId: 'b' }, asDb()),
      await createPipelineBrief({ title: 'ok2', rawText: 'c', batchId: 'b' }, asDb()),
    ];
    // Rename the middle brief's id so the mock throws.
    briefs[1] = { ...briefs[1]!, id: briefs[1]!.id + '-fail' };

    await scoreBriefBatchInBackground(briefs, asDb(), { concurrency: 2 });
    expect(scoreBriefMock).toHaveBeenCalledTimes(3);
  });
});

describe('getBriefBatch', () => {
  it('returns all briefs with the matching batchId, ordered by createdAt asc', async () => {
    const result = await createBriefBatchWithScoring(
      {
        briefs: [
          { title: 'First', rawText: 'a' },
          { title: 'Second', rawText: 'b' },
          { title: 'Third', rawText: 'c' },
        ],
      },
      asDb(),
    );

    // Also drop in a brief in a DIFFERENT batch to confirm filtering.
    await createPipelineBrief(
      { title: 'Unrelated', rawText: 'x', batchId: 'batch_other' },
      asDb(),
    );

    const fetched = await getBriefBatch(result.batchId, asDb());
    expect(fetched).toHaveLength(3);
    expect(fetched.map((b) => b.title)).toEqual(['First', 'Second', 'Third']);
  });

  it('returns empty array when no briefs match', async () => {
    const fetched = await getBriefBatch('batch_does_not_exist', asDb());
    expect(fetched).toEqual([]);
  });
});
