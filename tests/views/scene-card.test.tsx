import { describe, it, expect } from 'vitest';
import { SceneCard, SceneList } from '../../src/views/scene-card.js';
import type { Scene } from '../../src/db/schemas.js';

function fakeScene(overrides: Partial<Scene> = {}): Scene {
  return {
    id: 'scene_1',
    planId: 'plan_1',
    order: 1,
    title: 'Intro',
    description: 'desc',
    framingNotes: 'headshot',
    script: 'Hi I am Rick.',
    scriptDraft: 'Hi I am Rick.',
    emphasisCues: [],
    pacingNotes: 'slow',
    transitionNote: 'cut',
    estimatedDurationSeconds: 12,
    projectRef: null,
    storyboardImageUrl: null,
    ...overrides,
  };
}

const toHtml = (node: unknown) => String(node);

describe('SceneCard', () => {
  it('renders the scene number, title, and fields', () => {
    const html = toHtml(
      SceneCard({
        planId: 'plan_1',
        scene: fakeScene(),
        isFirst: true,
        isLast: false,
      }),
    );
    expect(html).toContain('id="scene-scene_1"');
    expect(html).toContain('#1');
    expect(html).toContain('Intro');
    expect(html).toContain('Hi I am Rick.');
    expect(html).toContain('12s');
  });

  it('disables move-up when isFirst is true', () => {
    const html = toHtml(
      SceneCard({
        planId: 'plan_1',
        scene: fakeScene(),
        isFirst: true,
        isLast: false,
      }),
    );
    // Two arrow buttons exist; the first one (up) should carry `disabled`.
    expect(html.indexOf('▲')).toBeGreaterThan(-1);
    // Crude check: the disabled attribute appears in the move-up button.
    expect(html).toMatch(/move-up[\s\S]*disabled[\s\S]*▲|disabled[\s\S]*move-up/);
  });

  it('disables move-down when isLast is true', () => {
    const html = toHtml(
      SceneCard({
        planId: 'plan_1',
        scene: fakeScene(),
        isFirst: false,
        isLast: true,
      }),
    );
    expect(html).toContain('▼');
    expect(html).toMatch(/move-down[\s\S]*disabled|disabled[\s\S]*move-down/);
  });

  it('shows projectRef when present', () => {
    const html = toHtml(
      SceneCard({
        planId: 'plan_1',
        scene: fakeScene({ projectRef: 'lead-pipeline' }),
        isFirst: false,
        isLast: false,
      }),
    );
    expect(html).toContain('Featuring project');
    expect(html).toContain('lead-pipeline');
  });

  it('renders the inline-edit textarea when editField is set', () => {
    const html = toHtml(
      SceneCard({
        planId: 'plan_1',
        scene: fakeScene(),
        editField: 'script',
        isFirst: false,
        isLast: false,
      }),
    );
    expect(html).toContain('<textarea');
    expect(html).toContain('name="value"');
    expect(html).toContain('Hi I am Rick.');
    expect(html).toContain('Auto-saves on blur');
  });

  it('only renders edit mode for the requested field', () => {
    // editField=title means only the title row is editable; script stays
    // in display mode.
    const html = toHtml(
      SceneCard({
        planId: 'plan_1',
        scene: fakeScene(),
        editField: 'title',
        isFirst: false,
        isLast: false,
      }),
    );
    // Title row has the textarea (containing 'Intro').
    expect(html).toContain('<textarea');
    // Other rows are still clickable swap targets (have hx-get edit URL).
    expect(html).toContain('field=script');
  });

  it('has a delete button wired to DELETE the scene endpoint', () => {
    const html = toHtml(
      SceneCard({
        planId: 'plan_1',
        scene: fakeScene(),
        isFirst: false,
        isLast: false,
      }),
    );
    expect(html).toContain('hx-delete="/plans/plan_1/scenes/scene_1"');
    expect(html).toContain('hx-confirm');
  });
});

describe('SceneList', () => {
  it('renders the empty state when no scenes', () => {
    const html = toHtml(SceneList({ planId: 'plan_1', scenes: [] }));
    expect(html).toContain('No scenes yet');
    expect(html).toContain('Add blank scene');
  });

  it('renders a card per scene with sequential numbering', () => {
    const html = toHtml(
      SceneList({
        planId: 'plan_1',
        scenes: [
          fakeScene({ id: 'a', order: 1, title: 'First' }),
          fakeScene({ id: 'b', order: 2, title: 'Second' }),
          fakeScene({ id: 'c', order: 3, title: 'Third' }),
        ],
      }),
    );
    expect(html).toContain('First');
    expect(html).toContain('Second');
    expect(html).toContain('Third');
    expect(html).toContain('id="scene-a"');
    expect(html).toContain('id="scene-b"');
    expect(html).toContain('id="scene-c"');
  });

  it('wraps the list in #scene-list for HTMX swaps', () => {
    const html = toHtml(
      SceneList({ planId: 'plan_1', scenes: [fakeScene()] }),
    );
    expect(html).toContain('id="scene-list"');
  });

  it('exposes the add-blank-scene button at the bottom of a non-empty list', () => {
    const html = toHtml(
      SceneList({ planId: 'plan_1', scenes: [fakeScene()] }),
    );
    expect(html).toContain('hx-post="/plans/plan_1/scenes"');
    expect(html).toContain('+ Add blank scene');
  });
});
