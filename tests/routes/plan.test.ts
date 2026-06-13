/**
 * Route tests for POST /plans/:id/generate-hooks and POST /plans/:id/select-hook.
 *
 * Strategy: mock the engine functions so routes don't call Firestore or LLM.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---- Mock engine functions ------------------------------------------------

const mockGenerateHookVariants = vi.fn();
const mockSelectHook = vi.fn();
const mockGenerateShotList = vi.fn();

vi.mock('../../src/engine/generate-hook-variants.js', () => ({
  generateHookVariants: (...args: unknown[]) => mockGenerateHookVariants(...args),
}));

vi.mock('../../src/engine/select-hook.js', () => ({
  selectHook: (...args: unknown[]) => mockSelectHook(...args),
}));

vi.mock('../../src/engine/generate-shot-list.js', () => ({
  generateShotList: (...args: unknown[]) => mockGenerateShotList(...args),
}));

// ---- Mock other dependencies so server instantiates cleanly ---------------

const mockGetPlan = vi.fn();
const mockPatchPlan = vi.fn();
const mockListScenes = vi.fn();

vi.mock('../../src/db/plans.js', () => ({
  getPlan: (...args: unknown[]) => mockGetPlan(...args),
  patchPlan: (...args: unknown[]) => mockPatchPlan(...args),
  createPlan: vi.fn(),
  listPlans: vi.fn(),
  deletePlan: vi.fn(),
}));

vi.mock('../../src/db/scenes.js', () => ({
  listScenes: (...args: unknown[]) => mockListScenes(...args),
  createScene: vi.fn(),
  patchScene: vi.fn(),
}));

vi.mock('../../src/db/hook-drafts.js', () => ({
  listHookDraftsForPlan: vi.fn().mockResolvedValue([]),
  createHookDraft: vi.fn(),
  deleteAllHookDraftsForPlan: vi.fn(),
  getSelectedHookDraft: vi.fn(),
  setSelectedHookDraft: vi.fn(),
}));

vi.mock('../../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() },
}));

vi.mock('../../src/neurocore/audience-profiles.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/neurocore/audience-profiles.js')
  >('../../src/neurocore/audience-profiles.js');
  return {
    ...actual,
    getAudienceProfileClient: () => ({
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue({ id: 'developer_longform', name: 'Dev' }),
    }),
  };
});

// ---- Mock pipeline / engine functions not under test ----------------------

vi.mock('../../src/engine/detect-requirements.js', () => ({
  detectRequirements: vi.fn(),
}));
vi.mock('../../src/engine/match-projects.js', () => ({
  matchProjects: vi.fn(),
}));
vi.mock('../../src/engine/write-scripts.js', () => ({
  generatePlanContent: vi.fn(),
  writeScripts: vi.fn(),
}));
vi.mock('../../src/engine/pipeline.js', () => ({
  runPipeline: vi.fn(),
}));
vi.mock('../../src/engine/change-format.js', () => ({
  changePlanFormatProfile: vi.fn(),
}));
vi.mock('../../src/neurocore/index.js', () => ({
  getNeurocoreClient: vi.fn().mockReturnValue({}),
  NeurocoreError: class NeurocoreError extends Error {},
}));

// Import AFTER mocks.
import { createApp } from '../../src/server.js';
import { PlanningEngineError } from '../../src/engine/errors.js';
import type { Plan, HookDraft } from '../../src/db/schemas.js';

function fakePlan(overrides: Partial<Plan> = {}): Plan {
  return {
    id: 'plan_abc',
    type: 'youtube_advanced',
    status: 'scenes_generated',
    title: 'Build a RAG chatbot',
    sourceListingId: null,
    sourceListingText: null,
    requirements: [],
    matchedProjects: [],
    targetRuntimeSeconds: 1800,
    estimatedRuntimeSeconds: 0,
    userConstraints: null,
    createdAt: new Date('2026-05-18T10:00:00Z'),
    updatedAt: new Date('2026-05-18T10:00:00Z'),
    exportedAt: null,
    formatProfileId: 'claude_code_build_along',
    pipelineBriefId: null,
    workspacePath: null,
    selectedHookVariantId: null,
    selectedTitleVariantId: null,
    selectedThumbnailConceptId: null,
    pipelineState: 'idle' as const,
    pipelineError: null,
    ...overrides,
  };
}

function fakeHookDraft(overrides: Partial<HookDraft> = {}): HookDraft {
  return {
    id: 'hook_1',
    archetype: 'pattern_interrupt',
    scriptText: 'This is the hook script text for the test with enough words for validation.',
    predictedRetention: 'Great retention because of the hook.',
    selected: false,
    createdAt: new Date('2026-05-18T10:01:00Z'),
    ...overrides,
  };
}

beforeEach(() => {
  mockGetPlan.mockReset();
  mockPatchPlan.mockReset();
  mockListScenes.mockResolvedValue([]);
  mockGenerateHookVariants.mockReset();
  mockSelectHook.mockReset();
  mockGenerateShotList.mockReset();
});

// ---------------------------------------------------------------------------
// POST /plans/:id/generate-hooks — happy path
// ---------------------------------------------------------------------------

describe('POST /plans/:id/generate-hooks', () => {
  it('calls generateHookVariants and redirects to workshop on success', async () => {
    mockGetPlan.mockResolvedValue(fakePlan());
    mockGenerateHookVariants.mockResolvedValue([fakeHookDraft()]);

    const app = createApp();
    const res = await app.request('/plans/plan_abc/generate-hooks', {
      method: 'POST',
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('HX-Redirect')).toBe('/plans/plan_abc/workshop/hooks');
    expect(mockGenerateHookVariants).toHaveBeenCalledWith('plan_abc');
  });

  it('returns 404 JSON when PLAN_NOT_FOUND', async () => {
    mockGenerateHookVariants.mockRejectedValue(
      new PlanningEngineError('generate-hook-variants', 'PLAN_NOT_FOUND', 'not found'),
    );

    const app = createApp();
    const res = await app.request('/plans/plan_xyz/generate-hooks', {
      method: 'POST',
    });

    expect(res.status).toBe(404);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('PLAN_NOT_FOUND');
  });

  it('returns 400 JSON when WRONG_PLAN_TYPE', async () => {
    mockGenerateHookVariants.mockRejectedValue(
      new PlanningEngineError('generate-hook-variants', 'WRONG_PLAN_TYPE', 'wrong type'),
    );

    const app = createApp();
    const res = await app.request('/plans/plan_abc/generate-hooks', {
      method: 'POST',
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('WRONG_PLAN_TYPE');
  });
});

// ---------------------------------------------------------------------------
// POST /plans/:id/select-hook — happy path
// ---------------------------------------------------------------------------

describe('POST /plans/:id/select-hook', () => {
  it('calls selectHook and redirects to workshop on success (JSON body)', async () => {
    mockGetPlan.mockResolvedValue(fakePlan({ status: 'hooks_generated' }));
    mockSelectHook.mockResolvedValue(undefined);

    const app = createApp();
    const res = await app.request('/plans/plan_abc/select-hook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hookId: 'hook_1' }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('HX-Redirect')).toBe('/plans/plan_abc/workshop/hooks');
    expect(mockSelectHook).toHaveBeenCalledWith('plan_abc', 'hook_1');
  });

  it('calls selectHook with form-encoded body', async () => {
    mockGetPlan.mockResolvedValue(fakePlan({ status: 'hooks_generated' }));
    mockSelectHook.mockResolvedValue(undefined);

    const app = createApp();
    const res = await app.request('/plans/plan_abc/select-hook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'hookId=hook_2',
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('HX-Redirect')).toBe('/plans/plan_abc/workshop/hooks');
    expect(mockSelectHook).toHaveBeenCalledWith('plan_abc', 'hook_2');
  });

  it('returns 404 JSON when HOOK_NOT_FOUND', async () => {
    mockSelectHook.mockRejectedValue(
      new PlanningEngineError('select-hook', 'HOOK_NOT_FOUND', 'hook not found'),
    );

    const app = createApp();
    const res = await app.request('/plans/plan_abc/select-hook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hookId: 'hook_bad' }),
    });

    expect(res.status).toBe(404);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('HOOK_NOT_FOUND');
  });

  it('returns 400 when hookId is missing from body', async () => {
    const app = createApp();
    const res = await app.request('/plans/plan_abc/select-hook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST /plans/:id/generate-shot-list — happy path + errors
// ---------------------------------------------------------------------------

describe('POST /plans/:id/generate-shot-list', () => {
  it('calls generateShotList and redirects to /plans/:id on success', async () => {
    mockGenerateShotList.mockResolvedValue({ scenes: [], retried: false, durationMs: 10 });

    const app = createApp();
    const res = await app.request('/plans/plan_abc/generate-shot-list', {
      method: 'POST',
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('HX-Redirect')).toBe('/plans/plan_abc');
    expect(mockGenerateShotList).toHaveBeenCalledWith('plan_abc');
  });

  it('returns 404 JSON when PLAN_NOT_FOUND', async () => {
    mockGenerateShotList.mockRejectedValue(
      new PlanningEngineError('generate-shot-list', 'PLAN_NOT_FOUND', 'not found'),
    );

    const app = createApp();
    const res = await app.request('/plans/plan_xyz/generate-shot-list', {
      method: 'POST',
    });

    expect(res.status).toBe(404);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('PLAN_NOT_FOUND');
  });

  it('returns 400 JSON when DISALLOWED_TRANSITION', async () => {
    mockGenerateShotList.mockRejectedValue(
      new PlanningEngineError('generate-shot-list', 'DISALLOWED_TRANSITION', 'wrong status'),
    );

    const app = createApp();
    const res = await app.request('/plans/plan_abc/generate-shot-list', {
      method: 'POST',
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('DISALLOWED_TRANSITION');
  });
});
