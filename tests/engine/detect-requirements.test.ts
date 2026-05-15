import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';

vi.mock('../../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() },
}));

import { createFakeFirestore, type FakeFirestore } from '../db/fake-firestore.js';
import { createPlan } from '../../src/db/plans.js';
import { detectRequirements } from '../../src/engine/detect-requirements.js';
import { PlanningEngineError } from '../../src/engine/errors.js';
import { LLMProviderError, type LLMProvider } from '../../src/providers/index.js';

let fake: FakeFirestore;
const asDb = () => fake as unknown as Firestore;

/** Build a mock provider whose responses cycle through `responses`. Each
 *  call shifts one off. Extra calls beyond the queue throw. */
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

const SAMPLE_LISTING = `Looking for a senior engineer to build automation for our lead pipeline.
Must record a 2-minute Loom video showing your work on AI/ML integration projects.
Bonus: experience with TypeScript, React, and Firestore.`;

beforeEach(() => {
  fake = createFakeFirestore();
});

describe('detectRequirements — happy path', () => {
  it('parses JSON, stores requirements, transitions to requirements_reviewed', async () => {
    const plan = await createPlan(
      {
        type: 'cover_letter',
        title: 'Backend Eng at Acme',
        targetRuntimeSeconds: 120,
        sourceListingText: SAMPLE_LISTING,
      },
      asDb(),
    );

    const llmReply = JSON.stringify([
      {
        skill: 'lead pipeline automation',
        category: 'automation',
        priority: 'must_show',
        evidence: 'build automation for our lead pipeline',
      },
      {
        skill: 'AI/ML integration',
        category: 'ai-ml',
        priority: 'must_show',
        evidence: 'showing your work on AI/ML integration projects',
      },
      {
        skill: 'TypeScript + React + Firestore',
        category: 'frontend',
        priority: 'nice_to_show',
        evidence: 'Bonus: experience with TypeScript, React, and Firestore',
      },
    ]);
    const provider = makeProvider([llmReply]);

    const result = await detectRequirements(plan.id, { provider, db: asDb() });

    expect(result.requirements).toHaveLength(3);
    expect(result.requirements[0]?.skill).toBe('lead pipeline automation');
    expect(result.plan.status).toBe('requirements_reviewed');
    expect(result.plan.requirements).toHaveLength(3);
    expect(result.retried).toBe(false);
    expect(typeof result.durationMs).toBe('number');
  });

  it('accepts an empty array (listing has no clear demo asks)', async () => {
    const plan = await createPlan(
      {
        type: 'cover_letter',
        title: 'Vague gig',
        targetRuntimeSeconds: 60,
        sourceListingText: 'Send us a hello and rate.',
      },
      asDb(),
    );
    const provider = makeProvider(['[]']);
    const result = await detectRequirements(plan.id, { provider, db: asDb() });
    expect(result.requirements).toEqual([]);
    expect(result.plan.status).toBe('requirements_reviewed');
  });

  it('strips ```json fences from LLM output', async () => {
    const plan = await createPlan(
      {
        type: 'cover_letter',
        title: 'X',
        targetRuntimeSeconds: 60,
        sourceListingText: SAMPLE_LISTING,
      },
      asDb(),
    );
    const fenced = '```json\n[{"skill":"x","category":"backend","priority":"must_show","evidence":"e"}]\n```';
    const result = await detectRequirements(plan.id, {
      provider: makeProvider([fenced]),
      db: asDb(),
    });
    expect(result.requirements).toHaveLength(1);
  });

  it('strips leading prose before the JSON', async () => {
    const plan = await createPlan(
      {
        type: 'cover_letter',
        title: 'X',
        targetRuntimeSeconds: 60,
        sourceListingText: SAMPLE_LISTING,
      },
      asDb(),
    );
    const prosePrefix =
      'Sure! Here are the requirements:\n[{"skill":"x","category":"backend","priority":"must_show","evidence":"e"}]';
    const result = await detectRequirements(plan.id, {
      provider: makeProvider([prosePrefix]),
      db: asDb(),
    });
    expect(result.requirements).toHaveLength(1);
  });
});

describe('detectRequirements — retry on bad output', () => {
  it('retries once with a stricter prompt then succeeds', async () => {
    const plan = await createPlan(
      {
        type: 'cover_letter',
        title: 'X',
        targetRuntimeSeconds: 60,
        sourceListingText: SAMPLE_LISTING,
      },
      asDb(),
    );
    const provider = makeProvider([
      'I refuse to use JSON',
      '[{"skill":"x","category":"backend","priority":"must_show","evidence":"e"}]',
    ]);
    const result = await detectRequirements(plan.id, { provider, db: asDb() });
    expect(result.retried).toBe(true);
    expect(result.requirements).toHaveLength(1);
    expect(result.plan.status).toBe('requirements_reviewed');
  });

  it('throws INVALID_OUTPUT when both attempts fail to parse', async () => {
    const plan = await createPlan(
      {
        type: 'cover_letter',
        title: 'X',
        targetRuntimeSeconds: 60,
        sourceListingText: SAMPLE_LISTING,
      },
      asDb(),
    );
    const provider = makeProvider(['gibberish 1', 'gibberish 2']);
    await expect(
      detectRequirements(plan.id, { provider, db: asDb() }),
    ).rejects.toMatchObject({
      code: 'INVALID_OUTPUT',
      step: 'detect-requirements',
    });
    // Plan status should NOT have transitioned on failure.
    const stillUntouched = (await fake.collection('plans').doc(plan.id).get()).data() as
      | { status?: string }
      | undefined;
    expect(stillUntouched?.status).toBe('awaiting_review');
  });

  it('throws INVALID_OUTPUT when the array contains schema-invalid items', async () => {
    const plan = await createPlan(
      {
        type: 'cover_letter',
        title: 'X',
        targetRuntimeSeconds: 60,
        sourceListingText: SAMPLE_LISTING,
      },
      asDb(),
    );
    // Missing required `evidence` field on first attempt; second attempt
    // also bad so we exhaust the retry budget.
    const provider = makeProvider([
      '[{"skill":"x","category":"backend","priority":"must_show"}]',
      '[{"skill":"y","category":"backend","priority":"maybe","evidence":"e"}]',
    ]);
    await expect(
      detectRequirements(plan.id, { provider, db: asDb() }),
    ).rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
  });
});

describe('detectRequirements — input / state validation', () => {
  it('throws PLAN_NOT_FOUND for an unknown id', async () => {
    await expect(
      detectRequirements('plan_missing', {
        provider: makeProvider(['[]']),
        db: asDb(),
      }),
    ).rejects.toMatchObject({ code: 'PLAN_NOT_FOUND' });
  });

  it('throws WRONG_PLAN_TYPE for youtube plans', async () => {
    const plan = await createPlan(
      {
        type: 'youtube',
        title: 'A manual topic',
        targetRuntimeSeconds: 600,
      },
      asDb(),
    );
    await expect(
      detectRequirements(plan.id, { provider: makeProvider(['[]']), db: asDb() }),
    ).rejects.toMatchObject({ code: 'WRONG_PLAN_TYPE' });
  });

  it('throws NO_LISTING_TEXT when sourceListingText is empty', async () => {
    const plan = await createPlan(
      {
        type: 'cover_letter',
        title: 'X',
        targetRuntimeSeconds: 60,
        // sourceListingText omitted on purpose
      },
      asDb(),
    );
    await expect(
      detectRequirements(plan.id, { provider: makeProvider(['[]']), db: asDb() }),
    ).rejects.toMatchObject({ code: 'NO_LISTING_TEXT' });
  });

  it('throws DISALLOWED_TRANSITION when plan is past the editable window', async () => {
    const plan = await createPlan(
      {
        type: 'cover_letter',
        title: 'X',
        targetRuntimeSeconds: 60,
        sourceListingText: SAMPLE_LISTING,
        status: 'finalized', // not allowed to drop back to requirements_reviewed
      },
      asDb(),
    );
    await expect(
      detectRequirements(plan.id, { provider: makeProvider(['[]']), db: asDb() }),
    ).rejects.toMatchObject({ code: 'DISALLOWED_TRANSITION' });
  });
});

describe('detectRequirements — LLM provider failure', () => {
  it('wraps LLMProviderError as PlanningEngineError(LLM_FAILED)', async () => {
    const plan = await createPlan(
      {
        type: 'cover_letter',
        title: 'X',
        targetRuntimeSeconds: 60,
        sourceListingText: SAMPLE_LISTING,
      },
      asDb(),
    );
    const provider = makeProvider([
      { throws: new LLMProviderError('claude', 'TIMEOUT', 'too slow') },
    ]);
    await expect(
      detectRequirements(plan.id, { provider, db: asDb() }),
    ).rejects.toBeInstanceOf(PlanningEngineError);
    await expect(
      detectRequirements(plan.id, {
        provider: makeProvider([
          { throws: new LLMProviderError('claude', 'TIMEOUT', 'too slow') },
        ]),
        db: asDb(),
      }),
    ).rejects.toMatchObject({ code: 'LLM_FAILED' });
  });
});
