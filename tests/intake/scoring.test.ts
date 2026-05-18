import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';

vi.mock('../../src/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  },
}));

import { createFakeFirestore, type FakeFirestore } from '../db/fake-firestore.js';
import { createBrief } from '../../src/intake/service.js';
import { scoreBriefViaLLM } from '../../src/intake/scoring.js';
import { IntakeError } from '../../src/intake/errors.js';
import { LLMProviderError, type LLMProvider } from '../../src/providers/index.js';

let fake: FakeFirestore;
const asDb = () => fake as unknown as Firestore;

function makeProvider(responses: Array<string | { throws: Error }>): LLMProvider {
  const queue = [...responses];
  return {
    name: 'claude' as const,
    async generate() {
      const next = queue.shift();
      if (next === undefined) {
        throw new Error('mock provider exhausted — test queued too few responses');
      }
      if (typeof next === 'object' && 'throws' in next) throw next.throws;
      return next;
    },
  };
}

const SAMPLE_SCORE_JSON = JSON.stringify({
  visualOutcome: 4,
  storyPotential: 4,
  scopeFit: 3,
  audienceMatch: 5,
  rationale: 'Strong AI angle with a visible UI demo; tight 4-hour scope.',
});

beforeEach(() => {
  fake = createFakeFirestore();
});

describe('scoreBriefViaLLM — happy path', () => {
  it('parses LLM output, computes aggregate, persists to brief', async () => {
    const brief = await createBrief(
      { title: 'Build a RAG dashboard', rawText: 'long body' },
      asDb(),
    );
    const provider = makeProvider([SAMPLE_SCORE_JSON]);

    const result = await scoreBriefViaLLM(brief.id, { provider, db: asDb() });

    expect(result.score.visualOutcome).toBe(4);
    expect(result.score.aggregate).toBe(4); // (4+4+3+5)/4 = 4.0
    expect(result.rationale).toContain('AI angle');
    expect(result.retried).toBe(false);

    // Persisted.
    const persisted = fake._dump()[`pipeline_briefs/${brief.id}`] as Record<string, unknown>;
    const persistedScore = persisted.score as Record<string, unknown>;
    expect(persistedScore.aggregate).toBe(4);
  });

  it('strips ```json fences from LLM output', async () => {
    const brief = await createBrief({ title: 'T', rawText: 'r' }, asDb());
    const fenced = '```json\n' + SAMPLE_SCORE_JSON + '\n```';
    const provider = makeProvider([fenced]);
    const result = await scoreBriefViaLLM(brief.id, { provider, db: asDb() });
    expect(result.score.visualOutcome).toBe(4);
  });

  it('rounds aggregate to one decimal', async () => {
    const brief = await createBrief({ title: 'T', rawText: 'r' }, asDb());
    const provider = makeProvider([
      JSON.stringify({
        visualOutcome: 3,
        storyPotential: 4,
        scopeFit: 4,
        audienceMatch: 5,
        rationale: 'good',
      }),
    ]);
    const result = await scoreBriefViaLLM(brief.id, { provider, db: asDb() });
    // (3+4+4+5)/4 = 4.0
    expect(result.score.aggregate).toBe(4);
  });
});

describe('scoreBriefViaLLM — retry path', () => {
  it('retries once on bad JSON, succeeds on second attempt', async () => {
    const brief = await createBrief({ title: 'T', rawText: 'r' }, asDb());
    const provider = makeProvider(['not valid json', SAMPLE_SCORE_JSON]);

    const result = await scoreBriefViaLLM(brief.id, { provider, db: asDb() });
    expect(result.retried).toBe(true);
    expect(result.score.visualOutcome).toBe(4);
  });

  it('throws INVALID_OUTPUT after two failed parses', async () => {
    const brief = await createBrief({ title: 'T', rawText: 'r' }, asDb());
    const provider = makeProvider(['garbage', 'still garbage']);

    try {
      await scoreBriefViaLLM(brief.id, { provider, db: asDb() });
      expect.fail('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(IntakeError);
      expect((err as IntakeError).code).toBe('INVALID_OUTPUT');
    }
  });

  it('throws INVALID_OUTPUT when schema validation fails twice', async () => {
    const brief = await createBrief({ title: 'T', rawText: 'r' }, asDb());
    // Both responses have a 0 score, which violates the 1-5 bound.
    const badShape = JSON.stringify({
      visualOutcome: 0,
      storyPotential: 3,
      scopeFit: 3,
      audienceMatch: 3,
      rationale: 'r',
    });
    const provider = makeProvider([badShape, badShape]);
    try {
      await scoreBriefViaLLM(brief.id, { provider, db: asDb() });
      expect.fail('should throw');
    } catch (err) {
      expect((err as IntakeError).code).toBe('INVALID_OUTPUT');
    }
  });
});

describe('scoreBriefViaLLM — failure paths', () => {
  it('throws BRIEF_NOT_FOUND when the brief does not exist', async () => {
    const provider = makeProvider([SAMPLE_SCORE_JSON]);
    try {
      await scoreBriefViaLLM('missing', { provider, db: asDb() });
      expect.fail('should throw');
    } catch (err) {
      expect((err as IntakeError).code).toBe('BRIEF_NOT_FOUND');
    }
  });

  it('wraps LLMProviderError as LLM_FAILED', async () => {
    const brief = await createBrief({ title: 'T', rawText: 'r' }, asDb());
    const provider = makeProvider([
      { throws: new LLMProviderError('claude', 'TIMEOUT', 'timed out') },
    ]);
    try {
      await scoreBriefViaLLM(brief.id, { provider, db: asDb() });
      expect.fail('should throw');
    } catch (err) {
      expect((err as IntakeError).code).toBe('LLM_FAILED');
    }
  });
});
