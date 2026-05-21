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
});
