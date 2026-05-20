import { logger } from '../logger.js';
import { YouTubeError } from './errors.js';

/**
 * In-process daily quota tracker for the YouTube Data + Analytics APIs.
 *
 * Per TECH-SPEC v2.1 §4 Piece 5:
 *   - getChannelSummary       = 1 unit
 *   - getVideoStats (batch)   = 1 unit per batch (≤50 ids/batch)
 *   - getVideoAnalytics       = ~5 units (we use a flat 5; the Analytics
 *     API doesn't actually share Data API quota, but treating it as the
 *     same bucket gives us a single budget to reason about)
 *
 * Behavior:
 *   - warn-logs once at 80% utilization (sticky — won't repeat)
 *   - throws QUOTA_EXCEEDED once at 95%, leaving the remaining 5% as
 *     headroom for an emergency call (e.g., admin debug) that bypasses
 *     this guard via consumeRaw
 *   - resets at the next UTC midnight — matches Google's quota window
 *
 * State is in-process only. A service restart resets to zero — that's
 * acceptable for v2.1 (Rick runs DREK on one host; a restart costs at
 * most the units already consumed before the restart). v2.2 could
 * persist the counter to Firestore if we end up running multiple workers.
 */

const DEFAULT_CAP = 10_000;
const WARN_FRACTION = 0.8;
const HARD_LIMIT_FRACTION = 0.95;

export interface QuotaSnapshot {
  cap: number;
  consumed: number;
  remaining: number;
  utilization: number;
  resetsAt: string;
  warnFiredAt: string | null;
}

let cap = DEFAULT_CAP;
let consumed = 0;
let dayKey = utcDayKey();
let warnFiredAt: string | null = null;

function utcDayKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function nextUtcMidnightIso(): string {
  const now = new Date();
  const next = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0),
  );
  return next.toISOString();
}

function rollDayIfNeeded(): void {
  const current = utcDayKey();
  if (current !== dayKey) {
    logger.info(
      { previousDay: dayKey, previousConsumed: consumed, cap },
      'youtube-quota: daily window rolled, resetting counter',
    );
    dayKey = current;
    consumed = 0;
    warnFiredAt = null;
  }
}

/** Set the per-day cap. Wired from env on client construction. */
export function setQuotaCap(newCap: number): void {
  cap = newCap > 0 ? newCap : DEFAULT_CAP;
}

/**
 * Charge `units` against today's budget. Throws QUOTA_EXCEEDED at 95%
 * utilization. Caller passes the endpoint name for the error message
 * so the offending call site is visible in the log.
 */
export function consume(units: number, endpoint: string): void {
  rollDayIfNeeded();
  const after = consumed + units;
  if (after > cap * HARD_LIMIT_FRACTION) {
    throw new YouTubeError(
      'QUOTA_EXCEEDED',
      endpoint,
      `would exceed 95% of daily quota (${after}/${cap}) — refusing call to leave headroom`,
      { detail: { consumed, requested: units, cap } },
    );
  }
  consumed = after;
  if (
    warnFiredAt === null &&
    consumed >= cap * WARN_FRACTION
  ) {
    warnFiredAt = new Date().toISOString();
    logger.warn(
      { consumed, cap, utilizationPct: Math.round((consumed / cap) * 100) },
      'youtube-quota: 80% of daily quota consumed — slow down or raise cap',
    );
  }
}

/** Test-only / emergency: charge against today's budget without the
 *  95% guard. Used by the verification script. */
export function consumeRaw(units: number): void {
  rollDayIfNeeded();
  consumed += units;
}

/** Current snapshot — exposed for /healthz + tests. */
export function snapshot(): QuotaSnapshot {
  rollDayIfNeeded();
  return {
    cap,
    consumed,
    remaining: Math.max(0, cap - consumed),
    utilization: cap > 0 ? consumed / cap : 0,
    resetsAt: nextUtcMidnightIso(),
    warnFiredAt,
  };
}

/** Test-only — reset state without waiting for UTC midnight. */
export function _resetQuotaForTests(newCap?: number): void {
  cap = newCap ?? DEFAULT_CAP;
  consumed = 0;
  dayKey = utcDayKey();
  warnFiredAt = null;
}
