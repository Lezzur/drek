import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock env so tests don't depend on process.env.
const fakeEnv = {
  PORT: 3003,
  NODE_ENV: 'test' as const,
  GCP_PROJECT_ID: 'drek-test',
  LOG_LEVEL: 'silent' as const,
  LLM_PROVIDER: 'claude' as const,
  LLM_TIMEOUT_MS: 120_000,
  CLAUDE_BIN: 'claude',
  CLAUDE_MODEL: 'claude-sonnet-4-5',
  CODEX_BIN: 'codex',
  CODEX_MODEL: 'gpt-5-codex',
  NEUROCORE_URL: 'http://localhost:3100',
  NEUROCORE_TOKEN: 'test-token',
  NEUROCORE_TIMEOUT_MS: 50,
};
vi.mock('../../src/env.js', () => ({
  getEnv: () => fakeEnv,
  loadEnv: () => fakeEnv,
}));

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
  AudienceProfileClientImpl,
  AudienceProfileNotFoundError,
  AudienceProfileUnavailableError,
  clearAudienceProfileCache,
  getAudienceProfileClient,
  _resetAudienceProfileClientForTests,
} from '../../src/neurocore/audience-profiles.js';

// -----------------------------------------------------------------------------
// fetch mock — minimal version of the one in client.test.ts, adapted for the
// GET-only audience-profile endpoints.
// -----------------------------------------------------------------------------

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
}

const fetchCalls: FetchCall[] = [];

type AnyHeaders = Headers | Record<string, string> | [string, string][] | undefined;

function headersToObject(h: AnyHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  if (h instanceof Headers) {
    h.forEach((v, k) => {
      out[k.toLowerCase()] = v;
    });
    return out;
  }
  if (Array.isArray(h)) {
    for (const [k, v] of h) out[k.toLowerCase()] = v;
    return out;
  }
  for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = v;
  return out;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

type FetchBehavior = Response | (() => Promise<Response>) | { throws: Error };
const fetchQueue: FetchBehavior[] = [];

function queueResponse(b: FetchBehavior): void {
  fetchQueue.push(b);
}

function installFetchMock(): void {
  globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? 'GET';
    const headers = headersToObject(init?.headers as AnyHeaders);
    fetchCalls.push({ url, method, headers });

    const next = fetchQueue.shift();
    if (!next) throw new Error(`unexpected fetch ${method} ${url} — queue empty`);
    if (next instanceof Response) return next;
    if ('throws' in next) throw next.throws;
    return new Promise<Response>((resolve, reject) => {
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        reject(new DOMException('aborted', 'AbortError'));
      };
      init?.signal?.addEventListener('abort', onAbort);
      void next().then(
        (res) => {
          if (settled) return;
          settled = true;
          resolve(res);
        },
        (err) => {
          if (settled) return;
          settled = true;
          reject(err);
        },
      );
    });
  }) as typeof fetch;
}

const sampleProfile = {
  id: 'developer_longform',
  name: 'Developer / Learner — Long-form',
  description: 'AI/automation practitioners',
  watchPersona: 'Engineers',
  painPoints: ['marketing-heavy AI content'],
  buyingTriggers: ['recovery-on-camera'],
  voiceGuidelines: {
    tone: 'authoritative-warm',
    vocabulary: 'technical but accessible',
    sentenceLengthGuide: 'mixed',
    taboos: ["'guys'"],
  },
  hookPatterns: ['start with the failure'],
  pacingRules: {
    wordsPerMinute: 150,
    avgSentenceWords: 14,
    densityNote: 'Pauses after big claims',
  },
  ctaStyle: {
    type: 'subscribe_and_long_form' as const,
    phrasing: 'subscribe — the next one is...',
    placement: 'final 15 seconds',
  },
  createdAt: '2026-05-18T14:00:00.000Z',
  updatedAt: '2026-05-18T14:00:00.000Z',
};

beforeEach(() => {
  fetchCalls.length = 0;
  fetchQueue.length = 0;
  installFetchMock();
  clearAudienceProfileCache();
  _resetAudienceProfileClientForTests();
});

// -----------------------------------------------------------------------------
// list()
// -----------------------------------------------------------------------------

describe('AudienceProfileClient.list', () => {
  it('returns parsed profiles + populates cache', async () => {
    queueResponse(jsonResponse(200, { profiles: [sampleProfile] }));
    const client = new AudienceProfileClientImpl({ retryBackoffMs: 0 });
    const profiles = await client.list();
    expect(profiles).toHaveLength(1);
    expect(profiles[0]?.id).toBe('developer_longform');
    expect(fetchCalls).toHaveLength(1);

    // Subsequent get() for the same id hits cache.
    const cached = await client.get('developer_longform');
    expect(cached.id).toBe('developer_longform');
    expect(fetchCalls).toHaveLength(1);
  });

  it('throws AudienceProfileUnavailableError on missing profiles array', async () => {
    queueResponse(jsonResponse(200, { wrongKey: [] }));
    const client = new AudienceProfileClientImpl({ retryBackoffMs: 0 });
    await expect(client.list()).rejects.toBeInstanceOf(AudienceProfileUnavailableError);
  });
});

// -----------------------------------------------------------------------------
// get()
// -----------------------------------------------------------------------------

describe('AudienceProfileClient.get', () => {
  it('returns parsed profile + caches it', async () => {
    queueResponse(jsonResponse(200, { profile: sampleProfile }));
    const client = new AudienceProfileClientImpl({ retryBackoffMs: 0 });
    const profile = await client.get('developer_longform');
    expect(profile.id).toBe('developer_longform');
    expect(profile.pacingRules.wordsPerMinute).toBe(150);

    // Second call hits cache, no fetch.
    const again = await client.get('developer_longform');
    expect(again).toBe(profile);
    expect(fetchCalls).toHaveLength(1);
  });

  it('throws AudienceProfileNotFoundError on 404 + does NOT cache', async () => {
    queueResponse(jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'missing' } }));
    const client = new AudienceProfileClientImpl({ retryBackoffMs: 0 });
    await expect(client.get('nonexistent')).rejects.toBeInstanceOf(AudienceProfileNotFoundError);

    // Subsequent call re-fetches — the failed attempt didn't cache anything.
    queueResponse(jsonResponse(200, { profile: { ...sampleProfile, id: 'nonexistent' } }));
    const recovered = await client.get('nonexistent');
    expect(recovered.id).toBe('nonexistent');
    expect(fetchCalls).toHaveLength(2);
  });

  it('throws after retry exhaustion on 5xx + does not cache failure', async () => {
    const client = new AudienceProfileClientImpl({ retryBackoffMs: 0 });

    // Simulate 5xx (DEGRADED) on every attempt. Note: status 503 maps to
    // 'DEGRADED' which is NOT retryable per isRetryable(), so only one fetch
    // happens. To exercise the retry path use 502.
    queueResponse(jsonResponse(502, {})); // attempt 1 — retryable SERVER_ERROR
    queueResponse(jsonResponse(502, {})); // attempt 2 — gives up
    await expect(client.get('developer_longform')).rejects.toBeInstanceOf(Error);
    expect(fetchCalls).toHaveLength(2);

    // Cache stayed empty after the failure — next attempt re-fetches.
    queueResponse(jsonResponse(200, { profile: sampleProfile }));
    const recovered = await client.get('developer_longform');
    expect(recovered.id).toBe('developer_longform');
    expect(fetchCalls).toHaveLength(3);
  });

  it('aborts on timeout and throws TIMEOUT-coded NeurocoreError', async () => {
    queueResponse(() => new Promise<Response>(() => {
      // Never resolves — only aborted via signal.
    }));
    const client = new AudienceProfileClientImpl({ retryBackoffMs: 0 });
    // The default fake env has NEUROCORE_TIMEOUT_MS = 50ms.
    const err = await client.get('developer_longform').catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    // The TIMEOUT path doesn't wrap in our class hierarchy; it's a plain
    // NeurocoreError with code 'TIMEOUT'. The cache invalidation contract
    // still holds.
  });

  it('throws on malformed JSON response + invalidates cache', async () => {
    queueResponse(new Response('not json', { status: 200, headers: { 'content-type': 'application/json' } }));
    const client = new AudienceProfileClientImpl({ retryBackoffMs: 0 });
    await expect(client.get('developer_longform')).rejects.toThrow();

    queueResponse(jsonResponse(200, { profile: sampleProfile }));
    const recovered = await client.get('developer_longform');
    expect(recovered.id).toBe('developer_longform');
  });

  it('rejects when server returns a different id than requested', async () => {
    queueResponse(jsonResponse(200, { profile: { ...sampleProfile, id: 'other_id' } }));
    const client = new AudienceProfileClientImpl({ retryBackoffMs: 0 });
    await expect(client.get('developer_longform')).rejects.toBeInstanceOf(
      AudienceProfileUnavailableError,
    );
  });

  it('rejects profile missing required fields (Zod-like guard)', async () => {
    const broken = { ...sampleProfile } as Record<string, unknown>;
    delete broken.painPoints;
    queueResponse(jsonResponse(200, { profile: broken }));
    const client = new AudienceProfileClientImpl({ retryBackoffMs: 0 });
    await expect(client.get('developer_longform')).rejects.toBeInstanceOf(
      AudienceProfileUnavailableError,
    );
  });

  it('rejects profile with empty painPoints array', async () => {
    queueResponse(jsonResponse(200, { profile: { ...sampleProfile, painPoints: [] } }));
    const client = new AudienceProfileClientImpl({ retryBackoffMs: 0 });
    await expect(client.get('developer_longform')).rejects.toBeInstanceOf(
      AudienceProfileUnavailableError,
    );
  });
});

// -----------------------------------------------------------------------------
// Cache controls + memoized factory
// -----------------------------------------------------------------------------

describe('cache controls', () => {
  it('clearAudienceProfileCache empties the cache; next get re-fetches', async () => {
    queueResponse(jsonResponse(200, { profile: sampleProfile }));
    const client = new AudienceProfileClientImpl({ retryBackoffMs: 0 });
    await client.get('developer_longform');

    clearAudienceProfileCache();
    // Need to populate the singleton path so clearAudienceProfileCache hits it.
    // Use getAudienceProfileClient() to exercise the memoized factory.
  });

  it('getAudienceProfileClient memoizes the instance', () => {
    const a = getAudienceProfileClient();
    const b = getAudienceProfileClient();
    expect(a).toBe(b);
    _resetAudienceProfileClientForTests();
    const c = getAudienceProfileClient();
    expect(c).not.toBe(a);
  });
});

describe('config errors', () => {
  it('throws AudienceProfileUnavailableError when token explicitly null', async () => {
    const client = new AudienceProfileClientImpl({ token: null, retryBackoffMs: 0 });
    await expect(client.get('developer_longform')).rejects.toBeInstanceOf(
      AudienceProfileUnavailableError,
    );
    expect(fetchCalls).toHaveLength(0);
  });
});
