import { NeurocoreError } from './errors.js';
import { getSharedClient } from './_shared.js';

/**
 * StackPerformance client — DREK's read-side path to the Neurocore
 * `stack_performance` entity.
 *
 * **Phase 2a migration:** facade over `@lezzur/neurocore-client`. Public
 * surface unchanged so call sites (Brief Transformer CHANNEL HISTORY
 * block) don't have to move yet.
 *
 * Behavior preserved verbatim:
 *   - get() returns null on 404 (NOT a throw — unlike audience-profiles).
 *   - Validation rejects sparse entries so a partial payload can't poison
 *     the prompt.
 *   - StackPerformanceUnavailableError on every transport failure path.
 *
 * Behavior delegated to the shared client:
 *   - HTTP transport, bearer auth, retry, abort-on-timeout.
 *   - StackPerformance is configured uncached in the shared client per
 *     entity-registry; every read is a fresh fetch.
 */

const STACK_PERFORMANCE_PATH = '/v1/stack-performance';

export interface StackPerformance {
  id: string;
  techStackProfileId: string;
  videoCount: number;
  avgViews: number;
  avgWatchTimeSeconds: number;
  avgCtr: number;
  totalRevenueUsd: number | null;
  lastVideoPublishedAt: string | null;
  lastComputedAt: string;
}

/** Derive the StackPerformance doc id from a tech-stack id. Must match
 *  the Neurocore-side derivePerfId() exactly — the route validates it. */
export function derivePerfId(techStackProfileId: string): string {
  return `perf_${techStackProfileId.replace(/^tech_/, '')}`;
}

export class StackPerformanceUnavailableError extends NeurocoreError {
  constructor(message: string, status: number | null = null) {
    super(
      status === null ? 'UNREACHABLE' : 'SERVER_ERROR',
      STACK_PERFORMANCE_PATH,
      message,
      status,
    );
    this.name = 'StackPerformanceUnavailableError';
  }
}

export interface StackPerformanceClient {
  list(): Promise<StackPerformance[]>;
  get(techStackProfileId: string): Promise<StackPerformance | null>;
}

export class StackPerformanceClientImpl implements StackPerformanceClient {
  constructor(_opts?: {
    baseUrl?: string;
    token?: string | null;
    timeoutMs?: number;
    retryBackoffMs?: number;
  }) {
    // Pre-migration constructor opts ignored — shared client owns transport.
  }

  async list(): Promise<StackPerformance[]> {
    const nc = await getSharedClient();
    let raw: unknown[];
    try {
      raw = await nc.stackPerformance.list();
    } catch (err) {
      throw translate(err, STACK_PERFORMANCE_PATH);
    }
    return raw.map((r) => validateEntry(r));
  }

  async get(techStackProfileId: string): Promise<StackPerformance | null> {
    if (!techStackProfileId) {
      throw new StackPerformanceUnavailableError('techStackProfileId is required');
    }
    const nc = await getSharedClient();
    let raw: unknown;
    try {
      raw = await nc.stackPerformance.get(techStackProfileId);
    } catch (err) {
      throw translate(err, `${STACK_PERFORMANCE_PATH}/${techStackProfileId}`);
    }
    // Per DREK's contract, get() returns null on 404 (not a throw).
    if (raw === null) return null;
    const entry = validateEntry(raw);
    if (entry.techStackProfileId !== techStackProfileId) {
      throw new StackPerformanceUnavailableError(
        `server returned entry for techStackProfileId ${entry.techStackProfileId}, ` +
          `expected ${techStackProfileId}`,
      );
    }
    return entry;
  }
}

function translate(err: unknown, endpoint: string): NeurocoreError {
  if (err instanceof NeurocoreError) return err;
  if (err && typeof err === 'object') {
    const e = err as { code?: string; message?: string; status?: number };
    const message = e.message ?? 'shared client error';
    const status = typeof e.status === 'number' ? e.status : null;
    return new StackPerformanceUnavailableError(message, status);
  }
  return new StackPerformanceUnavailableError(String(err));
}

function validateEntry(raw: unknown): StackPerformance {
  if (!raw || typeof raw !== 'object') {
    throw new StackPerformanceUnavailableError('entry is not an object');
  }
  const e = raw as Record<string, unknown>;
  const required = [
    'id',
    'techStackProfileId',
    'videoCount',
    'avgViews',
    'avgWatchTimeSeconds',
    'avgCtr',
    'lastComputedAt',
  ] as const;
  for (const k of required) {
    if (e[k] === undefined || e[k] === null) {
      throw new StackPerformanceUnavailableError(`entry missing field: ${k}`);
    }
  }
  return e as unknown as StackPerformance;
}

// ---------------------------------------------------------------------------
// Memoized client + cache controls
// ---------------------------------------------------------------------------

let cachedImpl: StackPerformanceClientImpl | null = null;

export function getStackPerformanceClient(): StackPerformanceClientImpl {
  if (!cachedImpl) cachedImpl = new StackPerformanceClientImpl();
  return cachedImpl;
}

export function _resetStackPerformanceClientForTests(): void {
  cachedImpl = null;
}

/**
 * Clear the in-memory cache. Pre-migration this wiped a local Map; now
 * it's a no-op because the shared client configures StackPerformance as
 * uncached (every read is fresh). Kept exported for backward-compat with
 * callers that defensively call it.
 */
export function clearStackPerformanceCache(): void {
  // intentional no-op — shared client is uncached for this entity
}
