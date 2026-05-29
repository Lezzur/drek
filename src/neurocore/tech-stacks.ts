import { NeurocoreError } from './errors.js';
import { getSharedClient } from './_shared.js';

/**
 * TechStackProfile client — DREK's path to the Neurocore v2.1
 * tech_stack_profiles entity.
 *
 * **Phase 2a migration:** this module is now a facade over
 * `@lezzur/neurocore-client`. The shared client owns HTTP, cache,
 * retry, and invalidate-on-error. This file preserves DREK's public
 * surface — types, error subclasses, ClientImpl class, singleton — so
 * the existing call sites (Brief Transformer, validators) don't have
 * to change yet.
 *
 * Same migration plan as audience-profiles.ts — see _shared.ts.
 *
 * Behavior preserved verbatim:
 *   - Strict structural validation on every returned profile.
 *   - TechStackProfileNotFoundError on 404 (shared client returns null).
 *   - TechStackProfileUnavailableError on every other failure path.
 *   - list() defaults to status='active' so deprecated stacks stay
 *     hidden from the Brief Transformer prompt.
 *
 * Behavior delegated to the shared client:
 *   - HTTP transport, bearer auth, retry, abort-on-timeout.
 *   - In-process cache with auto-invalidate-on-error.
 *   - Concurrent first-read dedup.
 */

const TECH_STACK_PROFILES_PATH = '/v1/tech-stack-profiles';

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
  private readonly seenIds = new Set<string>();

  constructor(_opts?: {
    baseUrl?: string;
    token?: string | null;
    timeoutMs?: number;
    retryBackoffMs?: number;
  }) {
    // Backward-compat: pre-migration constructor opts ignored; the
    // shared client owns transport config. Phase 2d removes this.
  }

  async list(opts: ListTechStackProfilesOpts = {}): Promise<TechStackProfile[]> {
    const status = opts.status ?? 'active';
    const nc = await getSharedClient();
    let raw: unknown[];
    try {
      // Shared client's list() takes an optional filter map. Server filters
      // by status server-side when status !== 'all'.
      raw = status === 'all'
        ? await nc.techStackProfiles.list()
        : await nc.techStackProfiles.list({ status });
    } catch (err) {
      throw translate(err, TECH_STACK_PROFILES_PATH);
    }
    const profiles = raw.map((r) => validateProfile(r));
    for (const p of profiles) this.seenIds.add(p.id);
    return profiles;
  }

  async get(id: string): Promise<TechStackProfile> {
    if (!id) {
      throw new TechStackProfileUnavailableError('id is required');
    }
    const nc = await getSharedClient();
    let raw: unknown;
    try {
      raw = await nc.techStackProfiles.get(id);
    } catch (err) {
      throw translate(err, `${TECH_STACK_PROFILES_PATH}/${id}`, id);
    }
    if (raw === null) throw new TechStackProfileNotFoundError(id);
    const profile = validateProfile(raw);
    if (profile.id !== id) {
      throw new TechStackProfileUnavailableError(
        `server returned profile id ${profile.id} for requested ${id}`,
      );
    }
    this.seenIds.add(id);
    return profile;
  }

  invalidateAllSeen(): void {
    void (async () => {
      const nc = await getSharedClient();
      for (const id of this.seenIds) nc.techStackProfiles.invalidate(id);
      this.seenIds.clear();
    })();
  }
}

function translate(err: unknown, endpoint: string, id?: string): NeurocoreError {
  if (err instanceof NeurocoreError) return err;
  if (err && typeof err === 'object') {
    const e = err as { code?: string; message?: string; status?: number };
    const message = e.message ?? 'shared client error';
    const status = typeof e.status === 'number' ? e.status : null;
    if (e.code === 'NOT_FOUND' && id !== undefined) {
      return new TechStackProfileNotFoundError(id);
    }
    return new TechStackProfileUnavailableError(message, status);
  }
  return new TechStackProfileUnavailableError(String(err));
}

function validateProfile(raw: unknown): TechStackProfile {
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
  if (!Array.isArray(p.exampleUseCases)) {
    throw new TechStackProfileUnavailableError('profile exampleUseCases not an array');
  }
  return p as unknown as TechStackProfile;
}

// ---------------------------------------------------------------------------
// Memoized client + cache controls
// ---------------------------------------------------------------------------

let cachedImpl: TechStackProfileClientImpl | null = null;

export function getTechStackProfileClient(): TechStackProfileClientImpl {
  if (!cachedImpl) cachedImpl = new TechStackProfileClientImpl();
  return cachedImpl;
}

export function _resetTechStackProfileClientForTests(): void {
  cachedImpl = null;
}

export function clearTechStackProfileCache(): void {
  if (cachedImpl) cachedImpl.invalidateAllSeen();
}
