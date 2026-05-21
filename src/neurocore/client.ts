import { getEnv } from '../env.js';
import { logger } from '../logger.js';
import { NeurocoreError, isRetryable, type NeurocoreErrorCode } from './errors.js';
import type {
  ApprovedScriptSignal,
  BuildPlanEditedSignal,
  ContentCatalogCreatePayload,
  ContentCatalogListEntry,
  ContentCatalogResponse,
  MemoryContextResponse,
  PendingListing,
  PendingListingsResponse,
  PlanMode,
  PublishedScriptSignal,
  ScoreOverriddenSignal,
} from './types.js';

const DEFAULT_RETRY_BACKOFF_MS = 2_000;
const MAX_ATTEMPTS = 2;
const IDEMPOTENCY_HEADER = 'Idempotency-Key';
const APP_ID = 'drek';

/**
 * NeurocoreClient — DREK's only path to Neurocore. Five methods, one per
 * call we need:
 *   - getProjectContext / getVoiceProfile  → POST /v1/memory/context
 *   - pollPendingSignals                   → GET  /v1/signals/pending-video
 *   - ackSignal                            → POST /v1/signals/pending-video/:id/ack
 *   - sendApprovedScript                   → POST /v1/memory/signals
 *
 * Hardening:
 *   - AbortController-driven timeout per attempt (NEUROCORE_TIMEOUT_MS)
 *   - One retry with 2s backoff on UNREACHABLE | TIMEOUT | SERVER_ERROR | RATE_LIMITED
 *   - 4xx errors surface immediately — retrying a bad request doesn't change anything
 *   - Typed NeurocoreError on every failure so the planning engine / cron can
 *     route on `code` (degrade vs propagate)
 *
 * Token resolution is lazy: NEUROCORE_TOKEN is optional in env.ts so tests can
 * construct the client without it. The first real call without a token throws
 * NOT_CONFIGURED — easy to spot, easy to fix.
 */
export class NeurocoreClient {
  private readonly baseUrl: string;
  private readonly token: string | null;
  private readonly timeoutMs: number;
  private readonly retryBackoffMs: number;

  constructor(opts?: {
    baseUrl?: string;
    token?: string | null;
    timeoutMs?: number;
    retryBackoffMs?: number;
  }) {
    const env = getEnv();
    this.baseUrl = (opts?.baseUrl ?? env.NEUROCORE_URL).replace(/\/$/, '');
    // Distinguish "caller passed null/undefined explicitly" from "caller didn't
    // pass a token key at all" — the explicit value wins, so a test can force
    // an unset state by passing `token: null`.
    this.token = opts && 'token' in opts ? opts.token ?? null : env.NEUROCORE_TOKEN ?? null;
    this.timeoutMs = opts?.timeoutMs ?? env.NEUROCORE_TIMEOUT_MS;
    this.retryBackoffMs = opts?.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
  }

  /**
   * Project + identity context for requirement matching (planning Call 2).
   * Mode picks the injection-profile task type — videoPlanCoverLetter vs
   * videoPlanYoutube — which Neurocore uses to weight projects/voice and
   * cap maxTokens.
   *
   * When `contactId` is provided (which is the same as PI's listingId for
   * listing-triggered plans), Neurocore inlines the per-listing fit-score
   * insight (quickWins, redFlags, reasoning) into the systemBlock as a
   * <listing_insight> XML block. Manual YouTube plans omit it — there's
   * no listing context to load.
   */
  async getProjectContext(params: {
    planMode: PlanMode;
    contactId?: string;
    jobContextHint?: string;
    tokenBudget?: number;
  }): Promise<MemoryContextResponse> {
    const taskType =
      params.planMode === 'cover_letter' ? 'videoPlanCoverLetter' : 'videoPlanYoutube';
    return this.requestJson<MemoryContextResponse>('POST', '/v1/memory/context', {
      taskType,
      scope: {
        userId: 'rick',
        appId: APP_ID,
        ...(params.contactId ? { contactId: params.contactId } : {}),
      },
      ...(params.jobContextHint ? { jobContextHint: params.jobContextHint } : {}),
      ...(params.tokenBudget !== undefined ? { tokenBudget: params.tokenBudget } : {}),
    });
  }

  /**
   * Voice profile + style for script writing (planning Call 4). DREK uses
   * the spoken-voice fingerprint Neurocore exposes once Gap 4 has had a
   * chance to populate it — until then, this returns whatever's in the
   * voice layer, which is the written voice (graceful degradation).
   *
   * Passing `contactId` here also pulls in the per-listing fit-score
   * insight, which is useful for script writing too — quickWins inform
   * what to emphasize, redFlags inform what to avoid.
   */
  async getVoiceProfile(params: {
    planMode: PlanMode;
    contactId?: string;
    jobContextHint?: string;
    tokenBudget?: number;
  }): Promise<MemoryContextResponse> {
    const taskType =
      params.planMode === 'cover_letter' ? 'scriptCoverLetter' : 'scriptYoutube';
    return this.requestJson<MemoryContextResponse>('POST', '/v1/memory/context', {
      taskType,
      scope: {
        userId: 'rick',
        appId: APP_ID,
        ...(params.contactId ? { contactId: params.contactId } : {}),
      },
      ...(params.jobContextHint ? { jobContextHint: params.jobContextHint } : {}),
      ...(params.tokenBudget !== undefined ? { tokenBudget: params.tokenBudget } : {}),
    });
  }

  /**
   * Poll for video-requiring PI listings DREK hasn't acked yet. Returns an
   * array (possibly empty). Cron-driven; manual "Check now" button hits the
   * same path.
   */
  async pollPendingSignals(): Promise<PendingListing[]> {
    const body = await this.requestJson<PendingListingsResponse>(
      'GET',
      '/v1/signals/pending-video',
      null,
    );
    if (!Array.isArray(body.listings)) {
      throw new NeurocoreError(
        'INVALID_RESPONSE',
        '/v1/signals/pending-video',
        'response missing listings array',
      );
    }
    return body.listings;
  }

  /**
   * Ack a single listing once DREK has created its video plan. Idempotent on
   * Neurocore's side — re-acking is a no-op. We send a deterministic
   * idempotency key so a retry collapses cleanly.
   */
  async ackSignal(memoryId: string): Promise<void> {
    if (!memoryId) {
      throw new NeurocoreError(
        'BAD_REQUEST',
        '/v1/signals/pending-video/:id/ack',
        'memoryId is required',
      );
    }
    await this.requestJson<{ memoryId: string; drekAcknowledged: boolean }>(
      'POST',
      `/v1/signals/pending-video/${encodeURIComponent(memoryId)}/ack`,
      null,
      { idempotencyKey: `drek-ack-${memoryId}` },
    );
  }

  /**
   * Send the final, edited scripts from a finalized plan to Neurocore as a
   * spoken-voice training sample (script.approved signal). Deterministic
   * idempotency key keyed off planId so the same plan can be finalized twice
   * without duplicating samples.
   */
  async sendApprovedScript(payload: ApprovedScriptSignal): Promise<void> {
    await this.requestJson<{ signalId: string; queued: boolean }>(
      'POST',
      '/v1/memory/signals',
      {
        appId: APP_ID,
        signalType: 'script.approved',
        payload,
        occurredAt: new Date().toISOString(),
      },
      { idempotencyKey: `drek-script-approved-${payload.planId}` },
    );
  }

  /**
   * Fire-and-forget signal when Rick marks a Deliverable as published.
   * Idempotency key is keyed per-deliverable so re-publishing the same
   * Deliverable (e.g., URL correction) collapses on Neurocore's side.
   *
   * The route layer wraps this in try/catch so a signal failure never
   * blocks the local published state transition — Neurocore degradation
   * is non-fatal here, same as sendApprovedScript.
   */
  /**
   * Send a `build_plan.edited` learning signal to Neurocore. Fires every
   * time Rick edits a transformed build plan in DREK. Idempotency key
   * carries the editedAt timestamp so two edits made within the 24h
   * idempotency window land as separate signals.
   *
   * Failure semantics: best-effort. Edit persistence in Firestore never
   * blocks on this — the caller catches and logs.
   */
  async sendBuildPlanEdited(payload: BuildPlanEditedSignal): Promise<void> {
    await this.requestJson<{ signalId: string; queued: boolean }>(
      'POST',
      '/v1/memory/signals',
      {
        appId: APP_ID,
        signalType: 'build_plan.edited',
        payload,
        occurredAt: payload.editedAt,
      },
      { idempotencyKey: `drek-build-plan-edited-${payload.briefId}-${payload.editedAt}` },
    );
  }

  /**
   * Send a `score.overridden` learning signal (M35). Fires every time
   * Rick edits a brief's score via the Edit-scores form. The payload
   * carries before+after scores, which axes moved, and an optional free
   * text reason. Idempotency key carries `overriddenAt` so back-to-back
   * edits within the 24h idempotency window land as separate signals.
   *
   * Best-effort: caller catches and logs — score persistence in
   * Firestore never blocks on this.
   */
  async sendScoreOverridden(payload: ScoreOverriddenSignal): Promise<void> {
    await this.requestJson<{ signalId: string; queued: boolean }>(
      'POST',
      '/v1/memory/signals',
      {
        appId: APP_ID,
        signalType: 'score.overridden',
        payload,
        occurredAt: payload.overriddenAt,
      },
      { idempotencyKey: `drek-score-overridden-${payload.briefId}-${payload.overriddenAt}` },
    );
  }

  async sendPublishedScript(payload: PublishedScriptSignal): Promise<void> {
    await this.requestJson<{ signalId: string; queued: boolean }>(
      'POST',
      '/v1/memory/signals',
      {
        appId: APP_ID,
        signalType: 'script.published',
        payload,
        occurredAt: new Date().toISOString(),
      },
      { idempotencyKey: `drek-script-published-${payload.deliverableId}` },
    );
  }

  /**
   * Create-or-update a ContentCatalog row on Neurocore. The server
   * upserts by deliverableId, so a re-publish for the same Deliverable
   * is safe — the same row updates in place. Idempotency-key here is the
   * 24h short-window guard against duplicate POSTs from the write queue's
   * retry path (the server-side deliverableId index is the long-window
   * guard).
   *
   * This is called via the persistent write queue, not directly. See
   * src/neurocore/write-queue.ts.
   */
  async createContentCatalog(
    payload: ContentCatalogCreatePayload,
  ): Promise<ContentCatalogResponse> {
    return this.requestJson<ContentCatalogResponse>(
      'POST',
      '/v1/content-catalog',
      payload,
      { idempotencyKey: `drek-content-catalog-${payload.deliverableId}` },
    );
  }

  /**
   * List ContentCatalog entries — used by the nightly
   * refresh-stack-performance cron to iterate every published video
   * and aggregate analytics per tech stack. Defaults sourceApp=drek so
   * the cron only sees what DREK published (future apps may publish too).
   */
  async listContentCatalog(opts?: {
    primaryTechStackId?: string;
    audienceProfileId?: string;
    limit?: number;
  }): Promise<{ profiles: ContentCatalogListEntry[] }> {
    const params = new URLSearchParams({ sourceApp: 'drek' });
    if (opts?.primaryTechStackId) params.set('primaryTechStackId', opts.primaryTechStackId);
    if (opts?.audienceProfileId) params.set('audienceProfileId', opts.audienceProfileId);
    if (opts?.limit) params.set('limit', String(opts.limit));
    const data = await this.requestJson<{ profiles: ContentCatalogListEntry[] }>(
      'GET',
      `/v1/content-catalog?${params.toString()}`,
      null,
    );
    if (!Array.isArray(data.profiles)) {
      throw new NeurocoreError(
        'INVALID_RESPONSE',
        '/v1/content-catalog',
        'response missing profiles array',
      );
    }
    return data;
  }

  /**
   * Upsert a StackPerformance row. Called by the nightly
   * refresh-stack-performance cron — one POST per active tech stack.
   * Idempotency-key carries the date so re-running the cron same-day
   * (manual retrigger) doesn't bounce off the 24h idempotency window
   * with a stale response.
   */
  async createStackPerformance(payload: {
    id: string;
    techStackProfileId: string;
    videoCount: number;
    avgViews: number;
    avgWatchTimeSeconds: number;
    avgCtr: number;
    totalRevenueUsd: number | null;
    lastVideoPublishedAt: string | null;
  }): Promise<{ entry: unknown }> {
    const todayUtc = new Date().toISOString().slice(0, 10);
    return this.requestJson<{ entry: unknown }>(
      'POST',
      '/v1/stack-performance',
      payload,
      {
        idempotencyKey: `drek-stack-performance-${payload.id}-${todayUtc}`,
      },
    );
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async requestJson<T>(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    opts?: { idempotencyKey?: string },
  ): Promise<T> {
    if (!this.token) {
      throw new NeurocoreError(
        'NOT_CONFIGURED',
        path,
        'NEUROCORE_TOKEN is not set — cannot call Neurocore',
      );
    }

    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/json',
    };
    if (body !== null && body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    if (opts?.idempotencyKey) {
      headers[IDEMPOTENCY_HEADER] = opts.idempotencyKey;
    }

    let lastError: NeurocoreError | null = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const result = await this.attempt<T>(method, url, headers, body, path);
        if (attempt > 1) {
          logger.info(
            { endpoint: path, attempt },
            'neurocore call succeeded after retry',
          );
        }
        return result;
      } catch (err) {
        if (!(err instanceof NeurocoreError)) throw err;
        lastError = err;
        if (!isRetryable(err) || attempt === MAX_ATTEMPTS) break;
        logger.warn(
          { endpoint: path, attempt, code: err.code },
          'neurocore call failed; retrying',
        );
        if (this.retryBackoffMs > 0) await sleep(this.retryBackoffMs);
      }
    }
    throw lastError ?? new NeurocoreError('SERVER_ERROR', path, 'unreachable code path');
  }

  private async attempt<T>(
    method: 'GET' | 'POST',
    url: string,
    headers: Record<string, string>,
    body: unknown,
    endpoint: string,
  ): Promise<T> {
    const controller = new AbortController();
    const timeoutTimer = setTimeout(() => controller.abort(), this.timeoutMs);
    if (typeof timeoutTimer.unref === 'function') timeoutTimer.unref();

    let response: Response;
    const t0 = Date.now();
    try {
      response = await fetch(url, {
        method,
        headers,
        body: body !== null && body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      const cause = err as Error & { name?: string };
      if (cause.name === 'AbortError') {
        throw new NeurocoreError(
          'TIMEOUT',
          endpoint,
          `request exceeded ${this.timeoutMs}ms`,
        );
      }
      throw new NeurocoreError(
        'UNREACHABLE',
        endpoint,
        cause.message || 'fetch failed',
      );
    } finally {
      clearTimeout(timeoutTimer);
    }

    const durationMs = Date.now() - t0;

    if (!response.ok) {
      const code = statusToCode(response.status);
      let detail = '';
      try {
        const errBody = (await response.json()) as Record<string, unknown>;
        const e = errBody.error as Record<string, unknown> | undefined;
        if (e && typeof e.message === 'string') detail = e.message;
      } catch {
        // ignore — body wasn't JSON
      }
      logger.warn(
        { endpoint, status: response.status, code, durationMs, detail: detail.slice(0, 200) },
        'neurocore non-2xx',
      );
      throw new NeurocoreError(
        code,
        endpoint,
        `${response.status} ${response.statusText}${detail ? `: ${detail}` : ''}`,
        response.status,
      );
    }

    logger.debug({ endpoint, durationMs }, 'neurocore ok');

    // 204-no-content is rare here, but handle it cleanly.
    if (response.status === 204) {
      return {} as T;
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch (err) {
      throw new NeurocoreError(
        'INVALID_RESPONSE',
        endpoint,
        `response was not valid JSON: ${(err as Error).message}`,
        response.status,
      );
    }
    return parsed as T;
  }
}

function statusToCode(status: number): NeurocoreErrorCode {
  if (status === 401) return 'UNAUTHENTICATED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 409) return 'INVALID_STATE';
  if (status === 429) return 'RATE_LIMITED';
  if (status === 503) return 'DEGRADED';
  if (status >= 400 && status < 500) return 'BAD_REQUEST';
  return 'SERVER_ERROR';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof t.unref === 'function') t.unref();
  });
}

// ---------------------------------------------------------------------------
// Memoized factory — keep one client per process. Useful so callers can do
// `getNeurocoreClient()` without threading the instance through everything.
// ---------------------------------------------------------------------------

let cached: NeurocoreClient | null = null;

export function getNeurocoreClient(): NeurocoreClient {
  if (!cached) cached = new NeurocoreClient();
  return cached;
}

/** Test-only: clear the memoized client so a new env can take effect. */
export function _resetNeurocoreClientForTests(): void {
  cached = null;
}
