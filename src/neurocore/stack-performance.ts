import { logger } from '../logger.js';
import { getEnv } from '../env.js';
import { NeurocoreError, isRetryable } from './errors.js';

/**
 * StackPerformance client — DREK's read-side path to the Neurocore
 * `stack_performance` entity. Same shape as audience-profiles.ts and
 * tech-stacks.ts: in-memory cache populated on successful read,
 * auto-invalidate on failure, retry-once at the HTTP layer.
 *
 * The Brief Transformer reads this once per transform to populate the
 * CHANNEL HISTORY block. The nightly refresh-stack-performance cron
 * WRITES via the existing NeurocoreClient.createStackPerformance path
 * (see stack-performance-writer below) — this module is reads only.
 */

const STACK_PERFORMANCE_PATH = '/v1/stack-performance';
const DEFAULT_RETRY_BACKOFF_MS = 2_000;
const MAX_ATTEMPTS = 2;

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
  private readonly baseUrl: string;
  private readonly token: string | null;
  private readonly timeoutMs: number;
  private readonly retryBackoffMs: number;
  private readonly cache = new Map<string, StackPerformance>();

  constructor(opts?: {
    baseUrl?: string;
    token?: string | null;
    timeoutMs?: number;
    retryBackoffMs?: number;
  }) {
    const env = getEnv();
    this.baseUrl = (opts?.baseUrl ?? env.NEUROCORE_URL).replace(/\/$/, '');
    this.token =
      opts && 'token' in opts ? opts.token ?? null : env.NEUROCORE_TOKEN ?? null;
    this.timeoutMs = opts?.timeoutMs ?? env.NEUROCORE_TIMEOUT_MS;
    this.retryBackoffMs = opts?.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
  }

  async list(): Promise<StackPerformance[]> {
    const data = await this.fetchWithRetry<{ entries: unknown[] }>(
      'GET',
      STACK_PERFORMANCE_PATH,
    );
    if (!Array.isArray(data.entries)) {
      throw new StackPerformanceUnavailableError(
        'list response missing entries array',
      );
    }
    const entries = data.entries.map((raw) => this.parseEntry(raw));
    for (const e of entries) this.cache.set(e.techStackProfileId, e);
    return entries;
  }

  async get(techStackProfileId: string): Promise<StackPerformance | null> {
    if (!techStackProfileId) {
      throw new StackPerformanceUnavailableError('techStackProfileId is required');
    }
    const cached = this.cache.get(techStackProfileId);
    if (cached) return cached;

    try {
      const data = await this.fetchWithRetry<{ entry: unknown }>(
        'GET',
        `${STACK_PERFORMANCE_PATH}/${encodeURIComponent(techStackProfileId)}`,
      );
      const entry = this.parseEntry(data.entry);
      this.cache.set(techStackProfileId, entry);
      return entry;
    } catch (err) {
      this.cache.delete(techStackProfileId);
      if (err instanceof NeurocoreError && err.code === 'NOT_FOUND') {
        // 404 here means "this stack hasn't been published yet" — that's
        // a valid state (the Brief Transformer falls back to "no data
        // yet" coverage hint). Return null rather than throw.
        return null;
      }
      throw err;
    }
  }

  private async fetchWithRetry<T>(method: 'GET', path: string): Promise<T> {
    if (!this.token) {
      throw new StackPerformanceUnavailableError(
        'NEUROCORE_TOKEN is not set — cannot call Neurocore',
      );
    }

    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/json',
    };

    let lastError: NeurocoreError | null = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        return await this.attempt<T>(method, url, headers, path);
      } catch (err) {
        if (!(err instanceof NeurocoreError)) throw err;
        lastError = err;
        if (!isRetryable(err) || attempt === MAX_ATTEMPTS) break;
        logger.warn(
          { endpoint: path, attempt, code: err.code },
          'stack-performance call failed; retrying',
        );
        if (this.retryBackoffMs > 0) await sleep(this.retryBackoffMs);
      }
    }
    throw (
      lastError ??
      new StackPerformanceUnavailableError('unreachable code path')
    );
  }

  private async attempt<T>(
    method: 'GET',
    url: string,
    headers: Record<string, string>,
    endpoint: string,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    let response: Response;
    try {
      response = await fetch(url, { method, headers, signal: controller.signal });
    } catch (err) {
      const cause = err as Error & { name?: string };
      if (cause.name === 'AbortError') {
        throw new NeurocoreError(
          'TIMEOUT',
          endpoint,
          `request exceeded ${this.timeoutMs}ms`,
        );
      }
      throw new NeurocoreError(
        'UNREACHABLE',
        endpoint,
        cause.message || 'fetch failed',
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const code = statusToCode(response.status);
      throw new NeurocoreError(
        code,
        endpoint,
        `${response.status} ${response.statusText}`,
        response.status,
      );
    }

    if (response.status === 204) return {} as T;

    try {
      return (await response.json()) as T;
    } catch (err) {
      throw new NeurocoreError(
        'INVALID_RESPONSE',
        endpoint,
        `response was not valid JSON: ${(err as Error).message}`,
        response.status,
      );
    }
  }

  private parseEntry(raw: unknown): StackPerformance {
    if (!raw || typeof raw !== 'object') {
      throw new StackPerformanceUnavailableError('entry is not an object');
    }
    const p = raw as Record<string, unknown>;
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
      if (p[k] === undefined || p[k] === null) {
        throw new StackPerformanceUnavailableError(
          `entry missing field: ${k}`,
        );
      }
    }
    return p as unknown as StackPerformance;
  }
}

function statusToCode(status: number) {
  if (status === 401) return 'UNAUTHENTICATED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 429) return 'RATE_LIMITED';
  if (status === 503) return 'DEGRADED';
  if (status >= 400 && status < 500) return 'BAD_REQUEST';
  return 'SERVER_ERROR';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof t.unref === 'function') t.unref();
  });
}

// ---------------------------------------------------------------------------
// Memoized client + cache controls.
// ---------------------------------------------------------------------------

let cached: StackPerformanceClientImpl | null = null;

export function getStackPerformanceClient(): StackPerformanceClientImpl {
  if (!cached) cached = new StackPerformanceClientImpl();
  return cached;
}

export function _resetStackPerformanceClientForTests(): void {
  cached = null;
}

export function clearStackPerformanceCache(): void {
  if (cached) {
    (cached as unknown as { cache: Map<string, StackPerformance> }).cache.clear();
  }
}
