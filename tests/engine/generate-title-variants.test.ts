import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';

vi.mock('../../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() },
}));

vi.mock('../../src/neurocore/audience-profiles.js', () => {
  const fakeProfile = {
    id: 'developer_longform',
    name: 'Dev Longform',
    description: 'Test',
    watchPersona: 'Devs',
    painPoints: ['pain1'],
    buyingTriggers: ['trigger1'],
    voiceGuidelines: { tone: 'warm', vocabulary: 'tech', sentenceLengthGuide: 'medium', taboos: [] },
    hookPatterns: ['hook1'],
    pacingRules: { wordsPerMinute: 150, avgSentenceWords: 14, densityNote: 'pauses' },
    ctaStyle: { type: 'subscribe_and_long_form', phrasing: 'sub', placement: 'end' },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  return {
    getAudienceProfileClient: () => ({ get: vi.fn().mockResolvedValue(fakeProfile) }),
    _resetAudienceProfileClientForTests: vi.fn(),
    clearAudienceProfileCache: vi.fn(),
  };
});

import { createFakeFirestore, type FakeFirestore } from '../db/fake-firestore.js';
import { createPlan, patchPlan } from '../../src/db/plans.js';
import { createDeliverable } from '../../src/db/deliverables.js';
import { listTitleConceptsForDeliverable } from '../../src/db/title-concepts.js';
import { generateTitleVariants } from '../../src/engine/generate-title-variants.js';
import { PlanningEngineError } from '../../src/engine/errors.js';
import { type LLMProvider } from '../../src/providers/index.js';

let fake: FakeFirestore;
const asDb = () => fake as unknown as Firestore;

function makeProvider(responses: Array<string | { throws: Error }>): LLMProvider {
  const queue = [...responses];
  return {
    name: 'claude' as const,
    async generate() {
      const next = queue.shift();
      if (next === undefined) throw new Error('mock provider exhausted');
      if (typeof next === 'object' && 'throws' in next) throw next.throws;
      return next;
    },
  };
}

function makeValidReply(count = 6): string {
  // 6 distinct archetypes ensures the "at least 4 distinct" rule passes
  const archetypes = [
    'curiosity_gap',
    'specificity',
    'payoff_promise',
    'controversy_hook',
    'numbered_listicle',
    'question_format',
  ];
  return JSON.stringify(
    Array.from({ length: count }, (_, i) => ({
      titleText: `Engaging title number ${i + 1}`,
      archetype: archetypes[i % archetypes.length],
      predictedClickability: 5 + (i % 5),
      reasoning: `This title creates ${archetypes[i % archetypes.length]} appeal.`,
      keywordsSurfaced: ['claude', 'automation'],
    })),
  );
}

async function makeLongFormReady(): Promise<{ planId: string; deliverableId: string }> {
  const plan = await createPlan(
    {
      type: 'youtube_advanced',
      title: 'Episode 1',
      targetRuntimeSeconds: 1800,
      formatProfileId: 'claude_code_build_along',
    },
    asDb(),
  );
  const deliverable = await createDeliverable(
    {
      planId: plan.id,
      kind: 'long_form',
      audienceProfileId: 'developer_longform',
      title: 'Long-form',
    },
    asDb(),
  );
  // Walk to shot_list_generated
  await patchPlan(plan.id, { status: 'requirements_reviewed' }, asDb());
  await patchPlan(plan.id, { status: 'projects_matched' }, asDb());
  await patchPlan(plan.id, { status: 'scenes_generated' }, asDb());
  await patchPlan(plan.id, { status: 'hooks_generated' }, asDb());
  await patchPlan(plan.id, { status: 'hook_selected' }, asDb());
  await patchPlan(plan.id, { status: 'shot_list_generated' }, asDb());
  return { planId: plan.id, deliverableId: deliverable.id };
}

beforeEach(() => {
  fake = createFakeFirestore();
});

describe('generateTitleVariants — happy path', () => {
  it('persists 6 concepts and advances plan status to titles_generated', async () => {
    const { planId, deliverableId } = await makeLongFormReady();
    const provider = makeProvider([makeValidReply(6)]);

    const result = await generateTitleVariants(deliverableId, { provider, db: asDb() });

    expect(result.retried).toBe(false);
    expect(result.concepts).toHaveLength(6);

    // Persisted under deliverable
    const persisted = await listTitleConceptsForDeliverable(deliverableId, asDb());
    expect(persisted).toHaveLength(6);
    expect(persisted.every((c) => c.selected === false)).toBe(true);

    // Plan status advanced
    const planDoc = fake._dump()[`plans/${planId}`] as Record<string, unknown>;
    expect(planDoc.status).toBe('titles_generated');
  });

  it('regeneration wipes old concepts and persists new ones', async () => {
    const { planId, deliverableId } = await makeLongFormReady();

    // First run
    await generateTitleVariants(deliverableId, {
      provider: makeProvider([makeValidReply(5)]),
      db: asDb(),
    });

    // Second run after advancing to titles_generated
    await generateTitleVariants(deliverableId, {
      provider: makeProvider([makeValidReply(7)]),
      db: asDb(),
    });

    const persisted = await listTitleConceptsForDeliverable(deliverableId, asDb());
    expect(persisted).toHaveLength(7);

    // Status stays at titles_generated (no double-transition)
    const planDoc = fake._dump()[`plans/${planId}`] as Record<string, unknown>;
    expect(planDoc.status).toBe('titles_generated');
  });
});

describe('generateTitleVariants — pre-condition guards', () => {
  it('rejects when deliverable id is unknown', async () => {
    try {
      await generateTitleVariants('del_missing', {
        provider: makeProvider([]),
        db: asDb(),
      });
      expect.fail('should throw');
    } catch (err) {
      expect((err as PlanningEngineError).code).toBe('PLAN_NOT_FOUND');
    }
  });

  it('rejects when plan type is not youtube_advanced', async () => {
    const plan = await createPlan(
      { type: 'cover_letter', title: 'CL', targetRuntimeSeconds: 120 },
      asDb(),
    );
    const deliverable = await createDeliverable(
      { planId: plan.id, kind: 'long_form', audienceProfileId: 'developer_longform', title: 'x' },
      asDb(),
    );
    try {
      await generateTitleVariants(deliverable.id, {
        provider: makeProvider([]),
        db: asDb(),
      });
      expect.fail('should throw');
    } catch (err) {
      expect((err as PlanningEngineError).code).toBe('WRONG_PLAN_TYPE');
    }
  });

  it('rejects long-form at wrong status (hook_selected)', async () => {
    const plan = await createPlan(
      {
        type: 'youtube_advanced',
        title: 'T',
        targetRuntimeSeconds: 1800,
        formatProfileId: 'claude_code_build_along',
      },
      asDb(),
    );
    const del = await createDeliverable(
      { planId: plan.id, kind: 'long_form', audienceProfileId: 'developer_longform', title: 'T' },
      asDb(),
    );
    await patchPlan(plan.id, { status: 'requirements_reviewed' }, asDb());
    await patchPlan(plan.id, { status: 'projects_matched' }, asDb());
    await patchPlan(plan.id, { status: 'scenes_generated' }, asDb());
    await patchPlan(plan.id, { status: 'hooks_generated' }, asDb());
    await patchPlan(plan.id, { status: 'hook_selected' }, asDb());
    // NOT advanced to shot_list_generated
    try {
      await generateTitleVariants(del.id, { provider: makeProvider([]), db: asDb() });
      expect.fail('should throw');
    } catch (err) {
      expect((err as PlanningEngineError).code).toBe('DISALLOWED_TRANSITION');
    }
  });
});

describe('generateTitleVariants — retry path', () => {
  it('retries on bad JSON', async () => {
    const { deliverableId } = await makeLongFormReady();
    const provider = makeProvider(['not json', makeValidReply(6)]);
    const result = await generateTitleVariants(deliverableId, { provider, db: asDb() });
    expect(result.retried).toBe(true);
  });

  it('retries when titleText exceeds 70 chars', async () => {
    const { deliverableId } = await makeLongFormReady();
    const badReply = JSON.stringify([
      {
        titleText: 'x'.repeat(71),
        archetype: 'curiosity_gap',
        predictedClickability: 5,
        reasoning: 'r',
        keywordsSurfaced: [],
      },
      ...JSON.parse(makeValidReply(4)),
    ]);
    const provider = makeProvider([badReply, makeValidReply(6)]);
    const result = await generateTitleVariants(deliverableId, { provider, db: asDb() });
    expect(result.retried).toBe(true);
  });

  it('retries when fewer than 4 distinct archetypes', async () => {
    const { deliverableId } = await makeLongFormReady();
    const monotone = JSON.stringify(
      Array.from({ length: 5 }, (_, i) => ({
        titleText: `Title ${i + 1}`,
        archetype: 'curiosity_gap',
        predictedClickability: 5,
        reasoning: 'same archetype repeated',
        keywordsSurfaced: [],
      })),
    );
    const provider = makeProvider([monotone, makeValidReply(6)]);
    const result = await generateTitleVariants(deliverableId, { provider, db: asDb() });
    expect(result.retried).toBe(true);
  });

  it('throws INVALID_OUTPUT after two failed parses', async () => {
    const { planId, deliverableId } = await makeLongFormReady();
    const provider = makeProvider(['garbage', 'still garbage']);
    try {
      await generateTitleVariants(deliverableId, { provider, db: asDb() });
      expect.fail('should throw');
    } catch (err) {
      expect((err as PlanningEngineError).code).toBe('INVALID_OUTPUT');
    }
    // Status unchanged
    const planDoc = fake._dump()[`plans/${planId}`] as Record<string, unknown>;
    expect(planDoc.status).toBe('shot_list_generated');
    // No partial concepts persisted
    const persisted = await listTitleConceptsForDeliverable(deliverableId, asDb());
    expect(persisted).toHaveLength(0);
  });
});
