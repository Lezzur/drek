import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() },
}));

// Stub the underlying provider fetchers and the store so we exercise the
// orchestrator's wiring without hitting the network or Firestore.
const anthropicMock = vi.fn();
const openaiMock = vi.fn();
const writeCatalogMock = vi.fn();
const readCatalogMock = vi.fn();

vi.mock('../../src/models/anthropic.js', () => ({
  fetchAnthropicModels: () => anthropicMock(),
}));
vi.mock('../../src/models/openai.js', () => ({
  fetchOpenAIModels: () => openaiMock(),
}));
vi.mock('../../src/models/store.js', () => ({
  readCatalog: () => readCatalogMock(),
  writeCatalog: (catalog: unknown) => writeCatalogMock(catalog),
}));

import { refreshModelCatalog, getCatalog } from '../../src/models/catalog.js';

beforeEach(() => {
  anthropicMock.mockReset();
  openaiMock.mockReset();
  writeCatalogMock.mockReset();
  readCatalogMock.mockReset();
});

describe('refreshModelCatalog', () => {
  it('fetches both providers in parallel and persists the result', async () => {
    anthropicMock.mockResolvedValue({
      fetched: true,
      error: null,
      items: [{ id: 'claude-opus-4', provider: 'anthropic', displayName: null, createdAt: null }],
      refreshedAt: 'now',
    });
    openaiMock.mockResolvedValue({
      fetched: true,
      error: null,
      items: [{ id: 'gpt-5-codex', provider: 'openai', displayName: null, createdAt: null }],
      refreshedAt: 'now',
    });
    writeCatalogMock.mockResolvedValue(undefined);

    const out = await refreshModelCatalog();

    expect(anthropicMock).toHaveBeenCalledTimes(1);
    expect(openaiMock).toHaveBeenCalledTimes(1);
    expect(writeCatalogMock).toHaveBeenCalledTimes(1);
    expect(out.anthropic.items).toHaveLength(1);
    expect(out.openai.items).toHaveLength(1);
  });

  it('still returns when Firestore write fails — fresh data takes priority', async () => {
    anthropicMock.mockResolvedValue({
      fetched: true, error: null, items: [], refreshedAt: 'now',
    });
    openaiMock.mockResolvedValue({
      fetched: false, error: 'OPENAI_API_KEY unset', items: [], refreshedAt: 'now',
    });
    writeCatalogMock.mockRejectedValue(new Error('firestore down'));

    const out = await refreshModelCatalog();
    expect(out.anthropic.fetched).toBe(true);
    expect(out.openai.fetched).toBe(false);
  });

  it('writes a complete snapshot even when one provider failed', async () => {
    anthropicMock.mockResolvedValue({
      fetched: true,
      error: null,
      items: [{ id: 'claude-opus-4', provider: 'anthropic', displayName: null, createdAt: null }],
      refreshedAt: 'now',
    });
    openaiMock.mockResolvedValue({
      fetched: false, error: 'HTTP 429', items: [], refreshedAt: 'now',
    });
    writeCatalogMock.mockResolvedValue(undefined);

    await refreshModelCatalog();
    const written = writeCatalogMock.mock.calls[0]?.[0] as { anthropic: unknown; openai: unknown };
    expect(written.anthropic).toBeDefined();
    expect(written.openai).toBeDefined();
  });
});

describe('getCatalog', () => {
  it('reads from the store', async () => {
    const fake = { anthropic: { fetched: true, error: null, items: [], refreshedAt: 'now' }, openai: { fetched: false, error: null, items: [], refreshedAt: 'now' } };
    readCatalogMock.mockResolvedValue(fake);
    const out = await getCatalog();
    expect(out).toBe(fake);
  });
});
