import { describe, it, expect } from 'vitest';
import { PlanDetailPage, RuntimeBar } from '../../src/views/plan-detail.js';
import type { Plan, Scene } from '../../src/db/schemas.js';

function fakePlan(overrides: Partial<Plan> = {}): Plan {
  return {
    id: 'plan_1',
    type: 'cover_letter',
    status: 'awaiting_review',
    title: 'Backend Eng at Acme',
    sourceListingId: 'lst_1',
    sourceListingText: 'Looking for a senior engineer to build lead pipelines.',
    requirements: [],
    matchedProjects: [],
    targetRuntimeSeconds: 120,
    estimatedRuntimeSeconds: 0,
    userConstraints: null,
    createdAt: new Date('2026-05-15T10:00:00Z'),
    updatedAt: new Date('2026-05-15T10:00:00Z'),
    exportedAt: null,
    formatProfileId: null,
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

function fakeScene(overrides: Partial<Scene> = {}): Scene {
  return {
    id: 'scene_1',
    planId: 'plan_1',
    order: 1,
    title: 'Intro',
    description: 'Rick intros.',
    framingNotes: 'Headshot.',
    script: 'Hi I am Rick.',
    scriptDraft: 'Hi I am Rick.',
    emphasisCues: [],
    pacingNotes: '',
    transitionNote: '',
    estimatedDurationSeconds: 10,
    projectRef: null,
    storyboardImageUrl: null,
    beatTag: null,
    primaryShot: null,
    brollItems: [],
    shotListItems: [],
    onScreenTextOverlays: [],
    cutPoints: [],
    ...overrides,
  };
}

const toHtml = (node: unknown) => String(node);

describe('PlanDetailPage', () => {
  it('renders plan title in the page heading', () => {
    const html = toHtml(
      PlanDetailPage({ plan: fakePlan({ title: 'Senior dev at Foo' }), scenes: [] }),
    );
    expect(html).toContain('Senior dev at Foo');
    expect(html).toContain('<title>Senior dev at Foo');
  });

  it('shows status badge', () => {
    const html = toHtml(
      PlanDetailPage({ plan: fakePlan({ status: 'scenes_generated' }), scenes: [] }),
    );
    expect(html).toContain('Scenes generated');
    expect(html).toContain('badge scenes_generated');
  });

  it('shows the listing text in a collapsible details element', () => {
    const html = toHtml(
      PlanDetailPage({
        plan: fakePlan({ sourceListingText: 'unique listing body here' }),
        scenes: [],
      }),
    );
    expect(html).toContain('<details');
    expect(html).toContain('unique listing body here');
    expect(html).toContain('Source listing text');
  });

  it('renders requirements when present', () => {
    const html = toHtml(
      PlanDetailPage({
        plan: fakePlan({
          status: 'requirements_reviewed',
          requirements: [
            {
              skill: 'lead pipeline automation',
              category: 'automation',
              priority: 'must_show',
              evidence: 'evidence here',
            },
          ],
        }),
        scenes: [],
      }),
    );
    // Header copy migrated from "Requirements (1)" to "Requirements · 1 extracted".
    expect(html).toContain('Requirements · 1 extracted');
    // Priority pill copy is now title-case "Must" (was ALLCAPS "MUST").
    expect(html).toContain('Must');
    expect(html).toContain('lead pipeline automation');
    expect(html).toContain('evidence here');
  });

  it('renders matched projects when present', () => {
    const html = toHtml(
      PlanDetailPage({
        plan: fakePlan({
          status: 'projects_matched',
          matchedProjects: [
            {
              projectSlug: 'lead-pipeline',
              projectName: 'Lead Pipeline',
              matchedFeatures: ['routing dashboard'],
              relevanceScore: 0.92,
              suggestedDemoSequence: 'Open the dashboard.',
            },
          ],
        }),
        scenes: [],
      }),
    );
    // Header copy migrated from "Matched projects (1)" to "Matched projects · 1 selected".
    expect(html).toContain('Matched projects · 1 selected');
    expect(html).toContain('Lead Pipeline');
    expect(html).toContain('routing dashboard');
    expect(html).toContain('0.92');
  });

  it('renders scene cards when scenes exist', () => {
    const html = toHtml(
      PlanDetailPage({
        plan: fakePlan({ status: 'scenes_generated' }),
        scenes: [
          fakeScene({ id: 'scene_a', title: 'Opening', order: 1 }),
          fakeScene({ id: 'scene_b', title: 'Demo', order: 2 }),
        ],
      }),
    );
    expect(html).toContain('Scenes (2)');
    expect(html).toContain('id="scene-scene_a"');
    expect(html).toContain('id="scene-scene_b"');
    expect(html).toContain('Opening');
    expect(html).toContain('Demo');
  });

  it('hides cover-letter-only sections for youtube plans', () => {
    const html = toHtml(
      PlanDetailPage({
        plan: fakePlan({ type: 'youtube_lite', sourceListingText: null, sourceListingId: null }),
        scenes: [],
      }),
    );
    expect(html).not.toContain('Source listing text');
    expect(html).not.toContain('Requirements');
    // "1. Analyze requirements" button is cover-letter only; YouTube starts at match.
    expect(html).not.toContain('1. Analyze requirements');
  });

  it('shows the Generate scripts button on a plan in awaiting_review', () => {
    // The blocking "Run pipeline" button became a non-blocking enqueue:
    // it posts to /queue and the page polls pipelineState until done.
    const html = toHtml(
      PlanDetailPage({ plan: fakePlan({ status: 'awaiting_review' }), scenes: [] }),
    );
    expect(html).toContain('Generate scripts');
    expect(html).toContain('hx-post="/plans/plan_1/queue"');
  });

  it('shows the busy banner and self-refresh while the pipeline runs', () => {
    const html = toHtml(
      PlanDetailPage({
        plan: fakePlan({ status: 'awaiting_review', pipelineState: 'running' }),
        scenes: [],
      }),
    );
    expect(html).toContain('Generating scripts in the background');
    expect(html).toContain('hx-trigger="every 5s"');
  });

  it('shows the failure banner with the error when the pipeline failed', () => {
    const html = toHtml(
      PlanDetailPage({
        plan: fakePlan({
          status: 'awaiting_review',
          pipelineState: 'failed',
          pipelineError: 'claude CLI failed: timeout',
        }),
        scenes: [],
      }),
    );
    expect(html).toContain('Background pipeline failed');
    expect(html).toContain('claude CLI failed: timeout');
  });
});

describe('RuntimeBar', () => {
  // Colors moved from hard-coded hex to CSS variables (--green-fg /
  // --amber-fg / --danger) so dark mode + theming Just Work. Tests assert
  // on the variable name now instead of the resolved value.
  it('green styling within 15% of target', () => {
    const html = toHtml(RuntimeBar({ targetSeconds: 120, estimatedSeconds: 115 }));
    expect(html).toContain('var(--green-fg)');
  });

  it('yellow styling between 15% and 30% off', () => {
    const html = toHtml(RuntimeBar({ targetSeconds: 120, estimatedSeconds: 90 }));
    expect(html).toContain('var(--amber-fg)');
  });

  it('red styling beyond 30% off', () => {
    const html = toHtml(RuntimeBar({ targetSeconds: 120, estimatedSeconds: 50 }));
    expect(html).toContain('var(--danger)');
  });

  it('handles zero target gracefully', () => {
    const html = toHtml(RuntimeBar({ targetSeconds: 0, estimatedSeconds: 60 }));
    expect(html).toContain('0s');
  });
});
