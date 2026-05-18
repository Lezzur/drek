import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---- Mocks ---------------------------------------------------------------

const mockGetPlan = vi.fn();
const mockGetDeliverable = vi.fn();
const mockGetPublishMetadata = vi.fn();
const mockPatchPublishMetadata = vi.fn();
const mockGetSelectedTitleConcept = vi.fn();
const mockGeneratePublishMetadata = vi.fn();

vi.mock('../../src/db/plans.js', () => ({
  getPlan: (...args: unknown[]) => mockGetPlan(...args),
}));

vi.mock('../../src/db/deliverables.js', () => ({
  getDeliverable: (...args: unknown[]) => mockGetDeliverable(...args),
}));

vi.mock('../../src/db/publish-metadata.js', () => ({
  getPublishMetadata: (...args: unknown[]) => mockGetPublishMetadata(...args),
  patchPublishMetadata: (...args: unknown[]) => mockPatchPublishMetadata(...args),
}));

vi.mock('../../src/db/title-concepts.js', () => ({
  getSelectedTitleConcept: (...args: unknown[]) => mockGetSelectedTitleConcept(...args),
}));

vi.mock('../../src/engine/generate-publish-metadata.js', async (importOriginal) => {
  // Keep renderPublishBundle real; only mock the engine call.
  const actual = await importOriginal<typeof import('../../src/engine/generate-publish-metadata.js')>();
  return {
    ...actual,
    generatePublishMetadata: (...args: unknown[]) => mockGeneratePublishMetadata(...args),
  };
});

vi.mock('../../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() },
}));

import { Hono } from 'hono';
import publish from '../../src/routes/publish.js';
import { PlanningEngineError } from '../../src/engine/errors.js';

function createApp(): Hono {
  const app = new Hono();
  app.route('/', publish);
  return app;
}

function fakePlan() {
  return {
    id: 'plan_1',
    type: 'youtube_advanced',
    status: 'metadata_generated',
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

function fakeDel() {
  return {
    id: 'del_1',
    planId: 'plan_1',
    kind: 'long_form',
    audienceProfileId: 'developer_longform',
    title: 'Ep 1',
    status: 'metadata_ready',
    scriptOverrideSceneIds: null,
    customScripts: null,
    selectedTitleVariantId: 'title_x',
    selectedThumbnailConceptId: 'thumb_x',
    publishMetadataId: 'current',
    youtubeUrl: null,
    publishedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function fakeMeta() {
  return {
    description: 'd',
    chapters: [{ timestampSeconds: 0, label: 'Cold open' }],
    tags: ['a', 'b'],
    pinnedComment: 'pc',
    endScreenSuggestion: 'es',
    generatedAt: new Date(),
    lastEditedAt: null,
  };
}

beforeEach(() => {
  mockGetPlan.mockReset();
  mockGetDeliverable.mockReset();
  mockGetPublishMetadata.mockReset();
  mockPatchPublishMetadata.mockReset();
  mockGetSelectedTitleConcept.mockReset();
  mockGeneratePublishMetadata.mockReset();
});

describe('GET /deliverables/:id/publish', () => {
  it('renders the view when metadata exists', async () => {
    mockGetDeliverable.mockResolvedValue(fakeDel());
    mockGetPlan.mockResolvedValue(fakePlan());
    mockGetPublishMetadata.mockResolvedValue(fakeMeta());
    mockGetSelectedTitleConcept.mockResolvedValue({ titleText: 'My picked title' });

    const res = await createApp().request('/deliverables/del_1/publish');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Publish · Ep 1');
    expect(html).toContain('My picked title');
    expect(html).toContain('Save description');
  });

  it('renders empty state with generate CTA when no metadata yet', async () => {
    mockGetDeliverable.mockResolvedValue(fakeDel());
    mockGetPlan.mockResolvedValue(fakePlan());
    mockGetPublishMetadata.mockResolvedValue(null);
    mockGetSelectedTitleConcept.mockResolvedValue(null);

    const res = await createApp().request('/deliverables/del_1/publish');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('No publishing metadata yet');
    expect(html).toContain('Generate publish metadata');
  });

  it('404 when deliverable missing', async () => {
    mockGetDeliverable.mockResolvedValue(null);
    const res = await createApp().request('/deliverables/missing/publish');
    expect(res.status).toBe(404);
  });

  it('404 when parent plan missing', async () => {
    mockGetDeliverable.mockResolvedValue(fakeDel());
    mockGetPlan.mockResolvedValue(null);
    const res = await createApp().request('/deliverables/del_1/publish');
    expect(res.status).toBe(404);
  });
});

describe('GET /deliverables/:id/publish/bundle', () => {
  it('returns plain-text bundle with all sections', async () => {
    mockGetDeliverable.mockResolvedValue(fakeDel());
    mockGetPublishMetadata.mockResolvedValue(fakeMeta());
    mockGetSelectedTitleConcept.mockResolvedValue({ titleText: 'My picked title' });

    const res = await createApp().request('/deliverables/del_1/publish/bundle');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/plain');
    const body = await res.text();
    expect(body).toContain('=== TITLE ===');
    expect(body).toContain('My picked title');
    expect(body).toContain('=== DESCRIPTION ===');
    expect(body).toContain('=== CHAPTERS ===');
    expect(body).toContain('=== TAGS ===');
    expect(body).toContain('=== PINNED COMMENT ===');
    expect(body).toContain('=== END SCREEN ===');
  });

  it('falls back to deliverable.title when no selected title concept', async () => {
    mockGetDeliverable.mockResolvedValue(fakeDel());
    mockGetPublishMetadata.mockResolvedValue(fakeMeta());
    mockGetSelectedTitleConcept.mockResolvedValue(null);

    const res = await createApp().request('/deliverables/del_1/publish/bundle');
    const body = await res.text();
    expect(body).toContain('Ep 1');
  });

  it('404 when no metadata generated', async () => {
    mockGetDeliverable.mockResolvedValue(fakeDel());
    mockGetPublishMetadata.mockResolvedValue(null);
    const res = await createApp().request('/deliverables/del_1/publish/bundle');
    expect(res.status).toBe(404);
  });
});

describe('PATCH /deliverables/:id/publish', () => {
  it('updates description from form body and redirects', async () => {
    mockGetDeliverable.mockResolvedValue(fakeDel());
    mockPatchPublishMetadata.mockResolvedValue(fakeMeta());

    const res = await createApp().request('/deliverables/del_1/publish', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'description=new+description+text',
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('HX-Redirect')).toBe('/deliverables/del_1/publish');
    expect(mockPatchPublishMetadata).toHaveBeenCalledWith(
      'del_1',
      expect.objectContaining({ description: 'new description text' }),
    );
  });

  it('parses tagsCsv into trimmed tag array', async () => {
    mockGetDeliverable.mockResolvedValue(fakeDel());
    mockPatchPublishMetadata.mockResolvedValue(fakeMeta());

    const res = await createApp().request('/deliverables/del_1/publish', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'tagsCsv=' + encodeURIComponent('ai, video,  creator , devtools'),
    });
    expect(res.status).toBe(200);
    expect(mockPatchPublishMetadata).toHaveBeenCalledWith(
      'del_1',
      expect.objectContaining({ tags: ['ai', 'video', 'creator', 'devtools'] }),
    );
  });

  it('rejects 404 when deliverable missing', async () => {
    mockGetDeliverable.mockResolvedValue(null);
    const res = await createApp().request('/deliverables/del_1/publish', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'x' }),
    });
    expect(res.status).toBe(404);
  });

  it('rejects 404 when metadata to update is missing', async () => {
    mockGetDeliverable.mockResolvedValue(fakeDel());
    mockPatchPublishMetadata.mockResolvedValue(null);

    const res = await createApp().request('/deliverables/del_1/publish', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinnedComment: 'new pc' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('POST /deliverables/:id/generate-publish-metadata', () => {
  it('redirects to publish view on success', async () => {
    mockGeneratePublishMetadata.mockResolvedValue({ retried: false });

    const res = await createApp().request('/deliverables/del_1/generate-publish-metadata', {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('HX-Redirect')).toBe('/deliverables/del_1/publish');
    expect(mockGeneratePublishMetadata).toHaveBeenCalledWith('del_1');
  });

  it('returns 400 on NO_REQUIREMENTS (missing title/thumbnail)', async () => {
    mockGeneratePublishMetadata.mockRejectedValue(
      new PlanningEngineError(
        'generate-publish-metadata',
        'NO_REQUIREMENTS',
        'need both',
      ),
    );
    const res = await createApp().request('/deliverables/del_1/generate-publish-metadata', {
      method: 'POST',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('NO_REQUIREMENTS');
  });

  it('returns 400 on DISALLOWED_TRANSITION', async () => {
    mockGeneratePublishMetadata.mockRejectedValue(
      new PlanningEngineError(
        'generate-publish-metadata',
        'DISALLOWED_TRANSITION',
        'wrong status',
      ),
    );
    const res = await createApp().request('/deliverables/del_1/generate-publish-metadata', {
      method: 'POST',
    });
    expect(res.status).toBe(400);
  });

  it('returns 500 on unknown error', async () => {
    mockGeneratePublishMetadata.mockRejectedValue(new Error('boom'));
    const res = await createApp().request('/deliverables/del_1/generate-publish-metadata', {
      method: 'POST',
    });
    expect(res.status).toBe(500);
  });
});
