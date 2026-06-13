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
  NEUROCORE_TIMEOUT_MS: 50,
  WORKSPACE_ROOT: '/tmp/drek-test',
};
vi.mock('../../src/env.js', () => ({
  getEnv: () => fakeEnv,
  loadEnv: () => fakeEnv,
}));

// In-memory plan store. getPlan/patchPlan/listPlans operate on it; the
// queue's behavior is observable through pipelineState transitions.
const store = new Map<string, Record<string, unknown>>();

function seedPlan(id: string, overrides: Record<string, unknown> = {}) {
  store.set(id, {
    id,
    type: 'cover_letter',
    status: 'awaiting_review',
    title: `Plan ${id}`,
    sourceListingId: null,
    sourceListingText: 'listing',
    requirements: [],
    matchedProjects: [],
    targetRuntimeSeconds: 120,
    estimatedRuntimeSeconds: 0,
    userConstraints: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    exportedAt: null,
    formatProfileId: null,
    pipelineBriefId: null,
    workspacePath: null,
    selectedHookVariantId: null,
    selectedTitleVariantId: null,
    selectedThumbnailConceptId: null,
    pipelineState: 'idle',
    pipelineError: null,
    ...overrides,
  });
}

vi.mock('../../src/db/plans.js', () => ({
  getPlan: vi.fn(async (id: string) => store.get(id) ?? null),
  patchPlan: vi.fn(async (id: string, patch: Record<string, unknown>) => {
    const existing = store.get(id);
    if (!existing) return null;
    const updated = { ...existing, ...patch, updatedAt: new Date() };
    store.set(id, updated);
    return updated;
  }),
  listPlans: vi.fn(async () => ({ plans: [...store.values()], nextCursor: null })),
}));

const runPipelineMock = vi.fn();
vi.mock('../../src/engine/pipeline.js', () => ({
  runPipeline: (...args: unknown[]) => runPipelineMock(...args),
}));

const readPollingConfigMock = vi.fn();
vi.mock('../../src/db/config.js', () => ({
  readPollingConfig: (...args: unknown[]) => readPollingConfigMock(...args),
}));

import {
  enqueuePipeline,
  recoverAndBackfill,
  isAutoRunEligible,
  _resetAutoPipelineForTests,
  _awaitDrainForTests,
} from '../../src/engine/auto-pipeline.js';
import { _resetPlanLocksForTests } from '../../src/lib/plan-locks.js';
import type { Plan, PollingConfig } from '../../src/db/schemas.js';

const okResult = {
  requirementsResult: { requirements: [{}] },
  matchResult: { matchedProjects: [{}], degraded: false },
  scenesResult: null,
  scriptsResult: { scenes: [{}, {}], degraded: false },
};

const cfg: PollingConfig = {
  lastPollAt: null,
  pollingEnabled: true,
  pollingIntervalMs: 1_800_000,
  autoRunPipeline: true,
  autoRunMaxAgeDays: 3,
};

beforeEach(() => {
  store.clear();
  runPipelineMock.mockReset();
  readPollingConfigMock.mockReset();
  readPollingConfigMock.mockResolvedValue(cfg);
  _resetAutoPipelineForTests();
  _resetPlanLocksForTests();
});

describe('enqueuePipeline', () => {
  it('runs the pipeline and lands back on idle', async () => {
    seedPlan('p1');
    runPipelineMock.mockResolvedValueOnce(okResult);
    expect(await enqueuePipeline('p1')).toBe(true);
    await _awaitDrainForTests();
    expect(runPipelineMock).toHaveBeenCalledTimes(1);
    expect(store.get('p1')!.pipelineState).toBe('idle');
    expect(store.get('p1')!.pipelineError).toBeNull();
  });

  it('marks the plan failed with the error message on pipeline failure', async () => {
    seedPlan('p1');
    runPipelineMock.mockRejectedValueOnce(new Error('claude CLI failed: timeout'));
    await enqueuePipeline('p1');
    await _awaitDrainForTests();
    expect(store.get('p1')!.pipelineState).toBe('failed');
    expect(store.get('p1')!.pipelineError).toContain('timeout');
  });

  it('dedups a plan that is already queued', async () => {
    seedPlan('p1');
    let release!: () => void;
    runPipelineMock.mockImplementationOnce(
      () => new Promise((r) => { release = () => r(okResult); }),
    );
    await enqueuePipeline('p1');
    expect(await enqueuePipeline('p1')).toBe(false);
    // The drain worker runs concurrently — wait until it has actually
    // invoked the pipeline before releasing it.
    await vi.waitFor(() => expect(runPipelineMock).toHaveBeenCalled());
    release();
    await _awaitDrainForTests();
    expect(runPipelineMock).toHaveBeenCalledTimes(1);
  });

  it('refuses plans in non-runnable statuses', async () => {
    seedPlan('p1', { status: 'dismissed' });
    expect(await enqueuePipeline('p1')).toBe(false);
    expect(runPipelineMock).not.toHaveBeenCalled();
  });

  it('runs plans serially in arrival order', async () => {
    seedPlan('p1');
    seedPlan('p2');
    const order: string[] = [];
    runPipelineMock.mockImplementation(async (id: string) => {
      order.push(id);
      return okResult;
    });
    await enqueuePipeline('p1');
    await enqueuePipeline('p2');
    await _awaitDrainForTests();
    expect(order).toEqual(['p1', 'p2']);
  });

  it('skips (and resets) a plan dismissed while it sat in the queue', async () => {
    seedPlan('p1');
    seedPlan('p2');
    let release!: () => void;
    runPipelineMock.mockImplementationOnce(
      () => new Promise((r) => { release = () => r(okResult); }),
    );
    await enqueuePipeline('p1');
    await enqueuePipeline('p2');
    // p2 gets dismissed while p1 is still running.
    store.set('p2', { ...store.get('p2')!, status: 'dismissed' });
    await vi.waitFor(() => expect(runPipelineMock).toHaveBeenCalled());
    release();
    await _awaitDrainForTests();
    expect(runPipelineMock).toHaveBeenCalledTimes(1);
    expect(store.get('p2')!.pipelineState).toBe('idle');
  });
});

describe('isAutoRunEligible', () => {
  const asPlan = (id: string) => store.get(id) as unknown as Plan;

  it('accepts a fresh idle awaiting_review cover letter', () => {
    seedPlan('p1');
    expect(isAutoRunEligible(asPlan('p1'), cfg)).toBe(true);
  });

  it('rejects plans older than the fresh window', () => {
    seedPlan('p1', { createdAt: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000) });
    expect(isAutoRunEligible(asPlan('p1'), cfg)).toBe(false);
  });

  it('rejects non-cover-letter and advanced-state plans', () => {
    seedPlan('p1', { type: 'youtube_lite' });
    seedPlan('p2', { status: 'scenes_generated' });
    expect(isAutoRunEligible(asPlan('p1'), cfg)).toBe(false);
    expect(isAutoRunEligible(asPlan('p2'), cfg)).toBe(false);
  });
});

describe('recoverAndBackfill', () => {
  it('re-enqueues plans a crash left queued/running', async () => {
    seedPlan('p1', { pipelineState: 'running' });
    seedPlan('p2', { pipelineState: 'queued' });
    runPipelineMock.mockResolvedValue(okResult);
    const result = await recoverAndBackfill();
    await _awaitDrainForTests();
    expect(result.recovered).toBe(2);
    expect(runPipelineMock).toHaveBeenCalledTimes(2);
  });

  it('backfills fresh awaiting_review plans, newest first, skipping stale', async () => {
    seedPlan('fresh1', { createdAt: new Date(Date.now() - 60_000) });
    seedPlan('fresh2', { createdAt: new Date() });
    seedPlan('stale', { createdAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000) });
    const order: string[] = [];
    runPipelineMock.mockImplementation(async (id: string) => {
      order.push(id);
      return okResult;
    });
    const result = await recoverAndBackfill();
    await _awaitDrainForTests();
    expect(result.backfilled).toBe(2);
    expect(order).toEqual(['fresh2', 'fresh1']);
  });

  it('backfills nothing when autoRunPipeline is off', async () => {
    readPollingConfigMock.mockResolvedValue({ ...cfg, autoRunPipeline: false });
    seedPlan('fresh1');
    const result = await recoverAndBackfill();
    await _awaitDrainForTests();
    expect(result.backfilled).toBe(0);
    expect(runPipelineMock).not.toHaveBeenCalled();
  });
});
