/**
 * Route tests for GET /plans/:id/workshop/hooks
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---- Mock DB so routes don't call real Firestore --------------------------

const mockGetPlan = vi.fn();
const mockListHookDraftsForPlan = vi.fn();

vi.mock('../../src/db/plans.js', () => ({
  getPlan: (...args: unknown[]) => mockGetPlan(...args),
  patchPlan: vi.fn(),
  createPlan: vi.fn(),
  listPlans: vi.fn(),
  deletePlan: vi.fn(),
}));

vi.mock('../../src/db/hook-drafts.js', () => ({
  listHookDraftsForPlan: (...args: unknown[]) => mockListHookDraftsForPlan(...args),
  createHookDraft: vi.fn(),
  deleteAllHookDraftsForPlan: vi.fn(),
  getSelectedHookDraft: vi.fn(),
  setSelectedHookDraft: vi.fn(),
}));

vi.mock('../../src/db/scenes.js', () => ({
  listScenes: vi.fn().mockResolvedValue([]),
  createScene: vi.fn(),
  patchScene: vi.fn(),
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

// Import AFTER mocks.
import { createApp } from '../../src/server.js';
import type { Plan, HookDraft } from '../../src/db/schemas.js';

function fakePlan(overrides: Partial<Plan> = {}): Plan {
  return {
    id: 'plan_abc',
    type: 'youtube_advanced',
    status: 'hooks_generated',
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
    ...overrides,
  };
}

function fakeHook(overrides: Partial<HookDraft> = {}): HookDraft {
  return {
    id: 'hook_1',
    archetype: 'pattern_interrupt',
    scriptText: 'This is a test hook script text with enough words to be valid for testing purposes here.',
    predictedRetention: 'Viewers will stay because of the opening demo curiosity.',
    selected: false,
    createdAt: new Date('2026-05-18T10:01:00Z'),
    ...overrides,
  };
}

beforeEach(() => {
  mockGetPlan.mockReset();
  mockListHookDraftsForPlan.mockReset();
  mockListHookDraftsForPlan.mockResolvedValue([]);
});

// ---------------------------------------------------------------------------
// GET /plans/:id/workshop/hooks
// ---------------------------------------------------------------------------

describe('GET /plans/:id/workshop/hooks', () => {
  it('returns 200 with workshop view content', async () => {
    mockGetPlan.mockResolvedValue(fakePlan({ id: 'plan_abc' }));
    mockListHookDraftsForPlan.mockResolvedValue([
      fakeHook({ id: 'hook_1', archetype: 'pattern_interrupt' }),
      fakeHook({ id: 'hook_2', archetype: 'bold_claim', selected: true }),
    ]);

    const app = createApp();
    const res = await app.request('/plans/plan_abc/workshop/hooks');

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Hook');
    expect(html).toContain('Build a RAG chatbot');
    // Hook archetypes should appear.
    expect(html).toContain('Pattern interrupt');
    expect(html).toContain('Bold claim');
  });

  it('returns 404 when plan is not found', async () => {
    mockGetPlan.mockResolvedValue(null);

    const app = createApp();
    const res = await app.request('/plans/plan_missing/workshop/hooks');

    expect(res.status).toBe(404);
  });

  it('renders empty state when no hooks exist', async () => {
    mockGetPlan.mockResolvedValue(fakePlan());
    mockListHookDraftsForPlan.mockResolvedValue([]);

    const app = createApp();
    const res = await app.request('/plans/plan_abc/workshop/hooks');

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Generate hooks first');
  });
});
