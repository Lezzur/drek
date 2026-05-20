import { promises as fs } from 'node:fs';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { logger } from '../logger.js';
import { getEnv } from '../env.js';
import { getNeurocoreClient, type NeurocoreClient } from './client.js';
import { NeurocoreError, isRetryable } from './errors.js';
import type { ContentCatalogCreatePayload } from './types.js';

/**
 * NeurocoreWriteQueue — durable, retrying write path for Neurocore POSTs
 * we cannot afford to lose (currently: ContentCatalog rows on publish).
 *
 * Contract per TECH-SPEC v2.1 §4 Piece 3:
 *   - In-process FIFO of pending writes
 *   - Persisted to `$WORKSPACE_ROOT/.neurocore-queue.jsonl` (append-only log)
 *     so a service restart doesn't lose writes
 *   - Worker drains every QUEUE_DRAIN_INTERVAL_MS (30s) if non-empty
 *   - Exponential backoff per entry (1s, 2s, 4s, 8s, 16s), capped at 5
 *     attempts; on the 6th try the entry is moved to
 *     `.neurocore-queue-dead.jsonl` and dropped from the live queue
 *   - The /healthz route reads `queueDepth()` and `deadLetterCount()` so
 *     a stuck queue is visible to ops
 *
 * Design notes:
 *   - We use ONE flat JSONL file rather than per-entry sidecar files so
 *     restart recovery is a single fs.readFile + JSON.parse-per-line pass.
 *   - Rewrites on each successful drain are atomic (write to .tmp then
 *     rename). This is the same temp+rename pattern used elsewhere in
 *     workspace/atomic-write.ts.
 *   - If WORKSPACE_ROOT is unset the queue still runs in-memory; it just
 *     loses durability. We log a warn on first enqueue so this isn't
 *     silent in production.
 */

const QUEUE_FILENAME = '.neurocore-queue.jsonl';
const DEAD_LETTER_FILENAME = '.neurocore-queue-dead.jsonl';
const QUEUE_DRAIN_INTERVAL_MS = 30_000;
const MAX_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 1_000;

export type QueueKind = 'content_catalog';

export interface QueueEntry {
  /** Stable id for log correlation. Generated on enqueue. */
  id: string;
  kind: QueueKind;
  /** The POST body — the queue worker hands this to the right client method. */
  body: ContentCatalogCreatePayload;
  /** Last attempt count (0 before first try). */
  attemptCount: number;
  /** ISO timestamp of when we queued the entry. */
  queuedAt: string;
  /** Earliest ISO timestamp the worker is allowed to retry. */
  nextAttemptAt: string;
}

let workerHandle: NodeJS.Timeout | null = null;
let inFlightDrain: Promise<void> | null = null;
let queue: QueueEntry[] = [];
let deadLetterTotal = 0;
let queueFileDir: string | null = null;
let warnedAboutMissingRoot = false;

function makeEntryId(): string {
  return `q_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function nextBackoffMs(attempt: number): number {
  // 1s, 2s, 4s, 8s, 16s — cap before MAX_ATTEMPTS hits.
  return BACKOFF_BASE_MS * Math.pow(2, Math.min(attempt, 4));
}

function getQueueDir(): string | null {
  // Wrap in try/catch — getEnv() throws when env vars are unset (e.g.,
  // in unit tests that don't load a full env). In that case the queue
  // degrades to in-memory only rather than crashing the caller.
  let root: string | undefined;
  try {
    root = getEnv().WORKSPACE_ROOT;
  } catch {
    root = undefined;
  }
  if (!root) {
    if (!warnedAboutMissingRoot) {
      logger.warn(
        {},
        'neurocore-write-queue: WORKSPACE_ROOT unset — queue is in-memory only, writes will not survive restart',
      );
      warnedAboutMissingRoot = true;
    }
    return null;
  }
  return path.resolve(root);
}

function queuePath(): string | null {
  if (!queueFileDir) queueFileDir = getQueueDir();
  return queueFileDir ? path.join(queueFileDir, QUEUE_FILENAME) : null;
}

function deadLetterPath(): string | null {
  if (!queueFileDir) queueFileDir = getQueueDir();
  return queueFileDir ? path.join(queueFileDir, DEAD_LETTER_FILENAME) : null;
}

async function persistQueue(): Promise<void> {
  const p = queuePath();
  if (!p) return;
  const lines = queue.map((e) => JSON.stringify(e)).join('\n');
  const body = lines.length > 0 ? `${lines}\n` : '';
  const tmp = `${p}.tmp`;
  await fs.writeFile(tmp, body, { mode: 0o600 });
  await fs.rename(tmp, p);
}

async function appendToDeadLetter(entry: QueueEntry, reason: string): Promise<void> {
  deadLetterTotal++;
  const p = deadLetterPath();
  if (!p) return;
  const record = JSON.stringify({ ...entry, deadLetteredAt: new Date().toISOString(), reason });
  await fs.appendFile(p, `${record}\n`, { mode: 0o600 });
}

async function recoverFromDisk(): Promise<void> {
  const p = queuePath();
  if (!p) return;
  try {
    const raw = await fs.readFile(p, 'utf8');
    const lines = raw
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    const recovered: QueueEntry[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as QueueEntry;
        if (parsed && typeof parsed.id === 'string' && parsed.kind === 'content_catalog') {
          recovered.push(parsed);
        }
      } catch (err) {
        logger.warn(
          { err: (err as Error).message, line: line.slice(0, 120) },
          'neurocore-write-queue: discarding malformed queue entry on recovery',
        );
      }
    }
    queue = recovered;
    if (recovered.length > 0) {
      logger.info(
        { recovered: recovered.length },
        'neurocore-write-queue: recovered pending writes from disk',
      );
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return; // first boot — no queue file yet
    logger.warn(
      { err: (err as Error).message },
      'neurocore-write-queue: failed to recover from disk (continuing with empty in-memory queue)',
    );
  }
}

async function countDeadLetters(): Promise<number> {
  const p = deadLetterPath();
  if (!p) return deadLetterTotal;
  try {
    const raw = await fs.readFile(p, 'utf8');
    const lines = raw
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    return lines.length;
  } catch {
    return deadLetterTotal;
  }
}

/**
 * Enqueue a ContentCatalog write. Returns the entry id for log correlation.
 * Side effect: persists the queue to disk if WORKSPACE_ROOT is set.
 */
export async function enqueueContentCatalog(
  body: ContentCatalogCreatePayload,
): Promise<string> {
  const now = new Date().toISOString();
  const entry: QueueEntry = {
    id: makeEntryId(),
    kind: 'content_catalog',
    body,
    attemptCount: 0,
    queuedAt: now,
    nextAttemptAt: now,
  };
  queue.push(entry);
  await persistQueue();
  logger.info(
    { entryId: entry.id, deliverableId: body.deliverableId, depth: queue.length },
    'neurocore-write-queue: enqueued ContentCatalog write',
  );
  return entry.id;
}

interface DrainOpts {
  client?: NeurocoreClient;
  /** Override "now" for tests. */
  now?: () => Date;
}

/**
 * Drain the queue once: attempt each entry whose `nextAttemptAt` is <= now.
 * Successful entries are removed; failed entries are either rescheduled
 * (with backoff) or dead-lettered (after MAX_ATTEMPTS).
 *
 * Safe to call concurrently — a single in-flight promise serializes
 * the work so we don't double-POST the same entry.
 */
export async function drainOnce(opts: DrainOpts = {}): Promise<{
  attempted: number;
  succeeded: number;
  rescheduled: number;
  deadLettered: number;
}> {
  if (inFlightDrain) {
    await inFlightDrain;
    return { attempted: 0, succeeded: 0, rescheduled: 0, deadLettered: 0 };
  }
  const drain = (async () => {
    const client = opts.client ?? getNeurocoreClient();
    const now = (opts.now ?? (() => new Date()))();
    const dueIndexes: number[] = [];
    for (let i = 0; i < queue.length; i++) {
      if (new Date(queue[i]!.nextAttemptAt) <= now) dueIndexes.push(i);
    }
    const result = { attempted: 0, succeeded: 0, rescheduled: 0, deadLettered: 0 };
    const toRemove = new Set<number>();
    for (const i of dueIndexes) {
      const entry = queue[i]!;
      result.attempted++;
      try {
        await client.createContentCatalog(entry.body);
        toRemove.add(i);
        result.succeeded++;
        logger.info(
          { entryId: entry.id, deliverableId: entry.body.deliverableId, attempt: entry.attemptCount + 1 },
          'neurocore-write-queue: ContentCatalog write succeeded',
        );
      } catch (err) {
        entry.attemptCount += 1;
        // 4xx (non-retryable) is a poison pill — dead-letter immediately.
        // Otherwise retry up to MAX_ATTEMPTS.
        const isPoisonPill =
          err instanceof NeurocoreError && !isRetryable(err) && err.code !== 'NOT_CONFIGURED';
        if (isPoisonPill || entry.attemptCount >= MAX_ATTEMPTS) {
          const reason =
            err instanceof NeurocoreError ? `${err.code}: ${err.message}` : (err as Error).message;
          await appendToDeadLetter(entry, reason);
          toRemove.add(i);
          result.deadLettered++;
          logger.error(
            {
              entryId: entry.id,
              deliverableId: entry.body.deliverableId,
              attempts: entry.attemptCount,
              reason,
            },
            'neurocore-write-queue: dead-lettered ContentCatalog write',
          );
        } else {
          const backoffMs = nextBackoffMs(entry.attemptCount);
          entry.nextAttemptAt = new Date(now.getTime() + backoffMs).toISOString();
          result.rescheduled++;
          logger.warn(
            {
              entryId: entry.id,
              deliverableId: entry.body.deliverableId,
              attempt: entry.attemptCount,
              backoffMs,
              err: (err as Error).message,
            },
            'neurocore-write-queue: ContentCatalog write failed, rescheduled',
          );
        }
      }
    }
    if (toRemove.size > 0) {
      queue = queue.filter((_, idx) => !toRemove.has(idx));
    }
    if (result.attempted > 0) {
      await persistQueue();
    }
    return result;
  })();

  inFlightDrain = drain.then(() => undefined);
  try {
    return await drain;
  } finally {
    inFlightDrain = null;
  }
}

/** Start the periodic drain worker. Safe to call once at server boot. */
export function startWriteQueueWorker(): void {
  if (workerHandle) return;
  workerHandle = setInterval(() => {
    if (queue.length === 0) return;
    void drainOnce().catch((err) => {
      logger.error({ err: (err as Error).message }, 'neurocore-write-queue: drain crashed');
    });
  }, QUEUE_DRAIN_INTERVAL_MS);
  if (typeof workerHandle.unref === 'function') workerHandle.unref();
  logger.info(
    { intervalMs: QUEUE_DRAIN_INTERVAL_MS },
    'neurocore-write-queue: worker started',
  );
}

/** Stop the worker. Test-only — production starts once and never stops. */
export function stopWriteQueueWorker(): void {
  if (workerHandle) {
    clearInterval(workerHandle);
    workerHandle = null;
  }
}

/**
 * Boot path: recover from disk and start the worker. Server.ts calls this
 * once at startup; idempotent (a second call is a no-op).
 */
export async function initializeWriteQueue(): Promise<void> {
  await recoverFromDisk();
  startWriteQueueWorker();
}

/** Health surface — count of in-process queued writes. */
export function queueDepth(): number {
  return queue.length;
}

/** Health surface — count of permanently-failed writes. Reads the dead-
 *  letter file if present (counts persist across restarts). */
export async function deadLetterCount(): Promise<number> {
  return countDeadLetters();
}

// ---------------------------------------------------------------------------
// Test-only helpers
// ---------------------------------------------------------------------------

/** Reset queue + worker state. Test-only. */
export function _resetWriteQueueForTests(): void {
  stopWriteQueueWorker();
  queue = [];
  deadLetterTotal = 0;
  queueFileDir = null;
  warnedAboutMissingRoot = false;
  inFlightDrain = null;
}

/** Override the queue file directory for tests. Returns the absolute path
 *  resolved. */
export function _setQueueDirForTests(dir: string): string {
  queueFileDir = path.resolve(dir);
  // Eagerly create the dir if it doesn't exist — tests use tmpdirs that
  // already exist, but a missing dir would break appendFile silently.
  if (!fsSync.existsSync(queueFileDir)) {
    fsSync.mkdirSync(queueFileDir, { recursive: true });
  }
  return queueFileDir;
}

/** Test-only inspector. */
export function _peekQueueForTests(): readonly QueueEntry[] {
  return [...queue];
}
