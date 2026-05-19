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
const mockCreateBriefBatchWithScoring = vi.fn();
const mockGetBriefBatch = vi.fn();

vi.mock('../../src/intake/service.js', () => ({
  listBriefs: (...args: unknown[]) => mockListBriefs(...args),
  getBrief: (...args: unknown[]) => mockGetBrief(...args),
  createBrief: (...args: unknown[]) => mockCreateBrief(...args),
  transitionBriefStage: (...args: unknown[]) => mockTransitionBriefStage(...args),
  promoteBriefToPlan: (...args: unknown[]) => mockPromoteBriefToPlan(...args),
  updateBriefScore: (...args: unknown[]) => mockUpdateBriefScore(...args),
  createBriefBatchWithScoring: (...args: unknown[]) =>
    mockCreateBriefBatchWithScoring(...args),
  getBriefBatch: (...args: unknown[]) => mockGetBriefBatch(...args),
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
    batchId: null,
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

// ===========================================================================
// Batch intake routes (M25)
// ===========================================================================

describe('GET /intake/batch/new', () => {
  it('renders the multi-row form with 3 default rows', async () => {
    const app = createApp();
    const res = await app.request('/intake/batch/new');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Add briefs (batch)');
    expect(html).toContain('Brief #1');
    expect(html).toContain('Brief #2');
    expect(html).toContain('Brief #3');
    expect(html).toContain('Score all');
    expect(html).toContain('+ Add another brief');
  });

  it('is routed BEFORE /intake/:briefId so the wildcard does not swallow it', async () => {
    // If this route lost order, /intake/batch/new would match /intake/:briefId
    // with briefId="batch" and trigger getBrief.
    mockGetBrief.mockClear();
    const app = createApp();
    const res = await app.request('/intake/batch/new');
    expect(res.status).toBe(200);
    expect(mockGetBrief).not.toHaveBeenCalled();
  });
});

describe('POST /intake/batch', () => {
  beforeEach(() => {
    mockCreateBriefBatchWithScoring.mockReset();
  });

  it('parses indexed form encoding into an ordered briefs array', async () => {
    mockCreateBriefBatchWithScoring.mockResolvedValue({
      batchId: 'batch_abc',
      briefs: [],
    });

    const form = new FormData();
    form.set('briefs[0][title]', 'First');
    form.set('briefs[0][rawText]', 'body1');
    form.set('briefs[1][title]', 'Second');
    form.set('briefs[1][rawText]', 'body2');
    form.set('briefs[1][sourceUrl]', 'https://upwork.com/jobs/123');

    const app = createApp();
    const res = await app.request('/intake/batch', {
      method: 'POST',
      body: form,
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/intake/batch/batch_abc');

    expect(mockCreateBriefBatchWithScoring).toHaveBeenCalledTimes(1);
    const call = mockCreateBriefBatchWithScoring.mock.calls[0]![0]!;
    expect(call.briefs).toHaveLength(2);
    expect(call.briefs[0]).toMatchObject({ title: 'First', rawText: 'body1', sourceUrl: null });
    expect(call.briefs[1]).toMatchObject({
      title: 'Second',
      rawText: 'body2',
      sourceUrl: 'https://upwork.com/jobs/123',
    });
  });

  it('accepts a JSON body with { briefs: [...] }', async () => {
    mockCreateBriefBatchWithScoring.mockResolvedValue({
      batchId: 'batch_json',
      briefs: [],
    });

    const app = createApp();
    const res = await app.request('/intake/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        briefs: [
          { title: 'A', rawText: 'a' },
          { title: 'B', rawText: 'b' },
        ],
      }),
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/intake/batch/batch_json');
  });

  it('400s with validation error when no briefs provided', async () => {
    const app = createApp();
    const res = await app.request('/intake/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ briefs: [] }),
    });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('at least one brief');
  });

  it('400s when any row is missing title or rawText', async () => {
    const app = createApp();
    const form = new FormData();
    form.set('briefs[0][title]', 'Only a title, no body');
    // No rawText
    const res = await app.request('/intake/batch', {
      method: 'POST',
      body: form,
    });
    expect(res.status).toBe(400);
  });

  it('400s when batch exceeds 25 briefs', async () => {
    const briefs = Array.from({ length: 26 }, (_, i) => ({
      title: `Brief ${i}`,
      rawText: `body ${i}`,
    }));
    const app = createApp();
    const res = await app.request('/intake/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ briefs }),
    });
    expect(res.status).toBe(400);
  });
});

describe('GET /intake/batch/:batchId', () => {
  beforeEach(() => {
    mockGetBriefBatch.mockReset();
  });

  it('renders the overview with live polling while scoring is in progress', async () => {
    mockGetBriefBatch.mockResolvedValue([
      fakeBrief({ id: 'b1', title: 'First', batchId: 'batch_x' }),
      fakeBrief({ id: 'b2', title: 'Second', batchId: 'batch_x' }),
    ]);

    const app = createApp();
    const res = await app.request('/intake/batch/batch_x');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('First');
    expect(html).toContain('Second');
    expect(html).toContain('Scoring 2 / 2');
    expect(html).toContain('hx-trigger="every 2s"');
  });

  it('drops the polling trigger when all rows are scored', async () => {
    mockGetBriefBatch.mockResolvedValue([
      fakeBrief({ id: 'b1', title: 'First', score: fakeScore() }),
      fakeBrief({ id: 'b2', title: 'Second', score: fakeScore() }),
    ]);

    const app = createApp();
    const res = await app.request('/intake/batch/batch_x');
    const html = await res.text();
    expect(html).toContain('All scored');
    expect(html).not.toContain('hx-trigger');
  });

  it('404 when batchId has no matching briefs', async () => {
    mockGetBriefBatch.mockResolvedValue([]);
    const app = createApp();
    const res = await app.request('/intake/batch/batch_does_not_exist');
    expect(res.status).toBe(404);
  });
});
