import { describe, it, expect } from 'vitest';
import { ShortsCandidateView } from '../../src/views/shorts-candidates.js';
import type { Plan } from '../../src/db/schemas.js';
import type { ShortCandidate } from '../../src/engine/extract-shorts.js';

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

function fakeCandidate(overrides: Partial<ShortCandidate> = {}): ShortCandidate {
  return {
    id: 'short_abc',
    sourceSceneIds: ['scene_demo'],
    cutWindow: { startLine: 1, endLine: 8 },
    reworkedScript: Array.from({ length: 180 }, (_, i) => `word${i}`).join(' '),
    hookText: 'You will not believe what shipped today.',
    verticalReframingNotes: 'Tight on terminal; preserve face top-right.',
    suggestedTitleHint: 'Shipped in 60 seconds',
    suggestedThumbnailHint: 'Big red SHIPPED text over terminal',
    beatImportanceScore: 9,
    ...overrides,
  };
}

describe('ShortsCandidateView — empty state', () => {
  it('shows extract CTA and "no candidates yet" when cache empty', () => {
    const html = toHtml(
      ShortsCandidateView({
        plan: fakePlan(),
        candidates: [],
        sceneTitlesById: {},
      }),
    );
    expect(html).toContain('Shorts · Test Plan');
    expect(html).toContain('Extract Shorts candidates');
    expect(html).toContain('No Shorts candidates yet');
    expect(html).toContain('hx-post="/plans/plan_1/extract-shorts"');
  });
});

describe('ShortsCandidateView — with candidates', () => {
  it('renders candidate card with hook + beat score + script + reframing notes', () => {
    const html = toHtml(
      ShortsCandidateView({
        plan: fakePlan(),
        candidates: [fakeCandidate()],
        sceneTitlesById: { scene_demo: 'Demo scene' },
      }),
    );
    expect(html).toContain('You will not believe what shipped today.');
    expect(html).toContain('9/10');
    expect(html).toContain('beat score');
    expect(html).toContain('Demo scene');
    expect(html).toContain('Tight on terminal; preserve face top-right.');
    expect(html).toContain('Shipped in 60 seconds');
    expect(html).toContain('Big red SHIPPED text');
  });

  it('shows approve + dismiss buttons on each card', () => {
    const html = toHtml(
      ShortsCandidateView({
        plan: fakePlan(),
        candidates: [fakeCandidate({ id: 'short_xyz' })],
        sceneTitlesById: {},
      }),
    );
    expect(html).toContain('hx-post="/plans/plan_1/approve-short"');
    expect(html).toContain('hx-post="/plans/plan_1/dismiss-short"');
    expect(html).toContain('name="candidateId" value="short_xyz"');
    expect(html).toContain('Approve');
    expect(html).toContain('Dismiss');
  });

  it('reworked script textarea is editable (override field)', () => {
    const html = toHtml(
      ShortsCandidateView({
        plan: fakePlan(),
        candidates: [fakeCandidate()],
        sceneTitlesById: {},
      }),
    );
    expect(html).toContain('name="reworkedScriptOverride"');
    expect(html).toContain('<textarea');
  });

  it('re-extract button uses hx-indicator + hx-disabled-elt when candidates already exist', () => {
    const html = toHtml(
      ShortsCandidateView({
        plan: fakePlan(),
        candidates: [fakeCandidate()],
        sceneTitlesById: {},
      }),
    );
    expect(html).toContain('Re-extract candidates');
    // UX pattern: swap the hx-confirm modal for an inline disable + spinner.
    expect(html).toContain('hx-indicator="#shorts-indicator"');
    expect(html).toContain('hx-disabled-elt="this"');
  });

  it('back link points to plan', () => {
    const html = toHtml(
      ShortsCandidateView({
        plan: fakePlan({ id: 'plan_xyz' }),
        candidates: [],
        sceneTitlesById: {},
      }),
    );
    expect(html).toContain('href="/plans/plan_xyz"');
    expect(html).toContain('Back to plan');
  });

  it('renders multiple cards in grid', () => {
    const html = toHtml(
      ShortsCandidateView({
        plan: fakePlan(),
        candidates: [
          fakeCandidate({ id: 'a', hookText: 'First hook' }),
          fakeCandidate({ id: 'b', hookText: 'Second hook' }),
          fakeCandidate({ id: 'c', hookText: 'Third hook' }),
        ],
        sceneTitlesById: {},
      }),
    );
    expect(html).toContain('First hook');
    expect(html).toContain('Second hook');
    expect(html).toContain('Third hook');
    expect(html).toContain('id="candidate-a"');
    expect(html).toContain('id="candidate-b"');
    expect(html).toContain('id="candidate-c"');
  });
});
