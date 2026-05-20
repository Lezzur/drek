/**
 * Narrow type definitions for what DREK consumes from YouTube. Kept
 * minimal — we never need the full API response shape, just the fields
 * that drive ContentCatalog enrichment + StackPerformance ingestion.
 */

export interface ChannelSummary {
  channelId: string;
  title: string;
  subscriberCount: number;
  viewCount: number;
  videoCount: number;
}

export interface VideoStats {
  videoId: string;
  /** Null when the video doesn't exist or was deleted between batch members. */
  found: boolean;
  title?: string;
  publishedAt?: string;
  viewCount?: number;
  likeCount?: number;
  commentCount?: number;
  durationIso?: string;
}

export interface DateRange {
  /** ISO date `YYYY-MM-DD`. */
  startDate: string;
  /** ISO date `YYYY-MM-DD`. */
  endDate: string;
}

export interface VideoAnalytics {
  videoId: string;
  range: DateRange;
  /** True when the upstream returned 403/no-data (e.g., a brand-new channel
   *  that hasn't crossed YouTube's analytics-eligibility threshold). The
   *  metrics fields will all be 0 in that case. */
  emptyChannel: boolean;
  views: number;
  estimatedMinutesWatched: number;
  averageViewDuration: number;
  /** 0-1 average percentage viewed (so 0.42 = 42%). Null when YouTube
   *  didn't return audienceRetentionRatio for this video (typical for
   *  videos with very low view counts). */
  averageViewPercentage: number | null;
}
