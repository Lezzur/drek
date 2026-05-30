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

// Mock the shared client singleton — the facade delegates to it for
// every method except getModelConfig.
const mockSharedClient = {
  composeContext: vi.fn(),
  pollPendingListings: vi.fn(),
  ackPendingListing: vi.fn(),
  emitSignal: vi.fn(),
  writeEntity: vi.fn(),
  contentCatalog: { list: vi.fn(), get: vi.fn(), invalidate: vi.fn() },
};
vi.mock('../../src/neurocore/_shared.js', () => ({
  getSharedClient: vi.fn(async () => mockSharedClient),
  _resetSharedClientForTests: vi.fn(),
}));

import { NeurocoreClient, _resetNeurocoreClientForTests } from '../../src/neurocore/client.js';
import { NeurocoreError } from '../../src/neurocore/errors.js';

beforeEach(() => {
  vi.clearAllMocks();
  _resetNeurocoreClientForTests();
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('NeurocoreClient — read methods', () => {
  it('getProjectContext uses videoPlanCoverLetter taskType for cover_letter', async () => {
    mockSharedClient.composeContext.mockResolvedValueOnce({ systemBlock: 'x', metadata: {} });
    const client = new NeurocoreClient();
    await client.getProjectContext({ planMode: 'cover_letter', contactId: 'c1' });
    expect(mockSharedClient.composeContext).toHaveBeenCalledWith(
      expect.objectContaining({
        taskType: 'videoPlanCoverLetter',
        scope: expect.objectContaining({ userId: 'rick', appId: 'drek', contactId: 'c1' }),
      }),
    );
  });

  it('getProjectContext uses videoPlanYoutube for youtube mode', async () => {
    mockSharedClient.composeContext.mockResolvedValueOnce({ systemBlock: 'x', metadata: {} });
    const client = new NeurocoreClient();
    await client.getProjectContext({ planMode: 'youtube' });
    expect(mockSharedClient.composeContext).toHaveBeenCalledWith(
      expect.objectContaining({ taskType: 'videoPlanYoutube' }),
    );
  });

  it('getVoiceProfile uses scriptCoverLetter for cover_letter', async () => {
    mockSharedClient.composeContext.mockResolvedValueOnce({ systemBlock: 'x', metadata: {} });
    const client = new NeurocoreClient();
    await client.getVoiceProfile({ planMode: 'cover_letter' });
    expect(mockSharedClient.composeContext).toHaveBeenCalledWith(
      expect.objectContaining({ taskType: 'scriptCoverLetter' }),
    );
  });

  it('pollPendingSignals returns the listings array', async () => {
    mockSharedClient.pollPendingListings.mockResolvedValueOnce([
      { id: 'L1', memoryId: 'L1', requiresVideo: true },
    ]);
    const client = new NeurocoreClient();
    const listings = await client.pollPendingSignals();
    expect(listings).toHaveLength(1);
  });

  it('ackSignal delegates to shared client', async () => {
    mockSharedClient.ackPendingListing.mockResolvedValueOnce(undefined);
    const client = new NeurocoreClient();
    await client.ackSignal('m1');
    expect(mockSharedClient.ackPendingListing).toHaveBeenCalledWith('m1');
  });

  it('ackSignal throws BAD_REQUEST on empty memoryId', async () => {
    const client = new NeurocoreClient();
    await expect(client.ackSignal('')).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

describe('NeurocoreClient — signal emit methods', () => {
  it('sendApprovedScript emits script.approved with deterministic key', async () => {
    mockSharedClient.emitSignal.mockResolvedValueOnce({ signalId: 's1', duplicate: false, queued: true });
    const client = new NeurocoreClient();
    await client.sendApprovedScript({ planId: 'p1' });
    expect(mockSharedClient.emitSignal).toHaveBeenCalledWith({
      type: 'script.approved',
      payload: { planId: 'p1' },
      idempotencyKey: 'drek-script-approved-p1',
    });
  });

  it('sendBuildPlanEdited keys on briefId+editedAt', async () => {
    mockSharedClient.emitSignal.mockResolvedValueOnce({ signalId: 's', duplicate: false, queued: true });
    const client = new NeurocoreClient();
    await client.sendBuildPlanEdited({
      spoke: 'drek',
      briefId: 'b1',
      fieldsChanged: ['title'],
      editedAt: '2026-05-30T00:00:00.000Z',
    });
    expect(mockSharedClient.emitSignal).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'build_plan.edited',
        idempotencyKey: 'drek-build-plan-edited-b1-2026-05-30T00:00:00.000Z',
      }),
    );
  });

  it('sendScoreOverridden uses score.overridden signal type', async () => {
    mockSharedClient.emitSignal.mockResolvedValueOnce({ signalId: 's', duplicate: false, queued: true });
    const client = new NeurocoreClient();
    await client.sendScoreOverridden({
      spoke: 'drek',
      briefId: 'b1',
      before: { scope_honesty: 3 },
      after: { scope_honesty: 4 },
      overriddenAt: '2026-05-30T00:00:00.000Z',
    });
    expect(mockSharedClient.emitSignal).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'score.overridden' }),
    );
  });

  it('sendUserEdited uses plan.user_edited signal type', async () => {
    mockSharedClient.emitSignal.mockResolvedValueOnce({ signalId: 's', duplicate: false, queued: true });
    const client = new NeurocoreClient();
    await client.sendUserEdited({
      spoke: 'drek',
      briefId: 'b1',
      fieldPath: 'title',
      editedAt: '2026-05-30T00:00:00.000Z',
    });
    expect(mockSharedClient.emitSignal).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'plan.user_edited' }),
    );
  });

  it('sendReferenceHallucination strips briefId from wire payload', async () => {
    mockSharedClient.emitSignal.mockResolvedValueOnce({ signalId: 's', duplicate: false, queued: true });
    const client = new NeurocoreClient();
    await client.sendReferenceHallucination({
      spoke: 'drek',
      operation: 'critique',
      hallucinatedId: 'h1',
      expectedSetSize: 4,
      briefId: 'b1',
    });
    const call = mockSharedClient.emitSignal.mock.calls[0]?.[0];
    expect(call?.type).toBe('llm.reference_hallucination_emitted');
    expect(call?.payload).not.toHaveProperty('briefId');
    expect(call?.idempotencyKey).toContain('drek-hallucination-b1-critique-h1-');
  });

  it('sendReferenceHallucination uses "unscoped" when briefId omitted', async () => {
    mockSharedClient.emitSignal.mockResolvedValueOnce({ signalId: 's', duplicate: false, queued: true });
    const client = new NeurocoreClient();
    await client.sendReferenceHallucination({
      spoke: 'drek',
      operation: 'critique',
      hallucinatedId: 'h1',
      expectedSetSize: 4,
    });
    const call = mockSharedClient.emitSignal.mock.calls[0]?.[0];
    expect(call?.idempotencyKey).toContain('drek-hallucination-unscoped-critique-h1-');
  });

  it('translates shared client errors to DREK NeurocoreError', async () => {
    mockSharedClient.emitSignal.mockRejectedValueOnce(
      Object.assign(new Error('boom'), { code: 'INTERNAL', status: 500 }),
    );
    const client = new NeurocoreClient();
    await expect(client.sendApprovedScript({ planId: 'p1' })).rejects.toBeInstanceOf(NeurocoreError);
  });
});

describe('NeurocoreClient — entity writes', () => {
  it('createContentCatalog delegates to writeEntity direct', async () => {
    mockSharedClient.writeEntity.mockResolvedValueOnce(undefined);
    const client = new NeurocoreClient();
    const payload = {
      deliverableId: 'd1',
      sourceApp: 'drek',
      title: 't',
      youtubeUrl: 'https://www.youtube.com/watch?v=x',
      publishedAt: '2026-05-30T00:00:00.000Z',
    };
    await client.createContentCatalog(payload as never);
    expect(mockSharedClient.writeEntity).toHaveBeenCalledWith(
      'contentCatalog',
      'create',
      expect.objectContaining({ deliverableId: 'd1' }),
    );
  });

  it('listContentCatalog defaults sourceApp filter to drek', async () => {
    mockSharedClient.contentCatalog.list.mockResolvedValueOnce([{ id: 'c1' }]);
    const client = new NeurocoreClient();
    await client.listContentCatalog();
    expect(mockSharedClient.contentCatalog.list).toHaveBeenCalledWith(
      expect.objectContaining({ sourceApp: 'drek' }),
    );
  });

  it('listContentCatalog passes through filters', async () => {
    mockSharedClient.contentCatalog.list.mockResolvedValueOnce([]);
    const client = new NeurocoreClient();
    await client.listContentCatalog({ primaryTechStackId: 'tech_vapi', limit: 25 });
    expect(mockSharedClient.contentCatalog.list).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceApp: 'drek',
        primaryTechStackId: 'tech_vapi',
        limit: 25,
      }),
    );
  });

  it('createStackPerformance delegates to writeEntity direct', async () => {
    mockSharedClient.writeEntity.mockResolvedValueOnce(undefined);
    const client = new NeurocoreClient();
    await client.createStackPerformance({
      id: 'perf_vapi',
      techStackProfileId: 'tech_vapi',
      videoCount: 5,
      avgViews: 1000,
      avgWatchTimeSeconds: 120,
      avgCtr: 0.05,
      totalRevenueUsd: null,
      lastVideoPublishedAt: null,
    });
    expect(mockSharedClient.writeEntity).toHaveBeenCalledWith(
      'stackPerformance',
      'create',
      expect.objectContaining({ id: 'perf_vapi' }),
    );
  });
});

describe('NeurocoreClient — configuration', () => {
  it('constructor accepts overrides without throwing', () => {
    expect(() => new NeurocoreClient({ baseUrl: 'http://x', token: 'tok' })).not.toThrow();
  });

  it('strips trailing slash from baseUrl', () => {
    const client = new NeurocoreClient({ baseUrl: 'http://x/', token: 'tok' });
    expect((client as unknown as { baseUrl: string }).baseUrl).toBe('http://x');
  });
});
