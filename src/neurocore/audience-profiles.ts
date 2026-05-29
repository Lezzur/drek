import { NeurocoreError } from './errors.js';
import { getSharedClient } from './_shared.js';

/**
 * AudienceProfile client — DREK's path to the Neurocore v2
 * AudienceProfile entity.
 *
 * **Phase 2a migration (this file):** this module is now a facade over
 * `@lezzur/neurocore-client`. The HTTP plumbing (auth, timeout, retry,
 * cache, invalidate-on-error) all lives in the shared client. This file
 * preserves DREK's public surface — `AudienceProfile`, the error
 * subclasses, `AudienceProfileClientImpl`, the singleton getter — so the
 * 57 call sites across DREK don't have to change yet. They'll move to
 * direct `@lezzur/neurocore-client` imports in Phase 2d.
 *
 * Behavior preserved from the pre-migration impl:
 *   - Strict structural validation on every returned profile (required
 *     fields + non-empty arrays). The shared client's schema validation
 *     is more permissive than DREK's — we keep DREK's stricter check
 *     at this boundary so a sparse payload can't poison downstream
 *     LLM prompts.
 *   - `AudienceProfileNotFoundError` on 404 (shared client returns null).
 *   - `AudienceProfileUnavailableError` on every other failure path,
 *     after invalidating the cache for the affected id.
 *
 * Behavior delegated to the shared client:
 *   - HTTP transport, auth header, retry with backoff, abort-on-timeout.
 *   - In-process cache with auto-invalidate-on-error.
 *   - Concurrent first-read dedup.
 */

const AUDIENCE_PROFILES_PATH = '/v1/audience-profiles';

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
  /**
   * Track IDs we've returned so `clearAudienceProfileCache()` can fan out
   * `invalidate(id)` calls to the shared client (which doesn't expose a
   * clear-all on its EntityReadClient interface).
   */
  private readonly seenIds = new Set<string>();

  /**
   * Backward-compat constructor. Pre-migration callers passed
   * baseUrl/token/timeout overrides; the shared client now owns all of
   * that, so these opts are accepted but ignored. Marked unused via
   * the underscore prefix so the typechecker doesn't complain.
   *
   * Phase 2d cleanup: remove this constructor when call sites switch
   * to importing the shared client directly.
   */
  constructor(_opts?: {
    baseUrl?: string;
    token?: string | null;
    timeoutMs?: number;
    retryBackoffMs?: number;
  }) {
    // intentionally empty — facade has no per-instance HTTP config
  }

  async list(): Promise<AudienceProfile[]> {
    const nc = await getSharedClient();
    let rawProfiles: unknown[];
    try {
      rawProfiles = await nc.audienceProfiles.list();
    } catch (err) {
      throw translate(err, AUDIENCE_PROFILES_PATH);
    }
    const profiles = rawProfiles.map((raw) => validateProfile(raw));
    for (const p of profiles) this.seenIds.add(p.id);
    return profiles;
  }

  async get(id: string): Promise<AudienceProfile> {
    if (!id) {
      throw new AudienceProfileUnavailableError('id is required');
    }
    const nc = await getSharedClient();
    let raw: unknown;
    try {
      raw = await nc.audienceProfiles.get(id);
    } catch (err) {
      throw translate(err, `${AUDIENCE_PROFILES_PATH}/${id}`, id);
    }
    if (raw === null) {
      throw new AudienceProfileNotFoundError(id);
    }
    const profile = validateProfile(raw);
    if (profile.id !== id) {
      // Shared client already has SERVER_ID_MISMATCH defense, but DREK's
      // existing contract throws Unavailable here. Surface that explicitly.
      throw new AudienceProfileUnavailableError(
        `server returned profile id ${profile.id} for requested ${id}`,
      );
    }
    this.seenIds.add(id);
    return profile;
  }

  /** Internal helper used by clearAudienceProfileCache(). */
  invalidateAllSeen(): void {
    // We can't reach into the shared client to peek its cache, so we
    // invalidate every id we've handed out. New ids fetched after this
    // will repopulate naturally.
    void (async () => {
      const nc = await getSharedClient();
      for (const id of this.seenIds) nc.audienceProfiles.invalidate(id);
      this.seenIds.clear();
    })();
  }
}

/**
 * Translate any shared-client error into the DREK-specific
 * AudienceProfileUnavailableError shape, so existing catch blocks across
 * DREK keep matching.
 */
function translate(err: unknown, endpoint: string, id?: string): NeurocoreError {
  if (err instanceof NeurocoreError) return err;
  // Shared client error: has code + status + message
  if (err && typeof err === 'object') {
    const e = err as { code?: string; message?: string; status?: number };
    const message = e.message ?? 'shared client error';
    const status = typeof e.status === 'number' ? e.status : null;
    if (e.code === 'NOT_FOUND' && id !== undefined) {
      return new AudienceProfileNotFoundError(id);
    }
    return new AudienceProfileUnavailableError(message, status);
  }
  return new AudienceProfileUnavailableError(String(err));
}

/**
 * Strict structural validation. DREK's downstream LLM prompts depend on
 * non-empty arrays + presence of every required field, so a partial
 * server response fails closed here.
 */
function validateProfile(raw: unknown): AudienceProfile {
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

// ---------------------------------------------------------------------------
// Memoized client + cache controls — kept for backward-compatibility with
// existing call sites across DREK.
// ---------------------------------------------------------------------------

let cachedImpl: AudienceProfileClientImpl | null = null;

export function getAudienceProfileClient(): AudienceProfileClientImpl {
  if (!cachedImpl) cachedImpl = new AudienceProfileClientImpl();
  return cachedImpl;
}

/** Test-only: dispose the singleton so the next call rebuilds it. */
export function _resetAudienceProfileClientForTests(): void {
  cachedImpl = null;
}

/**
 * Clear the in-memory cache. Pre-migration, this wiped a local Map; now
 * it fans out `invalidate(id)` calls to the shared client for every id
 * we've handed back to a caller.
 */
export function clearAudienceProfileCache(): void {
  if (cachedImpl) cachedImpl.invalidateAllSeen();
}
