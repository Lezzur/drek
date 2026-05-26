import { describe, it, expect } from 'vitest';
import { IntakeListPage } from '../../src/views/intake.js';
import type { PipelineBrief, BriefScore } from '../../src/db/schemas.js';

const toHtml = (node: unknown) => String(node);

function fakeBrief(overrides: Partial<PipelineBrief> = {}): PipelineBrief {
  return {
    id: 'brief_1',
    title: 'Build a RAG dashboard',
    company: 'Acme',
    sourceUrl: null,
    rawText: 'Body text here',
    score: null,
    scoringRationale: null,
    stage: 'candidate',
    promotedPlanId: null,
    batchId: null,
    transformedBriefText: null,
    transformedScore: null,
    pinnedTechStack: null,
    transformedBuildPlan: null,
    createdAt: new Date('2026-05-01T00:00:00Z'),
    updatedAt: new Date('2026-05-01T00:00:00Z'),
    ...overrides,
  };
}

function fakeScore(): BriefScore {
  return {
    visualOutcome: 4,
    storyPotential: 4,
    scopeFit: 3,
    audienceMatch: 5,
    aggregate: 4.0,
  };
}

describe('IntakeListPage', () => {
  it('renders empty state when no briefs', () => {
    const html = toHtml(IntakeListPage({ briefs: [], queueDepth: 0 }));
    expect(html).toContain('No briefs yet');
    expect(html).toContain('Intake pipeline');
  });

  it('shows queue depth warning when candidate+vetted < 3', () => {
    const html = toHtml(IntakeListPage({ briefs: [], queueDepth: 2 }));
    expect(html).toContain('Pipeline thin');
    expect(html).toContain('2 briefs');
  });

  it('does NOT show queue depth warning when candidate+vetted >= 3', () => {
    const html = toHtml(IntakeListPage({ briefs: [], queueDepth: 5 }));
    expect(html).not.toContain('Pipeline thin');
  });

  it('renders multiple brief rows', () => {
    const briefs = [
      fakeBrief({ id: 'brief_1', title: 'First brief' }),
      fakeBrief({ id: 'brief_2', title: 'Second brief' }),
      fakeBrief({ id: 'brief_3', title: 'Third brief' }),
    ];
    const html = toHtml(IntakeListPage({ briefs, queueDepth: 5 }));
    expect(html).toContain('First brief');
    expect(html).toContain('Second brief');
    expect(html).toContain('Third brief');
    expect(html).toContain('href="/intake/brief_1"');
    expect(html).toContain('href="/intake/brief_2"');
  });

  it('highlights active stage pill', () => {
    const html = toHtml(
      IntakeListPage({ briefs: [], queueDepth: 5, currentStage: 'vetted' }),
    );
    // The vetted pill should have the active background style
    expect(html).toContain('stage=vetted');
    // Active pill uses the primary (ink) color
    expect(html).toMatch(/stage=vetted[^"]*"[^>]*style="[^"]*background:var\(--ink\)/);
  });

  it('"Add brief" button links to /intake/new', () => {
    const html = toHtml(IntakeListPage({ briefs: [], queueDepth: 5 }));
    expect(html).toContain('href="/intake/new"');
    expect(html).toContain('Add brief');
  });

  it('renders score aggregate badge when score is set', () => {
    const scored = fakeBrief({ score: fakeScore() });
    const html = toHtml(IntakeListPage({ briefs: [scored], queueDepth: 5 }));
    expect(html).toContain('4.0');
  });

  // ---- M26.5 column layout + multi-select ----

  it('renders the column header row with Score / Status / Actions labels', () => {
    const html = toHtml(IntakeListPage({ briefs: [fakeBrief()], queueDepth: 5 }));
    expect(html).toContain('>Brief<');
    expect(html).toContain('>Score<');
    expect(html).toContain('>Status<');
    expect(html).toContain('>Actions<');
  });

  it('renders a checkbox per row with name=briefIds and the brief id as value', () => {
    const briefs = [
      fakeBrief({ id: 'brief_a', title: 'A' }),
      fakeBrief({ id: 'brief_b', title: 'B' }),
    ];
    const html = toHtml(IntakeListPage({ briefs, queueDepth: 5 }));
    expect(html).toContain('name="briefIds" value="brief_a"');
    expect(html).toContain('name="briefIds" value="brief_b"');
    // No select-all checkbox in the header — per Rick 2026-05-22 UX
    expect(html).not.toContain('id="brief-select-all"');
  });

  it('renders the bulk action bar (space reserved; visibility toggled via JS)', () => {
    const html = toHtml(IntakeListPage({ briefs: [fakeBrief()], queueDepth: 5 }));
    expect(html).toContain('id="bulk-action-bar"');
    expect(html).toContain('Retire selected');
    expect(html).toContain('Delete selected');
    expect(html).toContain('data-bulk-action="retire"');
    expect(html).toContain('data-bulk-action="delete"');
    // Space is always reserved (display:flex) — visibility starts hidden
    // so the page doesn't shift when the first checkbox flips on.
    expect(html).toMatch(/id="bulk-action-bar"[^>]*style="[^"]*display:flex/);
    expect(html).toMatch(/id="bulk-action-bar"[^>]*style="[^"]*visibility:hidden/);
  });

  it('embeds the bulk-action client script', () => {
    const html = toHtml(IntakeListPage({ briefs: [fakeBrief()], queueDepth: 5 }));
    expect(html).toContain('/intake/bulk-action');
    expect(html).toContain('selectedIds');
    expect(html).toContain('bulk-selected-count');
  });

  it('shows em-dash placeholder for unscored briefs in the score column', () => {
    const unscored = fakeBrief({ score: null });
    const html = toHtml(IntakeListPage({ briefs: [unscored], queueDepth: 5 }));
    // The score column is centered + has the em-dash for null-score briefs
    expect(html).toMatch(/>—</);
  });

  it('"Add batch" button is visible alongside "Add brief"', () => {
    const html = toHtml(IntakeListPage({ briefs: [], queueDepth: 5 }));
    expect(html).toContain('href="/intake/batch/new"');
    expect(html).toContain('Add batch');
  });

  // ---- M35 transformable column (yes / no / em-dash) ----

  it('renders the Transformable column header', () => {
    const html = toHtml(IntakeListPage({ briefs: [fakeBrief()], queueDepth: 5 }));
    expect(html).toContain('>Transformable<');
  });

  it('renders "yes" when score passes the gate', () => {
    const passing = fakeBrief({
      id: 'pass',
      score: {
        visualOutcome: 4,
        storyPotential: 4,
        scopeFit: 4,
        audienceMatch: 4,
        aggregate: 4.0,
      },
    });
    const html = toHtml(IntakeListPage({ briefs: [passing], queueDepth: 5 }));
    expect(html).toMatch(/>yes</);
  });

  it('renders "no" when scopeFit < 2.0', () => {
    const blocked = fakeBrief({
      id: 'blocked-scope',
      score: {
        visualOutcome: 5,
        storyPotential: 5,
        scopeFit: 1,
        audienceMatch: 5,
        aggregate: 4.0,
      },
    });
    const html = toHtml(IntakeListPage({ briefs: [blocked], queueDepth: 5 }));
    expect(html).toMatch(/>no</);
    // Hover-title spells out which axis is the problem.
    expect(html).toContain('Blocked by transformer gate: scope');
  });

  it('renders "no" when audienceMatch < 3.0', () => {
    const blocked = fakeBrief({
      id: 'blocked-audience',
      score: {
        visualOutcome: 4,
        storyPotential: 4,
        scopeFit: 4,
        audienceMatch: 2,
        aggregate: 3.5,
      },
    });
    const html = toHtml(IntakeListPage({ briefs: [blocked], queueDepth: 5 }));
    expect(html).toMatch(/>no</);
    expect(html).toContain('Blocked by transformer gate: audience');
  });

  it('hover-title lists both axes when both fail', () => {
    const blocked = fakeBrief({
      id: 'blocked-both',
      score: {
        visualOutcome: 5,
        storyPotential: 5,
        scopeFit: 1,
        audienceMatch: 1,
        aggregate: 3.0,
      },
    });
    const html = toHtml(IntakeListPage({ briefs: [blocked], queueDepth: 5 }));
    expect(html).toContain('Blocked by transformer gate: scope, audience');
  });

  it('renders "yes" for the 4/4/2/5 multi-day-series brief (M35 gate)', () => {
    const ricks = fakeBrief({
      id: 'ricks-brief',
      score: {
        visualOutcome: 4,
        storyPotential: 4,
        scopeFit: 2,
        audienceMatch: 5,
        aggregate: 3.75,
      },
    });
    const html = toHtml(IntakeListPage({ briefs: [ricks], queueDepth: 5 }));
    expect(html).toMatch(/>yes</);
  });

  // ---- M35 score-overrides counter + threshold banner ----

  it('renders Score overrides counter when below threshold', () => {
    const html = toHtml(
      IntakeListPage({ briefs: [], queueDepth: 5, scoreOverrideCount: 7 }),
    );
    expect(html).toContain('Score overrides: 7/15');
  });

  it('renders the score-review banner when overrides reach the threshold', () => {
    const html = toHtml(
      IntakeListPage({ briefs: [], queueDepth: 5, scoreOverrideCount: 16 }),
    );
    expect(html).toContain('16 score overrides reached');
    expect(html).toContain('score.overridden');
    // Counter pill hides once the banner takes over
    expect(html).not.toContain('Score overrides: 16/15');
  });

  // ---- M36 findings badge ----

  it('renders no findings badge when findingBadges is empty', () => {
    const html = toHtml(
      IntakeListPage({
        briefs: [fakeBrief({ id: 'brief_x', title: 'X' })],
        queueDepth: 1,
      }),
    );
    expect(html).not.toContain('findings');
    expect(html).not.toContain('⚠');
  });

  it('renders findings badge with singular noun for count of 1', () => {
    const html = toHtml(
      IntakeListPage({
        briefs: [fakeBrief({ id: 'brief_x', title: 'X' })],
        queueDepth: 1,
        findingBadges: { brief_x: 1 },
      }),
    );
    expect(html).toContain('1 finding');
    expect(html).not.toContain('1 findings');
  });

  it('renders findings badge with plural noun for count > 1', () => {
    const html = toHtml(
      IntakeListPage({
        briefs: [fakeBrief({ id: 'brief_x', title: 'X' })],
        queueDepth: 1,
        findingBadges: { brief_x: 3 },
      }),
    );
    expect(html).toContain('3 findings');
  });

  it('renders badge only on briefs present in findingBadges map', () => {
    const html = toHtml(
      IntakeListPage({
        briefs: [
          fakeBrief({ id: 'brief_a', title: 'A' }),
          fakeBrief({ id: 'brief_b', title: 'B' }),
        ],
        queueDepth: 2,
        findingBadges: { brief_a: 2 },
      }),
    );
    expect(html).toContain('2 findings');
    // Badge appears exactly once (for brief_a), not for brief_b
    expect((html.match(/findings</g) ?? []).length).toBe(1);
  });

  it('does not render badge for briefs with count 0 in findingBadges map', () => {
    const html = toHtml(
      IntakeListPage({
        briefs: [fakeBrief({ id: 'brief_x', title: 'X' })],
        queueDepth: 1,
        findingBadges: { brief_x: 0 },
      }),
    );
    expect(html).not.toContain('findings');
    expect(html).not.toContain('⚠');
  });
});
