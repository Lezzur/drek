import { describe, it, expect } from 'vitest';
import { HookWorkshopView } from '../../src/views/workshop.js';
import type { Plan, HookDraft } from '../../src/db/schemas.js';

function fakePlan(overrides: Partial<Plan> = {}): Plan {
  return {
    id: 'plan_1',
    type: 'youtube_advanced',
    status: 'hooks_generated',
    title: 'Build a RAG chatbot with Claude Code',
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
    scriptText: 'Watch this. In thirty seconds, this chatbot will answer questions about a codebase it has never seen. No fine-tuning. No indexing. Just Claude Code and a few prompts.',
    predictedRetention: 'Viewers will stay because the opening demo creates immediate curiosity about how this is possible.',
    selected: false,
    createdAt: new Date('2026-05-18T10:01:00Z'),
    ...overrides,
  };
}

const toHtml = (node: unknown) => String(node);

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

describe('HookWorkshopView — empty state', () => {
  it('renders "Generate hooks first" when hooks array is empty', () => {
    const html = toHtml(HookWorkshopView({ plan: fakePlan(), hooks: [] }));
    expect(html).toContain('Generate hooks first');
    expect(html).toContain('generate-hooks');
  });
});

// ---------------------------------------------------------------------------
// Hook cards render
// ---------------------------------------------------------------------------

describe('HookWorkshopView — hook cards', () => {
  it('renders a card for each hook', () => {
    const hooks = [
      fakeHook({ id: 'hook_1', archetype: 'pattern_interrupt' }),
      fakeHook({ id: 'hook_2', archetype: 'bold_claim' }),
      fakeHook({ id: 'hook_3', archetype: 'demo_first' }),
    ];
    const html = toHtml(HookWorkshopView({ plan: fakePlan(), hooks }));

    // All archetypes rendered as labels.
    expect(html).toContain('Pattern interrupt');
    expect(html).toContain('Bold claim');
    expect(html).toContain('Demo first');

    // scriptText rendered.
    expect(html).toContain('Watch this. In thirty seconds');

    // All three hooks have select-hook post triggers (none selected yet).
    // The hookId appears in hx-vals JSON values like {"hookId":"hook_1"}.
    const selectHookOccurrences = (html.match(/select-hook/g) ?? []).length;
    expect(selectHookOccurrences).toBeGreaterThanOrEqual(3);
  });

  it('selected card has "selected" marker and border highlight', () => {
    const hooks = [
      fakeHook({ id: 'hook_1', archetype: 'pattern_interrupt', selected: false }),
      fakeHook({ id: 'hook_2', archetype: 'bold_claim', selected: true }),
    ];
    const html = toHtml(HookWorkshopView({ plan: fakePlan({ selectedHookVariantId: 'hook_2' }), hooks }));

    // Selected badge present.
    expect(html).toContain('✓ selected');
    // Green background for selected card.
    expect(html).toContain('var(--green-bg)');
    expect(html).toContain('var(--green-fg)');
  });

  it('unselected cards have hx-post select-hook attributes', () => {
    const hooks = [
      fakeHook({ id: 'hook_1', archetype: 'pattern_interrupt', selected: false }),
      fakeHook({ id: 'hook_2', archetype: 'bold_claim', selected: false }),
    ];
    const html = toHtml(HookWorkshopView({ plan: fakePlan(), hooks }));

    // Both unselected cards should have hx-post pointing to select-hook.
    expect(html).toContain('/plans/plan_1/select-hook');
  });

  it('renders predictedRetention in italicized muted text', () => {
    const hooks = [fakeHook({ predictedRetention: 'This hook creates immediate curiosity.' })];
    const html = toHtml(HookWorkshopView({ plan: fakePlan(), hooks }));
    expect(html).toContain('This hook creates immediate curiosity.');
    // It should be in a muted/italic style block.
    expect(html).toContain('font-style:italic');
  });
});

// ---------------------------------------------------------------------------
// Regenerate button
// ---------------------------------------------------------------------------

describe('HookWorkshopView — regenerate button', () => {
  it('renders "Regenerate hooks" button with hx-confirm', () => {
    const hooks = [fakeHook()];
    const html = toHtml(HookWorkshopView({ plan: fakePlan(), hooks }));

    expect(html).toContain('Regenerate hooks');
    expect(html).toContain('hx-confirm');
    expect(html).toContain('Discard current variants');
    expect(html).toContain('generate-hooks');
  });
});

// ---------------------------------------------------------------------------
// Page title + back link
// ---------------------------------------------------------------------------

describe('HookWorkshopView — header', () => {
  it('includes the plan title in the page heading', () => {
    const html = toHtml(HookWorkshopView({ plan: fakePlan({ title: 'My RAG video' }), hooks: [] }));
    expect(html).toContain('My RAG video');
    expect(html).toContain('Hooks · My RAG video');
  });

  it('has a back link to the plan', () => {
    const html = toHtml(HookWorkshopView({ plan: fakePlan({ id: 'plan_xyz' }), hooks: [] }));
    expect(html).toContain('/plans/plan_xyz');
    expect(html).toContain('Back to plan');
  });
});

import { TitleWorkshopView, ThumbnailWorkshopView } from '../../src/views/workshop.js';
import type { Deliverable, TitleConcept, ThumbnailConcept } from '../../src/db/schemas.js';

function fakeDeliverable(overrides: Partial<Deliverable> = {}): Deliverable {
  return {
    id: 'del_1',
    planId: 'plan_1',
    kind: 'long_form',
    audienceProfileId: 'developer_longform',
    title: 'My Episode',
    status: 'draft',
    scriptOverrideSceneIds: null,
    customScripts: null,
    selectedTitleVariantId: null,
    selectedThumbnailConceptId: null,
    publishMetadataId: null,
    youtubeUrl: null,
    publishedAt: null,
    createdAt: new Date('2026-05-18T10:00:00Z'),
    updatedAt: new Date('2026-05-18T10:00:00Z'),
    ...overrides,
  };
}

function fakeTitleConcept(overrides: Partial<TitleConcept> = {}): TitleConcept {
  return {
    id: 'title_a',
    titleText: 'How I built a $50k automation in 2 hours',
    archetype: 'specificity',
    predictedClickability: 8,
    reasoning: 'Specific dollar figure grabs attention',
    keywordsSurfaced: ['claude', 'automation'],
    selected: false,
    createdAt: new Date('2026-05-18T10:01:00Z'),
    ...overrides,
  };
}

function fakeThumbnailConcept(overrides: Partial<ThumbnailConcept> = {}): ThumbnailConcept {
  return {
    id: 'thumb_a',
    composition: 'split: terminal left, headshot right',
    textHook: 'SAVED IT',
    expression: 'relieved smile',
    colorPalette: ['#0a0a0a', '#22c55e'],
    assetsRequired: ['screenshot of failed test'],
    conceptSummary: 'demo-saved moment with green accent',
    selected: false,
    createdAt: new Date('2026-05-18T10:02:00Z'),
    ...overrides,
  };
}

describe('TitleWorkshopView', () => {
  it('renders empty state when no concepts', () => {
    const html = toHtml(
      TitleWorkshopView({
        plan: fakePlan(),
        deliverable: fakeDeliverable(),
        concepts: [],
      }),
    );
    expect(html).toContain('Generate titles first');
  });

  it('renders concept cards sorted by clickability desc', () => {
    const html = toHtml(
      TitleWorkshopView({
        plan: fakePlan(),
        deliverable: fakeDeliverable(),
        concepts: [
          fakeTitleConcept({ id: 'a', predictedClickability: 5, titleText: 'Low CTR' }),
          fakeTitleConcept({ id: 'b', predictedClickability: 9, titleText: 'High CTR' }),
        ],
      }),
    );
    expect(html).toContain('High CTR');
    expect(html).toContain('Low CTR');
    // The high-CTR card should appear first in the HTML
    expect(html.indexOf('High CTR')).toBeLessThan(html.indexOf('Low CTR'));
  });

  it('selected concept has the selected marker', () => {
    const html = toHtml(
      TitleWorkshopView({
        plan: fakePlan(),
        deliverable: fakeDeliverable(),
        concepts: [fakeTitleConcept({ selected: true })],
      }),
    );
    expect(html).toContain('selected');
    expect(html).toContain('✓ selected');
  });

  it('regenerate button is wired to deliverable endpoint', () => {
    const html = toHtml(
      TitleWorkshopView({
        plan: fakePlan(),
        deliverable: fakeDeliverable({ id: 'del_xyz' }),
        concepts: [fakeTitleConcept()],
      }),
    );
    expect(html).toContain('hx-post="/deliverables/del_xyz/generate-titles"');
    expect(html).toContain('hx-confirm');
  });
});

describe('ThumbnailWorkshopView', () => {
  it('renders empty state when no concepts', () => {
    const html = toHtml(
      ThumbnailWorkshopView({
        plan: fakePlan(),
        deliverable: fakeDeliverable(),
        concepts: [],
        selectedTitleText: 'Some title',
      }),
    );
    expect(html).toContain('Generate thumbnail concepts first');
  });

  it('warns when no title is selected', () => {
    const html = toHtml(
      ThumbnailWorkshopView({
        plan: fakePlan(),
        deliverable: fakeDeliverable(),
        concepts: [],
        selectedTitleText: null,
      }),
    );
    expect(html).toContain('No title selected');
  });

  it('shows the selected title context above the cards', () => {
    const html = toHtml(
      ThumbnailWorkshopView({
        plan: fakePlan(),
        deliverable: fakeDeliverable(),
        concepts: [fakeThumbnailConcept()],
        selectedTitleText: 'My chosen title',
      }),
    );
    expect(html).toContain('My chosen title');
  });

  it('renders concept cards with palette swatches + text hook', () => {
    const html = toHtml(
      ThumbnailWorkshopView({
        plan: fakePlan(),
        deliverable: fakeDeliverable(),
        concepts: [fakeThumbnailConcept()],
        selectedTitleText: 'x',
      }),
    );
    expect(html).toContain('SAVED IT');
    expect(html).toContain('#0a0a0a');
    expect(html).toContain('#22c55e');
    expect(html).toContain('split: terminal left, headshot right');
  });
});
