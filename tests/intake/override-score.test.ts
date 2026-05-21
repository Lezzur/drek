import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';

vi.mock('../../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() },
}));

import { createFakeFirestore, type FakeFirestore } from '../db/fake-firestore.js';
import { createBrief } from '../../src/intake/service.js';
import { patchPipelineBrief } from '../../src/db/pipeline-briefs.js';
import { overrideScore } from '../../src/intake/override-score.js';
import { IntakeError } from '../../src/intake/errors.js';
import { NeurocoreError } from '../../src/neurocore/errors.js';
import type { NeurocoreClient } from '../../src/neurocore/client.js';
import type { ScoreOverriddenSignal } from '../../src/neurocore/types.js';
import type { BriefScore } from '../../src/db/schemas.js';
import { getCounter, SCORE_OVERRIDES_KEY } from '../../src/db/admin-counters.js';

const ORIGINAL_SCORE: BriefScore = {
  visualOutcome: 4,
  storyPotential: 4,
  scopeFit: 2,
  audienceMatch: 5,
  aggregate: 3.75,
};

let fake: FakeFirestore;
const asDb = () => fake as unknown as Firestore;

interface FakeClient {
  client: NeurocoreClient;
  sent: ScoreOverriddenSignal[];
  failNext: (err: Error) => void;
}

function makeFakeClient(): FakeClient {
  const sent: ScoreOverriddenSignal[] = [];
  let nextError: Error | null = null;
  const client: Partial<NeurocoreClient> = {
    async sendScoreOverridden(payload: ScoreOverriddenSignal) {
      if (nextError) {
        const e = nextError;
        nextError = null;
        throw e;
      }
      sent.push(payload);
    },
  };
  return {
    client: client as NeurocoreClient,
    sent,
    failNext(err: Error) {
      nextError = err;
    },
  };
}

async function seedScoredBrief(score: BriefScore = ORIGINAL_SCORE): Promise<string> {
  const brief = await createBrief({ title: 'T', rawText: 'r' }, asDb());
  await patchPipelineBrief(brief.id, { score }, asDb());
  return brief.id;
}

beforeEach(() => {
  fake = createFakeFirestore();
});

describe('overrideScore', () => {
  it('persists the edited score and fires score.overridden signal with axesChanged', async () => {
    const briefId = await seedScoredBrief();
    const fc = makeFakeClient();
    const edited: BriefScore = { ...ORIGINAL_SCORE, scopeFit: 4, aggregate: 4.25 };

    const result = await overrideScore(
      briefId,
      edited,
      'Scorer underrated — this is a 1-day build',
      'manual override rationale',
      { db: asDb(), client: fc.client },
    );

    expect(result.signalSent).toBe(true);
    expect(result.brief.score?.scopeFit).toBe(4);
    expect(result.brief.score?.aggregate).toBe(4.25);
    expect(result.brief.scoringRationale).toBe('manual override rationale');

    expect(fc.sent).toHaveLength(1);
    const signal = fc.sent[0]!;
    expect(signal.briefId).toBe(briefId);
    expect(signal.axesChanged).toEqual(['scopeFit']);
    expect(signal.reason).toBe('Scorer underrated — this is a 1-day build');
    expect(signal.originalScore.scopeFit).toBe(2);
    expect(signal.editedScore.scopeFit).toBe(4);
  });

  it('omits reason field on the signal when not provided', async () => {
    const briefId = await seedScoredBrief();
    const fc = makeFakeClient();
    const edited: BriefScore = { ...ORIGINAL_SCORE, scopeFit: 3, aggregate: 4.0 };

    await overrideScore(briefId, edited, undefined, null, {
      db: asDb(),
      client: fc.client,
    });

    expect(fc.sent[0]!.reason).toBeUndefined();
  });

  it('reports multiple axesChanged when several scores move', async () => {
    const briefId = await seedScoredBrief();
    const fc = makeFakeClient();
    const edited: BriefScore = {
      ...ORIGINAL_SCORE,
      scopeFit: 4,
      audienceMatch: 4,
      aggregate: 4.0,
    };

    await overrideScore(briefId, edited, undefined, null, {
      db: asDb(),
      client: fc.client,
    });

    expect(fc.sent[0]!.axesChanged.sort()).toEqual(['audienceMatch', 'scopeFit']);
  });

  it('skips the signal on a no-op edit (only rationale changed)', async () => {
    const briefId = await seedScoredBrief();
    const fc = makeFakeClient();
    const result = await overrideScore(
      briefId,
      { ...ORIGINAL_SCORE },
      'no-op',
      'just updating the rationale',
      { db: asDb(), client: fc.client },
    );

    expect(result.signalSent).toBe(false);
    expect(fc.sent).toHaveLength(0);
    // Counter should NOT increment for no-op edits.
    expect(await getCounter(SCORE_OVERRIDES_KEY, asDb())).toBe(0);
  });

  it('skips the signal when the brief had no prior score (first-touch manual score)', async () => {
    const brief = await createBrief({ title: 'T', rawText: 'r' }, asDb());
    const fc = makeFakeClient();

    const result = await overrideScore(
      brief.id,
      {
        visualOutcome: 3,
        storyPotential: 3,
        scopeFit: 3,
        audienceMatch: 3,
        aggregate: 3.0,
      },
      'first manual score',
      null,
      { db: asDb(), client: fc.client },
    );

    expect(result.signalSent).toBe(false);
    expect(fc.sent).toHaveLength(0);
    expect(result.brief.score?.aggregate).toBe(3.0);
  });

  it('persists locally even when the signal fails (best-effort signal-send)', async () => {
    const briefId = await seedScoredBrief();
    const fc = makeFakeClient();
    fc.failNext(
      new NeurocoreError('SERVER_ERROR', '/v1/memory/signals', 'temporary glitch', 503),
    );

    const edited: BriefScore = { ...ORIGINAL_SCORE, scopeFit: 4, aggregate: 4.25 };
    const result = await overrideScore(briefId, edited, undefined, null, {
      db: asDb(),
      client: fc.client,
    });

    expect(result.signalSent).toBe(false);
    expect(result.signalError).toMatch(/SERVER_ERROR/);
    expect(result.brief.score?.scopeFit).toBe(4);
  });

  it('increments the score_overrides counter on successful override', async () => {
    const briefId = await seedScoredBrief();
    const fc = makeFakeClient();
    expect(await getCounter(SCORE_OVERRIDES_KEY, asDb())).toBe(0);

    await overrideScore(
      briefId,
      { ...ORIGINAL_SCORE, scopeFit: 4, aggregate: 4.25 },
      undefined,
      null,
      { db: asDb(), client: fc.client },
    );

    expect(await getCounter(SCORE_OVERRIDES_KEY, asDb())).toBe(1);
  });

  it('throws BRIEF_NOT_FOUND when brief id does not exist', async () => {
    const fc = makeFakeClient();
    try {
      await overrideScore(
        'nonexistent',
        { visualOutcome: 3, storyPotential: 3, scopeFit: 3, audienceMatch: 3, aggregate: 3.0 },
        undefined,
        null,
        { db: asDb(), client: fc.client },
      );
      expect.fail('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(IntakeError);
      expect((err as IntakeError).code).toBe('BRIEF_NOT_FOUND');
    }
  });
});
