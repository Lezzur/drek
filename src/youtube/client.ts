import { logger } from '../logger.js';
import { getEnv } from '../env.js';
import { YouTubeError, isRetryable, type YouTubeErrorCode } from './errors.js';
import { YouTubeOAuth } from './oauth.js';
import { consume, setQuotaCap, snapshot, type QuotaSnapshot } from './quota.js';
import type {
  ChannelSummary,
  DateRange,
  VideoAnalytics,
  VideoStats,
} from './types.js';

/**
 * YouTubeClient — DREK's read-only path to YouTube Data + Analytics APIs.
 *
 * Per TECH-SPEC-drek-v2.1-content-substrate-2026-05-19.md §4 Piece 5:
 *   - getChannelSummary()
 *   - getVideoStats(videoIds[]) — batched ≤50 per call
 *   - getVideoAnalytics(videoId, dateRange)
 *
 * Hardening:
 *   - OAuth refresh on cache miss / token expiry (oauth.ts)
 *   - One retry on UNREACHABLE/TIMEOUT/SERVER_ERROR; never on auth/quota/404
 *   - Quota counter (quota.ts) refuses calls at 95% of daily cap
 *   - Empty-channel 403 (brand-new channel, no analytics data yet) is
 *     surfaced as a non-error VideoAnalytics with emptyChannel=true so
 *     the upstream ingestion can degrade gracefully rather than crash
 *
 * Auth is env-driven. The bootstrap (one-time refresh-token mint) is
 * out-of-band — see scripts/verify-youtube-oauth.ts for the manual flow.
 * Reading from `$WORKSPACE_ROOT/.youtube-token.json` (per the spec's
 * earlier sketch) was dropped in favor of env vars because Rick provisioned
 * via OAuth Playground; the on-disk cache was redundant with that path.
 */

const DATA_API_BASE = 'https://www.googleapis.com/youtube/v3';
const ANALYTICS_API_BASE = 'https://youtubeanalytics.googleapis.com/v2';
const MAX_VIDEO_BATCH = 50;
const DEFAULT_RETRY_BACKOFF_MS = 1_000;
const MAX_ATTEMPTS = 2;

export interface YouTubeClientOptions {
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  channelId?: string;
  /** Per-call timeout. Defaults to env.YOUTUBE_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Per-process daily quota cap. Defaults to env.YOUTUBE_DAILY_QUOTA. */
  quotaCap?: number;
  retryBackoffMs?: number;
  /** Test seam — supply a pre-built OAuth so tests can mock token minting. */
  oauth?: YouTubeOAuth;
}

export class YouTubeClient {
  private readonly oauth: YouTubeOAuth;
  private readonly channelId: string;
  private readonly timeoutMs: number;
  private readonly retryBackoffMs: number;
  private readonly configured: boolean;

  constructor(opts: YouTubeClientOptions = {}) {
    const env = getEnv();
    const clientId = opts.clientId ?? env.YOUTUBE_CLIENT_ID;
    const clientSecret = opts.clientSecret ?? env.YOUTUBE_CLIENT_SECRET;
    const refreshToken = opts.refreshToken ?? env.YOUTUBE_REFRESH_TOKEN;
    const channelId = opts.channelId ?? env.YOUTUBE_CHANNEL_ID;
    this.timeoutMs = opts.timeoutMs ?? env.YOUTUBE_TIMEOUT_MS;
    this.retryBackoffMs = opts.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;

    setQuotaCap(opts.quotaCap ?? env.YOUTUBE_DAILY_QUOTA);

    this.configured = Boolean(clientId && clientSecret && refreshToken && channelId);
    this.channelId = channelId ?? '';

    if (opts.oauth) {
      this.oauth = opts.oauth;
    } else if (this.configured) {
      this.oauth = new YouTubeOAuth(
        {
          clientId: clientId!,
          clientSecret: clientSecret!,
          refreshToken: refreshToken!,
        },
        { timeoutMs: this.timeoutMs },
      );
    } else {
      // Build a placeholder OAuth that will never be reached — every
      // public method short-circuits on !this.configured.
      this.oauth = new YouTubeOAuth(
        { clientId: '', clientSecret: '', refreshToken: '' },
        { timeoutMs: this.timeoutMs },
      );
    }
  }

  /** True when all four YOUTUBE_* env vars are set. Tests + /healthz
   *  use this to surface a degraded state without making a real call. */
  isConfigured(): boolean {
    return this.configured;
  }

  /** Snapshot of the in-process quota counter. */
  quotaSnapshot(): QuotaSnapshot {
    return snapshot();
  }

  // ---------------------------------------------------------------------
  // getChannelSummary — 1 unit
  // ---------------------------------------------------------------------

  async getChannelSummary(): Promise<ChannelSummary> {
    this.assertConfigured('/channels');
    const endpoint = '/youtube/v3/channels';
    consume(1, endpoint);
    const url = `${DATA_API_BASE}/channels?part=snippet,statistics&id=${encodeURIComponent(
      this.channelId,
    )}`;
    const body = await this.requestJson<{
      items?: Array<{
        id: string;
        snippet?: { title?: string };
        statistics?: {
          subscriberCount?: string;
          viewCount?: string;
          videoCount?: string;
        };
      }>;
    }>('GET', url, endpoint);
    const item = body.items?.[0];
    if (!item) {
      throw new YouTubeError(
        'NOT_FOUND',
        endpoint,
        `channel ${this.channelId} returned no items`,
      );
    }
    return {
      channelId: item.id,
      title: item.snippet?.title ?? '',
      subscriberCount: parseIntSafe(item.statistics?.subscriberCount),
      viewCount: parseIntSafe(item.statistics?.viewCount),
      videoCount: parseIntSafe(item.statistics?.videoCount),
    };
  }

  // ---------------------------------------------------------------------
  // getVideoStats — 1 unit per batch (≤50 ids/batch)
  // ---------------------------------------------------------------------

  async getVideoStats(videoIds: string[]): Promise<VideoStats[]> {
    this.assertConfigured('/videos');
    if (videoIds.length === 0) return [];
    const endpoint = '/youtube/v3/videos';
    const batches: string[][] = [];
    for (let i = 0; i < videoIds.length; i += MAX_VIDEO_BATCH) {
      batches.push(videoIds.slice(i, i + MAX_VIDEO_BATCH));
    }
    const out: VideoStats[] = [];
    for (const batch of batches) {
      consume(1, endpoint);
      const url = `${DATA_API_BASE}/videos?part=snippet,statistics,contentDetails&id=${batch
        .map((id) => encodeURIComponent(id))
        .join(',')}`;
      const body = await this.requestJson<{
        items?: Array<{
          id: string;
          snippet?: { title?: string; publishedAt?: string };
          statistics?: {
            viewCount?: string;
            likeCount?: string;
            commentCount?: string;
          };
          contentDetails?: { duration?: string };
        }>;
      }>('GET', url, endpoint);
      const returned = new Map<string, VideoStats>();
      for (const item of body.items ?? []) {
        returned.set(item.id, {
          videoId: item.id,
          found: true,
          ...(item.snippet?.title !== undefined ? { title: item.snippet.title } : {}),
          ...(item.snippet?.publishedAt !== undefined
            ? { publishedAt: item.snippet.publishedAt }
            : {}),
          viewCount: parseIntSafe(item.statistics?.viewCount),
          likeCount: parseIntSafe(item.statistics?.likeCount),
          commentCount: parseIntSafe(item.statistics?.commentCount),
          ...(item.contentDetails?.duration !== undefined
            ? { durationIso: item.contentDetails.duration }
            : {}),
        });
      }
      // Preserve request order; mark ids that the API silently dropped
      // (deleted videos, wrong region restrictions, etc.) as found:false
      // so the caller can decide what to do per-video.
      for (const id of batch) {
        out.push(returned.get(id) ?? { videoId: id, found: false });
      }
    }
    return out;
  }

  // ---------------------------------------------------------------------
  // getVideoAnalytics — ~5 units
  // ---------------------------------------------------------------------

  async getVideoAnalytics(
    videoId: string,
    range: DateRange,
  ): Promise<VideoAnalytics> {
    this.assertConfigured('/reports');
    const endpoint = '/youtubeAnalytics/v2/reports';
    consume(5, endpoint);

    const params = new URLSearchParams({
      ids: `channel==${this.channelId}`,
      startDate: range.startDate,
      endDate: range.endDate,
      metrics: 'views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage',
      filters: `video==${videoId}`,
    });
    const url = `${ANALYTICS_API_BASE}/reports?${params.toString()}`;

    try {
      const body = await this.requestJson<{
        rows?: Array<[number, number, number, number?]>;
      }>('GET', url, endpoint);
      const row = body.rows?.[0];
      if (!row) {
        // 200 with no rows = the video exists, but had no measurable
        // analytics events in the window. Treat as zeros.
        return {
          videoId,
          range,
          emptyChannel: false,
          views: 0,
          estimatedMinutesWatched: 0,
          averageViewDuration: 0,
          averageViewPercentage: null,
        };
      }
      const [views, minutes, avgDuration, avgPctRaw] = row;
      return {
        videoId,
        range,
        emptyChannel: false,
        views,
        estimatedMinutesWatched: minutes,
        averageViewDuration: avgDuration,
        averageViewPercentage:
          typeof avgPctRaw === 'number' ? avgPctRaw / 100 : null,
      };
    } catch (err) {
      // Brand-new channel quirk: Analytics returns 403 (not 200 with
      // empty rows) when the channel has zero analytics history. Surface
      // as a non-error so the ingestion job can carry on.
      if (err instanceof YouTubeError && err.code === 'EMPTY_CHANNEL') {
        return {
          videoId,
          range,
          emptyChannel: true,
          views: 0,
          estimatedMinutesWatched: 0,
          averageViewDuration: 0,
          averageViewPercentage: null,
        };
      }
      throw err;
    }
  }

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  private assertConfigured(endpoint: string): void {
    if (!this.configured) {
      throw new YouTubeError(
        'NOT_CONFIGURED',
        endpoint,
        'YOUTUBE_* env vars are not all set — cannot call YouTube',
      );
    }
  }

  private async requestJson<T>(
    method: 'GET',
    url: string,
    endpoint: string,
  ): Promise<T> {
    let lastError: YouTubeError | null = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const accessToken = await this.oauth.getAccessToken();
        return await this.attempt<T>(method, url, accessToken, endpoint);
      } catch (err) {
        if (!(err instanceof YouTubeError)) throw err;
        lastError = err;
        // 401 → token rotated mid-session. Drop the cache and try again
        // (still counted as the same attempt — the retry counter is for
        // network/server errors, not the token rotation case).
        if (err.code === 'AUTH_FAILED' && err.status === 401 && attempt === 1) {
          this.oauth.invalidate();
          logger.warn({ endpoint }, 'youtube-client: 401 — invalidated token, retrying');
          continue;
        }
        if (!isRetryable(err) || attempt === MAX_ATTEMPTS) break;
        logger.warn(
          { endpoint, attempt, code: err.code },
          'youtube-client: call failed, retrying',
        );
        if (this.retryBackoffMs > 0) await sleep(this.retryBackoffMs);
      }
    }
    throw lastError ?? new YouTubeError('SERVER_ERROR', endpoint, 'unreachable code path');
  }

  private async attempt<T>(
    method: 'GET',
    url: string,
    accessToken: string,
    endpoint: string,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: 'application/json',
        },
        signal: controller.signal,
      });
    } catch (err) {
      const cause = err as Error & { name?: string };
      if (cause.name === 'AbortError') {
        throw new YouTubeError(
          'TIMEOUT',
          endpoint,
          `request exceeded ${this.timeoutMs}ms`,
        );
      }
      throw new YouTubeError(
        'UNREACHABLE',
        endpoint,
        cause.message || 'fetch failed',
      );
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const code = mapStatusToCode(res.status);
      let detail: unknown = null;
      let upstreamReason: string | undefined;
      try {
        const errBody = (await res.json()) as Record<string, unknown>;
        detail = errBody;
        const e = errBody.error as Record<string, unknown> | undefined;
        const errs = e?.errors as Array<{ reason?: string }> | undefined;
        upstreamReason = errs?.[0]?.reason;
      } catch {
        // ignore — body wasn't JSON
      }
      // Refine the code using upstream "reason" so quota vs forbidden vs
      // empty-channel each surface distinctly:
      let refined: YouTubeErrorCode = code;
      if (upstreamReason === 'quotaExceeded' || upstreamReason === 'rateLimitExceeded') {
        refined = 'QUOTA_EXCEEDED';
      } else if (res.status === 403 && endpoint.includes('reports')) {
        // Analytics 403 on a brand-new channel — distinct enough that the
        // caller can treat as "no data yet" rather than "auth broken".
        refined = 'EMPTY_CHANNEL';
      } else if (res.status === 403) {
        refined = 'FORBIDDEN';
      } else if (res.status === 401) {
        refined = 'AUTH_FAILED';
      }
      throw new YouTubeError(refined, endpoint, `${res.status} ${res.statusText}`, {
        status: res.status,
        detail,
      });
    }

    if (res.status === 204) return {} as T;

    try {
      return (await res.json()) as T;
    } catch (err) {
      throw new YouTubeError(
        'INVALID_RESPONSE',
        endpoint,
        `response was not valid JSON: ${(err as Error).message}`,
        { status: res.status },
      );
    }
  }
}

function mapStatusToCode(status: number): YouTubeErrorCode {
  if (status === 401) return 'AUTH_FAILED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 429) return 'QUOTA_EXCEEDED';
  if (status >= 500) return 'SERVER_ERROR';
  return 'FORBIDDEN'; // fallback for other 4xx
}

function parseIntSafe(s: string | undefined): number {
  if (s === undefined) return 0;
  const n = Number.parseInt(s, 10);
  return Number.isNaN(n) ? 0 : n;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof t.unref === 'function') t.unref();
  });
}

// ---------------------------------------------------------------------------
// Memoized factory — one client per process.
// ---------------------------------------------------------------------------

let cached: YouTubeClient | null = null;

export function getYouTubeClient(): YouTubeClient {
  if (!cached) cached = new YouTubeClient();
  return cached;
}

/** Test-only — clear the memoized client. */
export function _resetYouTubeClientForTests(): void {
  cached = null;
}
