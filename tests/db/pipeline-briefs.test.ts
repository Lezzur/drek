import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';

vi.mock('../../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() },
}));

import { createFakeFirestore, type FakeFirestore } from './fake-firestore.js';
import {
  createPipelineBrief,
  getPipelineBrief,
  listPipelineBriefs,
  patchPipelineBrief,
  countBriefsByStage,
} from '../../src/db/pipeline-briefs.js';

let fake: FakeFirestore;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asDb = () => fake as unknown as Firestore;

const RAW_TEXT =
  'Build a real-time analytics dashboard for a SaaS platform. The dashboard should show user metrics, churn rate, MRR, and session recordings. Tech stack is React + Node + Postgres.';

beforeEach(() => {
  fake = createFakeFirestore();
});

describe('createPipelineBrief', () => {
  it('creates a brief with candidate stage by default', async () => {
    const b = await createPipelineBrief(
      { title: 'Analytics Dashboard SaaS', rawText: RAW_TEXT },
      asDb(),
    );
    expect(b.id).toMatch(/^brief_/);
    expect(b.stage).toBe('candidate');
    expect(b.title).toBe('Analytics Dashboard SaaS');
    expect(b.score).toBeNull();
    expect(b.scoringRationale).toBeNull();
    expect(b.promotedPlanId).toBeNull();
    expect(b.company).toBeNull();
    expect(b.sourceUrl).toBeNull();
    expect(b.createdAt).toBeInstanceOf(Date);
    expect(b.updatedAt).toBeInstanceOf(Date);
  });

  it('honors an explicit stage', async () => {
    const b = await createPipelineBrief(
      { title: 'Already Vetted', rawText: RAW_TEXT, stage: 'vetted' },
      asDb(),
    );
    expect(b.stage).toBe('vetted');
  });

  it('stores optional fields when provided', async () => {
    const b = await createPipelineBrief(
      {
        title: 'With Company',
        rawText: RAW_TEXT,
        company: 'Acme Corp',
        sourceUrl: 'https://upwork.com/jobs/xyz',
      },
      asDb(),
    );
    expect(b.company).toBe('Acme Corp');
    expect(b.sourceUrl).toBe('https://upwork.com/jobs/xyz');
  });
});

describe('getPipelineBrief', () => {
  it('returns null when the brief does not exist', async () => {
    expect(await getPipelineBrief('brief_missing', asDb())).toBeNull();
  });

  it('round-trips a created brief', async () => {
    const created = await createPipelineBrief(
      { title: 'Round Trip Brief', rawText: RAW_TEXT },
      asDb(),
    );
    const fetched = await getPipelineBrief(created.id, asDb());
    expect(fetched?.id).toBe(created.id);
    expect(fetched?.title).toBe('Round Trip Brief');
    expect(fetched?.stage).toBe('candidate');
  });
});

describe('listPipelineBriefs', () => {
  it('returns all briefs sorted by updatedAt desc by default', async () => {
    const b1 = await createPipelineBrief(
      { title: 'Brief 1', rawText: RAW_TEXT },
      asDb(),
    );
    await new Promise((r) => setTimeout(r, 5));
    const b2 = await createPipelineBrief(
      { title: 'Brief 2', rawText: RAW_TEXT },
      asDb(),
    );
    const list = await listPipelineBriefs({}, asDb());
    expect(list).toHaveLength(2);
    // Newest first
    expect(list[0]!.id).toBe(b2.id);
    expect(list[1]!.id).toBe(b1.id);
  });

  it('filters by stage', async () => {
    await createPipelineBrief(
      { title: 'Candidate Brief', rawText: RAW_TEXT, stage: 'candidate' },
      asDb(),
    );
    const vetted = await createPipelineBrief(
      { title: 'Vetted Brief', rawText: RAW_TEXT, stage: 'vetted' },
      asDb(),
    );
    const list = await listPipelineBriefs({ stage: 'vetted' }, asDb());
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(vetted.id);
  });

  it('sorts by aggregate score desc when sortBy=aggregate', async () => {
    const b1 = await createPipelineBrief(
      {
        title: 'Low Score Brief',
        rawText: RAW_TEXT,
        score: { visualOutcome: 2, storyPotential: 2, scopeFit: 2, audienceMatch: 2, aggregate: 2.0 },
      },
      asDb(),
    );
    const b2 = await createPipelineBrief(
      {
        title: 'High Score Brief',
        rawText: RAW_TEXT,
        score: { visualOutcome: 5, storyPotential: 5, scopeFit: 4, audienceMatch: 5, aggregate: 4.8 },
      },
      asDb(),
    );
    const list = await listPipelineBriefs({ sortBy: 'aggregate' }, asDb());
    expect(list[0]!.id).toBe(b2.id);
    expect(list[1]!.id).toBe(b1.id);
  });
});

describe('patchPipelineBrief', () => {
  it('returns null when the brief does not exist', async () => {
    expect(await patchPipelineBrief('brief_nope', { title: 'X' }, asDb())).toBeNull();
  });

  it('updates stage and title and bumps updatedAt', async () => {
    const b = await createPipelineBrief(
      { title: 'Original Title', rawText: RAW_TEXT },
      asDb(),
    );
    const before = b.updatedAt.getTime();
    await new Promise((r) => setTimeout(r, 5));
    const patched = await patchPipelineBrief(b.id, { title: 'Revised Title', stage: 'vetted' }, asDb());
    expect(patched?.title).toBe('Revised Title');
    expect(patched?.stage).toBe('vetted');
    expect(patched!.updatedAt.getTime()).toBeGreaterThan(before);
  });

  it('can attach a score via patch', async () => {
    const b = await createPipelineBrief(
      { title: 'Unscored Brief', rawText: RAW_TEXT },
      asDb(),
    );
    const score = { visualOutcome: 4, storyPotential: 3, scopeFit: 5, audienceMatch: 4, aggregate: 4.0 };
    const patched = await patchPipelineBrief(b.id, { score, scoringRationale: 'Good visual potential.' }, asDb());
    expect(patched?.score?.aggregate).toBe(4.0);
    expect(patched?.scoringRationale).toBe('Good visual potential.');
  });
});

describe('countBriefsByStage', () => {
  it('returns zero counts for all 6 stages when no briefs exist', async () => {
    const counts = await countBriefsByStage(asDb());
    expect(counts.candidate).toBe(0);
    expect(counts.vetted).toBe(0);
    expect(counts.selected).toBe(0);
    expect(counts.in_production).toBe(0);
    expect(counts.published).toBe(0);
    expect(counts.retired).toBe(0);
  });

  it('accurately counts briefs per stage', async () => {
    await createPipelineBrief({ title: 'C1', rawText: RAW_TEXT, stage: 'candidate' }, asDb());
    await createPipelineBrief({ title: 'C2', rawText: RAW_TEXT, stage: 'candidate' }, asDb());
    await createPipelineBrief({ title: 'C3', rawText: RAW_TEXT, stage: 'candidate' }, asDb());
    await createPipelineBrief({ title: 'V1', rawText: RAW_TEXT, stage: 'vetted' }, asDb());
    await createPipelineBrief({ title: 'V2', rawText: RAW_TEXT, stage: 'vetted' }, asDb());
    await createPipelineBrief({ title: 'S1', rawText: RAW_TEXT, stage: 'selected' }, asDb());

    const counts = await countBriefsByStage(asDb());
    expect(counts.candidate).toBe(3);
    expect(counts.vetted).toBe(2);
    expect(counts.selected).toBe(1);
    expect(counts.in_production).toBe(0);
    expect(counts.published).toBe(0);
    expect(counts.retired).toBe(0);
  });
});
