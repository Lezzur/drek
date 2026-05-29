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

// Mock the shared-client singleton so we control entity-read responses
// without spinning up the real @lezzur/neurocore-client transport.
const mockAudienceProfiles = {
  get: vi.fn(),
  list: vi.fn(),
  invalidate: vi.fn(),
};
const mockSharedClient = { audienceProfiles: mockAudienceProfiles };
vi.mock('../../src/neurocore/_shared.js', () => ({
  getSharedClient: vi.fn(async () => mockSharedClient),
  _resetSharedClientForTests: vi.fn(),
}));

import {
  AudienceProfileClientImpl,
  AudienceProfileNotFoundError,
  AudienceProfileUnavailableError,
  _resetAudienceProfileClientForTests,
} from '../../src/neurocore/audience-profiles.js';

const sampleProfile = {
  id: 'developer_longform',
  name: 'Developer Long-form',
  description: 'engineers watching tutorials',
  watchPersona: 'Engineers',
  painPoints: ['marketing-heavy AI content'],
  buyingTriggers: ['seeing real code'],
  voiceGuidelines: {
    tone: 'authoritative-warm',
    vocabulary: 'technical but accessible',
    sentenceLengthGuide: 'mixed',
    taboos: ["'guys'"],
  },
  hookPatterns: ['open with a code snippet'],
  pacingRules: { wordsPerMinute: 150, avgSentenceWords: 18, densityNote: '' },
  ctaStyle: { type: 'subscribe_and_long_form', phrasing: '', placement: '' },
  createdAt: '2026-05-01T00:00:00.000Z',
  updatedAt: '2026-05-18T14:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  _resetAudienceProfileClientForTests();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('AudienceProfileClient.list — facade behavior', () => {
  it('delegates to shared client and validates each profile', async () => {
    mockAudienceProfiles.list.mockResolvedValueOnce([sampleProfile]);
    const client = new AudienceProfileClientImpl();
    const profiles = await client.list();
    expect(profiles).toHaveLength(1);
    expect(profiles[0]?.id).toBe('developer_longform');
    expect(mockAudienceProfiles.list).toHaveBeenCalledTimes(1);
  });

  it('rejects a sparse profile (missing required field) with Unavailable', async () => {
    const broken = { ...sampleProfile };
    delete (broken as Record<string, unknown>).name;
    mockAudienceProfiles.list.mockResolvedValueOnce([broken]);
    const client = new AudienceProfileClientImpl();
    await expect(client.list()).rejects.toBeInstanceOf(AudienceProfileUnavailableError);
  });

  it('rejects empty painPoints array', async () => {
    mockAudienceProfiles.list.mockResolvedValueOnce([{ ...sampleProfile, painPoints: [] }]);
    const client = new AudienceProfileClientImpl();
    await expect(client.list()).rejects.toBeInstanceOf(AudienceProfileUnavailableError);
  });

  it('translates shared client errors to Unavailable', async () => {
    mockAudienceProfiles.list.mockRejectedValueOnce(
      Object.assign(new Error('server boom'), { code: 'INTERNAL', status: 500 }),
    );
    const client = new AudienceProfileClientImpl();
    await expect(client.list()).rejects.toBeInstanceOf(AudienceProfileUnavailableError);
  });
});

describe('AudienceProfileClient.get — facade behavior', () => {
  it('returns the profile on a successful fetch', async () => {
    mockAudienceProfiles.get.mockResolvedValueOnce(sampleProfile);
    const client = new AudienceProfileClientImpl();
    const profile = await client.get('developer_longform');
    expect(profile.id).toBe('developer_longform');
    expect(mockAudienceProfiles.get).toHaveBeenCalledWith('developer_longform');
  });

  it('throws AudienceProfileNotFoundError when shared client returns null (404)', async () => {
    mockAudienceProfiles.get.mockResolvedValueOnce(null);
    const client = new AudienceProfileClientImpl();
    await expect(client.get('missing')).rejects.toBeInstanceOf(AudienceProfileNotFoundError);
  });

  it('throws Unavailable when server returns a different id (SERVER_ID_MISMATCH)', async () => {
    mockAudienceProfiles.get.mockResolvedValueOnce({ ...sampleProfile, id: 'WRONG' });
    const client = new AudienceProfileClientImpl();
    await expect(client.get('developer_longform')).rejects.toBeInstanceOf(
      AudienceProfileUnavailableError,
    );
  });

  it('throws Unavailable for empty id', async () => {
    const client = new AudienceProfileClientImpl();
    await expect(client.get('')).rejects.toBeInstanceOf(AudienceProfileUnavailableError);
  });

  it('maps shared client NOT_FOUND error to NotFound', async () => {
    mockAudienceProfiles.get.mockRejectedValueOnce(
      Object.assign(new Error('no'), { code: 'NOT_FOUND', status: 404 }),
    );
    const client = new AudienceProfileClientImpl();
    await expect(client.get('missing')).rejects.toBeInstanceOf(AudienceProfileNotFoundError);
  });

  it('maps other shared client errors to Unavailable', async () => {
    mockAudienceProfiles.get.mockRejectedValueOnce(
      Object.assign(new Error('timeout'), { code: 'TIMEOUT', status: undefined }),
    );
    const client = new AudienceProfileClientImpl();
    await expect(client.get('any')).rejects.toBeInstanceOf(AudienceProfileUnavailableError);
  });
});
