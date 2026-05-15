import { describe, it, expect } from 'vitest';
import { ShootInstructionsPage, toPlainText } from '../../src/views/export.js';
import type { Plan, Scene } from '../../src/db/schemas.js';

function fakePlan(overrides: Partial<Plan> = {}): Plan {
  return {
    id: 'plan_1',
    type: 'cover_letter',
    status: 'finalized',
    title: 'Backend Eng at Acme',
    sourceListingId: 'lst_1',
    sourceListingText: 'text',
    requirements: [],
    matchedProjects: [],
    targetRuntimeSeconds: 120,
    estimatedRuntimeSeconds: 0,
    userConstraints: null,
    createdAt: new Date('2026-05-15T10:00:00Z'),
    updatedAt: new Date('2026-05-15T10:00:00Z'),
    exportedAt: null,
    ...overrides,
  };
}

function fakeScene(overrides: Partial<Scene> = {}): Scene {
  return {
    id: 'scene_1',
    planId: 'plan_1',
    order: 1,
    title: 'Intro',
    description: 'd',
    framingNotes: 'Headshot, plain background.',
    script: 'Hi I am Rick.',
    emphasisCues: [],
    pacingNotes: '',
    transitionNote: '',
    estimatedDurationSeconds: 10,
    projectRef: null,
    storyboardImageUrl: null,
    ...overrides,
  };
}

const toHtml = (node: unknown) => String(node);

describe('ShootInstructionsPage', () => {
  it('renders title, type, runtime, and audience callout', () => {
    const html = toHtml(
      ShootInstructionsPage({
        plan: fakePlan({ title: 'Senior Eng at Foo' }),
        scenes: [],
        stale: false,
      }),
    );
    expect(html).toContain('<title>Shoot instructions · Senior Eng at Foo');
    expect(html).toContain('Senior Eng at Foo');
    expect(html).toContain('Cover letter');
    expect(html).toContain('Hiring manager');
  });

  it('renders youtube audience callout for youtube plans', () => {
    const html = toHtml(
      ShootInstructionsPage({
        plan: fakePlan({ type: 'youtube' }),
        scenes: [],
        stale: false,
      }),
    );
    expect(html).toContain('Potential clients');
    expect(html).toContain('outcomes, not technology');
  });

  it('renders one block per scene with framing + script', () => {
    const html = toHtml(
      ShootInstructionsPage({
        plan: fakePlan(),
        scenes: [
          fakeScene({ id: 'a', order: 1, title: 'Open', script: 'Hello.', framingNotes: 'headshot' }),
          fakeScene({ id: 'b', order: 2, title: 'Demo', script: 'Watch this.', framingNotes: 'screenshare' }),
        ],
        stale: false,
      }),
    );
    expect(html).toContain('Open');
    expect(html).toContain('Demo');
    expect(html).toContain('headshot');
    expect(html).toContain('screenshare');
    expect(html).toContain('Hello.');
    expect(html).toContain('Watch this.');
  });

  it('shows the stale-banner when stale=true', () => {
    const html = toHtml(
      ShootInstructionsPage({ plan: fakePlan(), scenes: [], stale: true }),
    );
    expect(html).toContain('stale-banner');
    expect(html).toContain('older than the most recent edit');
  });

  it('hides the stale-banner when not stale', () => {
    const html = toHtml(
      ShootInstructionsPage({ plan: fakePlan(), scenes: [], stale: false }),
    );
    expect(html).not.toContain('older than the most recent edit');
  });

  it('renders pacing and transition notes when present', () => {
    const html = toHtml(
      ShootInstructionsPage({
        plan: fakePlan(),
        scenes: [
          fakeScene({
            pacingNotes: 'Slow on the open.',
            transitionNote: 'Cut to dashboard.',
          }),
        ],
        stale: false,
      }),
    );
    expect(html).toContain('Slow on the open.');
    expect(html).toContain('Cut to dashboard.');
  });

  it('shows total estimated runtime in the summary', () => {
    const html = toHtml(
      ShootInstructionsPage({
        plan: fakePlan({ targetRuntimeSeconds: 120 }),
        scenes: [
          fakeScene({ estimatedDurationSeconds: 30 }),
          fakeScene({ id: 'b', order: 2, estimatedDurationSeconds: 80 }),
        ],
        stale: false,
      }),
    );
    expect(html).toContain('Total estimated runtime: 110s');
    expect(html).toContain('Target: 120s');
  });

  it('includes a print button and plain-text link in the action bar', () => {
    const html = toHtml(
      ShootInstructionsPage({ plan: fakePlan(), scenes: [], stale: false }),
    );
    expect(html).toContain('window.print()');
    expect(html).toContain('href="/plans/plan_1/export.txt"');
  });

  it('back link returns to the plan page', () => {
    const html = toHtml(
      ShootInstructionsPage({ plan: fakePlan(), scenes: [], stale: false }),
    );
    expect(html).toContain('href="/plans/plan_1"');
    expect(html).toContain('Back to plan');
  });
});

describe('toPlainText', () => {
  it('renders title and metadata as a banner block', () => {
    const text = toPlainText(
      fakePlan({ title: 'X' }),
      [fakeScene()],
    );
    expect(text).toContain('SHOOT INSTRUCTIONS — X');
    expect(text).toContain('Type:    Cover letter');
    expect(text).toContain('Runtime: target 120s, estimated 10s');
  });

  it('renders each scene with all sections', () => {
    const text = toPlainText(
      fakePlan(),
      [
        fakeScene({
          order: 1,
          title: 'Intro',
          framingNotes: 'headshot',
          script: 'Hi there.',
          pacingNotes: 'slow',
          transitionNote: 'cut',
          estimatedDurationSeconds: 5,
        }),
      ],
    );
    expect(text).toContain('SCENE #1 · Intro');
    expect(text).toContain('FRAMING: headshot');
    expect(text).toContain('Hi there.');
    expect(text).toContain('PACING: slow');
    expect(text).toContain('→ cut');
  });

  it('uses (no script written yet) fallback for empty scripts', () => {
    const text = toPlainText(
      fakePlan(),
      [fakeScene({ script: '' })],
    );
    expect(text).toContain('(no script written yet)');
  });

  it('omits pacing/transition lines when fields are empty', () => {
    const text = toPlainText(
      fakePlan(),
      [
        fakeScene({
          pacingNotes: '',
          transitionNote: '',
        }),
      ],
    );
    expect(text).not.toContain('PACING:');
    expect(text).not.toContain('→ ');
  });

  it('shows the total runtime footer', () => {
    const text = toPlainText(
      fakePlan({ targetRuntimeSeconds: 60 }),
      [fakeScene({ estimatedDurationSeconds: 30 })],
    );
    expect(text).toContain('Total estimated runtime: 30s (target 60s)');
  });
});
