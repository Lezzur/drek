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
