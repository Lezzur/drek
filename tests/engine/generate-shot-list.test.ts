import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';

vi.mock('../../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() },
}));

vi.mock('../../src/neurocore/audience-profiles.js', () => {
  const fakeProfile = {
    id: 'developer_longform',
    name: 'Developer Longform',
    description: 'Test profile',
    watchPersona: 'Devs',
    painPoints: ['pain1'],
    buyingTriggers: ['trigger1'],
    voiceGuidelines: { tone: 'warm', vocabulary: 'technical', sentenceLengthGuide: 'medium', taboos: [] },
    hookPatterns: ['hook1'],
    pacingRules: { wordsPerMinute: 150, avgSentenceWords: 14, densityNote: 'pauses' },
    ctaStyle: { type: 'subscribe_and_long_form', phrasing: 'sub', placement: 'end' },
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
import { createPlan, patchPlan } from '../../src/db/plans.js';
import { createDeliverable } from '../../src/db/deliverables.js';
import { createScene, listScenes } from '../../src/db/scenes.js';
import { generateShotList } from '../../src/engine/generate-shot-list.js';
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

/**
 * Make a valid shot-list response for the given scene ids. Returns a JSON
 * object keyed by sceneId with valid primaryShot/brollItems/etc.
 */
function makeValidReply(sceneIds: string[]): string {
  const entries = Object.fromEntries(
    sceneIds.map((id, i) => [
      id,
      {
        primaryShot: { type: 'terminal', description: `primary shot for scene ${i + 1}` },
        brollItems: [
          {
            type: 'web-ui',
            description: `b-roll cutaway ${i + 1}`,
            source: 'record_during_scene',
            durationSeconds: 5,
          },
        ],
        shotListItems: [],
        onScreenTextOverlays: [
          {
            textContent: `Overlay ${i + 1}`,
            timingHint: 'first 3 seconds',
            styleHint: 'callout',
          },
        ],
        cutPoints: [{ scriptLineNumber: 2, reason: 'breath' }],
      },
    ]),
  );
  return JSON.stringify(entries);
}

async function makeReadyPlan(): Promise<{ planId: string; sceneIds: string[] }> {
  const plan = await createPlan(
    {
      type: 'youtube_advanced',
      title: 'Test',
      targetRuntimeSeconds: 1800,
      formatProfileId: 'claude_code_build_along',
    },
    asDb(),
  );
  await createDeliverable(
    {
      planId: plan.id,
      kind: 'long_form',
      audienceProfileId: 'developer_longform',
      title: 'Test long-form',
    },
    asDb(),
  );
  // Walk plan through to hook_selected
  await patchPlan(plan.id, { status: 'requirements_reviewed' }, asDb());
  await patchPlan(plan.id, { status: 'projects_matched' }, asDb());
  await patchPlan(plan.id, { status: 'scenes_generated' }, asDb());
  await patchPlan(plan.id, { status: 'hooks_generated' }, asDb());
  await patchPlan(plan.id, { status: 'hook_selected' }, asDb());

  // Create 3 scenes with scripts
  const sceneIds: string[] = [];
  for (let i = 1; i <= 3; i++) {
    const scene = await createScene(
      plan.id,
      {
        title: `Scene ${i}`,
        description: `Description for scene ${i}`,
        framingNotes: 'screenshare',
        script: 'Line one\nLine two\nLine three',
        beatTag: ['cold_open', 'problem', 'demo'][i - 1] ?? null,
      },
      asDb(),
    );
    sceneIds.push(scene.id);
  }

  return { planId: plan.id, sceneIds };
}

beforeEach(() => {
  fake = createFakeFirestore();
});

describe('generateShotList — happy path', () => {
  it('persists per-scene shot data and advances status', async () => {
    const { planId, sceneIds } = await makeReadyPlan();
    const provider = makeProvider([makeValidReply(sceneIds)]);

    const result = await generateShotList(planId, { provider, db: asDb() });

    expect(result.retried).toBe(false);
    expect(result.scenes).toHaveLength(3);

    // Confirm scenes were patched with shot data
    const scenes = await listScenes(planId, asDb());
    for (const s of scenes) {
      expect(s.primaryShot).not.toBeNull();
      expect(s.brollItems.length).toBeGreaterThan(0);
      expect(s.onScreenTextOverlays.length).toBeGreaterThan(0);
      expect(s.cutPoints.length).toBeGreaterThan(0);
    }

    // Plan status advanced
    const dump = fake._dump();
    const planDoc = dump[`plans/${planId}`] as Record<string, unknown>;
    expect(planDoc.status).toBe('shot_list_generated');
  });

  it('regeneration from shot_list_generated overwrites existing shot data', async () => {
    const { planId, sceneIds } = await makeReadyPlan();

    // First run
    await generateShotList(planId, {
      provider: makeProvider([makeValidReply(sceneIds)]),
      db: asDb(),
    });

    // Second run — different content
    const provider2 = makeProvider([makeValidReply(sceneIds)]);
    const result = await generateShotList(planId, { provider: provider2, db: asDb() });
    expect(result.scenes).toHaveLength(3);

    // Status stays at shot_list_generated (no double-transition error)
    const planDoc = fake._dump()[`plans/${planId}`] as Record<string, unknown>;
    expect(planDoc.status).toBe('shot_list_generated');
  });
});

describe('generateShotList — pre-condition guards', () => {
  it('rejects when plan type is not youtube_advanced', async () => {
    const plan = await createPlan(
      { type: 'cover_letter', title: 'CL', targetRuntimeSeconds: 120 },
      asDb(),
    );
    const provider = makeProvider([]);
    try {
      await generateShotList(plan.id, { provider, db: asDb() });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PlanningEngineError);
      expect((err as PlanningEngineError).code).toBe('WRONG_PLAN_TYPE');
    }
  });

  it('rejects when plan status is wrong (scenes_generated, not hook_selected)', async () => {
    const plan = await createPlan(
      {
        type: 'youtube_advanced',
        title: 'T',
        targetRuntimeSeconds: 1800,
        formatProfileId: 'claude_code_build_along',
      },
      asDb(),
    );
    await createDeliverable(
      {
        planId: plan.id,
        kind: 'long_form',
        audienceProfileId: 'developer_longform',
        title: 'T',
      },
      asDb(),
    );
    await patchPlan(plan.id, { status: 'requirements_reviewed' }, asDb());
    await patchPlan(plan.id, { status: 'projects_matched' }, asDb());
    await patchPlan(plan.id, { status: 'scenes_generated' }, asDb());
    // Skip hooks/hook-selected — leave at scenes_generated
    const provider = makeProvider([]);
    try {
      await generateShotList(plan.id, { provider, db: asDb() });
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as PlanningEngineError).code).toBe('DISALLOWED_TRANSITION');
    }
  });

  it('rejects when planId is unknown', async () => {
    const provider = makeProvider([]);
    try {
      await generateShotList('plan_missing', { provider, db: asDb() });
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as PlanningEngineError).code).toBe('PLAN_NOT_FOUND');
    }
  });

  it('rejects when long_form deliverable is missing', async () => {
    const plan = await createPlan(
      {
        type: 'youtube_advanced',
        title: 'T',
        targetRuntimeSeconds: 1800,
        formatProfileId: 'claude_code_build_along',
      },
      asDb(),
    );
    // Skip deliverable creation
    await patchPlan(plan.id, { status: 'requirements_reviewed' }, asDb());
    await patchPlan(plan.id, { status: 'projects_matched' }, asDb());
    await patchPlan(plan.id, { status: 'scenes_generated' }, asDb());
    await patchPlan(plan.id, { status: 'hooks_generated' }, asDb());
    await patchPlan(plan.id, { status: 'hook_selected' }, asDb());
    const provider = makeProvider([]);
    try {
      await generateShotList(plan.id, { provider, db: asDb() });
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as PlanningEngineError).code).toBe('NO_LONG_FORM_DELIVERABLE');
    }
  });

  it('rejects when no scenes exist', async () => {
    const plan = await createPlan(
      {
        type: 'youtube_advanced',
        title: 'T',
        targetRuntimeSeconds: 1800,
        formatProfileId: 'claude_code_build_along',
      },
      asDb(),
    );
    await createDeliverable(
      {
        planId: plan.id,
        kind: 'long_form',
        audienceProfileId: 'developer_longform',
        title: 'T',
      },
      asDb(),
    );
    await patchPlan(plan.id, { status: 'requirements_reviewed' }, asDb());
    await patchPlan(plan.id, { status: 'projects_matched' }, asDb());
    await patchPlan(plan.id, { status: 'scenes_generated' }, asDb());
    await patchPlan(plan.id, { status: 'hooks_generated' }, asDb());
    await patchPlan(plan.id, { status: 'hook_selected' }, asDb());
    // No scenes created
    const provider = makeProvider([]);
    try {
      await generateShotList(plan.id, { provider, db: asDb() });
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as PlanningEngineError).code).toBe('INVALID_OUTPUT');
    }
  });
});

describe('generateShotList — retry path', () => {
  it('retries on bad JSON; second valid attempt succeeds', async () => {
    const { planId, sceneIds } = await makeReadyPlan();
    const provider = makeProvider(['garbage not json', makeValidReply(sceneIds)]);

    const result = await generateShotList(planId, { provider, db: asDb() });
    expect(result.retried).toBe(true);
    expect(result.scenes).toHaveLength(3);
  });

  it('retries when a sceneId is missing from output', async () => {
    const { planId, sceneIds } = await makeReadyPlan();
    // First reply omits scene 3
    const partialReply = makeValidReply(sceneIds.slice(0, 2));
    const provider = makeProvider([partialReply, makeValidReply(sceneIds)]);

    const result = await generateShotList(planId, { provider, db: asDb() });
    expect(result.retried).toBe(true);
  });

  it('throws INVALID_OUTPUT after two failed parses; status unchanged', async () => {
    const { planId } = await makeReadyPlan();
    const provider = makeProvider(['garbage', 'still garbage']);

    try {
      await generateShotList(planId, { provider, db: asDb() });
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as PlanningEngineError).code).toBe('INVALID_OUTPUT');
    }

    // Status stayed at hook_selected
    const planDoc = fake._dump()[`plans/${planId}`] as Record<string, unknown>;
    expect(planDoc.status).toBe('hook_selected');
  });

  it('retries when an item has an invalid shot type', async () => {
    const { planId, sceneIds } = await makeReadyPlan();
    const badReply = JSON.stringify({
      [sceneIds[0]!]: {
        primaryShot: { type: 'NOT_A_VALID_TYPE', description: 'x' },
        brollItems: [],
        shotListItems: [],
        onScreenTextOverlays: [],
        cutPoints: [],
      },
      [sceneIds[1]!]: {
        primaryShot: { type: 'terminal', description: 'x' },
        brollItems: [],
        shotListItems: [],
        onScreenTextOverlays: [],
        cutPoints: [],
      },
      [sceneIds[2]!]: {
        primaryShot: { type: 'terminal', description: 'x' },
        brollItems: [],
        shotListItems: [],
        onScreenTextOverlays: [],
        cutPoints: [],
      },
    });
    const provider = makeProvider([badReply, makeValidReply(sceneIds)]);

    const result = await generateShotList(planId, { provider, db: asDb() });
    expect(result.retried).toBe(true);
  });

  it('retries when an overlay textContent exceeds 80 chars', async () => {
    const { planId, sceneIds } = await makeReadyPlan();
    const badReply = JSON.stringify({
      [sceneIds[0]!]: {
        primaryShot: { type: 'terminal', description: 'x' },
        brollItems: [],
        shotListItems: [],
        onScreenTextOverlays: [
          {
            textContent: 'x'.repeat(81),
            timingHint: 'now',
            styleHint: 'callout',
          },
        ],
        cutPoints: [],
      },
      [sceneIds[1]!]: {
        primaryShot: { type: 'terminal', description: 'x' },
        brollItems: [],
        shotListItems: [],
        onScreenTextOverlays: [],
        cutPoints: [],
      },
      [sceneIds[2]!]: {
        primaryShot: { type: 'terminal', description: 'x' },
        brollItems: [],
        shotListItems: [],
        onScreenTextOverlays: [],
        cutPoints: [],
      },
    });
    const provider = makeProvider([badReply, makeValidReply(sceneIds)]);

    const result = await generateShotList(planId, { provider, db: asDb() });
    expect(result.retried).toBe(true);
  });
});
