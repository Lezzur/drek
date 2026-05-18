import { describe, it, expect } from 'vitest';
import { PublishMetadataView } from '../../src/views/publish.js';
import type { Plan, Deliverable, PublishMetadata } from '../../src/db/schemas.js';

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
    workspacePath: null,
    selectedHookVariantId: null,
    selectedTitleVariantId: null,
    selectedThumbnailConceptId: null,
    ...overrides,
  };
}

function fakeDeliverable(overrides: Partial<Deliverable> = {}): Deliverable {
  return {
    id: 'del_1',
    planId: 'plan_1',
    kind: 'long_form',
    audienceProfileId: 'developer_longform',
    title: 'Test Episode',
    status: 'metadata_ready',
    scriptOverrideSceneIds: null,
    customScripts: null,
    selectedTitleVariantId: 'title_x',
    selectedThumbnailConceptId: 'thumb_x',
    publishMetadataId: 'current',
    youtubeUrl: null,
    publishedAt: null,
    createdAt: new Date('2026-05-18T10:00:00Z'),
    updatedAt: new Date('2026-05-18T10:00:00Z'),
    ...overrides,
  };
}

function fakeMetadata(overrides: Partial<PublishMetadata> = {}): PublishMetadata {
  return {
    description:
      'Hook opener.\n\nA paragraph of body text.\n\nSubscribe.\n\n--- Chapters ---\n0:00 — Cold open\n0:30 — Demo\n3:30 — Outro',
    chapters: [
      { timestampSeconds: 0, label: 'Cold open' },
      { timestampSeconds: 30, label: 'Demo' },
      { timestampSeconds: 210, label: 'Outro' },
    ],
    tags: ['ai', 'video', 'youtube', 'creator', 'devtools'],
    pinnedComment: 'What did you build with this? Comment below.',
    endScreenSuggestion: 'Watch the previous episode about lead pipelines.',
    generatedAt: new Date('2026-05-18T12:00:00Z'),
    lastEditedAt: null,
    ...overrides,
  };
}

describe('PublishMetadataView — empty state, can generate', () => {
  it('shows generate CTA when title + thumbnail selected but no metadata', () => {
    const html = toHtml(
      PublishMetadataView({
        plan: fakePlan(),
        deliverable: fakeDeliverable({ publishMetadataId: null }),
        metadata: null,
        selectedTitleText: 'My selected title',
      }),
    );
    expect(html).toContain('Publish · Test Episode');
    expect(html).toContain('No publishing metadata yet');
    expect(html).toContain('Generate publish metadata');
    expect(html).toContain('hx-post="/deliverables/del_1/generate-publish-metadata"');
  });
});

describe('PublishMetadataView — empty state, cannot generate', () => {
  it('shows missing-prereq message when title not selected', () => {
    const html = toHtml(
      PublishMetadataView({
        plan: fakePlan(),
        deliverable: fakeDeliverable({
          selectedTitleVariantId: null,
          publishMetadataId: null,
        }),
        metadata: null,
        selectedTitleText: null,
      }),
    );
    expect(html).toContain('No publishing metadata yet');
    expect(html).toContain('selected title AND a selected thumbnail');
    // No POST CTA — should be a back link instead.
    expect(html).not.toContain('Generate publish metadata');
    expect(html).toContain('Back to plan');
  });
});

describe('PublishMetadataView — with metadata', () => {
  it('renders description with character count', () => {
    const meta = fakeMetadata();
    const html = toHtml(
      PublishMetadataView({
        plan: fakePlan(),
        deliverable: fakeDeliverable(),
        metadata: meta,
        selectedTitleText: 'My title',
      }),
    );
    expect(html).toContain(`Description · ${meta.description.length} / 5000`);
    expect(html).toContain('Hook opener.');
    expect(html).toContain('hx-patch="/deliverables/del_1/publish"');
    expect(html).toContain('Save description');
  });

  it('renders chapters block with timestamps and labels', () => {
    const html = toHtml(
      PublishMetadataView({
        plan: fakePlan(),
        deliverable: fakeDeliverable(),
        metadata: fakeMetadata(),
        selectedTitleText: 'My title',
      }),
    );
    expect(html).toContain('Chapters · 3');
    expect(html).toContain('0:00');
    expect(html).toContain('0:30');
    expect(html).toContain('3:30');
    expect(html).toContain('Cold open');
    expect(html).toContain('Demo');
    expect(html).toContain('Outro');
  });

  it('renders tags as CSV input + chips with count', () => {
    const html = toHtml(
      PublishMetadataView({
        plan: fakePlan(),
        deliverable: fakeDeliverable(),
        metadata: fakeMetadata(),
        selectedTitleText: 'My title',
      }),
    );
    expect(html).toContain('Tags · 5');
    expect(html).toContain('name="tagsCsv"');
    expect(html).toContain('ai, video, youtube, creator, devtools');
  });

  it('renders pinned comment + end-screen blocks with character counts', () => {
    const meta = fakeMetadata();
    const html = toHtml(
      PublishMetadataView({
        plan: fakePlan(),
        deliverable: fakeDeliverable(),
        metadata: meta,
        selectedTitleText: 'My title',
      }),
    );
    expect(html).toContain(`Pinned comment · ${meta.pinnedComment.length} / 500`);
    expect(html).toContain('What did you build with this?');
    expect(html).toContain(`End-screen suggestion · ${meta.endScreenSuggestion.length} / 500`);
    expect(html).toContain('Watch the previous episode');
  });

  it('renders upload-bundle link and regenerate button when metadata exists', () => {
    const html = toHtml(
      PublishMetadataView({
        plan: fakePlan(),
        deliverable: fakeDeliverable(),
        metadata: fakeMetadata(),
        selectedTitleText: 'My title',
      }),
    );
    expect(html).toContain('href="/deliverables/del_1/publish/bundle"');
    expect(html).toContain('View upload bundle');
    expect(html).toContain('Regenerate metadata');
    expect(html).toContain('hx-confirm');
  });

  it('back link points to plan', () => {
    const html = toHtml(
      PublishMetadataView({
        plan: fakePlan({ id: 'plan_xyz' }),
        deliverable: fakeDeliverable({ planId: 'plan_xyz' }),
        metadata: fakeMetadata(),
        selectedTitleText: 'T',
      }),
    );
    expect(html).toContain('href="/plans/plan_xyz"');
    expect(html).toContain('Back to plan');
  });
});
