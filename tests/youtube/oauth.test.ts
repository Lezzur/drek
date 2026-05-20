import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() },
}));

import { YouTubeOAuth } from '../../src/youtube/oauth.js';
import { YouTubeError } from '../../src/youtube/errors.js';

interface FetchCall {
  url: string;
  method: string;
  body: string;
}

const fetchCalls: FetchCall[] = [];
type FetchBehavior = Response | (() => Promise<Response>) | { throws: Error };
const fetchQueue: FetchBehavior[] = [];

function queueResponse(b: FetchBehavior): void {
  fetchQueue.push(b);
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  fetchCalls.length = 0;
  fetchQueue.length = 0;
  globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? 'GET';
    let body = '';
    if (typeof init?.body === 'string') body = init.body;
    else if (init?.body instanceof URLSearchParams) body = init.body.toString();
    fetchCalls.push({ url, method, body });
    const next = fetchQueue.shift();
    if (!next) throw new Error(`unexpected fetch ${method} ${url}`);
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
});

const creds = {
  clientId: 'cid.apps.googleusercontent.com',
  clientSecret: 'GOCSPX-secret',
  refreshToken: '1//refresh',
};

describe('YouTubeOAuth — happy path', () => {
  it('exchanges refresh token for access token and caches it', async () => {
    queueResponse(jsonResponse(200, { access_token: 'AT1', expires_in: 3600, token_type: 'Bearer' }));
    const oauth = new YouTubeOAuth(creds, { timeoutMs: 1_000 });
    const t1 = await oauth.getAccessToken();
    expect(t1).toBe('AT1');
    expect(fetchCalls).toHaveLength(1);
    // Second call within the cache window reuses without re-fetching.
    const t2 = await oauth.getAccessToken();
    expect(t2).toBe('AT1');
    expect(fetchCalls).toHaveLength(1);
  });

  it('POSTs to the token endpoint with the right form body', async () => {
    queueResponse(jsonResponse(200, { access_token: 'AT', expires_in: 3600, token_type: 'Bearer' }));
    const oauth = new YouTubeOAuth(creds);
    await oauth.getAccessToken();
    const call = fetchCalls[0]!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe('https://oauth2.googleapis.com/token');
    expect(call.body).toContain('grant_type=refresh_token');
    expect(call.body).toContain(`refresh_token=${encodeURIComponent(creds.refreshToken)}`);
    expect(call.body).toContain(`client_id=${encodeURIComponent(creds.clientId)}`);
  });

  it('deduplicates concurrent refreshes via inFlight', async () => {
    let resolveResp: ((r: Response) => void) | null = null;
    queueResponse(
      () =>
        new Promise((resolve) => {
          resolveResp = resolve;
        }),
    );
    const oauth = new YouTubeOAuth(creds);
    const p1 = oauth.getAccessToken();
    const p2 = oauth.getAccessToken();
    resolveResp!(jsonResponse(200, { access_token: 'AT', expires_in: 3600, token_type: 'Bearer' }));
    const [t1, t2] = await Promise.all([p1, p2]);
    expect(t1).toBe('AT');
    expect(t2).toBe('AT');
    expect(fetchCalls).toHaveLength(1); // one shared refresh
  });
});

describe('YouTubeOAuth — failure paths', () => {
  it('throws AUTH_FAILED on 400 invalid_grant', async () => {
    queueResponse(jsonResponse(400, { error: 'invalid_grant' }));
    const oauth = new YouTubeOAuth(creds);
    try {
      await oauth.getAccessToken();
      expect.fail('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(YouTubeError);
      expect((err as YouTubeError).code).toBe('AUTH_FAILED');
    }
  });

  it('throws TIMEOUT on AbortError', async () => {
    queueResponse(() => new Promise<Response>(() => { /* never resolves */ }));
    const oauth = new YouTubeOAuth(creds, { timeoutMs: 30 });
    try {
      await oauth.getAccessToken();
      expect.fail('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(YouTubeError);
      expect((err as YouTubeError).code).toBe('TIMEOUT');
    }
  });

  it('throws UNREACHABLE on network error', async () => {
    queueResponse({ throws: new TypeError('fetch failed') });
    const oauth = new YouTubeOAuth(creds);
    try {
      await oauth.getAccessToken();
      expect.fail('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(YouTubeError);
      expect((err as YouTubeError).code).toBe('UNREACHABLE');
    }
  });

  it('throws INVALID_RESPONSE when token body lacks access_token', async () => {
    queueResponse(jsonResponse(200, { expires_in: 3600 }));
    const oauth = new YouTubeOAuth(creds);
    try {
      await oauth.getAccessToken();
      expect.fail('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(YouTubeError);
      expect((err as YouTubeError).code).toBe('INVALID_RESPONSE');
    }
  });
});

describe('YouTubeOAuth — invalidate()', () => {
  it('drops the cache so next call re-fetches', async () => {
    queueResponse(jsonResponse(200, { access_token: 'AT1', expires_in: 3600, token_type: 'Bearer' }));
    const oauth = new YouTubeOAuth(creds);
    await oauth.getAccessToken();
    expect(fetchCalls).toHaveLength(1);
    oauth.invalidate();
    queueResponse(jsonResponse(200, { access_token: 'AT2', expires_in: 3600, token_type: 'Bearer' }));
    const t2 = await oauth.getAccessToken();
    expect(t2).toBe('AT2');
    expect(fetchCalls).toHaveLength(2);
  });
});
