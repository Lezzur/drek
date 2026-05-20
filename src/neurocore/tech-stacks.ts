import { logger } from '../logger.js';
import { getEnv } from '../env.js';
import { NeurocoreError, isRetryable } from './errors.js';

/**
 * TechStackProfile client — DREK's path to the Neurocore v2.1
 * tech_stack_profiles entity. Same shape as audience-profiles.ts:
 *   - In-memory cache, populated on successful read.
 *   - Auto-invalidate on any failure path (a cached entry is always a
 *     fresh successful read; never stale-on-error).
 *   - retry-once at the HTTP layer for retryable errors.
 *
 * The Brief Transformer (Call 11.5) uses `list({ status: 'active' })` once
 * per transform to build the catalog block in the prompt + validates the
 * LLM's pinnedTechStack picks against this same set.
 *
 * Failure mode: TechStackProfileUnavailableError /
 * TechStackProfileNotFoundError surface to the caller. NO fallback to a
 * hardcoded list — the whole point of moving the catalog into Neurocore
 * is one source of truth; silent fallback defeats it.
 */

const TECH_STACK_PROFILES_PATH = '/v1/tech-stack-profiles';
const DEFAULT_RETRY_BACKOFF_MS = 2_000;
const MAX_ATTEMPTS = 2;

export type TechStackCategory =
  | 'voice_bot'
  | 'workflow_automation'
  | 'agent_framework'
  | 'database'
  | 'frontend'
  | 'devtool'
  | 'integration_platform'
  | 'observability'
  | 'other';

export type PopularityTier = 'mainstream' | 'emerging' | 'niche';
export type TechStackStatus = 'active' | 'deprecated';

export interface TechStackProfile {
  id: string;
  name: string;
  category: TechStackCategory;
  ecosystem: string[];
  popularityTier: PopularityTier;
  filmableNotes: string;
  exampleUseCases: string[];
  status: TechStackStatus;
  createdAt: string;
  updatedAt: string;
}

export class TechStackProfileNotFoundError extends NeurocoreError {
  public readonly profileId: string;
  constructor(id: string) {
    super(
      'NOT_FOUND',
      `${TECH_STACK_PROFILES_PATH}/${id}`,
      `TechStackProfile not found: ${id}`,
      404,
    );
    this.name = 'TechStackProfileNotFoundError';
    this.profileId = id;
  }
}

export class TechStackProfileUnavailableError extends NeurocoreError {
  constructor(message: string, status: number | null = null) {
    super(
      status === null ? 'UNREACHABLE' : 'SERVER_ERROR',
      TECH_STACK_PROFILES_PATH,
      message,
      status,
    );
    this.name = 'TechStackProfileUnavailableError';
  }
}

export interface ListTechStackProfilesOpts {
  /** Filter by status. Default 'active' — deprecated stacks are hidden
   *  from the Brief Transformer prompt and the LLM can't pin them. */
  status?: TechStackStatus | 'all';
}

export interface TechStackProfileClient {
  list(opts?: ListTechStackProfilesOpts): Promise<TechStackProfile[]>;
  get(id: string): Promise<TechStackProfile>;
}

export class TechStackProfileClientImpl implements TechStackProfileClient {
  private readonly baseUrl: string;
  private readonly token: string | null;
  private readonly timeoutMs: number;
  private readonly retryBackoffMs: number;
  private readonly cache = new Map<string, TechStackProfile>();

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

  async list(opts: ListTechStackProfilesOpts = {}): Promise<TechStackProfile[]> {
    const status = opts.status ?? 'active';
    const path =
      status === 'active'
        ? TECH_STACK_PROFILES_PATH
        : `${TECH_STACK_PROFILES_PATH}?status=${status}`;
    const data = await this.fetchWithRetry<{ profiles: unknown[] }>('GET', path);
    if (!Array.isArray(data.profiles)) {
      throw new TechStackProfileUnavailableError(
        'list response missing profiles array',
      );
    }
    const profiles = data.profiles.map((raw) => this.parseProfile(raw));
    // Only cache active profiles (the default fetch path) to keep the
    // cache from drifting between filtered and unfiltered list calls.
    if (status === 'active') {
      for (const p of profiles) this.cache.set(p.id, p);
    }
    return profiles;
  }

  async get(id: string): Promise<TechStackProfile> {
    if (!id) {
      throw new TechStackProfileUnavailableError('id is required');
    }
    const cached = this.cache.get(id);
    if (cached) return cached;

    try {
      const data = await this.fetchWithRetry<{ profile: unknown }>(
        'GET',
        `${TECH_STACK_PROFILES_PATH}/${encodeURIComponent(id)}`,
      );
      const profile = this.parseProfile(data.profile);
      if (profile.id !== id) {
        throw new TechStackProfileUnavailableError(
          `server returned profile id ${profile.id} for requested ${id}`,
        );
      }
      this.cache.set(id, profile);
      return profile;
    } catch (err) {
      this.cache.delete(id);
      if (err instanceof NeurocoreError && err.code === 'NOT_FOUND') {
        throw new TechStackProfileNotFoundError(id);
      }
      throw err;
    }
  }

  private async fetchWithRetry<T>(method: 'GET', path: string): Promise<T> {
    if (!this.token) {
      throw new TechStackProfileUnavailableError(
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
          'tech-stack-profile call failed; retrying',
        );
        if (this.retryBackoffMs > 0) await sleep(this.retryBackoffMs);
      }
    }
    throw (
      lastError ??
      new TechStackProfileUnavailableError('unreachable code path')
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

  private parseProfile(raw: unknown): TechStackProfile {
    if (!raw || typeof raw !== 'object') {
      throw new TechStackProfileUnavailableError('profile is not an object');
    }
    const p = raw as Record<string, unknown>;
    const required = [
      'id',
      'name',
      'category',
      'ecosystem',
      'popularityTier',
      'filmableNotes',
      'exampleUseCases',
      'status',
      'createdAt',
      'updatedAt',
    ] as const;
    for (const k of required) {
      if (p[k] === undefined || p[k] === null) {
        throw new TechStackProfileUnavailableError(`profile missing field: ${k}`);
      }
    }
    if (!Array.isArray(p.ecosystem)) {
      throw new TechStackProfileUnavailableError('profile ecosystem not an array');
    }
    if (!Array.isArray(p.exampleUseCases) || p.exampleUseCases.length === 0) {
      throw new TechStackProfileUnavailableError(
        'profile exampleUseCases empty or not an array',
      );
    }
    return p as unknown as TechStackProfile;
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
// Memoized client + cache controls — matches the audience-profiles pattern.
// ---------------------------------------------------------------------------

let cached: TechStackProfileClientImpl | null = null;

export function getTechStackProfileClient(): TechStackProfileClientImpl {
  if (!cached) cached = new TechStackProfileClientImpl();
  return cached;
}

/** Test-only: clear the memoized client so a new env/cache can take effect. */
export function _resetTechStackProfileClientForTests(): void {
  cached = null;
}

/** Clear the in-memory cache. Exposed for tests + a future admin flush route. */
export function clearTechStackProfileCache(): void {
  if (cached) {
    (cached as unknown as { cache: Map<string, TechStackProfile> }).cache.clear();
  }
}
