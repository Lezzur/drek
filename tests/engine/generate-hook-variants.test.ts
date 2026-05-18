import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';

vi.mock('../../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() },
}));

// Mock the audience profile client so tests don't need a real Neurocore endpoint.
vi.mock('../../src/neurocore/audience-profiles.js', () => {
  const fakeProfile = {
    id: 'developer_longform',
    name: 'Developer Longform',
    description: 'Test profile',
    watchPersona: 'Developers watching to learn',
    painPoints: ['pain1'],
    buyingTriggers: ['trigger1'],
    voiceGuidelines: { tone: 'warm', vocabulary: 'technical', sentenceLengthGuide: 'medium', taboos: [] },
    hookPatterns: ['hook1'],
    pacingRules: { wordsPerMinute: 150, avgSentenceWords: 14, densityNote: 'leave pauses' },
    ctaStyle: { type: 'subscribe_and_long_form', phrasing: 'Subscribe', placement: 'end' },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  return {
    getAudienceProfileClient: () => ({
      get: vi.fn().mockResolvedValue(fakeProfile),
    }),
    _resetAudienceProfileClientForTests: vi.fn(),
    clearAudienceProfileCache: vi.fn(),
  };
});

import { createFakeFirestore, type FakeFirestore } from '../db/fake-firestore.js';
import { createPlan } from '../../src/db/plans.js';
import { createDeliverable } from '../../src/db/deliverables.js';
import { createHookDraft, listHookDraftsForPlan } from '../../src/db/hook-drafts.js';
import { generateHookVariants } from '../../src/engine/generate-hook-variants.js';
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
      if (next === undefined) {
        throw new Error('mock provider exhausted — test queued too few responses');
      }
      if (typeof next === 'object' && 'throws' in next) throw next.throws;
      return next;
    },
  };
}

/** Generate a valid scriptText string of the given word count. */
function makeScriptText(wordCount: number): string {
  const base = 'word';
  return Array.from({ length: wordCount }, (_, i) => `${base}${i + 1}`).join(' ');
}

/** Build a valid LLM response with the given array of variants. */
function makeValidReply(count = 4): string {
  const archetypes = ['pattern_interrupt', 'bold_claim', 'retention_question', 'story_cold_open'];
  return JSON.stringify(
    Array.from({ length: count }, (_, i) => ({
      archetype: archetypes[i % archetypes.length],
      scriptText: makeScriptText(35),
      predictedRetention: 'This hook will hold viewers because it creates immediate curiosity.',
    })),
  );
}

async function makeReadyPlan(): Promise<string> {
  const plan = await createPlan(
    {
      type: 'youtube_advanced',
      title: 'Build a RAG chatbot with Claude Code',
      targetRuntimeSeconds: 1800,
      formatProfileId: 'claude_code_build_along',
      status: 'scenes_generated',
    },
    asDb(),
  );
  // Create the long_form deliverable required by the engine step.
  await createDeliverable(
    {
      planId: plan.id,
      kind: 'long_form',
      audienceProfileId: 'developer_longform',
      title: 'RAG chatbot build-along',
    },
    asDb(),
  );
  return plan.id;
}

beforeEach(() => {
  fake = createFakeFirestore();
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('generateHookVariants — happy path', () => {
  it('generates 4 valid variants, persists all, advances status to hooks_generated', async () => {
    const planId = await makeReadyPlan();
    const provider = makeProvider([makeValidReply(4)]);

    const drafts = await generateHookVariants(planId, { provider, db: asDb() });

    expect(drafts).toHaveLength(4);
    expect(drafts.every((d) => d.scriptText.length > 0)).toBe(true);
    expect(drafts.every((d) => d.predictedRetention.length > 0)).toBe(true);

    // All persisted in DB.
    const fromDb = await listHookDraftsForPlan(planId, asDb());
    expect(fromDb).toHaveLength(4);

    // Plan status advanced.
    const planDoc = await fake.collection('plans').doc(planId).get();
    expect((planDoc.data() as { status: string } | undefined)?.status).toBe('hooks_generated');
  });
});

// ---------------------------------------------------------------------------
// Regeneration: pre-existing drafts are wiped
// ---------------------------------------------------------------------------

describe('generateHookVariants — regeneration', () => {
  it('wipes pre-existing drafts and persists new ones', async () => {
    const planId = await makeReadyPlan();

    // Pre-seed 3 drafts.
    await createHookDraft(planId, { archetype: 'bold_claim', scriptText: makeScriptText(35), predictedRetention: 'old1' }, asDb());
    await createHookDraft(planId, { archetype: 'demo_first', scriptText: makeScriptText(35), predictedRetention: 'old2' }, asDb());
    await createHookDraft(planId, { archetype: 'pattern_interrupt', scriptText: makeScriptText(35), predictedRetention: 'old3' }, asDb());

    const beforeCount = (await listHookDraftsForPlan(planId, asDb())).length;
    expect(beforeCount).toBe(3);

    // Make plan status hooks_generated to simulate re-generation.
    await fake.collection('plans').doc(planId).update({ status: 'hooks_generated' });

    const provider = makeProvider([makeValidReply(4)]);
    const drafts = await generateHookVariants(planId, { provider, db: asDb() });

    expect(drafts).toHaveLength(4);

    // Old 3 deleted, new 4 persisted.
    const afterDb = await listHookDraftsForPlan(planId, asDb());
    expect(afterDb).toHaveLength(4);

    // None of the old predictedRetention values should be in the DB.
    const retentions = afterDb.map((d) => d.predictedRetention);
    expect(retentions).not.toContain('old1');
    expect(retentions).not.toContain('old2');
    expect(retentions).not.toContain('old3');
  });
});

// ---------------------------------------------------------------------------
// Pre-condition failures
// ---------------------------------------------------------------------------

describe('generateHookVariants — WRONG_PLAN_TYPE', () => {
  it('throws WRONG_PLAN_TYPE for cover_letter plan', async () => {
    const plan = await createPlan(
      { type: 'cover_letter', title: 'Cover letter', targetRuntimeSeconds: 120, sourceListingText: 'text', status: 'scenes_generated' },
      asDb(),
    );
    await expect(
      generateHookVariants(plan.id, { provider: makeProvider([]), db: asDb() }),
    ).rejects.toMatchObject({ code: 'WRONG_PLAN_TYPE' });
  });
});

describe('generateHookVariants — DISALLOWED_TRANSITION', () => {
  it('throws DISALLOWED_TRANSITION when plan.status is requirements_reviewed', async () => {
    const plan = await createPlan(
      { type: 'youtube_advanced', title: 'YT plan', targetRuntimeSeconds: 1800, formatProfileId: 'claude_code_build_along', status: 'requirements_reviewed' },
      asDb(),
    );
    await expect(
      generateHookVariants(plan.id, { provider: makeProvider([]), db: asDb() }),
    ).rejects.toMatchObject({ code: 'DISALLOWED_TRANSITION' });
  });
});

describe('generateHookVariants — NO_FORMAT_PROFILE', () => {
  it('throws NO_FORMAT_PROFILE when plan.formatProfileId is null', async () => {
    const plan = await createPlan(
      { type: 'youtube_advanced', title: 'YT plan', targetRuntimeSeconds: 1800, status: 'scenes_generated' },
      asDb(),
    );
    // null formatProfileId
    await fake.collection('plans').doc(plan.id).update({ formatProfileId: null });
    await expect(
      generateHookVariants(plan.id, { provider: makeProvider([]), db: asDb() }),
    ).rejects.toMatchObject({ code: 'NO_FORMAT_PROFILE' });
  });
});

describe('generateHookVariants — NO_LONG_FORM_DELIVERABLE', () => {
  it('throws NO_LONG_FORM_DELIVERABLE when no long_form deliverable exists', async () => {
    const plan = await createPlan(
      { type: 'youtube_advanced', title: 'YT plan', targetRuntimeSeconds: 1800, formatProfileId: 'claude_code_build_along', status: 'scenes_generated' },
      asDb(),
    );
    // No deliverable created.
    await expect(
      generateHookVariants(plan.id, { provider: makeProvider([]), db: asDb() }),
    ).rejects.toMatchObject({ code: 'NO_LONG_FORM_DELIVERABLE' });
  });
});

// ---------------------------------------------------------------------------
// Validation + retry behavior
// ---------------------------------------------------------------------------

describe('generateHookVariants — variant count outside 3-5', () => {
  it('retries when first response has 2 variants (count below minimum)', async () => {
    const planId = await makeReadyPlan();
    const tooFew = JSON.stringify([
      { archetype: 'bold_claim', scriptText: makeScriptText(35), predictedRetention: 'ok' },
      { archetype: 'demo_first', scriptText: makeScriptText(35), predictedRetention: 'ok' },
    ]);
    const provider = makeProvider([tooFew, makeValidReply(3)]);
    const drafts = await generateHookVariants(planId, { provider, db: asDb() });
    expect(drafts).toHaveLength(3);
  });

  it('retries when first response has 6 variants (count above maximum)', async () => {
    const planId = await makeReadyPlan();
    const tooMany = JSON.stringify(
      Array.from({ length: 6 }, (_, i) => ({
        archetype: ['pattern_interrupt', 'bold_claim', 'retention_question', 'story_cold_open', 'demo_first', 'pattern_interrupt'][i],
        scriptText: makeScriptText(35),
        predictedRetention: 'ok',
      })),
    );
    const provider = makeProvider([tooMany, makeValidReply(4)]);
    const drafts = await generateHookVariants(planId, { provider, db: asDb() });
    expect(drafts).toHaveLength(4);
  });
});

describe('generateHookVariants — unknown archetype', () => {
  it('retries when first response contains an unknown archetype', async () => {
    const planId = await makeReadyPlan();
    const unknownArchetype = JSON.stringify([
      { archetype: 'mystery_opener', scriptText: makeScriptText(35), predictedRetention: 'ok' },
      { archetype: 'bold_claim', scriptText: makeScriptText(35), predictedRetention: 'ok' },
      { archetype: 'demo_first', scriptText: makeScriptText(35), predictedRetention: 'ok' },
    ]);
    const provider = makeProvider([unknownArchetype, makeValidReply(3)]);
    const drafts = await generateHookVariants(planId, { provider, db: asDb() });
    expect(drafts).toHaveLength(3);
  });
});

describe('generateHookVariants — word count violation', () => {
  it('retries when first response has a very short scriptText (< 20 words)', async () => {
    const planId = await makeReadyPlan();
    const shortScript = JSON.stringify([
      { archetype: 'pattern_interrupt', scriptText: makeScriptText(5), predictedRetention: 'ok' },
      { archetype: 'bold_claim', scriptText: makeScriptText(35), predictedRetention: 'ok' },
      { archetype: 'demo_first', scriptText: makeScriptText(35), predictedRetention: 'ok' },
    ]);
    const provider = makeProvider([shortScript, makeValidReply(3)]);
    const drafts = await generateHookVariants(planId, { provider, db: asDb() });
    expect(drafts).toHaveLength(3);
  });

  it('retries when first response has a very long scriptText (> 80 words)', async () => {
    const planId = await makeReadyPlan();
    const longScript = JSON.stringify([
      { archetype: 'story_cold_open', scriptText: makeScriptText(100), predictedRetention: 'ok' },
      { archetype: 'bold_claim', scriptText: makeScriptText(35), predictedRetention: 'ok' },
      { archetype: 'demo_first', scriptText: makeScriptText(35), predictedRetention: 'ok' },
    ]);
    const provider = makeProvider([longScript, makeValidReply(3)]);
    const drafts = await generateHookVariants(planId, { provider, db: asDb() });
    expect(drafts).toHaveLength(3);
  });
});

describe('generateHookVariants — bad JSON twice', () => {
  it('throws INVALID_OUTPUT, leaves plan status unchanged, no partial drafts persisted', async () => {
    const planId = await makeReadyPlan();
    const provider = makeProvider(['not json at all', 'also not json']);

    await expect(
      generateHookVariants(planId, { provider, db: asDb() }),
    ).rejects.toMatchObject({ code: 'INVALID_OUTPUT' });

    // Plan status unchanged (still scenes_generated).
    const planDoc = await fake.collection('plans').doc(planId).get();
    expect((planDoc.data() as { status: string } | undefined)?.status).toBe('scenes_generated');

    // No hook drafts persisted.
    const drafts = await listHookDraftsForPlan(planId, asDb());
    expect(drafts).toHaveLength(0);
  });
});
