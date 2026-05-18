import { logger } from '../logger.js';
import { getEnv } from '../env.js';
import { NeurocoreError, isRetryable } from './errors.js';

/**
 * AudienceProfile client — DREK's path to the Neurocore v2
 * AudienceProfile entity. Wraps the same HTTP plumbing as NeurocoreClient
 * (auth, timeout, retry-once) but adds a process-lifetime in-memory cache.
 *
 * Cache contract per TECH-SPEC-drek-v2-youtube-2026-05-18.md §4.2 Component F:
 *   - Successful fetch populates the cache for the profile id
 *   - Any fetch failure (timeout, 5xx, 404, JSON parse error) invalidates
 *     the affected cache entry before throwing, so the next attempt
 *     re-fetches cleanly
 *   - clearAudienceProfileCache() is exposed for tests + a future
 *     manual-flush admin route; production steady-state relies on
 *     the auto-invalidate-on-error path
 *
 * Failure mode: AudienceProfileUnavailableError and AudienceProfileNotFoundError
 * surface to the engine step that called us. NO fallback to a generic profile.
 * Targeted output is the whole point of the entity — silent fallback defeats it.
 */

const AUDIENCE_PROFILES_PATH = '/v1/audience-profiles';
const DEFAULT_RETRY_BACKOFF_MS = 2_000;
const MAX_ATTEMPTS = 2;

export type CtaType =
  | 'subscribe_and_long_form'
  | 'consultation_book'
  | 'community_join'
  | 'lead_magnet_download';

export interface AudienceProfile {
  id: string;
  name: string;
  description: string;
  watchPersona: string;
  painPoints: string[];
  buyingTriggers: string[];
  voiceGuidelines: {
    tone: string;
    vocabulary: string;
    sentenceLengthGuide: string;
    taboos: string[];
  };
  hookPatterns: string[];
  pacingRules: {
    wordsPerMinute: number;
    avgSentenceWords: number;
    densityNote: string;
  };
  ctaStyle: {
    type: CtaType;
    phrasing: string;
    placement: string;
  };
  createdAt: string;
  updatedAt: string;
}

export class AudienceProfileNotFoundError extends NeurocoreError {
  public readonly profileId: string;
  constructor(id: string) {
    super('NOT_FOUND', `${AUDIENCE_PROFILES_PATH}/${id}`, `AudienceProfile not found: ${id}`, 404);
    this.name = 'AudienceProfileNotFoundError';
    this.profileId = id;
  }
}

export class AudienceProfileUnavailableError extends NeurocoreError {
  constructor(message: string, status: number | null = null) {
    super(status === null ? 'UNREACHABLE' : 'SERVER_ERROR', AUDIENCE_PROFILES_PATH, message, status);
    this.name = 'AudienceProfileUnavailableError';
  }
}

export interface AudienceProfileClient {
  list(): Promise<AudienceProfile[]>;
  get(id: string): Promise<AudienceProfile>;
}

export class AudienceProfileClientImpl implements AudienceProfileClient {
  private readonly baseUrl: string;
  private readonly token: string | null;
  private readonly timeoutMs: number;
  private readonly retryBackoffMs: number;
  private readonly cache = new Map<string, AudienceProfile>();

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

  async list(): Promise<AudienceProfile[]> {
    const data = await this.fetchWithRetry<{ profiles: unknown[] }>(
      'GET',
      AUDIENCE_PROFILES_PATH,
    );
    if (!Array.isArray(data.profiles)) {
      throw new AudienceProfileUnavailableError(
        'list response missing profiles array',
      );
    }
    const profiles = data.profiles.map((raw) => this.parseProfile(raw));
    for (const p of profiles) this.cache.set(p.id, p);
    return profiles;
  }

  async get(id: string): Promise<AudienceProfile> {
    if (!id) {
      throw new AudienceProfileUnavailableError('id is required');
    }
    const cached = this.cache.get(id);
    if (cached) return cached;

    try {
      const data = await this.fetchWithRetry<{ profile: unknown }>(
        'GET',
        `${AUDIENCE_PROFILES_PATH}/${encodeURIComponent(id)}`,
      );
      const profile = this.parseProfile(data.profile);
      // Defensive: server should return the same id we asked for.
      if (profile.id !== id) {
        throw new AudienceProfileUnavailableError(
          `server returned profile id ${profile.id} for requested ${id}`,
        );
      }
      this.cache.set(id, profile);
      return profile;
    } catch (err) {
      // Always invalidate on any failure path — keeps the cache contract
      // simple: a cached entry is always a fresh successful read.
      this.cache.delete(id);
      if (err instanceof NeurocoreError && err.code === 'NOT_FOUND') {
        throw new AudienceProfileNotFoundError(id);
      }
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Internals — mirror NeurocoreClient.requestJson but with AudienceProfile-
  // specific error wrapping. Kept private so the cache invariants stay tight.
  // -------------------------------------------------------------------------

  private async fetchWithRetry<T>(method: 'GET', path: string): Promise<T> {
    if (!this.token) {
      throw new AudienceProfileUnavailableError(
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
          'audience-profile call failed; retrying',
        );
        if (this.retryBackoffMs > 0) await sleep(this.retryBackoffMs);
      }
    }
    throw lastError ?? new AudienceProfileUnavailableError('unreachable code path');
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

  /**
   * Strict structural validation. We don't want a bad-shape payload poisoning
   * downstream LLM prompts, so the check is verbose and explicit.
   */
  private parseProfile(raw: unknown): AudienceProfile {
    if (!raw || typeof raw !== 'object') {
      throw new AudienceProfileUnavailableError('profile is not an object');
    }
    const p = raw as Record<string, unknown>;
    const required = [
      'id',
      'name',
      'description',
      'watchPersona',
      'painPoints',
      'buyingTriggers',
      'voiceGuidelines',
      'hookPatterns',
      'pacingRules',
      'ctaStyle',
      'createdAt',
      'updatedAt',
    ] as const;
    for (const k of required) {
      if (p[k] === undefined || p[k] === null) {
        throw new AudienceProfileUnavailableError(`profile missing field: ${k}`);
      }
    }
    if (!Array.isArray(p.painPoints) || p.painPoints.length === 0) {
      throw new AudienceProfileUnavailableError('profile painPoints empty or not an array');
    }
    if (!Array.isArray(p.buyingTriggers) || p.buyingTriggers.length === 0) {
      throw new AudienceProfileUnavailableError('profile buyingTriggers empty or not an array');
    }
    if (!Array.isArray(p.hookPatterns) || p.hookPatterns.length === 0) {
      throw new AudienceProfileUnavailableError('profile hookPatterns empty or not an array');
    }
    return p as unknown as AudienceProfile;
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
// Memoized client + cache controls — matches the NeurocoreClient pattern.
// ---------------------------------------------------------------------------

let cached: AudienceProfileClientImpl | null = null;

export function getAudienceProfileClient(): AudienceProfileClientImpl {
  if (!cached) cached = new AudienceProfileClientImpl();
  return cached;
}

/** Test-only: clear the memoized client so a new env/cache can take effect. */
export function _resetAudienceProfileClientForTests(): void {
  cached = null;
}

/** Clear the in-memory cache. Exposed for tests + a future admin flush route. */
export function clearAudienceProfileCache(): void {
  if (cached) {
    // Reach into the private cache via a controlled method.
    (cached as unknown as { cache: Map<string, AudienceProfile> }).cache.clear();
  }
}
