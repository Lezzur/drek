import { logger } from '../logger.js';
import { getNeurocoreClient, type NeurocoreClient } from '../neurocore/client.js';
import { NeurocoreError } from '../neurocore/errors.js';
import {
  getYouTubeClient,
  type YouTubeClient,
} from '../youtube/client.js';
import { YouTubeError } from '../youtube/errors.js';
import { derivePerfId } from '../neurocore/stack-performance.js';
import type { ContentCatalogListEntry } from '../neurocore/types.js';
import type { VideoAnalytics, VideoStats } from '../youtube/types.js';

/**
 * Nightly cron: aggregate YouTube analytics per tech stack and upsert
 * StackPerformance rows in Neurocore. Per TECH-SPEC v2.1 §4 Piece 6.
 *
 * Algorithm:
 *   1. List every ContentCatalog row DREK published.
 *   2. Batch-fetch video stats from YouTube Data API (≤50 ids/call).
 *   3. Per-video analytics from YouTube Analytics API (5 units each).
 *   4. Group by primaryTechStackId; average views, watch time, CTR.
 *   5. POST one StackPerformance per group.
 *
 * Failure semantics:
 *   - Per-tech-stack failures are isolated. One group failing to upsert
 *     doesn't block the others — we log + continue.
 *   - YouTube quota exhaustion stops the whole run (so we don't leave
 *     half the registry stale). Logged loud.
 *   - YouTube empty-channel (brand-new channel) → we still build zero-
 *     metric rows so the transformer prompt has SOMETHING to read.
 *
 * Quota budget:
 *   - List ContentCatalog: 0 (Neurocore, no YouTube cost)
 *   - getVideoStats: 1 unit per 50 videos
 *   - getVideoAnalytics: 5 units per video
 *   - Per 50 videos: 1 + (50 × 5) = 251 units. 10K/day cap → ~2000
 *     videos/night ceiling. We're nowhere near that.
 */

const STEP_NAME = 'refresh-stack-performance';
const ANALYTICS_WINDOW_DAYS = 28;

export interface RefreshOptions {
  client?: NeurocoreClient;
  youtube?: YouTubeClient;
  /** Override "today" for tests. */
  now?: () => Date;
}

export interface RefreshResult {
  attempted: number;
  upserted: number;
  failed: number;
  videosProcessed: number;
  emptyChannel: boolean;
  durationMs: number;
}

export async function refreshStackPerformance(
  opts: RefreshOptions = {},
): Promise<RefreshResult> {
  const t0 = Date.now();
  const neuro = opts.client ?? getNeurocoreClient();
  const yt = opts.youtube ?? getYouTubeClient();
  const now = (opts.now ?? (() => new Date()))();

  if (!yt.isConfigured()) {
    logger.warn(
      { step: STEP_NAME },
      'refresh-stack-performance: YouTube client not configured — skipping run',
    );
    return {
      attempted: 0,
      upserted: 0,
      failed: 0,
      videosProcessed: 0,
      emptyChannel: false,
      durationMs: Date.now() - t0,
    };
  }

  // 1. List ContentCatalog
  let catalog: ContentCatalogListEntry[];
  try {
    const res = await neuro.listContentCatalog({ limit: 200 });
    catalog = res.profiles;
  } catch (err) {
    logger.error(
      { step: STEP_NAME, err: (err as Error).message },
      'refresh-stack-performance: failed to list ContentCatalog',
    );
    throw err;
  }

  if (catalog.length === 0) {
    logger.info(
      { step: STEP_NAME },
      'refresh-stack-performance: no published videos yet — nothing to aggregate',
    );
    return {
      attempted: 0,
      upserted: 0,
      failed: 0,
      videosProcessed: 0,
      emptyChannel: false,
      durationMs: Date.now() - t0,
    };
  }

  // 2. Fetch video stats in one batched call (≤50 per call; the client
  // chunks internally).
  const videoIds = catalog.map((c) => c.youtubeVideoId);
  let stats: VideoStats[];
  try {
    stats = await yt.getVideoStats(videoIds);
  } catch (err) {
    if (err instanceof YouTubeError && err.code === 'QUOTA_EXCEEDED') {
      logger.error(
        { step: STEP_NAME, err: err.message },
        'refresh-stack-performance: YouTube quota exhausted — aborting run',
      );
    }
    throw err;
  }
  const statsByVideoId = new Map(stats.map((s) => [s.videoId, s]));

  // 3. Per-video analytics. ANALYTICS_WINDOW_DAYS-day window matches
  // the YouTube Studio default for "lifetime-but-recent" comparison.
  const endDate = isoDate(now);
  const startDate = isoDate(
    new Date(now.getTime() - ANALYTICS_WINDOW_DAYS * 24 * 60 * 60 * 1000),
  );

  let emptyChannelSeen = false;
  const analyticsByVideoId = new Map<string, VideoAnalytics>();
  for (const id of videoIds) {
    try {
      const a = await yt.getVideoAnalytics(id, { startDate, endDate });
      analyticsByVideoId.set(id, a);
      if (a.emptyChannel) emptyChannelSeen = true;
    } catch (err) {
      if (err instanceof YouTubeError && err.code === 'QUOTA_EXCEEDED') {
        logger.error(
          { step: STEP_NAME, videoId: id, err: err.message },
          'refresh-stack-performance: quota exhausted mid-run',
        );
        throw err;
      }
      logger.warn(
        { step: STEP_NAME, videoId: id, err: (err as Error).message },
        'refresh-stack-performance: per-video analytics failed (skipping)',
      );
    }
  }

  // 4. Group by primaryTechStackId and aggregate.
  interface Aggregate {
    techStackProfileId: string;
    videoCount: number;
    totalViews: number;
    totalWatchSeconds: number;
    totalCtrSamples: number;
    ctrSampleCount: number;
    latestPublishedAt: string | null;
  }
  const byTech = new Map<string, Aggregate>();
  for (const entry of catalog) {
    const s = statsByVideoId.get(entry.youtubeVideoId);
    const a = analyticsByVideoId.get(entry.youtubeVideoId);
    let agg = byTech.get(entry.primaryTechStackId);
    if (!agg) {
      agg = {
        techStackProfileId: entry.primaryTechStackId,
        videoCount: 0,
        totalViews: 0,
        totalWatchSeconds: 0,
        totalCtrSamples: 0,
        ctrSampleCount: 0,
        latestPublishedAt: null,
      };
      byTech.set(entry.primaryTechStackId, agg);
    }
    agg.videoCount++;
    // Prefer Analytics window views (consistent timeframe across stacks);
    // fall back to lifetime Data API views if Analytics failed for this id.
    const views = a?.views ?? s?.viewCount ?? 0;
    agg.totalViews += views;
    if (a) {
      agg.totalWatchSeconds += (a.estimatedMinutesWatched ?? 0) * 60;
      if (a.averageViewPercentage !== null) {
        agg.totalCtrSamples += a.averageViewPercentage * 100;
        agg.ctrSampleCount++;
      }
    }
    if (entry.publishedAt) {
      if (!agg.latestPublishedAt || entry.publishedAt > agg.latestPublishedAt) {
        agg.latestPublishedAt = entry.publishedAt;
      }
    }
  }

  // 5. Upsert StackPerformance, one per group.
  let upserted = 0;
  let failed = 0;
  for (const agg of byTech.values()) {
    const id = derivePerfId(agg.techStackProfileId);
    const avgViews = agg.videoCount > 0 ? agg.totalViews / agg.videoCount : 0;
    const avgWatchTimeSeconds =
      agg.videoCount > 0 ? agg.totalWatchSeconds / agg.videoCount : 0;
    const avgCtr =
      agg.ctrSampleCount > 0 ? agg.totalCtrSamples / agg.ctrSampleCount : 0;
    try {
      await neuro.createStackPerformance({
        id,
        techStackProfileId: agg.techStackProfileId,
        videoCount: agg.videoCount,
        avgViews: roundOneDecimal(avgViews),
        avgWatchTimeSeconds: roundOneDecimal(avgWatchTimeSeconds),
        avgCtr: roundOneDecimal(avgCtr),
        totalRevenueUsd: null,
        lastVideoPublishedAt: agg.latestPublishedAt,
      });
      upserted++;
      logger.info(
        {
          step: STEP_NAME,
          techStackProfileId: agg.techStackProfileId,
          videoCount: agg.videoCount,
          avgViews: Math.round(avgViews),
        },
        'refresh-stack-performance: upserted',
      );
    } catch (err) {
      failed++;
      const code = err instanceof NeurocoreError ? err.code : 'UNKNOWN';
      logger.error(
        {
          step: STEP_NAME,
          techStackProfileId: agg.techStackProfileId,
          code,
          err: (err as Error).message,
        },
        'refresh-stack-performance: upsert failed (continuing)',
      );
    }
  }

  const durationMs = Date.now() - t0;
  logger.info(
    {
      step: STEP_NAME,
      attempted: byTech.size,
      upserted,
      failed,
      videosProcessed: catalog.length,
      emptyChannel: emptyChannelSeen,
      durationMs,
    },
    'refresh-stack-performance: run complete',
  );

  return {
    attempted: byTech.size,
    upserted,
    failed,
    videosProcessed: catalog.length,
    emptyChannel: emptyChannelSeen,
    durationMs,
  };
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function roundOneDecimal(n: number): number {
  return Math.round(n * 10) / 10;
}
