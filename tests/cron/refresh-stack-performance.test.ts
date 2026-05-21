import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() },
}));

import { refreshStackPerformance } from '../../src/cron/refresh-stack-performance.js';
import { YouTubeError } from '../../src/youtube/errors.js';
import type { NeurocoreClient } from '../../src/neurocore/client.js';
import type { YouTubeClient } from '../../src/youtube/client.js';
import type { ContentCatalogListEntry } from '../../src/neurocore/types.js';
import type { VideoAnalytics, VideoStats } from '../../src/youtube/types.js';

// ---------------------------------------------------------------------------
// Stub clients
// ---------------------------------------------------------------------------

interface StubNeuro {
  client: NeurocoreClient;
  listCalls: number;
  upsertCalls: Array<{ id: string; techStackProfileId: string; videoCount: number; avgViews: number; avgWatchTimeSeconds: number; avgCtr: number; lastVideoPublishedAt: string | null }>;
  failNextUpsert: Error | null;
}

function makeNeuro(catalog: ContentCatalogListEntry[]): StubNeuro {
  const ctx: StubNeuro = {
    client: {} as NeurocoreClient,
    listCalls: 0,
    upsertCalls: [],
    failNextUpsert: null,
  };
  const client = {
    listContentCatalog: vi.fn(async () => {
      ctx.listCalls++;
      return { profiles: catalog };
    }),
    createStackPerformance: vi.fn(async (payload: StubNeuro['upsertCalls'][number]) => {
      if (ctx.failNextUpsert) {
        const err = ctx.failNextUpsert;
        ctx.failNextUpsert = null;
        throw err;
      }
      ctx.upsertCalls.push(payload);
      return { entry: { ...payload, lastComputedAt: '2026-05-20T04:00:00.000Z' } };
    }),
  };
  ctx.client = client as unknown as NeurocoreClient;
  return ctx;
}

interface StubYouTube {
  client: YouTubeClient;
  configured: boolean;
  statsByVideoId: Map<string, VideoStats>;
  analyticsByVideoId: Map<string, VideoAnalytics>;
  analyticsThrow?: Error;
}

function makeYouTube(opts: {
  configured?: boolean;
  stats?: VideoStats[];
  analytics?: VideoAnalytics[];
  analyticsThrow?: Error;
} = {}): StubYouTube {
  const ctx: StubYouTube = {
    client: {} as YouTubeClient,
    configured: opts.configured ?? true,
    statsByVideoId: new Map((opts.stats ?? []).map((s) => [s.videoId, s])),
    analyticsByVideoId: new Map((opts.analytics ?? []).map((a) => [a.videoId, a])),
    ...(opts.analyticsThrow ? { analyticsThrow: opts.analyticsThrow } : {}),
  };
  const client = {
    isConfigured: () => ctx.configured,
    quotaSnapshot: () => ({ cap: 10_000, consumed: 0, remaining: 10_000, utilization: 0, resetsAt: '', warnFiredAt: null }),
    getVideoStats: vi.fn(async (ids: string[]) =>
      ids.map((id) => ctx.statsByVideoId.get(id) ?? { videoId: id, found: false }),
    ),
    getVideoAnalytics: vi.fn(async (id: string, range) => {
      if (ctx.analyticsThrow) throw ctx.analyticsThrow;
      const a = ctx.analyticsByVideoId.get(id);
      if (a) return a;
      return {
        videoId: id,
        range,
        emptyChannel: false,
        views: 0,
        estimatedMinutesWatched: 0,
        averageViewDuration: 0,
        averageViewPercentage: null,
      };
    }),
  };
  ctx.client = client as unknown as YouTubeClient;
  return ctx;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function fakeCatalogEntry(overrides: Partial<ContentCatalogListEntry> = {}): ContentCatalogListEntry {
  return {
    id: 'content_default',
    deliverableId: 'del_default',
    planId: 'plan_default',
    kind: 'long_form',
    title: 'Video',
    youtubeUrl: 'https://www.youtube.com/watch?v=defaultvid1',
    youtubeVideoId: 'defaultvid1',
    audienceProfileId: 'developer_longform',
    primaryTechStackId: 'tech_vapi',
    supportingTechStackIds: [],
    topicTags: [],
    publishedAt: '2026-05-15T10:00:00.000Z',
    sourceApp: 'drek',
    createdAt: '2026-05-15T10:00:00.000Z',
    updatedAt: '2026-05-15T10:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  // Each test builds its own stubs; nothing global to reset here.
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('refreshStackPerformance — short-circuit paths', () => {
  it('returns no-op when YouTube client is not configured', async () => {
    const neuro = makeNeuro([fakeCatalogEntry()]);
    const yt = makeYouTube({ configured: false });
    const result = await refreshStackPerformance({ client: neuro.client, youtube: yt.client });
    expect(result.attempted).toBe(0);
    expect(neuro.listCalls).toBe(0);
  });

  it('returns no-op when ContentCatalog is empty', async () => {
    const neuro = makeNeuro([]);
    const yt = makeYouTube();
    const result = await refreshStackPerformance({ client: neuro.client, youtube: yt.client });
    expect(result.attempted).toBe(0);
    expect(result.upserted).toBe(0);
    expect(result.videosProcessed).toBe(0);
    expect(neuro.upsertCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Aggregation correctness
// ---------------------------------------------------------------------------

describe('refreshStackPerformance — aggregation', () => {
  it('groups by primaryTechStackId and averages metrics', async () => {
    const catalog: ContentCatalogListEntry[] = [
      fakeCatalogEntry({ id: 'c1', deliverableId: 'd1', youtubeVideoId: 'vid1', primaryTechStackId: 'tech_vapi', publishedAt: '2026-05-10T00:00:00.000Z' }),
      fakeCatalogEntry({ id: 'c2', deliverableId: 'd2', youtubeVideoId: 'vid2', primaryTechStackId: 'tech_vapi', publishedAt: '2026-05-15T00:00:00.000Z' }),
      fakeCatalogEntry({ id: 'c3', deliverableId: 'd3', youtubeVideoId: 'vid3', primaryTechStackId: 'tech_n8n', publishedAt: '2026-05-12T00:00:00.000Z' }),
    ];
    const neuro = makeNeuro(catalog);
    const yt = makeYouTube({
      stats: [
        { videoId: 'vid1', found: true, viewCount: 100 },
        { videoId: 'vid2', found: true, viewCount: 300 },
        { videoId: 'vid3', found: true, viewCount: 50 },
      ],
      analytics: [
        { videoId: 'vid1', range: { startDate: '', endDate: '' }, emptyChannel: false, views: 100, estimatedMinutesWatched: 20, averageViewDuration: 120, averageViewPercentage: 0.4 },
        { videoId: 'vid2', range: { startDate: '', endDate: '' }, emptyChannel: false, views: 300, estimatedMinutesWatched: 60, averageViewDuration: 180, averageViewPercentage: 0.5 },
        { videoId: 'vid3', range: { startDate: '', endDate: '' }, emptyChannel: false, views: 50, estimatedMinutesWatched: 10, averageViewDuration: 90, averageViewPercentage: 0.3 },
      ],
    });
    const result = await refreshStackPerformance({ client: neuro.client, youtube: yt.client });

    expect(result.attempted).toBe(2);
    expect(result.upserted).toBe(2);
    expect(result.videosProcessed).toBe(3);

    const byId = new Map(neuro.upsertCalls.map((u) => [u.techStackProfileId, u]));
    const vapi = byId.get('tech_vapi')!;
    expect(vapi.videoCount).toBe(2);
    expect(vapi.avgViews).toBe(200); // (100 + 300) / 2
    expect(vapi.avgWatchTimeSeconds).toBe(2_400); // (20*60 + 60*60) / 2 = 2400
    expect(vapi.avgCtr).toBe(45); // (40 + 50) / 2
    expect(vapi.lastVideoPublishedAt).toBe('2026-05-15T00:00:00.000Z'); // latest

    const n8n = byId.get('tech_n8n')!;
    expect(n8n.videoCount).toBe(1);
    expect(n8n.avgViews).toBe(50);
  });

  it('writes derivePerfId-derived ids', async () => {
    const catalog = [fakeCatalogEntry({ primaryTechStackId: 'tech_claude_code_cli', youtubeVideoId: 'vid1' })];
    const neuro = makeNeuro(catalog);
    const yt = makeYouTube({
      stats: [{ videoId: 'vid1', found: true, viewCount: 1 }],
      analytics: [{ videoId: 'vid1', range: { startDate: '', endDate: '' }, emptyChannel: false, views: 1, estimatedMinutesWatched: 0, averageViewDuration: 0, averageViewPercentage: null }],
    });
    await refreshStackPerformance({ client: neuro.client, youtube: yt.client });
    expect(neuro.upsertCalls[0]!.id).toBe('perf_claude_code_cli');
  });

  it('isolates per-stack upsert failures — one failed group does not block the others', async () => {
    const catalog = [
      fakeCatalogEntry({ id: 'c1', deliverableId: 'd1', youtubeVideoId: 'vid1', primaryTechStackId: 'tech_vapi' }),
      fakeCatalogEntry({ id: 'c2', deliverableId: 'd2', youtubeVideoId: 'vid2', primaryTechStackId: 'tech_n8n' }),
    ];
    const neuro = makeNeuro(catalog);
    neuro.failNextUpsert = new Error('boom');
    const yt = makeYouTube({
      stats: [
        { videoId: 'vid1', found: true, viewCount: 100 },
        { videoId: 'vid2', found: true, viewCount: 200 },
      ],
      analytics: [
        { videoId: 'vid1', range: { startDate: '', endDate: '' }, emptyChannel: false, views: 100, estimatedMinutesWatched: 10, averageViewDuration: 60, averageViewPercentage: null },
        { videoId: 'vid2', range: { startDate: '', endDate: '' }, emptyChannel: false, views: 200, estimatedMinutesWatched: 20, averageViewDuration: 120, averageViewPercentage: null },
      ],
    });
    const result = await refreshStackPerformance({ client: neuro.client, youtube: yt.client });
    expect(result.attempted).toBe(2);
    expect(result.upserted).toBe(1);
    expect(result.failed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Quota / error propagation
// ---------------------------------------------------------------------------

describe('refreshStackPerformance — error propagation', () => {
  it('aborts the run when YouTube quota is exhausted mid-stream', async () => {
    const catalog = [
      fakeCatalogEntry({ youtubeVideoId: 'vid1', primaryTechStackId: 'tech_vapi' }),
    ];
    const neuro = makeNeuro(catalog);
    const yt = makeYouTube({
      stats: [{ videoId: 'vid1', found: true, viewCount: 100 }],
      analyticsThrow: new YouTubeError('QUOTA_EXCEEDED', '/reports', 'cap reached'),
    });
    await expect(
      refreshStackPerformance({ client: neuro.client, youtube: yt.client }),
    ).rejects.toBeInstanceOf(YouTubeError);
    // Nothing was upserted because we never got to the aggregation step.
    expect(neuro.upsertCalls).toHaveLength(0);
  });

  it('flags emptyChannel:true when any video returned the empty-channel marker', async () => {
    const catalog = [fakeCatalogEntry({ youtubeVideoId: 'vid1', primaryTechStackId: 'tech_vapi' })];
    const neuro = makeNeuro(catalog);
    const yt = makeYouTube({
      stats: [{ videoId: 'vid1', found: true, viewCount: 0 }],
      analytics: [
        { videoId: 'vid1', range: { startDate: '', endDate: '' }, emptyChannel: true, views: 0, estimatedMinutesWatched: 0, averageViewDuration: 0, averageViewPercentage: null },
      ],
    });
    const result = await refreshStackPerformance({ client: neuro.client, youtube: yt.client });
    expect(result.emptyChannel).toBe(true);
    // Still upserts a zero-metric row so the transformer prompt has something.
    expect(result.upserted).toBe(1);
    expect(neuro.upsertCalls[0]!.avgViews).toBe(0);
  });
});
