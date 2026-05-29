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

const mockTechStackProfiles = {
  get: vi.fn(),
  list: vi.fn(),
  invalidate: vi.fn(),
};
vi.mock('../../src/neurocore/_shared.js', () => ({
  getSharedClient: vi.fn(async () => ({ techStackProfiles: mockTechStackProfiles })),
  _resetSharedClientForTests: vi.fn(),
}));

import {
  TechStackProfileClientImpl,
  TechStackProfileNotFoundError,
  TechStackProfileUnavailableError,
  _resetTechStackProfileClientForTests,
} from '../../src/neurocore/tech-stacks.js';

const sampleStack = {
  id: 'tech_vapi',
  name: 'Vapi',
  category: 'voice_bot',
  ecosystem: ['twilio'],
  popularityTier: 'mainstream',
  filmableNotes: 'good for voice demos',
  exampleUseCases: ['receptionist'],
  status: 'active',
  createdAt: '2026-05-01T00:00:00.000Z',
  updatedAt: '2026-05-18T14:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  _resetTechStackProfileClientForTests();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('TechStackProfileClient.list', () => {
  it('defaults to status=active filter', async () => {
    mockTechStackProfiles.list.mockResolvedValueOnce([sampleStack]);
    const client = new TechStackProfileClientImpl();
    await client.list();
    expect(mockTechStackProfiles.list).toHaveBeenCalledWith({ status: 'active' });
  });

  it('passes status=all unfiltered when caller asks for "all"', async () => {
    mockTechStackProfiles.list.mockResolvedValueOnce([sampleStack]);
    const client = new TechStackProfileClientImpl();
    await client.list({ status: 'all' });
    expect(mockTechStackProfiles.list).toHaveBeenCalledWith();
  });

  it('passes explicit status filter through', async () => {
    mockTechStackProfiles.list.mockResolvedValueOnce([sampleStack]);
    const client = new TechStackProfileClientImpl();
    await client.list({ status: 'deprecated' });
    expect(mockTechStackProfiles.list).toHaveBeenCalledWith({ status: 'deprecated' });
  });

  it('validates each returned stack', async () => {
    mockTechStackProfiles.list.mockResolvedValueOnce([sampleStack]);
    const client = new TechStackProfileClientImpl();
    const stacks = await client.list();
    expect(stacks[0]?.id).toBe('tech_vapi');
  });

  it('rejects a sparse stack (missing required field)', async () => {
    const broken = { ...sampleStack };
    delete (broken as Record<string, unknown>).category;
    mockTechStackProfiles.list.mockResolvedValueOnce([broken]);
    const client = new TechStackProfileClientImpl();
    await expect(client.list()).rejects.toBeInstanceOf(TechStackProfileUnavailableError);
  });
});

describe('TechStackProfileClient.get', () => {
  it('returns the stack on success', async () => {
    mockTechStackProfiles.get.mockResolvedValueOnce(sampleStack);
    const client = new TechStackProfileClientImpl();
    const stack = await client.get('tech_vapi');
    expect(stack.id).toBe('tech_vapi');
  });

  it('throws NotFound when shared client returns null', async () => {
    mockTechStackProfiles.get.mockResolvedValueOnce(null);
    const client = new TechStackProfileClientImpl();
    await expect(client.get('tech_missing')).rejects.toBeInstanceOf(
      TechStackProfileNotFoundError,
    );
  });

  it('throws Unavailable for empty id', async () => {
    const client = new TechStackProfileClientImpl();
    await expect(client.get('')).rejects.toBeInstanceOf(TechStackProfileUnavailableError);
  });

  it('maps shared client NOT_FOUND error to NotFound', async () => {
    mockTechStackProfiles.get.mockRejectedValueOnce(
      Object.assign(new Error('no'), { code: 'NOT_FOUND', status: 404 }),
    );
    const client = new TechStackProfileClientImpl();
    await expect(client.get('tech_missing')).rejects.toBeInstanceOf(
      TechStackProfileNotFoundError,
    );
  });

  it('maps other shared client errors to Unavailable', async () => {
    mockTechStackProfiles.get.mockRejectedValueOnce(
      Object.assign(new Error('timeout'), { code: 'TIMEOUT' }),
    );
    const client = new TechStackProfileClientImpl();
    await expect(client.get('tech_vapi')).rejects.toBeInstanceOf(
      TechStackProfileUnavailableError,
    );
  });
});
