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
  NEUROCORE_TIMEOUT_MS: 10_000,
  ANTHROPIC_API_KEY: undefined as string | undefined,
  OPENAI_API_KEY: undefined as string | undefined,
  MODEL_REFRESH_INTERVAL_HOURS: 24,
};
vi.mock('../../src/env.js', () => ({
  getEnv: () => fakeEnv,
  loadEnv: () => fakeEnv,
}));
vi.mock('../../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() },
}));

import { fetchAnthropicModels } from '../../src/models/anthropic.js';
import { fetchOpenAIModels } from '../../src/models/openai.js';

const fetchQueue: Array<Response | { throws: Error }> = [];
const fetchCalls: Array<{ url: string; headers: Record<string, string> }> = [];

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function installFetchMock(): void {
  globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    if (init?.headers) {
      for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
        headers[k.toLowerCase()] = v;
      }
    }
    fetchCalls.push({ url, headers });
    const next = fetchQueue.shift();
    if (!next) throw new Error(`unexpected fetch ${url} — queue empty`);
    if (next instanceof Response) return next;
    throw next.throws;
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  fetchQueue.length = 0;
  fetchCalls.length = 0;
  installFetchMock();
  fakeEnv.ANTHROPIC_API_KEY = undefined;
  fakeEnv.OPENAI_API_KEY = undefined;
});

describe('fetchAnthropicModels', () => {
  it('skips silently when ANTHROPIC_API_KEY is unset', async () => {
    const out = await fetchAnthropicModels();
    expect(out.fetched).toBe(false);
    expect(out.error).toContain('ANTHROPIC_API_KEY unset');
    expect(out.items).toEqual([]);
    expect(fetchCalls).toHaveLength(0);
  });

  it('maps the API response into ModelEntry items', async () => {
    fakeEnv.ANTHROPIC_API_KEY = 'sk-ant-test';
    fetchQueue.push(
      jsonResponse(200, {
        data: [
          {
            id: 'claude-opus-4',
            display_name: 'Claude Opus 4',
            created_at: '2026-01-15T00:00:00Z',
            type: 'model',
          },
          { id: 'claude-sonnet-4-5', display_name: 'Claude Sonnet 4.5' },
          { id: '' }, // filtered out — empty id
          { display_name: 'orphan' }, // filtered out — no id
        ],
      }),
    );
    const out = await fetchAnthropicModels();
    expect(out.fetched).toBe(true);
    expect(out.error).toBeNull();
    expect(out.items).toHaveLength(2);
    expect(out.items[0]).toMatchObject({
      id: 'claude-opus-4',
      provider: 'anthropic',
      displayName: 'Claude Opus 4',
      createdAt: '2026-01-15T00:00:00Z',
    });
    expect(fetchCalls[0]?.headers['x-api-key']).toBe('sk-ant-test');
    expect(fetchCalls[0]?.headers['anthropic-version']).toBe('2023-06-01');
  });

  it('reports HTTP error without leaking the key', async () => {
    fakeEnv.ANTHROPIC_API_KEY = 'sk-ant-test';
    fetchQueue.push(jsonResponse(401, { error: { message: 'invalid api key' } }));
    const out = await fetchAnthropicModels();
    expect(out.fetched).toBe(false);
    expect(out.error).toBe('HTTP 401');
    expect(out.items).toEqual([]);
  });

  it('reports network errors with the error message', async () => {
    fakeEnv.ANTHROPIC_API_KEY = 'sk-ant-test';
    fetchQueue.push({ throws: new TypeError('fetch failed: ENOTFOUND') });
    const out = await fetchAnthropicModels();
    expect(out.fetched).toBe(false);
    expect(out.error).toContain('fetch failed');
  });
});

describe('fetchOpenAIModels', () => {
  it('skips silently when OPENAI_API_KEY is unset', async () => {
    const out = await fetchOpenAIModels();
    expect(out.fetched).toBe(false);
    expect(out.error).toContain('OPENAI_API_KEY unset');
    expect(out.items).toEqual([]);
  });

  it('filters out embeddings/images/legacy models and keeps coding models', async () => {
    fakeEnv.OPENAI_API_KEY = 'sk-test';
    fetchQueue.push(
      jsonResponse(200, {
        data: [
          { id: 'gpt-5-codex', owned_by: 'openai', created: 1735689600 },
          { id: 'gpt-5', owned_by: 'openai', created: 1735689600 },
          { id: 'gpt-4o', owned_by: 'openai' },
          { id: 'o1-preview', owned_by: 'openai' },
          { id: 'text-embedding-3-large', owned_by: 'openai' }, // filtered
          { id: 'dall-e-3', owned_by: 'openai' }, // filtered
          { id: 'whisper-1', owned_by: 'openai' }, // filtered
          { id: 'tts-1-hd', owned_by: 'openai' }, // filtered
          { id: 'text-davinci-003' }, // filtered
        ],
      }),
    );
    const out = await fetchOpenAIModels();
    expect(out.fetched).toBe(true);
    expect(out.items.map((m) => m.id)).toEqual([
      'gpt-5-codex',
      'gpt-5',
      'gpt-4o',
      'o1-preview',
    ]);
    expect(out.items[0]?.displayName).toBe('openai');
    expect(out.items[0]?.createdAt).toBe('2025-01-01T00:00:00.000Z');
    expect(fetchCalls[0]?.headers['authorization']).toBe('Bearer sk-test');
  });

  it('reports HTTP error', async () => {
    fakeEnv.OPENAI_API_KEY = 'sk-test';
    fetchQueue.push(jsonResponse(429, { error: { message: 'rate limited' } }));
    const out = await fetchOpenAIModels();
    expect(out.fetched).toBe(false);
    expect(out.error).toBe('HTTP 429');
  });
});
