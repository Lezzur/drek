/**
 * M36 Phase 2.4 — Model config cache
 *
 * Fetches per-function model config from Neurocore on boot, caches it for
 * 15 minutes, and falls back to env defaults if Neurocore is unreachable
 * and no cache exists. The pipeline must never block on model selection —
 * if all sources fail, we log loud and throw so the transform aborts
 * cleanly rather than silently using a wrong model.
 *
 * Refresh cadence:
 *   - Boot: initModelConfigCache() called from index.ts, fires in background
 *   - Every 15 minutes: auto-refresh timer (started by initModelConfigCache)
 *   - Manual: refreshModelConfig() — called by POST /admin/refresh-model-config
 */

import { getEnv } from '../env.js';
import { logger } from '../logger.js';
import { NeurocoreClient } from '../neurocore/client.js';
import { NeurocoreError } from '../neurocore/errors.js';

const REFRESH_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

/* ─── Public shape ─────────────────────────────────────────────────────── */

export interface ModelConfig {
  drafter: { provider: string; model_id: string };
  critic: { provider: string; model_id: string };
  reviser: { provider: string; model_id: string };
  embedder: { provider: string; model_id: string };
  cached_at: number;
  source: 'neurocore' | 'env_fallback';
}

/* ─── Module-level cache ───────────────────────────────────────────────── */

let _cache: ModelConfig | null = null;
// Dedups concurrent cache-miss fetches so two simultaneous first callers don't
// both hit Neurocore.
let _inFlight: Promise<ModelConfig> | null = null;
let _refreshTimer: ReturnType<typeof setTimeout> | null = null;
let _client: NeurocoreClient | null = null;

function getClient(): NeurocoreClient {
  if (!_client) _client = new NeurocoreClient();
  return _client;
}

/** Test helper — swap the Neurocore client used by this module. */
export function _setClientForTests(client: NeurocoreClient | null): void {
  _client = client;
}

/** Test helper — reset the in-memory cache and stop the refresh timer. */
export function _resetCacheForTests(): void {
  _cache = null;
  _inFlight = null;
  if (_refreshTimer !== null) {
    clearTimeout(_refreshTimer);
    _refreshTimer = null;
  }
}

/* ─── Internal fetch + normalise ───────────────────────────────────────── */

function buildEnvFallback(): ModelConfig {
  const env = getEnv();
  return {
    drafter: { provider: 'anthropic', model_id: env.DEFAULT_DRAFTER_MODEL },
    critic: { provider: 'anthropic', model_id: env.DEFAULT_CRITIC_MODEL },
    reviser: { provider: 'anthropic', model_id: env.DEFAULT_REVISER_MODEL },
    embedder: { provider: 'openai', model_id: env.DEFAULT_EMBEDDER_MODEL },
    cached_at: Date.now(),
    source: 'env_fallback',
  };
}

async function fetchFromNeurocore(): Promise<ModelConfig> {
  const raw = await getClient().getModelConfig();
  return {
    drafter: { provider: raw.functions.drafter.provider, model_id: raw.functions.drafter.modelId },
    critic: { provider: raw.functions.critic.provider, model_id: raw.functions.critic.modelId },
    reviser: { provider: raw.functions.reviser.provider, model_id: raw.functions.reviser.modelId },
    embedder: { provider: raw.functions.embedder.provider, model_id: raw.functions.embedder.modelId },
    cached_at: Date.now(),
    source: 'neurocore',
  };
}

function scheduleNextRefresh(): void {
  if (_refreshTimer !== null) clearTimeout(_refreshTimer);
  _refreshTimer = setTimeout(() => {
    void refreshModelConfig().catch((err) =>
      logger.warn({ err: (err as Error).message }, 'model-config: background refresh failed'),
    );
  }, REFRESH_INTERVAL_MS);
  // Keep the timer non-blocking so it doesn't prevent the process from exiting
  // cleanly in tests or graceful shutdowns.
  if (_refreshTimer.unref) _refreshTimer.unref();
}

/* ─── Public API ───────────────────────────────────────────────────────── */

/**
 * Returns the cached model config. If the cache is empty (first call before
 * boot fetch has completed), attempts a synchronous fetch from Neurocore. If
 * Neurocore is unreachable and the cache is still empty, falls back to env
 * defaults and emits a loud warning.
 *
 * Mid-run: if the cache becomes stale (Neurocore went down after caching),
 * we keep using the cached config until Neurocore is reachable again — never
 * throw for a stale-but-present cache.
 */
export async function getModelConfig(): Promise<ModelConfig> {
  if (_cache !== null) return _cache;
  // Coalesce concurrent cache-miss callers onto a single fetch.
  if (_inFlight !== null) return _inFlight;

  // Cache miss — attempt a synchronous fetch (happens if getModelConfig is
  // called before initModelConfigCache fires, e.g. in tests or on the first
  // transform request before the boot timer finishes).
  _inFlight = (async () => {
    try {
      const cfg = await fetchFromNeurocore();
      _cache = cfg;
      logger.info({ source: 'neurocore' }, 'model-config: fetched on demand');
      scheduleNextRefresh();
      return cfg;
    } catch (err) {
      const isNeuroError = err instanceof NeurocoreError;
      logger.warn(
        {
          err: (err as Error).message,
          code: isNeuroError ? (err as NeurocoreError).code : undefined,
        },
        'model-config: Neurocore unreachable, falling back to env defaults',
      );
      const fallback = buildEnvFallback();
      _cache = fallback;
      scheduleNextRefresh();
      return fallback;
    } finally {
      _inFlight = null;
    }
  })();
  return _inFlight;
}

/**
 * Force-refresh the model config from Neurocore. Called by the boot timer,
 * the 15-minute auto-refresh timer, and the admin refresh endpoint.
 * On success: updates the cache.
 * On failure: keeps the existing cache (if any) and logs a warning.
 */
export async function refreshModelConfig(): Promise<void> {
  try {
    const fresh = await fetchFromNeurocore();
    const prev = _cache;
    _cache = fresh;
    if (prev?.source === 'env_fallback') {
      logger.info(
        { drafter: fresh.drafter.model_id, critic: fresh.critic.model_id },
        'model-config: recovered from env fallback — now using Neurocore config',
      );
    } else {
      logger.debug(
        { drafter: fresh.drafter.model_id, critic: fresh.critic.model_id },
        'model-config: refreshed from Neurocore',
      );
    }
  } catch (err) {
    const isNeuroError = err instanceof NeurocoreError;
    if (_cache !== null) {
      // Stale cache — keep using it, don't throw.
      logger.warn(
        {
          err: (err as Error).message,
          code: isNeuroError ? (err as NeurocoreError).code : undefined,
          cachedAt: _cache.cached_at,
          source: _cache.source,
        },
        'model-config: refresh failed, continuing with existing cache',
      );
    } else {
      // No cache at all — fall back to env defaults.
      logger.warn(
        {
          err: (err as Error).message,
          code: isNeuroError ? (err as NeurocoreError).code : undefined,
        },
        'model-config: refresh failed with empty cache, falling back to env defaults',
      );
      _cache = buildEnvFallback();
    }
  } finally {
    scheduleNextRefresh();
  }
}

/**
 * Called from index.ts on startup. Kicks off an initial background fetch so
 * getModelConfig() has data ready before the first transform. Non-blocking:
 * errors are logged, not thrown — the server must always boot.
 */
export function initModelConfigCache(): void {
  void refreshModelConfig().catch((err) =>
    logger.warn({ err: (err as Error).message }, 'model-config: boot fetch failed'),
  );
}
