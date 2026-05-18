import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockGetPlan = vi.fn();
const mockListScenes = vi.fn();
const mockExtractShorts = vi.fn();
const mockApproveShort = vi.fn();

vi.mock('../../src/db/plans.js', () => ({
  getPlan: (...args: unknown[]) => mockGetPlan(...args),
}));

vi.mock('../../src/db/scenes.js', () => ({
  listScenes: (...args: unknown[]) => mockListScenes(...args),
}));

vi.mock('../../src/engine/extract-shorts.js', async (importOriginal) => {
  // Keep ShortCandidate type + BEAT_WEIGHTS real; mock the engine fns.
  const actual = await importOriginal<typeof import('../../src/engine/extract-shorts.js')>();
  return {
    ...actual,
    extractShortsCandidates: (...args: unknown[]) => mockExtractShorts(...args),
    approveShortCandidate: (...args: unknown[]) => mockApproveShort(...args),
  };
});

vi.mock('../../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() },
}));

import { Hono } from 'hono';
import shorts, { _resetShortsCacheForTests } from '../../src/routes/shorts.js';
import { PlanningEngineError } from '../../src/engine/errors.js';
import type { ShortCandidate } from '../../src/engine/extract-shorts.js';

function createApp(): Hono {
  const app = new Hono();
  app.route('/', shorts);
  return app;
}

function fakePlan() {
  return {
    id: 'plan_1',
    type: 'youtube_advanced',
    status: 'finalized',
    title: 'T',
    sourceListingId: null,
    sourceListingText: null,
    requirements: [],
    matchedProjects: [],
    targetRuntimeSeconds: 1800,
    estimatedRuntimeSeconds: 0,
    userConstraints: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    exportedAt: null,
    formatProfileId: 'claude_code_build_along',
    pipelineBriefId: null,
    workspacePath: null,
    selectedHookVariantId: null,
    selectedTitleVariantId: null,
    selectedThumbnailConceptId: null,
  };
}

function fakeCandidate(id: string): ShortCandidate {
  return {
    id,
    sourceSceneIds: ['scene_demo'],
    cutWindow: { startLine: 1, endLine: 8 },
    reworkedScript: Array.from({ length: 180 }, (_, i) => `word${i}`).join(' '),
    hookText: 'h',
    verticalReframingNotes: 'v',
    suggestedTitleHint: 't',
    suggestedThumbnailHint: 'th',
    beatImportanceScore: 9,
  };
}

beforeEach(() => {
  mockGetPlan.mockReset();
  mockListScenes.mockReset();
  mockExtractShorts.mockReset();
  mockApproveShort.mockReset();
  _resetShortsCacheForTests();
});

describe('GET /plans/:id/shorts', () => {
  it('renders empty state when no cached candidates', async () => {
    mockGetPlan.mockResolvedValue(fakePlan());
    mockListScenes.mockResolvedValue([]);

    const res = await createApp().request('/plans/plan_1/shorts');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Shorts · T');
    expect(html).toContain('No Shorts candidates yet');
  });

  it('404 when plan missing', async () => {
    mockGetPlan.mockResolvedValue(null);
    const res = await createApp().request('/plans/plan_1/shorts');
    expect(res.status).toBe(404);
  });
});

describe('POST /plans/:id/extract-shorts', () => {
  it('caches result + redirects to shorts page', async () => {
    const candidate = fakeCandidate('short_a');
    mockExtractShorts.mockResolvedValue({ candidates: [candidate], retried: false, durationMs: 5 });

    const res = await createApp().request('/plans/plan_1/extract-shorts', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(res.headers.get('HX-Redirect')).toBe('/plans/plan_1/shorts');
    expect(mockExtractShorts).toHaveBeenCalledWith('plan_1');
  });

  it('returns 400 on DISALLOWED_TRANSITION', async () => {
    mockExtractShorts.mockRejectedValue(
      new PlanningEngineError('extract-shorts', 'DISALLOWED_TRANSITION', 'wrong status'),
    );
    const res = await createApp().request('/plans/plan_1/extract-shorts', { method: 'POST' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('DISALLOWED_TRANSITION');
  });

  it('returns 400 on NO_FORMAT_PROFILE (missing shorts audience)', async () => {
    mockExtractShorts.mockRejectedValue(
      new PlanningEngineError(
        'extract-shorts',
        'NO_FORMAT_PROFILE',
        'business_owner_shorts missing — run M14 Track A seed',
      ),
    );
    const res = await createApp().request('/plans/plan_1/extract-shorts', { method: 'POST' });
    expect(res.status).toBe(400);
  });
});

describe('POST /plans/:id/approve-short', () => {
  it('400 when no cached candidates', async () => {
    const res = await createApp().request('/plans/plan_1/approve-short', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ candidateId: 'short_a' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('NO_CANDIDATES');
  });

  it('400 when candidateId missing', async () => {
    const res = await createApp().request('/plans/plan_1/approve-short', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('approves cached candidate, redirects to publish, evicts cache', async () => {
    // First populate cache.
    const candidate = fakeCandidate('short_a');
    mockExtractShorts.mockResolvedValue({ candidates: [candidate], retried: false, durationMs: 5 });
    await createApp().request('/plans/plan_1/extract-shorts', { method: 'POST' });

    mockApproveShort.mockResolvedValue({ deliverableId: 'del_new' });

    const res = await createApp().request('/plans/plan_1/approve-short', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ candidateId: 'short_a' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('HX-Redirect')).toBe('/deliverables/del_new/publish');
    expect(mockApproveShort).toHaveBeenCalledTimes(1);

    // Second approve should fail — cache was evicted.
    const res2 = await createApp().request('/plans/plan_1/approve-short', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ candidateId: 'short_a' }),
    });
    expect(res2.status).toBe(400);
  });

  it('uses reworkedScriptOverride when provided (Rick edited the textarea)', async () => {
    const candidate = fakeCandidate('short_a');
    mockExtractShorts.mockResolvedValue({ candidates: [candidate], retried: false, durationMs: 5 });
    await createApp().request('/plans/plan_1/extract-shorts', { method: 'POST' });
    mockApproveShort.mockResolvedValue({ deliverableId: 'del_new' });

    const editedScript = 'Rick rewrote this entirely.';
    await createApp().request('/plans/plan_1/approve-short', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `candidateId=short_a&reworkedScriptOverride=${encodeURIComponent(editedScript)}`,
    });

    const callArgs = mockApproveShort.mock.calls[0]!;
    expect(callArgs[1].reworkedScript).toBe(editedScript);
  });

  it('404 when candidate not in cache', async () => {
    const candidate = fakeCandidate('short_a');
    mockExtractShorts.mockResolvedValue({ candidates: [candidate], retried: false, durationMs: 5 });
    await createApp().request('/plans/plan_1/extract-shorts', { method: 'POST' });

    const res = await createApp().request('/plans/plan_1/approve-short', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ candidateId: 'short_does_not_exist' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('POST /plans/:id/dismiss-short', () => {
  it('removes candidate from cache + redirects', async () => {
    const a = fakeCandidate('short_a');
    const b = fakeCandidate('short_b');
    mockExtractShorts.mockResolvedValue({ candidates: [a, b], retried: false, durationMs: 5 });
    await createApp().request('/plans/plan_1/extract-shorts', { method: 'POST' });

    const res = await createApp().request('/plans/plan_1/dismiss-short', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ candidateId: 'short_a' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('HX-Redirect')).toBe('/plans/plan_1/shorts');

    // Approving the dismissed candidate now fails.
    mockApproveShort.mockResolvedValue({ deliverableId: 'del_x' });
    const resApprove = await createApp().request('/plans/plan_1/approve-short', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ candidateId: 'short_a' }),
    });
    expect(resApprove.status).toBe(404);

    // But the other candidate still works.
    const resApproveB = await createApp().request('/plans/plan_1/approve-short', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ candidateId: 'short_b' }),
    });
    expect(resApproveB.status).toBe(200);
  });
});
