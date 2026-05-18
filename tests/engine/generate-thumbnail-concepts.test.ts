import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';

vi.mock('../../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() },
}));

vi.mock('../../src/neurocore/audience-profiles.js', () => {
  const fakeProfile = {
    id: 'developer_longform',
    name: 'Dev',
    description: 'x',
    watchPersona: 'devs',
    painPoints: ['p'],
    buyingTriggers: ['t'],
    voiceGuidelines: { tone: 'w', vocabulary: 'tech', sentenceLengthGuide: 'm', taboos: [] },
    hookPatterns: ['h'],
    pacingRules: { wordsPerMinute: 150, avgSentenceWords: 14, densityNote: 'n' },
    ctaStyle: { type: 'subscribe_and_long_form', phrasing: 's', placement: 'end' },
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
import { createDeliverable, patchDeliverable } from '../../src/db/deliverables.js';
import { listThumbnailConceptsForDeliverable } from '../../src/db/thumbnail-concepts.js';
import { generateThumbnailConcepts } from '../../src/engine/generate-thumbnail-concepts.js';
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

function makeValidReply(count = 3): string {
  return JSON.stringify(
    Array.from({ length: count }, (_, i) => ({
      composition: `composition ${i + 1}`,
      textHook: `Hook ${i + 1}`,
      expression: i === 0 ? 'relieved' : null,
      colorPalette: ['#0a0a0a', '#22c55e'],
      assetsRequired: ['screenshot'],
      conceptSummary: `concept ${i + 1}`,
    })),
  );
}

async function makeReadyDeliverable(): Promise<{ planId: string; deliverableId: string }> {
  const plan = await createPlan(
    {
      type: 'youtube_advanced',
      title: 'Ep 1',
      targetRuntimeSeconds: 1800,
      formatProfileId: 'claude_code_build_along',
    },
    asDb(),
  );
  const del = await createDeliverable(
    { planId: plan.id, kind: 'long_form', audienceProfileId: 'developer_longform', title: 'lf' },
    asDb(),
  );
  await patchPlan(plan.id, { status: 'requirements_reviewed' }, asDb());
  await patchPlan(plan.id, { status: 'projects_matched' }, asDb());
  await patchPlan(plan.id, { status: 'scenes_generated' }, asDb());
  await patchPlan(plan.id, { status: 'hooks_generated' }, asDb());
  await patchPlan(plan.id, { status: 'hook_selected' }, asDb());
  await patchPlan(plan.id, { status: 'shot_list_generated' }, asDb());
  await patchPlan(plan.id, { status: 'titles_generated' }, asDb());
  await patchPlan(plan.id, { status: 'title_selected', selectedTitleVariantId: 'title_x' }, asDb());
  await patchDeliverable(del.id, { selectedTitleVariantId: 'title_x' }, asDb());
  return { planId: plan.id, deliverableId: del.id };
}

beforeEach(() => {
  fake = createFakeFirestore();
});

describe('generateThumbnailConcepts — happy path', () => {
  it('persists 3 concepts and advances status', async () => {
    const { planId, deliverableId } = await makeReadyDeliverable();
    const provider = makeProvider([makeValidReply(3)]);
    const result = await generateThumbnailConcepts(deliverableId, { provider, db: asDb() });

    expect(result.concepts).toHaveLength(3);
    const persisted = await listThumbnailConceptsForDeliverable(deliverableId, asDb());
    expect(persisted).toHaveLength(3);

    const planDoc = fake._dump()[`plans/${planId}`] as Record<string, unknown>;
    expect(planDoc.status).toBe('thumbnails_generated');
  });
});

describe('generateThumbnailConcepts — guards', () => {
  it('rejects when no title selected', async () => {
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
    await patchPlan(plan.id, { status: 'shot_list_generated' }, asDb());
    await patchPlan(plan.id, { status: 'titles_generated' }, asDb());
    await patchPlan(plan.id, { status: 'title_selected' }, asDb());
    // Did NOT patch deliverable.selectedTitleVariantId
    try {
      await generateThumbnailConcepts(del.id, { provider: makeProvider([]), db: asDb() });
      expect.fail('should throw');
    } catch (err) {
      expect((err as PlanningEngineError).code).toBe('NO_REQUIREMENTS');
    }
  });

  it('rejects wrong plan status', async () => {
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
    await patchDeliverable(del.id, { selectedTitleVariantId: 'title_x' }, asDb());
    // Plan stays at awaiting_review
    try {
      await generateThumbnailConcepts(del.id, { provider: makeProvider([]), db: asDb() });
      expect.fail('should throw');
    } catch (err) {
      expect((err as PlanningEngineError).code).toBe('DISALLOWED_TRANSITION');
    }
  });
});

describe('generateThumbnailConcepts — retry', () => {
  it('retries when textHook exceeds 4 words', async () => {
    const { deliverableId } = await makeReadyDeliverable();
    const badReply = JSON.stringify([
      {
        composition: 'c',
        textHook: 'one two three four five',
        expression: null,
        colorPalette: ['#000000', '#ffffff'],
        assetsRequired: [],
        conceptSummary: 's',
      },
      ...JSON.parse(makeValidReply(2)),
    ]);
    const provider = makeProvider([badReply, makeValidReply(3)]);
    const result = await generateThumbnailConcepts(deliverableId, { provider, db: asDb() });
    expect(result.retried).toBe(true);
  });

  it('retries when palette has invalid hex', async () => {
    const { deliverableId } = await makeReadyDeliverable();
    const badReply = JSON.stringify([
      {
        composition: 'c',
        textHook: 'Hook',
        expression: null,
        colorPalette: ['#zzzzzz', '#ffffff'],
        assetsRequired: [],
        conceptSummary: 's',
      },
      ...JSON.parse(makeValidReply(2)),
    ]);
    const provider = makeProvider([badReply, makeValidReply(3)]);
    const result = await generateThumbnailConcepts(deliverableId, { provider, db: asDb() });
    expect(result.retried).toBe(true);
  });

  it('throws INVALID_OUTPUT after two failed parses', async () => {
    const { deliverableId } = await makeReadyDeliverable();
    try {
      await generateThumbnailConcepts(deliverableId, {
        provider: makeProvider(['garbage', 'still garbage']),
        db: asDb(),
      });
      expect.fail('should throw');
    } catch (err) {
      expect((err as PlanningEngineError).code).toBe('INVALID_OUTPUT');
    }
  });
});
