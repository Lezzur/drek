import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock env so we don't depend on process.env at all.
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
  NEUROCORE_TIMEOUT_MS: 50, // tight so timeout tests run fast
};
vi.mock('../../src/env.js', () => ({
  getEnv: () => fakeEnv,
  loadEnv: () => fakeEnv,
}));

// Silent logger.
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

import { NeurocoreClient } from '../../src/neurocore/client.js';

// -----------------------------------------------------------------------------
// fetch mock helpers — install on globalThis so the client's fetch call hits it
// -----------------------------------------------------------------------------

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

const fetchCalls: FetchCall[] = [];

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Queue of responses or behaviors. Each fetch call shifts one off. */
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
    let parsedBody: unknown = null;
    if (typeof init?.body === 'string') {
      try {
        parsedBody = JSON.parse(init.body);
      } catch {
        parsedBody = init.body;
      }
    }
    fetchCalls.push({ url, method, headers, body: parsedBody });

    const next = fetchQueue.shift();
    if (!next) throw new Error(`unexpected fetch ${method} ${url} — queue empty`);
    if (next instanceof Response) return next;
    if ('throws' in next) throw next.throws;
    // For function-based responses, honor the AbortSignal: if the caller
    // aborts before the function resolves, reject with AbortError. That's
    // how native fetch behaves, and we need the same so timeout tests
    // can actually observe an aborted request.
    return new Promise<Response>((resolve, reject) => {
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        const err = new DOMException('aborted', 'AbortError');
        reject(err);
      };
      init?.signal?.addEventListener('abort', onAbort);
      void next().then((res) => {
        if (settled) return;
        settled = true;
        resolve(res);
      }, (err: Error) => {
        if (settled) return;
        settled = true;
        reject(err);
      });
    });
  }) as unknown as typeof fetch;
}

type AnyHeaders = Headers | Record<string, string> | [string, string][] | undefined;
/** Normalize every header key to lowercase so tests can read them in a
 *  case-insensitive way (Headers does this natively; plain objects don't). */
function headersToObject(h: AnyHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  if (h instanceof Headers) {
    h.forEach((value, key) => { out[key.toLowerCase()] = value; });
    return out;
  }
  if (Array.isArray(h)) {
    for (const pair of h) {
      const k = pair[0];
      const v = pair[1];
      if (typeof k === 'string' && typeof v === 'string') out[k.toLowerCase()] = v;
    }
    return out;
  }
  for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = v;
  return out;
}

beforeEach(() => {
  fetchCalls.length = 0;
  fetchQueue.length = 0;
  installFetchMock();
  fakeEnv.NEUROCORE_TOKEN = 'test-token';
  fakeEnv.NEUROCORE_TIMEOUT_MS = 50;
});

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe('NeurocoreClient — configuration', () => {
  it('throws NOT_CONFIGURED when no token is available', async () => {
    const client = new NeurocoreClient({ token: null });
    await expect(client.pollPendingSignals()).rejects.toMatchObject({
      code: 'NOT_CONFIGURED',
    });
    expect(fetchCalls).toHaveLength(0);
  });

  it('strips a trailing slash from baseUrl', async () => {
    queueResponse(jsonResponse(200, { listings: [] }));
    const client = new NeurocoreClient({ baseUrl: 'http://nc.example/' });
    await client.pollPendingSignals();
    expect(fetchCalls[0]?.url).toBe('http://nc.example/v1/signals/pending-video');
  });
});

describe('NeurocoreClient — getProjectContext', () => {
  it('routes cover_letter mode to videoPlanCoverLetter taskType', async () => {
    queueResponse(
      jsonResponse(200, {
        systemBlock: 'block',
        metadata: {
          layersIncluded: ['profile', 'projects'],
          memoryRecordIds: [],
          estimatedTokens: 100,
          degraded: false,
          budget: { requested: 4000, clampedTo: 4000, effective: 4000 },
        },
      }),
    );
    const client = new NeurocoreClient();
    const out = await client.getProjectContext({
      planMode: 'cover_letter',
      jobContextHint: 'react eng at acme',
    });
    expect(out.systemBlock).toBe('block');
    expect(fetchCalls[0]?.method).toBe('POST');
    expect(fetchCalls[0]?.url).toBe('http://localhost:3100/v1/memory/context');
    expect(fetchCalls[0]?.headers['authorization']).toBe('Bearer test-token');
    expect(fetchCalls[0]?.body).toMatchObject({
      taskType: 'videoPlanCoverLetter',
      scope: { userId: 'rick', appId: 'drek' },
      jobContextHint: 'react eng at acme',
    });
  });

  it('routes youtube mode to videoPlanYoutube taskType', async () => {
    queueResponse(
      jsonResponse(200, {
        systemBlock: '',
        metadata: {
          layersIncluded: [],
          memoryRecordIds: [],
          estimatedTokens: 0,
          degraded: false,
          budget: { requested: 4000, clampedTo: 4000, effective: 4000 },
        },
      }),
    );
    const client = new NeurocoreClient();
    await client.getProjectContext({ planMode: 'youtube' });
    expect(fetchCalls[0]?.body).toMatchObject({ taskType: 'videoPlanYoutube' });
  });
});

describe('NeurocoreClient — getVoiceProfile', () => {
  it('routes to scriptCoverLetter / scriptYoutube based on mode', async () => {
    queueResponse(
      jsonResponse(200, {
        systemBlock: '',
        metadata: {
          layersIncluded: [],
          memoryRecordIds: [],
          estimatedTokens: 0,
          degraded: false,
          budget: { requested: 4000, clampedTo: 4000, effective: 4000 },
        },
      }),
    );
    queueResponse(
      jsonResponse(200, {
        systemBlock: '',
        metadata: {
          layersIncluded: [],
          memoryRecordIds: [],
          estimatedTokens: 0,
          degraded: false,
          budget: { requested: 4000, clampedTo: 4000, effective: 4000 },
        },
      }),
    );
    const client = new NeurocoreClient();
    await client.getVoiceProfile({ planMode: 'cover_letter' });
    await client.getVoiceProfile({ planMode: 'youtube' });
    expect(fetchCalls[0]?.body).toMatchObject({ taskType: 'scriptCoverLetter' });
    expect(fetchCalls[1]?.body).toMatchObject({ taskType: 'scriptYoutube' });
  });
});

describe('NeurocoreClient — pollPendingSignals', () => {
  it('returns the listings array from a 200 response', async () => {
    queueResponse(
      jsonResponse(200, {
        listings: [
          {
            memoryId: 'mem_1',
            listingId: 'lst_1',
            company: 'Acme',
            role: 'Backend Eng',
            videoRequirements: 'show lead pipeline work',
            keySkills: ['ts'],
            url: 'https://x',
            ingestedAt: '2026-05-15T00:00:00Z',
          },
        ],
      }),
    );
    const client = new NeurocoreClient();
    const listings = await client.pollPendingSignals();
    expect(listings).toHaveLength(1);
    expect(listings[0]?.memoryId).toBe('mem_1');
    expect(fetchCalls[0]?.method).toBe('GET');
  });

  it('throws INVALID_RESPONSE when the body shape is wrong', async () => {
    queueResponse(jsonResponse(200, { wrong: true }));
    const client = new NeurocoreClient();
    await expect(client.pollPendingSignals()).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
  });
});

describe('NeurocoreClient — ackSignal', () => {
  it('POSTs to the per-memory ack endpoint with an idempotency key', async () => {
    queueResponse(jsonResponse(200, { memoryId: 'mem_1', drekAcknowledged: true }));
    const client = new NeurocoreClient();
    await client.ackSignal('mem_1');
    expect(fetchCalls[0]?.url).toBe(
      'http://localhost:3100/v1/signals/pending-video/mem_1/ack',
    );
    expect(fetchCalls[0]?.method).toBe('POST');
    expect(fetchCalls[0]?.headers['idempotency-key']).toBe('drek-ack-mem_1');
  });

  it('rejects when memoryId is empty', async () => {
    const client = new NeurocoreClient();
    await expect(client.ackSignal('')).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(fetchCalls).toHaveLength(0);
  });

  it('URL-encodes the memoryId path segment', async () => {
    queueResponse(jsonResponse(200, { memoryId: 'mem/with slash', drekAcknowledged: true }));
    const client = new NeurocoreClient();
    await client.ackSignal('mem/with slash');
    expect(fetchCalls[0]?.url).toBe(
      'http://localhost:3100/v1/signals/pending-video/mem%2Fwith%20slash/ack',
    );
  });
});

describe('NeurocoreClient — sendApprovedScript', () => {
  it('sends a script.approved signal with deterministic idempotency', async () => {
    queueResponse(jsonResponse(202, { signalId: 'sig_1', queued: true }));
    const client = new NeurocoreClient();
    await client.sendApprovedScript({
      planId: 'plan_1',
      planMode: 'cover_letter',
      scenes: [
        { script: 'Hi I am Rick.', wasEdited: true },
        { script: 'Let me show you the build.', wasEdited: false },
      ],
    });
    expect(fetchCalls[0]?.url).toBe('http://localhost:3100/v1/memory/signals');
    expect(fetchCalls[0]?.method).toBe('POST');
    expect(fetchCalls[0]?.headers['idempotency-key']).toBe('drek-script-approved-plan_1');
    expect(fetchCalls[0]?.body).toMatchObject({
      appId: 'drek',
      signalType: 'script.approved',
      payload: {
        planId: 'plan_1',
        planMode: 'cover_letter',
        scenes: [
          { script: 'Hi I am Rick.', wasEdited: true },
          { script: 'Let me show you the build.', wasEdited: false },
        ],
      },
    });
    expect(typeof (fetchCalls[0]?.body as { occurredAt?: string }).occurredAt).toBe('string');
  });
});

describe('NeurocoreClient — error mapping', () => {
  it('maps 401 to UNAUTHENTICATED and does not retry', async () => {
    queueResponse(
      jsonResponse(401, { error: { code: 'UNAUTHENTICATED', message: 'bad token' } }),
    );
    const client = new NeurocoreClient();
    await expect(client.pollPendingSignals()).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
      status: 401,
    });
    // Just one call — no retry for 4xx auth failures.
    expect(fetchCalls).toHaveLength(1);
  });

  it('maps 404 to NOT_FOUND', async () => {
    queueResponse(jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'gone' } }));
    const client = new NeurocoreClient();
    await expect(client.ackSignal('m1')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('maps 409 to INVALID_STATE', async () => {
    queueResponse(
      jsonResponse(409, { error: { code: 'INVALID_STATE', message: 'not video' } }),
    );
    const client = new NeurocoreClient();
    await expect(client.ackSignal('m1')).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('retries on 502 (SERVER_ERROR) and succeeds on the second attempt', async () => {
    queueResponse(jsonResponse(502, { error: { code: 'SERVER_ERROR', message: 'bad gw' } }));
    queueResponse(jsonResponse(200, { listings: [] }));
    const client = new NeurocoreClient({ timeoutMs: 5000, retryBackoffMs: 0 });
    const out = await client.pollPendingSignals();
    expect(out).toEqual([]);
    expect(fetchCalls).toHaveLength(2);
  });

  it('does NOT retry on 503 DEGRADED — partial result is the answer', async () => {
    queueResponse(jsonResponse(503, { error: { code: 'DEGRADED', message: 'embed down' } }));
    const client = new NeurocoreClient({ retryBackoffMs: 0 });
    await expect(client.pollPendingSignals()).rejects.toMatchObject({
      code: 'DEGRADED',
      status: 503,
    });
    expect(fetchCalls).toHaveLength(1);
  });

  it('times out when the server hangs longer than NEUROCORE_TIMEOUT_MS', async () => {
    // Hang forever on both attempts — the client should abort each after 50ms
    // (NEUROCORE_TIMEOUT_MS in the fake env), then bail with TIMEOUT.
    queueResponse(() => new Promise(() => { /* never resolves */ }));
    queueResponse(() => new Promise(() => { /* same on retry */ }));
    const client = new NeurocoreClient({ timeoutMs: 30, retryBackoffMs: 0 });
    await expect(client.pollPendingSignals()).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(fetchCalls).toHaveLength(2);
  });

  it('throws UNREACHABLE on a network error', async () => {
    queueResponse({ throws: new TypeError('fetch failed: ECONNREFUSED') });
    queueResponse({ throws: new TypeError('fetch failed: ECONNREFUSED') });
    const client = new NeurocoreClient({ retryBackoffMs: 0 });
    await expect(client.pollPendingSignals()).rejects.toMatchObject({ code: 'UNREACHABLE' });
    expect(fetchCalls).toHaveLength(2);
  });
});
