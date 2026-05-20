import { describe, it, expect } from 'vitest';
import {
  BatchOverviewPage,
  NewBatchBriefForm,
} from '../../src/views/intake-batch.js';
import type { PipelineBrief, BriefScore } from '../../src/db/schemas.js';

const toHtml = (node: unknown) => String(node);

function fakeBrief(overrides: Partial<PipelineBrief> = {}): PipelineBrief {
  return {
    id: 'brief_1',
    title: 'Test brief',
    company: null,
    sourceUrl: null,
    rawText: 'body',
    score: null,
    scoringRationale: null,
    stage: 'candidate',
    promotedPlanId: null,
    batchId: 'batch_abc',
    transformedBriefText: null,
    transformedScore: null,
    pinnedTechStack: null,
    createdAt: new Date('2026-05-19T10:00:00Z'),
    updatedAt: new Date('2026-05-19T10:00:00Z'),
    ...overrides,
  };
}

function fakeScore(aggregate = 4.2): BriefScore {
  return {
    visualOutcome: 4,
    storyPotential: 4,
    scopeFit: 4,
    audienceMatch: 5,
    aggregate,
  };
}

describe('NewBatchBriefForm', () => {
  it('renders 3 default empty rows on first load', () => {
    const html = toHtml(NewBatchBriefForm({}));
    expect(html).toContain('Add briefs (batch)');
    expect(html).toContain('Brief #1');
    expect(html).toContain('Brief #2');
    expect(html).toContain('Brief #3');
    expect(html).not.toContain('Brief #4');
    expect(html).toContain('+ Add another brief');
    expect(html).toContain('Score all');
  });

  it('echoes back posted values on validation failure', () => {
    const html = toHtml(
      NewBatchBriefForm({
        values: [
          { title: 'First title', rawText: 'first body' },
          { title: 'Second title', rawText: 'second body', sourceUrl: 'https://upwork.com/jobs/abc' },
        ],
        error: 'at least one row is missing rawText',
      }),
    );
    expect(html).toContain('First title');
    expect(html).toContain('Second title');
    expect(html).toContain('https://upwork.com/jobs/abc');
    expect(html).toContain('at least one row is missing rawText');
    // When echoing 2 rows, only render 2 rows (don't pad).
    expect(html).toContain('Brief #2');
    expect(html).not.toContain('Brief #3');
  });

  it('form posts to /intake/batch', () => {
    const html = toHtml(NewBatchBriefForm({}));
    expect(html).toContain('action="/intake/batch"');
    expect(html).toContain('method="post"');
  });

  it('each row uses indexed naming briefs[N][field]', () => {
    const html = toHtml(NewBatchBriefForm({}));
    expect(html).toContain('name="briefs[0][title]"');
    expect(html).toContain('name="briefs[0][rawText]"');
    expect(html).toContain('name="briefs[1][title]"');
    expect(html).toContain('name="briefs[2][rawText]"');
  });
});

describe('BatchOverviewPage — in-progress state', () => {
  it('shows scoring count and HTMX polling trigger when any brief is unscored', () => {
    const html = toHtml(
      BatchOverviewPage({
        batchId: 'batch_x123',
        briefs: [
          fakeBrief({ id: 'b1', title: 'First', score: fakeScore() }),
          fakeBrief({ id: 'b2', title: 'Second', score: null }),
          fakeBrief({ id: 'b3', title: 'Third', score: null }),
        ],
      }),
    );
    expect(html).toContain('Scoring 2 / 3');
    expect(html).toContain('hx-trigger="every 2s"');
    expect(html).toContain('hx-get="/intake/batch/batch_x123"');
    expect(html).toContain('scoring…');
  });

  it('per-row links open the detail page', () => {
    const html = toHtml(
      BatchOverviewPage({
        batchId: 'b',
        briefs: [fakeBrief({ id: 'brief_z', title: 'Linkable' })],
      }),
    );
    expect(html).toContain('href="/intake/brief_z"');
    expect(html).toContain('Linkable');
  });
});

describe('BatchOverviewPage — all-scored state', () => {
  it('drops the polling trigger and shows All scored', () => {
    const html = toHtml(
      BatchOverviewPage({
        batchId: 'batch_done',
        briefs: [
          fakeBrief({ id: 'b1', title: 'A', score: fakeScore(4.5) }),
          fakeBrief({ id: 'b2', title: 'B', score: fakeScore(2.8) }),
        ],
      }),
    );
    expect(html).toContain('✓ All scored');
    expect(html).not.toContain('hx-trigger');
    // Per-row score breakdown rendered.
    expect(html).toContain('4.5');
    expect(html).toContain('2.8');
    expect(html).toContain('VO 4 · SP 4 · SF 4 · AM 5');
  });

  it('color-codes aggregate green/amber/red by threshold', () => {
    // green: aggregate >= 4
    const greenHtml = toHtml(
      BatchOverviewPage({
        batchId: 'b',
        briefs: [fakeBrief({ score: fakeScore(4.5) })],
      }),
    );
    expect(greenHtml).toContain('var(--green-fg)');

    // amber: 3 <= aggregate < 4
    const amberHtml = toHtml(
      BatchOverviewPage({
        batchId: 'b',
        briefs: [fakeBrief({ score: fakeScore(3.2) })],
      }),
    );
    expect(amberHtml).toContain('var(--amber-fg)');

    // red: aggregate < 3
    const redHtml = toHtml(
      BatchOverviewPage({
        batchId: 'b',
        briefs: [fakeBrief({ score: fakeScore(2.5) })],
      }),
    );
    expect(redHtml).toContain('var(--danger)');
  });
});

describe('BatchOverviewPage — navigation', () => {
  it('back link to /intake', () => {
    const html = toHtml(
      BatchOverviewPage({ batchId: 'b', briefs: [fakeBrief()] }),
    );
    expect(html).toContain('href="/intake"');
    expect(html).toContain('Intake pipeline');
  });

  it('renders empty state when no briefs in batch', () => {
    const html = toHtml(
      BatchOverviewPage({ batchId: 'b_empty', briefs: [] }),
    );
    expect(html).toContain('No briefs in this batch');
  });
});
