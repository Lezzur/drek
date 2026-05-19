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
});
