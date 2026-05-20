import { describe, it, expect, beforeEach, vi } from 'vitest';

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
  MODEL_REFRESH_INTERVAL_HOURS: 24,
  POLLING_INTERVAL_MS: 1_800_000,
  YOUTUBE_CLIENT_ID: 'cid.apps.googleusercontent.com',
  YOUTUBE_CLIENT_SECRET: 'GOCSPX-secret',
  YOUTUBE_REFRESH_TOKEN: '1//refresh',
  YOUTUBE_CHANNEL_ID: 'UC0123456789012345678901',
  YOUTUBE_DAILY_QUOTA: 10_000,
  YOUTUBE_TIMEOUT_MS: 1_000,
};
vi.mock('../../src/env.js', () => ({ getEnv: () => fakeEnv, loadEnv: () => fakeEnv }));
vi.mock('../../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() },
}));

import { YouTubeClient } from '../../src/youtube/client.js';
import { YouTubeOAuth } from '../../src/youtube/oauth.js';
import { YouTubeError } from '../../src/youtube/errors.js';
import { _resetQuotaForTests, snapshot as quotaSnapshot } from '../../src/youtube/quota.js';

interface FetchCall {
  url: string;
  method: string;
  authHeader: string;
}

const fetchCalls: FetchCall[] = [];
type FetchBehavior = Response | (() => Promise<Response>) | { throws: Error };
const fetchQueue: FetchBehavior[] = [];

function queueResponse(b: FetchBehavior): void { fetchQueue.push(b); }
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  fetchCalls.length = 0;
  fetchQueue.length = 0;
  _resetQuotaForTests(10_000);
  globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? 'GET';
    const headers = init?.headers as Record<string, string> | undefined;
    fetchCalls.push({ url, method, authHeader: headers?.authorization ?? '' });
    const next = fetchQueue.shift();
    if (!next) throw new Error(`unexpected fetch ${method} ${url}`);
    if (next instanceof Response) return next;
    if ('throws' in next) throw next.throws;
    return next();
  }) as typeof fetch;
});

// ---------------------------------------------------------------------------
// Stubbed OAuth that returns a static access token
// ---------------------------------------------------------------------------

function stubOAuth(token = 'TEST_TOKEN'): YouTubeOAuth {
  const fake = new YouTubeOAuth(
    { clientId: 'x', clientSecret: 'y', refreshToken: 'z' },
    { timeoutMs: 1_000 },
  );
  (fake as unknown as { getAccessToken: () => Promise<string> }).getAccessToken =
    async () => token;
  return fake;
}

// ---------------------------------------------------------------------------
// isConfigured
// ---------------------------------------------------------------------------

describe('YouTubeClient.isConfigured', () => {
  it('returns true when all four env vars are set', () => {
    const c = new YouTubeClient({ oauth: stubOAuth() });
    expect(c.isConfigured()).toBe(true);
  });

  it('returns false when any var is missing — and refuses calls with NOT_CONFIGURED', async () => {
    const c = new YouTubeClient({
      clientId: '',
      clientSecret: 'x',
      refreshToken: 'y',
      channelId: 'UCabc',
      oauth: stubOAuth(),
    });
    expect(c.isConfigured()).toBe(false);
    try {
      await c.getChannelSummary();
      expect.fail('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(YouTubeError);
      expect((err as YouTubeError).code).toBe('NOT_CONFIGURED');
    }
  });
});

// ---------------------------------------------------------------------------
// getChannelSummary
// ---------------------------------------------------------------------------

describe('YouTubeClient.getChannelSummary', () => {
  it('returns parsed summary on 200', async () => {
    queueResponse(
      jsonResponse(200, {
        items: [
          {
            id: 'UCabc',
            snippet: { title: 'Test Channel' },
            statistics: { subscriberCount: '42', viewCount: '1234', videoCount: '7' },
          },
        ],
      }),
    );
    const c = new YouTubeClient({ oauth: stubOAuth() });
    const summary = await c.getChannelSummary();
    expect(summary.title).toBe('Test Channel');
    expect(summary.subscriberCount).toBe(42);
    expect(summary.viewCount).toBe(1_234);
    expect(summary.videoCount).toBe(7);
    expect(fetchCalls[0]!.authHeader).toBe('Bearer TEST_TOKEN');
    expect(quotaSnapshot().consumed).toBe(1);
  });

  it('throws NOT_FOUND when items array is empty', async () => {
    queueResponse(jsonResponse(200, { items: [] }));
    const c = new YouTubeClient({ oauth: stubOAuth() });
    try {
      await c.getChannelSummary();
      expect.fail('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(YouTubeError);
      expect((err as YouTubeError).code).toBe('NOT_FOUND');
    }
  });

  it('retries once on 502 and succeeds on the second attempt', async () => {
    queueResponse(jsonResponse(502, { error: { message: 'bad gateway' } }));
    queueResponse(
      jsonResponse(200, {
        items: [{ id: 'UCabc', snippet: { title: 'T' }, statistics: { subscriberCount: '1', viewCount: '1', videoCount: '0' } }],
      }),
    );
    const c = new YouTubeClient({ oauth: stubOAuth(), retryBackoffMs: 0 });
    const summary = await c.getChannelSummary();
    expect(summary.title).toBe('T');
    expect(fetchCalls).toHaveLength(2);
  });

  it('does NOT retry on 403 forbidden', async () => {
    queueResponse(jsonResponse(403, { error: { errors: [{ reason: 'forbidden' }] } }));
    const c = new YouTubeClient({ oauth: stubOAuth(), retryBackoffMs: 0 });
    try {
      await c.getChannelSummary();
      expect.fail('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(YouTubeError);
      expect((err as YouTubeError).code).toBe('FORBIDDEN');
    }
    expect(fetchCalls).toHaveLength(1);
  });

  it('surfaces QUOTA_EXCEEDED when upstream reason=quotaExceeded', async () => {
    queueResponse(jsonResponse(403, { error: { errors: [{ reason: 'quotaExceeded' }] } }));
    const c = new YouTubeClient({ oauth: stubOAuth(), retryBackoffMs: 0 });
    try {
      await c.getChannelSummary();
      expect.fail('should throw');
    } catch (err) {
      expect((err as YouTubeError).code).toBe('QUOTA_EXCEEDED');
    }
  });
});

// ---------------------------------------------------------------------------
// getVideoStats
// ---------------------------------------------------------------------------

describe('YouTubeClient.getVideoStats', () => {
  it('returns empty array for empty input without any HTTP call', async () => {
    const c = new YouTubeClient({ oauth: stubOAuth() });
    const result = await c.getVideoStats([]);
    expect(result).toEqual([]);
    expect(fetchCalls).toHaveLength(0);
    expect(quotaSnapshot().consumed).toBe(0);
  });

  it('returns one VideoStats per requested id, preserving order', async () => {
    queueResponse(
      jsonResponse(200, {
        items: [
          { id: 'vid1', snippet: { title: 'A', publishedAt: '2026-05-01T00:00:00Z' }, statistics: { viewCount: '100', likeCount: '10', commentCount: '2' }, contentDetails: { duration: 'PT4M' } },
          { id: 'vid2', snippet: { title: 'B' }, statistics: { viewCount: '50' } },
        ],
      }),
    );
    const c = new YouTubeClient({ oauth: stubOAuth() });
    const result = await c.getVideoStats(['vid1', 'vid2']);
    expect(result).toHaveLength(2);
    expect(result[0]!.videoId).toBe('vid1');
    expect(result[0]!.found).toBe(true);
    expect(result[0]!.title).toBe('A');
    expect(result[0]!.viewCount).toBe(100);
    expect(result[0]!.durationIso).toBe('PT4M');
    expect(result[1]!.videoId).toBe('vid2');
    expect(result[1]!.viewCount).toBe(50);
  });

  it('marks ids the API silently dropped as found:false', async () => {
    queueResponse(
      jsonResponse(200, {
        items: [{ id: 'vid1', snippet: { title: 'A' }, statistics: { viewCount: '1' } }],
      }),
    );
    const c = new YouTubeClient({ oauth: stubOAuth() });
    const result = await c.getVideoStats(['vid1', 'vid_deleted']);
    expect(result).toHaveLength(2);
    expect(result[0]!.found).toBe(true);
    expect(result[1]!.found).toBe(false);
    expect(result[1]!.videoId).toBe('vid_deleted');
  });

  it('splits >50 ids into multiple batched calls', async () => {
    const ids = Array.from({ length: 75 }, (_, i) => `vid_${i}`);
    // Two batches: 50 + 25.
    queueResponse(
      jsonResponse(200, {
        items: ids.slice(0, 50).map((id) => ({ id, snippet: { title: id }, statistics: { viewCount: '1' } })),
      }),
    );
    queueResponse(
      jsonResponse(200, {
        items: ids.slice(50).map((id) => ({ id, snippet: { title: id }, statistics: { viewCount: '1' } })),
      }),
    );
    const c = new YouTubeClient({ oauth: stubOAuth() });
    const result = await c.getVideoStats(ids);
    expect(result).toHaveLength(75);
    expect(fetchCalls).toHaveLength(2);
    expect(quotaSnapshot().consumed).toBe(2); // one per batch
  });
});

// ---------------------------------------------------------------------------
// getVideoAnalytics
// ---------------------------------------------------------------------------

describe('YouTubeClient.getVideoAnalytics', () => {
  const range = { startDate: '2026-05-13', endDate: '2026-05-20' };

  it('returns parsed analytics on 200 with rows', async () => {
    queueResponse(
      jsonResponse(200, {
        rows: [[500, 1_200, 144, 42.5]], // views, minutes, avgDuration, avgPct
      }),
    );
    const c = new YouTubeClient({ oauth: stubOAuth() });
    const result = await c.getVideoAnalytics('vid1', range);
    expect(result.views).toBe(500);
    expect(result.estimatedMinutesWatched).toBe(1_200);
    expect(result.averageViewDuration).toBe(144);
    expect(result.averageViewPercentage).toBeCloseTo(0.425, 3);
    expect(result.emptyChannel).toBe(false);
    expect(quotaSnapshot().consumed).toBe(5);
  });

  it('returns zeros (non-empty) when 200 with no rows', async () => {
    queueResponse(jsonResponse(200, { rows: [] }));
    const c = new YouTubeClient({ oauth: stubOAuth() });
    const result = await c.getVideoAnalytics('vid1', range);
    expect(result.views).toBe(0);
    expect(result.emptyChannel).toBe(false);
  });

  it('returns emptyChannel=true when 403 on /reports (new channel)', async () => {
    queueResponse(jsonResponse(403, { error: { errors: [{ reason: 'forbidden' }] } }));
    const c = new YouTubeClient({ oauth: stubOAuth(), retryBackoffMs: 0 });
    const result = await c.getVideoAnalytics('vid1', range);
    expect(result.emptyChannel).toBe(true);
    expect(result.views).toBe(0);
  });

  it('propagates QUOTA_EXCEEDED when upstream reason is quotaExceeded (not empty-channel)', async () => {
    queueResponse(jsonResponse(403, { error: { errors: [{ reason: 'quotaExceeded' }] } }));
    const c = new YouTubeClient({ oauth: stubOAuth(), retryBackoffMs: 0 });
    try {
      await c.getVideoAnalytics('vid1', range);
      expect.fail('should throw');
    } catch (err) {
      expect((err as YouTubeError).code).toBe('QUOTA_EXCEEDED');
    }
  });
});

// ---------------------------------------------------------------------------
// Token rotation (401 → invalidate → retry)
// ---------------------------------------------------------------------------

describe('YouTubeClient — 401 token rotation', () => {
  it('invalidates the cached token on 401 and retries once', async () => {
    queueResponse(jsonResponse(401, { error: { message: 'token expired' } }));
    queueResponse(
      jsonResponse(200, {
        items: [{ id: 'UCabc', snippet: { title: 'T' }, statistics: { subscriberCount: '1', viewCount: '1', videoCount: '0' } }],
      }),
    );
    const oauth = stubOAuth();
    const invalidateSpy = vi.spyOn(oauth, 'invalidate');
    const c = new YouTubeClient({ oauth, retryBackoffMs: 0 });
    const result = await c.getChannelSummary();
    expect(result.title).toBe('T');
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
    expect(fetchCalls).toHaveLength(2);
  });
});
