import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---- Mock engine + db ----------------------------------------------------

const mockGenerateTitleVariants = vi.fn();
const mockGenerateThumbnailConcepts = vi.fn();
const mockSelectTitle = vi.fn();
const mockSelectThumbnail = vi.fn();
const mockGetDeliverable = vi.fn();

vi.mock('../../src/engine/generate-title-variants.js', () => ({
  generateTitleVariants: (...args: unknown[]) => mockGenerateTitleVariants(...args),
}));

vi.mock('../../src/engine/generate-thumbnail-concepts.js', () => ({
  generateThumbnailConcepts: (...args: unknown[]) => mockGenerateThumbnailConcepts(...args),
}));

vi.mock('../../src/engine/select-title.js', () => ({
  selectTitle: (...args: unknown[]) => mockSelectTitle(...args),
}));

vi.mock('../../src/engine/select-thumbnail.js', () => ({
  selectThumbnail: (...args: unknown[]) => mockSelectThumbnail(...args),
}));

vi.mock('../../src/db/deliverables.js', () => ({
  getDeliverable: (...args: unknown[]) => mockGetDeliverable(...args),
  findLongFormDeliverable: vi.fn(),
  createDeliverable: vi.fn(),
  patchDeliverable: vi.fn(),
  listDeliverablesForPlan: vi.fn(),
  deleteDeliverable: vi.fn(),
  DeliverableNotFoundError: class extends Error {},
}));

vi.mock('../../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() },
}));

import { Hono } from 'hono';
import deliverables from '../../src/routes/deliverables.js';
import { PlanningEngineError } from '../../src/engine/errors.js';

function createApp(): Hono {
  const app = new Hono();
  app.route('/', deliverables);
  return app;
}

beforeEach(() => {
  mockGenerateTitleVariants.mockReset();
  mockGenerateThumbnailConcepts.mockReset();
  mockSelectTitle.mockReset();
  mockSelectThumbnail.mockReset();
  mockGetDeliverable.mockReset();
});

describe('POST /deliverables/:id/generate-titles', () => {
  it('redirects to plan title workshop on success', async () => {
    mockGenerateTitleVariants.mockResolvedValue({ concepts: [], retried: false, durationMs: 5 });
    mockGetDeliverable.mockResolvedValue({ id: 'del_1', planId: 'plan_abc' });

    const res = await createApp().request('/deliverables/del_1/generate-titles', {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('HX-Redirect')).toBe('/plans/plan_abc/workshop/titles?deliverableId=del_1');
    expect(mockGenerateTitleVariants).toHaveBeenCalledWith('del_1');
  });

  it('returns 400 on DISALLOWED_TRANSITION', async () => {
    mockGenerateTitleVariants.mockRejectedValue(
      new PlanningEngineError('generate-title-variants', 'DISALLOWED_TRANSITION', 'wrong status'),
    );
    const res = await createApp().request('/deliverables/del_1/generate-titles', {
      method: 'POST',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('DISALLOWED_TRANSITION');
  });
});

describe('POST /deliverables/:id/generate-thumbnails', () => {
  it('redirects on success', async () => {
    mockGenerateThumbnailConcepts.mockResolvedValue({ concepts: [], retried: false, durationMs: 5 });
    mockGetDeliverable.mockResolvedValue({ id: 'del_1', planId: 'plan_abc' });
    const res = await createApp().request('/deliverables/del_1/generate-thumbnails', {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('HX-Redirect')).toBe('/plans/plan_abc/workshop/thumbnails?deliverableId=del_1');
  });

  it('returns 400 on NO_REQUIREMENTS (no selected title)', async () => {
    mockGenerateThumbnailConcepts.mockRejectedValue(
      new PlanningEngineError('generate-thumbnail-concepts', 'NO_REQUIREMENTS', 'no title selected'),
    );
    const res = await createApp().request('/deliverables/del_1/generate-thumbnails', {
      method: 'POST',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('NO_REQUIREMENTS');
  });
});

describe('POST /deliverables/:id/select-title', () => {
  it('redirects on success (JSON body)', async () => {
    mockSelectTitle.mockResolvedValue(undefined);
    mockGetDeliverable.mockResolvedValue({ id: 'del_1', planId: 'plan_abc' });
    const res = await createApp().request('/deliverables/del_1/select-title', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conceptId: 'title_x' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('HX-Redirect')).toBe('/plans/plan_abc/workshop/titles?deliverableId=del_1');
    expect(mockSelectTitle).toHaveBeenCalledWith('del_1', 'title_x');
  });

  it('400 when conceptId missing', async () => {
    const res = await createApp().request('/deliverables/del_1/select-title', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /deliverables/:id/select-thumbnail', () => {
  it('redirects on success (form body)', async () => {
    mockSelectThumbnail.mockResolvedValue(undefined);
    mockGetDeliverable.mockResolvedValue({ id: 'del_1', planId: 'plan_abc' });
    const res = await createApp().request('/deliverables/del_1/select-thumbnail', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'conceptId=thumb_y',
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('HX-Redirect')).toBe('/plans/plan_abc/workshop/thumbnails?deliverableId=del_1');
    expect(mockSelectThumbnail).toHaveBeenCalledWith('del_1', 'thumb_y');
  });
});
