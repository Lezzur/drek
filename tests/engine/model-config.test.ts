import { describe, it, expect, vi, beforeEach } from 'vitest';

// Must be before any module imports that call getEnv.
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
  NEUROCORE_TIMEOUT_MS: 10_000,
  MODEL_REFRESH_INTERVAL_HOURS: 24,
  POLLING_INTERVAL_MS: 1_800_000,
  DEFAULT_DRAFTER_MODEL: 'claude-opus-fallback',
  DEFAULT_CRITIC_MODEL: 'claude-opus-fallback',
  DEFAULT_REVISER_MODEL: 'claude-opus-fallback',
  DEFAULT_EMBEDDER_MODEL: 'text-embedding-fallback',
};
vi.mock('../../src/env.js', () => ({
  getEnv: () => fakeEnv,
  loadEnv: () => fakeEnv,
}));

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

import { NeurocoreError } from '../../src/neurocore/errors.js';
import {
  getModelConfig,
  refreshModelConfig,
  _resetCacheForTests,
  _setClientForTests,
  type ModelConfig,
} from '../../src/engine/model-config.js';

// ---------------------------------------------------------------------------
// Mock client factory
// ---------------------------------------------------------------------------

function makeClient(responses: Array<ModelConfig | Error>): {
  getModelConfig: ReturnType<typeof vi.fn>;
} {
  const queue = [...responses];
  return {
    getModelConfig: vi.fn(async () => {
      const next = queue.shift();
      if (next === undefined) throw new Error('mock client exhausted');
      if (next instanceof Error) throw next;
      // Return in Neurocore wire shape
      return {
        functions: {
          drafter: { provider: next.drafter.provider, modelId: next.drafter.model_id },
          critic: { provider: next.critic.provider, modelId: next.critic.model_id },
          reviser: { provider: next.reviser.provider, modelId: next.reviser.model_id },
          embedder: { provider: next.embedder.provider, modelId: next.embedder.model_id },
        },
        cacheTtlSeconds: 900,
        schemaVersion: 1 as const,
      };
    }),
  };
}

const neurocoreConfig: ModelConfig = {
  drafter: { provider: 'anthropic', model_id: 'claude-opus-live' },
  critic: { provider: 'anthropic', model_id: 'claude-opus-live' },
  reviser: { provider: 'anthropic', model_id: 'claude-opus-live' },
  embedder: { provider: 'openai', model_id: 'text-embedding-3-small' },
  cached_at: 0,
  source: 'neurocore',
};

beforeEach(() => {
  _resetCacheForTests();
  _setClientForTests(null);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getModelConfig', () => {
  it('fetches from Neurocore on cache miss and caches the result', async () => {
    const client = makeClient([neurocoreConfig]);
    _setClientForTests(client as never);

    const cfg = await getModelConfig();

    expect(cfg.source).toBe('neurocore');
    expect(cfg.drafter.model_id).toBe('claude-opus-live');
    expect(cfg.critic.model_id).toBe('claude-opus-live');
    expect(cfg.reviser.model_id).toBe('claude-opus-live');
    expect(cfg.embedder.model_id).toBe('text-embedding-3-small');
    expect(cfg.cached_at).toBeGreaterThan(0);
    expect(client.getModelConfig).toHaveBeenCalledTimes(1);
  });

  it('returns cached value on second call without re-fetching', async () => {
    const client = makeClient([neurocoreConfig]);
    _setClientForTests(client as never);

    await getModelConfig();
    const cfg2 = await getModelConfig();

    expect(client.getModelConfig).toHaveBeenCalledTimes(1);
    expect(cfg2.source).toBe('neurocore');
  });

  it('falls back to env defaults when Neurocore is unreachable on first call', async () => {
    const client = makeClient([new NeurocoreError('UNREACHABLE', '/v1/model-config', 'down')]);
    _setClientForTests(client as never);

    const cfg = await getModelConfig();

    expect(cfg.source).toBe('env_fallback');
    expect(cfg.drafter.model_id).toBe('claude-opus-fallback');
    expect(cfg.critic.model_id).toBe('claude-opus-fallback');
    expect(cfg.embedder.model_id).toBe('text-embedding-fallback');
  });

  it('provider is set correctly from env fallback', async () => {
    const client = makeClient([new NeurocoreError('UNREACHABLE', '/v1/model-config', 'down')]);
    _setClientForTests(client as never);

    const cfg = await getModelConfig();

    expect(cfg.drafter.provider).toBe('anthropic');
    expect(cfg.embedder.provider).toBe('openai');
  });
});

describe('refreshModelConfig', () => {
  it('updates the cache with fresh data from Neurocore', async () => {
    const client = makeClient([neurocoreConfig]);
    _setClientForTests(client as never);

    await refreshModelConfig();
    const cfg = await getModelConfig();

    expect(cfg.source).toBe('neurocore');
    expect(cfg.drafter.model_id).toBe('claude-opus-live');
    // getModelConfig should return the cached value, not trigger another fetch
    expect(client.getModelConfig).toHaveBeenCalledTimes(1);
  });

  it('keeps existing cache when refresh fails', async () => {
    // Seed the cache first
    const client = makeClient([
      neurocoreConfig,
      new NeurocoreError('UNREACHABLE', '/v1/model-config', 'down'),
    ]);
    _setClientForTests(client as never);

    await refreshModelConfig(); // populates cache
    await refreshModelConfig(); // fails, cache should survive

    const cfg = await getModelConfig();
    expect(cfg.source).toBe('neurocore');
    expect(cfg.drafter.model_id).toBe('claude-opus-live');
  });

  it('falls back to env defaults when refresh fails with empty cache', async () => {
    const client = makeClient([new NeurocoreError('UNREACHABLE', '/v1/model-config', 'down')]);
    _setClientForTests(client as never);

    await refreshModelConfig();
    const cfg = await getModelConfig();

    expect(cfg.source).toBe('env_fallback');
    expect(cfg.drafter.model_id).toBe('claude-opus-fallback');
  });

  it('transitions source from env_fallback to neurocore when Neurocore recovers', async () => {
    // First call: Neurocore down → env fallback
    const client = makeClient([
      new NeurocoreError('UNREACHABLE', '/v1/model-config', 'down'),
      neurocoreConfig,
    ]);
    _setClientForTests(client as never);

    await refreshModelConfig();
    const fallback = await getModelConfig();
    expect(fallback.source).toBe('env_fallback');

    // Second refresh: Neurocore back up
    _resetCacheForTests();
    _setClientForTests(client as never);
    await refreshModelConfig();
    const recovered = await getModelConfig();
    expect(recovered.source).toBe('neurocore');
    expect(recovered.drafter.model_id).toBe('claude-opus-live');
  });

  it('does not throw on refresh failure — always resolves', async () => {
    const client = makeClient([new Error('network error')]);
    _setClientForTests(client as never);

    await expect(refreshModelConfig()).resolves.toBeUndefined();
  });
});

describe('ModelConfig shape', () => {
  it('normalises Neurocore camelCase modelId to snake_case model_id', async () => {
    const client = makeClient([
      {
        drafter: { provider: 'anthropic', model_id: 'claude-opus-4-7' },
        critic: { provider: 'anthropic', model_id: 'claude-opus-4-7' },
        reviser: { provider: 'anthropic', model_id: 'claude-sonnet-4-6' },
        embedder: { provider: 'openai', model_id: 'text-embedding-3-large' },
        cached_at: 0,
        source: 'neurocore',
      },
    ]);
    _setClientForTests(client as never);

    const cfg = await getModelConfig();

    expect(cfg.drafter).toHaveProperty('model_id');
    expect(cfg.drafter).not.toHaveProperty('modelId');
    expect(cfg.drafter.model_id).toBe('claude-opus-4-7');
    expect(cfg.reviser.model_id).toBe('claude-sonnet-4-6');
    expect(cfg.embedder.model_id).toBe('text-embedding-3-large');
  });

  it('cached_at is a recent epoch ms timestamp', async () => {
    const before = Date.now();
    const client = makeClient([neurocoreConfig]);
    _setClientForTests(client as never);

    const cfg = await getModelConfig();
    const after = Date.now();

    expect(cfg.cached_at).toBeGreaterThanOrEqual(before);
    expect(cfg.cached_at).toBeLessThanOrEqual(after);
  });
});
