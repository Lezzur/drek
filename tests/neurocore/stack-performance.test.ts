import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  WORKSPACE_ROOT: '/tmp/drek-test',
};
vi.mock('../../src/env.js', () => ({
  getEnv: () => fakeEnv,
  loadEnv: () => fakeEnv,
}));

const mockStackPerformance = {
  get: vi.fn(),
  list: vi.fn(),
  invalidate: vi.fn(),
};
vi.mock('../../src/neurocore/_shared.js', () => ({
  getSharedClient: vi.fn(async () => ({ stackPerformance: mockStackPerformance })),
  _resetSharedClientForTests: vi.fn(),
}));

import {
  StackPerformanceClientImpl,
  StackPerformanceUnavailableError,
  derivePerfId,
  _resetStackPerformanceClientForTests,
} from '../../src/neurocore/stack-performance.js';

const sampleEntry = {
  id: 'perf_vapi',
  techStackProfileId: 'tech_vapi',
  videoCount: 12,
  avgViews: 4500,
  avgWatchTimeSeconds: 280,
  avgCtr: 0.07,
  totalRevenueUsd: null,
  lastVideoPublishedAt: '2026-05-15T00:00:00.000Z',
  lastComputedAt: '2026-05-29T00:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  _resetStackPerformanceClientForTests();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('derivePerfId', () => {
  it('strips tech_ prefix and prepends perf_', () => {
    expect(derivePerfId('tech_vapi')).toBe('perf_vapi');
    expect(derivePerfId('vapi')).toBe('perf_vapi');
  });
});

describe('StackPerformanceClient.list', () => {
  it('delegates to shared client', async () => {
    mockStackPerformance.list.mockResolvedValueOnce([sampleEntry]);
    const client = new StackPerformanceClientImpl();
    const entries = await client.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.techStackProfileId).toBe('tech_vapi');
  });

  it('rejects a sparse entry', async () => {
    const broken = { ...sampleEntry };
    delete (broken as Record<string, unknown>).videoCount;
    mockStackPerformance.list.mockResolvedValueOnce([broken]);
    const client = new StackPerformanceClientImpl();
    await expect(client.list()).rejects.toBeInstanceOf(StackPerformanceUnavailableError);
  });

  it('translates shared client errors to Unavailable', async () => {
    mockStackPerformance.list.mockRejectedValueOnce(
      Object.assign(new Error('server boom'), { code: 'INTERNAL', status: 500 }),
    );
    const client = new StackPerformanceClientImpl();
    await expect(client.list()).rejects.toBeInstanceOf(StackPerformanceUnavailableError);
  });
});

describe('StackPerformanceClient.get', () => {
  it('returns the entry on success', async () => {
    mockStackPerformance.get.mockResolvedValueOnce(sampleEntry);
    const client = new StackPerformanceClientImpl();
    const entry = await client.get('tech_vapi');
    expect(entry?.techStackProfileId).toBe('tech_vapi');
  });

  it('returns null when shared client returns null (404)', async () => {
    mockStackPerformance.get.mockResolvedValueOnce(null);
    const client = new StackPerformanceClientImpl();
    const entry = await client.get('tech_missing');
    expect(entry).toBeNull();
  });

  it('throws Unavailable for empty techStackProfileId', async () => {
    const client = new StackPerformanceClientImpl();
    await expect(client.get('')).rejects.toBeInstanceOf(StackPerformanceUnavailableError);
  });

  it('throws Unavailable when server returns a different techStackProfileId', async () => {
    mockStackPerformance.get.mockResolvedValueOnce({ ...sampleEntry, techStackProfileId: 'WRONG' });
    const client = new StackPerformanceClientImpl();
    await expect(client.get('tech_vapi')).rejects.toBeInstanceOf(StackPerformanceUnavailableError);
  });

  it('translates other shared client errors to Unavailable', async () => {
    mockStackPerformance.get.mockRejectedValueOnce(
      Object.assign(new Error('timeout'), { code: 'TIMEOUT' }),
    );
    const client = new StackPerformanceClientImpl();
    await expect(client.get('tech_vapi')).rejects.toBeInstanceOf(StackPerformanceUnavailableError);
  });
});
