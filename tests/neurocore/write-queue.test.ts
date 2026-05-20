import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

vi.mock('../../src/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  },
}));

import {
  enqueueContentCatalog,
  drainOnce,
  queueDepth,
  deadLetterCount,
  initializeWriteQueue,
  stopWriteQueueWorker,
  _resetWriteQueueForTests,
  _setQueueDirForTests,
  _peekQueueForTests,
} from '../../src/neurocore/write-queue.js';
import type { NeurocoreClient } from '../../src/neurocore/client.js';
import { NeurocoreError } from '../../src/neurocore/errors.js';
import type { ContentCatalogCreatePayload } from '../../src/neurocore/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function fakePayload(
  overrides: Partial<ContentCatalogCreatePayload> = {},
): ContentCatalogCreatePayload {
  return {
    deliverableId: 'del_abc',
    planId: 'plan_xyz',
    kind: 'long_form',
    title: 'How I Built a Voice Agent',
    youtubeUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    youtubeVideoId: 'dQw4w9WgXcQ',
    audienceProfileId: 'developer_longform',
    primaryTechStackId: 'tech_vapi',
    supportingTechStackIds: ['tech_n8n'],
    topicTags: ['voice', 'ai'],
    publishedAt: '2026-05-19T10:00:00.000Z',
    sourceApp: 'drek',
    ...overrides,
  };
}

interface StubClient {
  createContentCatalog: ReturnType<typeof vi.fn>;
}

function makeStubClient(responses: Array<'ok' | { throws: Error }>): StubClient {
  const queue = [...responses];
  return {
    createContentCatalog: vi.fn(async () => {
      const next = queue.shift();
      if (next === undefined) throw new Error('stub client exhausted');
      if (next === 'ok') {
        return {
          profile: {
            id: 'content_test',
            deliverableId: 'del_abc',
            publishedAt: '2026-05-19T10:00:00.000Z',
          },
          created: true,
        };
      }
      throw next.throws;
    }),
  };
}

let tmpDir: string;

beforeEach(() => {
  _resetWriteQueueForTests();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drek-write-queue-'));
  _setQueueDirForTests(tmpDir);
});

afterEach(() => {
  stopWriteQueueWorker();
  _resetWriteQueueForTests();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

// ---------------------------------------------------------------------------
// enqueue + queueDepth
// ---------------------------------------------------------------------------

describe('enqueueContentCatalog', () => {
  it('returns an entry id, increments queueDepth, persists to disk', async () => {
    expect(queueDepth()).toBe(0);
    const id = await enqueueContentCatalog(fakePayload());
    expect(id).toMatch(/^q_/);
    expect(queueDepth()).toBe(1);
    const filePath = path.join(tmpDir, '.neurocore-queue.jsonl');
    expect(fs.existsSync(filePath)).toBe(true);
    const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.body.deliverableId).toBe('del_abc');
  });

  it('preserves FIFO order across multiple enqueues', async () => {
    await enqueueContentCatalog(fakePayload({ deliverableId: 'del_1' }));
    await enqueueContentCatalog(fakePayload({ deliverableId: 'del_2' }));
    await enqueueContentCatalog(fakePayload({ deliverableId: 'del_3' }));
    const snap = _peekQueueForTests();
    expect(snap.map((e) => e.body.deliverableId)).toEqual(['del_1', 'del_2', 'del_3']);
  });
});

// ---------------------------------------------------------------------------
// drainOnce — happy path
// ---------------------------------------------------------------------------

describe('drainOnce — happy path', () => {
  it('successfully drains a single entry and removes it from the queue', async () => {
    await enqueueContentCatalog(fakePayload());
    const client = makeStubClient(['ok']);
    const result = await drainOnce({ client: client as unknown as NeurocoreClient });
    expect(result).toEqual({ attempted: 1, succeeded: 1, rescheduled: 0, deadLettered: 0 });
    expect(queueDepth()).toBe(0);
    expect(client.createContentCatalog).toHaveBeenCalledTimes(1);
  });

  it('persists the empty queue to disk after a successful drain', async () => {
    await enqueueContentCatalog(fakePayload());
    const client = makeStubClient(['ok']);
    await drainOnce({ client: client as unknown as NeurocoreClient });
    const raw = fs.readFileSync(path.join(tmpDir, '.neurocore-queue.jsonl'), 'utf8');
    expect(raw).toBe('');
  });

  it('drains multiple due entries in one pass', async () => {
    await enqueueContentCatalog(fakePayload({ deliverableId: 'del_1' }));
    await enqueueContentCatalog(fakePayload({ deliverableId: 'del_2' }));
    const client = makeStubClient(['ok', 'ok']);
    const result = await drainOnce({ client: client as unknown as NeurocoreClient });
    expect(result.attempted).toBe(2);
    expect(result.succeeded).toBe(2);
    expect(queueDepth()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// drainOnce — retry path
// ---------------------------------------------------------------------------

describe('drainOnce — retry semantics', () => {
  it('reschedules on retryable error and applies backoff', async () => {
    const t0 = new Date('2026-05-19T10:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(t0);
    await enqueueContentCatalog(fakePayload());
    const client = makeStubClient([
      { throws: new NeurocoreError('SERVER_ERROR', '/v1/content-catalog', '502', 502) },
    ]);
    const result = await drainOnce({
      client: client as unknown as NeurocoreClient,
      now: () => t0,
    });
    vi.useRealTimers();
    expect(result).toEqual({ attempted: 1, succeeded: 0, rescheduled: 1, deadLettered: 0 });
    expect(queueDepth()).toBe(1);
    const [entry] = _peekQueueForTests();
    expect(entry?.attemptCount).toBe(1);
    // Backoff = 2^1 * 1000ms = 2000ms (uses the index-aware formula).
    expect(new Date(entry!.nextAttemptAt).getTime()).toBe(t0.getTime() + 2_000);
  });

  it('does not re-attempt an entry whose nextAttemptAt is in the future', async () => {
    const t0 = new Date('2026-05-19T10:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(t0);
    await enqueueContentCatalog(fakePayload());
    const client = makeStubClient([
      { throws: new NeurocoreError('SERVER_ERROR', '/v1/content-catalog', '502', 502) },
    ]);
    await drainOnce({ client: client as unknown as NeurocoreClient, now: () => t0 });
    // Without advancing time, a second drain should skip the entry.
    const result = await drainOnce({
      client: client as unknown as NeurocoreClient,
      now: () => t0,
    });
    vi.useRealTimers();
    expect(result.attempted).toBe(0);
    expect(queueDepth()).toBe(1);
  });

  it('retries on a later drain when nextAttemptAt has elapsed', async () => {
    const t0 = new Date('2026-05-19T10:00:00.000Z');
    const t1 = new Date(t0.getTime() + 10_000); // 10s later, past 2s backoff
    vi.useFakeTimers();
    vi.setSystemTime(t0);
    await enqueueContentCatalog(fakePayload());
    const client = makeStubClient([
      { throws: new NeurocoreError('SERVER_ERROR', '/v1/content-catalog', '502', 502) },
      'ok',
    ]);
    await drainOnce({ client: client as unknown as NeurocoreClient, now: () => t0 });
    const result = await drainOnce({
      client: client as unknown as NeurocoreClient,
      now: () => t1,
    });
    vi.useRealTimers();
    expect(result.succeeded).toBe(1);
    expect(queueDepth()).toBe(0);
  });

  it('dead-letters after 5 failed attempts', async () => {
    const start = new Date('2026-05-19T10:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(start);
    await enqueueContentCatalog(fakePayload());
    const fail = {
      throws: new NeurocoreError('SERVER_ERROR', '/v1/content-catalog', '502', 502),
    };
    const client = makeStubClient([fail, fail, fail, fail, fail]);
    let t = start.getTime();
    for (let i = 0; i < 5; i++) {
      await drainOnce({
        client: client as unknown as NeurocoreClient,
        now: () => new Date(t),
      });
      t += 60_000; // jump 60s so the next attempt is always due
    }
    vi.useRealTimers();
    expect(queueDepth()).toBe(0);
    expect(await deadLetterCount()).toBe(1);
    const dlPath = path.join(tmpDir, '.neurocore-queue-dead.jsonl');
    expect(fs.existsSync(dlPath)).toBe(true);
    const dlContent = fs.readFileSync(dlPath, 'utf8').trim();
    const dlEntry = JSON.parse(dlContent);
    expect(dlEntry.body.deliverableId).toBe('del_abc');
    expect(dlEntry.attemptCount).toBe(5);
    expect(dlEntry.reason).toContain('SERVER_ERROR');
  });

  it('dead-letters IMMEDIATELY on non-retryable 4xx (poison pill)', async () => {
    await enqueueContentCatalog(fakePayload());
    const client = makeStubClient([
      { throws: new NeurocoreError('BAD_REQUEST', '/v1/content-catalog', '400', 400) },
    ]);
    const result = await drainOnce({ client: client as unknown as NeurocoreClient });
    expect(result.deadLettered).toBe(1);
    expect(queueDepth()).toBe(0);
    expect(await deadLetterCount()).toBe(1);
  });

  it('keeps retrying on NOT_CONFIGURED (token not yet set in env)', async () => {
    // NOT_CONFIGURED is special — it's not "the server hates this request",
    // it's "we haven't deployed the token yet". Retry rather than poison-pill.
    await enqueueContentCatalog(fakePayload());
    const client = makeStubClient([
      { throws: new NeurocoreError('NOT_CONFIGURED', '/v1/content-catalog', 'no token') },
    ]);
    const result = await drainOnce({ client: client as unknown as NeurocoreClient });
    expect(result.rescheduled).toBe(1);
    expect(result.deadLettered).toBe(0);
    expect(queueDepth()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// initializeWriteQueue — disk recovery
// ---------------------------------------------------------------------------

describe('initializeWriteQueue — recovery', () => {
  it('recovers pending entries from disk on boot', async () => {
    // Pre-populate the queue file as if a prior process had enqueued.
    const filePath = path.join(tmpDir, '.neurocore-queue.jsonl');
    const entry = {
      id: 'q_pretest',
      kind: 'content_catalog',
      body: fakePayload(),
      attemptCount: 0,
      queuedAt: '2026-05-19T10:00:00.000Z',
      nextAttemptAt: '2026-05-19T10:00:00.000Z',
    };
    fs.writeFileSync(filePath, JSON.stringify(entry) + '\n');

    await initializeWriteQueue();
    expect(queueDepth()).toBe(1);
    stopWriteQueueWorker(); // don't let the periodic worker fire mid-test
  });

  it('silently survives a missing queue file (first boot)', async () => {
    // No file exists in tmpDir.
    await initializeWriteQueue();
    expect(queueDepth()).toBe(0);
    stopWriteQueueWorker();
  });

  it('discards malformed JSONL lines on recovery without throwing', async () => {
    const filePath = path.join(tmpDir, '.neurocore-queue.jsonl');
    const valid = {
      id: 'q_valid',
      kind: 'content_catalog',
      body: fakePayload(),
      attemptCount: 0,
      queuedAt: '2026-05-19T10:00:00.000Z',
      nextAttemptAt: '2026-05-19T10:00:00.000Z',
    };
    fs.writeFileSync(filePath, [JSON.stringify(valid), 'not-json', ''].join('\n') + '\n');

    await initializeWriteQueue();
    expect(queueDepth()).toBe(1);
    stopWriteQueueWorker();
  });
});

// ---------------------------------------------------------------------------
// Concurrency guard
// ---------------------------------------------------------------------------

describe('drainOnce — concurrency', () => {
  it('serializes concurrent drains so the same entry is not double-attempted', async () => {
    await enqueueContentCatalog(fakePayload());
    let resolveFirst: (() => void) | null = null;
    const firstAttempt = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const client = {
      createContentCatalog: vi.fn(async () => {
        await firstAttempt;
        return {
          profile: {
            id: 'content_test',
            deliverableId: 'del_abc',
            publishedAt: '2026-05-19T10:00:00.000Z',
          },
          created: true,
        };
      }),
    };

    const drainA = drainOnce({ client: client as unknown as NeurocoreClient });
    const drainB = drainOnce({ client: client as unknown as NeurocoreClient });
    resolveFirst!();
    await Promise.all([drainA, drainB]);
    // The second drain saw the in-flight promise and returned an empty
    // result without invoking the client a second time.
    expect(client.createContentCatalog).toHaveBeenCalledTimes(1);
    expect(queueDepth()).toBe(0);
  });
});
