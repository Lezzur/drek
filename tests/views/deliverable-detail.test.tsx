import { describe, it, expect } from 'vitest';
import { DeliverableDetailView } from '../../src/views/deliverable-detail.js';
import type {
  Plan,
  Deliverable,
  Scene,
  CustomShortScript,
} from '../../src/db/schemas.js';

const toHtml = (node: unknown) => String(node);

function fakePlan(overrides: Partial<Plan> = {}): Plan {
  return {
    id: 'plan_1',
    type: 'youtube_advanced',
    status: 'finalized',
    title: 'Test',
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
    title: 'Episode 1',
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
    ...overrides,
  };
}

function fakeScene(order: number, overrides: Partial<Scene> = {}): Scene {
  return {
    id: `scene_${order}`,
    planId: 'plan_1',
    order,
    title: `Scene ${order}`,
    description: 'd',
    framingNotes: 'f',
    script: `script text for scene ${order}`,
    scriptDraft: '',
    emphasisCues: [],
    pacingNotes: '',
    transitionNote: '',
    estimatedDurationSeconds: 60,
    projectRef: null,
    storyboardImageUrl: null,
    beatTag: 'demo',
    primaryShot: null,
    brollItems: [],
    shotListItems: [],
    onScreenTextOverlays: [],
    cutPoints: [],
    ...overrides,
  };
}

describe('DeliverableDetailView — long_form', () => {
  it('renders hook + title + thumbnail + publishing + footage links', () => {
    const html = toHtml(
      DeliverableDetailView({
        plan: fakePlan(),
        deliverable: fakeDeliverable(),
        relatedScenes: [fakeScene(1), fakeScene(2)],
        customScripts: null,
      }),
    );
    expect(html).toContain('Episode 1');
    expect(html).toContain('/plans/plan_1/workshop/hooks');
    expect(html).toContain('deliverableId=del_lf');
    expect(html).toContain('/deliverables/del_lf/publish');
    expect(html).toContain('/plans/plan_1/footage');
    expect(html).toContain('Scenes · 2');
    expect(html).toContain('script text for scene 1');
  });

  it('does not show customScripts block for long_form', () => {
    const html = toHtml(
      DeliverableDetailView({
        plan: fakePlan(),
        deliverable: fakeDeliverable(),
        relatedScenes: [],
        customScripts: null,
      }),
    );
    expect(html).not.toContain('Reworked Short script');
  });
});

describe('DeliverableDetailView — short_clip', () => {
  it('renders reworked Short script + only related scenes', () => {
    const customScripts: CustomShortScript[] = [
      { sourceSceneId: 'scene_1', script: 'You will not believe this 60-second clip.' },
    ];
    const html = toHtml(
      DeliverableDetailView({
        plan: fakePlan(),
        deliverable: fakeDeliverable({
          id: 'del_short',
          kind: 'short_clip',
          audienceProfileId: 'business_owner_shorts',
          title: 'Short 1',
          scriptOverrideSceneIds: ['scene_1'],
          customScripts,
        }),
        relatedScenes: [fakeScene(1)],
        customScripts,
      }),
    );
    expect(html).toContain('Short 1');
    expect(html).toContain('Reworked Short script');
    expect(html).toContain('You will not believe this 60-second clip');
    expect(html).toContain('Source scene: scene_1');
    // No hook workshop link for shorts.
    expect(html).not.toContain('/plans/plan_1/workshop/hooks');
  });
});

describe('DeliverableDetailView — navigation', () => {
  it('back link points to deliverable bundle', () => {
    const html = toHtml(
      DeliverableDetailView({
        plan: fakePlan({ id: 'plan_xyz' }),
        deliverable: fakeDeliverable({ planId: 'plan_xyz' }),
        relatedScenes: [],
        customScripts: null,
      }),
    );
    expect(html).toContain('href="/plans/plan_xyz/deliverables"');
  });
});
