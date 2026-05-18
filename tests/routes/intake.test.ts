/**
 * Route tests for GET/POST /intake* handlers.
 *
 * Strategy: mock the intake service + scoring so tests stay fast and don't
 * touch Firestore. The service/scoring modules are unit-tested separately.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---- Mock the service + scoring so routes don't call Firestore -----------

const mockListBriefs = vi.fn();
const mockGetBrief = vi.fn();
const mockCreateBrief = vi.fn();
const mockTransitionBriefStage = vi.fn();
const mockPromoteBriefToPlan = vi.fn();
const mockUpdateBriefScore = vi.fn();

vi.mock('../../src/intake/service.js', () => ({
  listBriefs: (...args: unknown[]) => mockListBriefs(...args),
  getBrief: (...args: unknown[]) => mockGetBrief(...args),
  createBrief: (...args: unknown[]) => mockCreateBrief(...args),
  transitionBriefStage: (...args: unknown[]) => mockTransitionBriefStage(...args),
  promoteBriefToPlan: (...args: unknown[]) => mockPromoteBriefToPlan(...args),
  updateBriefScore: (...args: unknown[]) => mockUpdateBriefScore(...args),
}));

const mockScoreBriefViaLLM = vi.fn();
vi.mock('../../src/intake/scoring.js', () => ({
  scoreBriefViaLLM: (...args: unknown[]) => mockScoreBriefViaLLM(...args),
}));

vi.mock('../../src/neurocore/audience-profiles.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/neurocore/audience-profiles.js')
  >('../../src/neurocore/audience-profiles.js');
  return {
    ...actual,
    getAudienceProfileClient: () => ({
      list: vi.fn().mockResolvedValue([
        { id: 'developer_longform', name: 'Developer / Learner — Long-form' },
      ]),
      get: vi.fn().mockResolvedValue({ id: 'developer_longform', name: 'Dev' }),
    }),
  };
});

vi.mock('../../src/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  },
}));

// Import AFTER the mocks.
import { createApp } from '../../src/server.js';
import { IntakeError } from '../../src/intake/errors.js';
import type { PipelineBrief, BriefScore } from '../../src/db/schemas.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakeBrief(overrides: Partial<PipelineBrief> = {}): PipelineBrief {
  return {
    id: 'brief_abc',
    title: 'Build a RAG dashboard',
    company: 'Acme Corp',
    sourceUrl: null,
    rawText: 'Long body text',
    score: null,
    scoringRationale: null,
    stage: 'candidate',
    promotedPlanId: null,
    createdAt: new Date('2026-05-01T00:00:00Z'),
    updatedAt: new Date('2026-05-01T00:00:00Z'),
    ...overrides,
  };
}

function fakeScore(): BriefScore {
  return {
    visualOutcome: 4,
    storyPotential: 4,
    scopeFit: 3,
    audienceMatch: 5,
    aggregate: 4.0,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /intake', () => {
  beforeEach(() => {
    mockListBriefs.mockResolvedValue([]);
  });

  it('renders the list page with empty state', async () => {
    const app = createApp();
    const res = await app.request('/intake');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Intake pipeline');
    expect(html).toContain('No briefs yet');
  });

  it('passes stage filter to listBriefs', async () => {
    const app = createApp();
    const res = await app.request('/intake?stage=vetted');
    expect(res.status).toBe(200);
    // The first call should be with stage='vetted'
    expect(mockListBriefs).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'vetted' }),
    );
  });

  it('renders brief rows when briefs exist', async () => {
    mockListBriefs.mockResolvedValue([
      fakeBrief({ id: 'brief_1', title: 'Lead routing build' }),
      fakeBrief({ id: 'brief_2', title: 'RAG pipeline' }),
    ]);
    const app = createApp();
    const res = await app.request('/intake');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Lead routing build');
    expect(html).toContain('RAG pipeline');
  });
});

describe('GET /intake/new', () => {
  it('renders the new brief form', async () => {
    const app = createApp();
    const res = await app.request('/intake/new');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Add brief');
    expect(html).toContain('name="title"');
    expect(html).toContain('name="rawText"');
  });
});

describe('POST /intake', () => {
  it('creates a brief and redirects to /intake/:id on success', async () => {
    mockCreateBrief.mockResolvedValue(fakeBrief({ id: 'brief_new' }));
    const app = createApp();
    const form = new FormData();
    form.set('title', 'My brief');
    form.set('rawText', 'Detailed body text here');
    const res = await app.request('/intake', {
      method: 'POST',
      body: form,
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/intake/brief_new');
  });

  it('returns 400 and re-renders form when title is missing', async () => {
    const app = createApp();
    const form = new FormData();
    form.set('title', '');
    form.set('rawText', 'some text');
    const res = await app.request('/intake', {
      method: 'POST',
      body: form,
    });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('Add brief');
    expect(html).toContain('required');
  });

  it('returns 400 and echoes back user input on validation error', async () => {
    const app = createApp();
    const form = new FormData();
    form.set('title', 'My title');
    form.set('rawText', ''); // missing — should fail
    form.set('company', 'Acme');
    const res = await app.request('/intake', {
      method: 'POST',
      body: form,
    });
    expect(res.status).toBe(400);
    const html = await res.text();
    // Title echoed back
    expect(html).toContain('My title');
    // Company echoed back
    expect(html).toContain('Acme');
  });
});

describe('POST /intake/:id/score', () => {
  beforeEach(() => {
    mockGetBrief.mockResolvedValue(fakeBrief());
    mockListBriefs.mockResolvedValue([]);
  });

  it('redirects to detail page with flash on success', async () => {
    mockScoreBriefViaLLM.mockResolvedValue({
      score: fakeScore(),
      rationale: 'good',
      retried: false,
      durationMs: 1000,
    });
    const app = createApp();
    const res = await app.request('/intake/brief_abc/score', {
      method: 'POST',
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/intake/brief_abc');
    expect(res.headers.get('location')).toContain('flash=scored');
  });

  it('returns 404 when brief not found', async () => {
    mockScoreBriefViaLLM.mockRejectedValue(
      new IntakeError('BRIEF_NOT_FOUND', 'not found', { briefId: 'missing' }),
    );
    const app = createApp();
    const res = await app.request('/intake/missing/score', {
      method: 'POST',
    });
    expect(res.status).toBe(404);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('BRIEF_NOT_FOUND');
  });

  it('returns 500 on LLM_FAILED', async () => {
    mockScoreBriefViaLLM.mockRejectedValue(
      new IntakeError('LLM_FAILED', 'timeout', { briefId: 'brief_abc' }),
    );
    const app = createApp();
    const res = await app.request('/intake/brief_abc/score', {
      method: 'POST',
    });
    expect(res.status).toBe(500);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('LLM_FAILED');
  });
});

describe('POST /intake/:id/promote', () => {
  beforeEach(() => {
    mockGetBrief.mockResolvedValue(fakeBrief({ score: fakeScore() }));
    mockListBriefs.mockResolvedValue([]);
  });

  it('redirects to /plans/:planId on success', async () => {
    mockPromoteBriefToPlan.mockResolvedValue({ planId: 'plan_xyz', deliverableId: 'del_1' });
    const app = createApp();
    const form = new FormData();
    form.set('formatProfileId', 'claude_code_build_along');
    form.set('audienceProfileId', 'developer_longform');
    const res = await app.request('/intake/brief_abc/promote', {
      method: 'POST',
      body: form,
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/plans/plan_xyz');
  });

  it('returns 400 with structured error when audience profile unknown', async () => {
    mockPromoteBriefToPlan.mockRejectedValue(
      new IntakeError('UNKNOWN_AUDIENCE_PROFILE', 'unknown audience', {
        briefId: 'brief_abc',
      }),
    );
    const app = createApp();
    const form = new FormData();
    form.set('formatProfileId', 'claude_code_build_along');
    form.set('audienceProfileId', 'not_real');
    const res = await app.request('/intake/brief_abc/promote', {
      method: 'POST',
      body: form,
    });
    // Re-renders the detail page with an error flash (400)
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('unknown audience');
  });
});

describe('POST /intake/:id/stage', () => {
  it('returns 302 redirect on valid transition', async () => {
    mockTransitionBriefStage.mockResolvedValue(fakeBrief({ stage: 'vetted' }));
    const app = createApp();
    const form = new FormData();
    form.set('stage', 'vetted');
    const res = await app.request('/intake/brief_abc/stage', {
      method: 'POST',
      body: form,
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/intake/brief_abc');
  });

  it('returns 400 with structured error on invalid stage value', async () => {
    const app = createApp();
    const form = new FormData();
    form.set('stage', 'not_a_real_stage');
    const res = await app.request('/intake/brief_abc/stage', {
      method: 'POST',
      body: form,
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('INVALID_STAGE');
  });

  it('returns 400 on INVALID_STAGE_TRANSITION from service', async () => {
    mockTransitionBriefStage.mockRejectedValue(
      new IntakeError('INVALID_STAGE_TRANSITION', 'cannot go from candidate to published'),
    );
    const app = createApp();
    const form = new FormData();
    form.set('stage', 'published');
    const res = await app.request('/intake/brief_abc/stage', {
      method: 'POST',
      body: form,
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('INVALID_STAGE_TRANSITION');
  });
});
