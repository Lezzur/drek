import { describe, it, expect } from 'vitest';
import {
  DeliverableBundleView,
  type DeliverableSummary,
} from '../../src/views/deliverable-bundle.js';
import type {
  Plan,
  Deliverable,
  TitleConcept,
  ThumbnailConcept,
} from '../../src/db/schemas.js';

const toHtml = (node: unknown) => String(node);

function fakePlan(overrides: Partial<Plan> = {}): Plan {
  return {
    id: 'plan_1',
    type: 'youtube_advanced',
    status: 'metadata_generated',
    title: 'Test Plan',
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
    workspacePath: '/tmp/ws',
    selectedHookVariantId: null,
    selectedTitleVariantId: null,
    selectedThumbnailConceptId: null,
    pipelineState: 'idle' as const,
    pipelineError: null,
    ...overrides,
  };
}

function fakeDeliverable(overrides: Partial<Deliverable> = {}): Deliverable {
  return {
    id: 'del_lf',
    planId: 'plan_1',
    kind: 'long_form',
    audienceProfileId: 'developer_longform',
    title: 'My Long-form Episode',
    status: 'metadata_ready',
    scriptOverrideSceneIds: null,
    customScripts: null,
    selectedTitleVariantId: null,
    selectedThumbnailConceptId: null,
    publishMetadataId: 'current',
    youtubeUrl: null,
    publishedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function fakeSummary(d: Deliverable, overrides: Partial<DeliverableSummary> = {}): DeliverableSummary {
  return {
    deliverable: d,
    selectedTitle: null,
    selectedThumbnail: null,
    hasPublishMetadata: true,
    ...overrides,
  };
}

describe('DeliverableBundleView — empty state', () => {
  it('shows empty hint with Shorts workshop link', () => {
    const html = toHtml(
      DeliverableBundleView({
        plan: fakePlan(),
        summaries: [],
      }),
    );
    expect(html).toContain('Deliverables · Test Plan');
    expect(html).toContain('No deliverables yet');
    expect(html).toContain('/plans/plan_1/shorts');
  });
});

describe('DeliverableBundleView — with deliverables', () => {
  it('renders long-form card and short_clip grid', () => {
    const longForm = fakeDeliverable();
    const shortA = fakeDeliverable({
      id: 'del_sa',
      kind: 'short_clip',
      audienceProfileId: 'business_owner_shorts',
      title: 'Short A',
    });
    const shortB = fakeDeliverable({
      id: 'del_sb',
      kind: 'short_clip',
      audienceProfileId: 'business_owner_shorts',
      title: 'Short B',
    });
    const html = toHtml(
      DeliverableBundleView({
        plan: fakePlan(),
        summaries: [fakeSummary(longForm), fakeSummary(shortA), fakeSummary(shortB)],
      }),
    );
    expect(html).toContain('My Long-form Episode');
    expect(html).toContain('Short A');
    expect(html).toContain('Short B');
    expect(html).toContain('id="deliverable-del_lf"');
    expect(html).toContain('id="deliverable-del_sa"');
    expect(html).toContain('id="deliverable-del_sb"');
  });

  it('shows status badge + audience id per card', () => {
    const html = toHtml(
      DeliverableBundleView({
        plan: fakePlan(),
        summaries: [
          fakeSummary(fakeDeliverable({ status: 'published' })),
        ],
      }),
    );
    expect(html).toContain('Published');
    expect(html).toContain('developer_longform');
  });

  it('renders selected title text from the summary', () => {
    const titleConcept: TitleConcept = {
      id: 'title_x',
      titleText: 'How I shipped in 60 seconds',
      archetype: 'curiosity_gap',
      reasoning: 'r',
      predictedClickability: 8,
      keywordsSurfaced: [],
      selected: true,
      createdAt: new Date(),
    };
    const html = toHtml(
      DeliverableBundleView({
        plan: fakePlan(),
        summaries: [fakeSummary(fakeDeliverable(), { selectedTitle: titleConcept })],
      }),
    );
    expect(html).toContain('How I shipped in 60 seconds');
  });

  it('renders selected thumbnail conceptSummary as the thumb hint', () => {
    const thumb: ThumbnailConcept = {
      id: 'thumb_x',
      composition: 'split: terminal left, headshot right',
      textHook: 'SHIPPED',
      expression: 'relieved',
      colorPalette: ['#0a0a0a', '#22c55e'],
      assetsRequired: [],
      conceptSummary: 'Bold SHIPPED text over terminal screenshot',
      selected: true,
      createdAt: new Date(),
    };
    const html = toHtml(
      DeliverableBundleView({
        plan: fakePlan(),
        summaries: [fakeSummary(fakeDeliverable(), { selectedThumbnail: thumb })],
      }),
    );
    expect(html).toContain('Bold SHIPPED text over terminal screenshot');
  });

  it('shows youtubeUrl when published', () => {
    const html = toHtml(
      DeliverableBundleView({
        plan: fakePlan(),
        summaries: [
          fakeSummary(
            fakeDeliverable({
              status: 'published',
              youtubeUrl: 'https://www.youtube.com/watch?v=xyz',
            }),
          ),
        ],
      }),
    );
    expect(html).toContain('https://www.youtube.com/watch?v=xyz');
  });

  it('export-all button + flash messaging', () => {
    const html = toHtml(
      DeliverableBundleView({
        plan: fakePlan(),
        summaries: [fakeSummary(fakeDeliverable())],
        exportFlash: {
          successCount: 2,
          failures: [{ deliverableId: 'del_short_1', reason: 'no publish metadata generated yet' }],
        },
      }),
    );
    expect(html).toContain('Export all to workspace');
    expect(html).toContain('Exported 2 deliverable');
    expect(html).toContain('del_short_1');
    expect(html).toContain('no publish metadata');
  });

  it('back link points to plan', () => {
    const html = toHtml(
      DeliverableBundleView({
        plan: fakePlan({ id: 'plan_xyz' }),
        summaries: [],
      }),
    );
    expect(html).toContain('href="/plans/plan_xyz"');
  });
});
