import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';

vi.mock('../../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() },
}));

import { createFakeFirestore, type FakeFirestore } from '../db/fake-firestore.js';
import { createPlan } from '../../src/db/plans.js';
import { createScene, listScenes } from '../../src/db/scenes.js';
import { writeScripts, generatePlanContent } from '../../src/engine/write-scripts.js';
import { LLMProviderError, type LLMProvider } from '../../src/providers/index.js';
import { NeurocoreError, type NeurocoreClient, type MemoryContextResponse } from '../../src/neurocore/index.js';
import type { MatchedProject, Requirement, Scene } from '../../src/db/schemas.js';

let fake: FakeFirestore;
const asDb = () => fake as unknown as Firestore;

function makeProvider(responses: Array<string | { throws: Error }>): LLMProvider {
  const queue = [...responses];
  return {
    name: 'claude' as const,
    async generate() {
      const next = queue.shift();
      if (next === undefined) throw new Error('provider queue empty');
      if (typeof next === 'object' && 'throws' in next) throw next.throws;
      return next;
    },
  };
}

function makeClient(
  responseOrError: MemoryContextResponse | { throws: Error },
): NeurocoreClient {
  return {
    async getVoiceProfile() {
      if ('throws' in responseOrError) throw responseOrError.throws;
      return responseOrError;
    },
    async getProjectContext() {
      if ('throws' in responseOrError) throw responseOrError.throws;
      return responseOrError;
    },
  } as unknown as NeurocoreClient;
}

const VOICE_RESPONSE: MemoryContextResponse = {
  systemBlock: '<voice>cadence: short bursts, then long sentences.</voice>',
  metadata: {
    layersIncluded: ['voice'],
    memoryRecordIds: [],
    estimatedTokens: 500,
    degraded: false,
    budget: { requested: 8000, clampedTo: 8000, effective: 8000 },
  },
};

const SAMPLE_REQUIREMENT: Requirement = {
  skill: 'lead pipeline automation',
  category: 'automation',
  priority: 'must_show',
  evidence: 'build automation',
};
const SAMPLE_MATCH: MatchedProject = {
  projectSlug: 'lead-pipeline',
  projectName: 'Lead Pipeline',
  matchedFeatures: ['routing dashboard'],
  relevanceScore: 0.9,
  suggestedDemoSequence: 'Open dashboard. Trigger lead. Show alert.',
};

async function makeReadyPlanWithScenes(): Promise<{ planId: string; scenes: Scene[] }> {
  const plan = await createPlan(
    {
      type: 'cover_letter',
      title: 'Backend Eng at Acme',
      targetRuntimeSeconds: 120,
      sourceListingText: 'text',
      status: 'requirements_reviewed',
    },
    asDb(),
  );
  await fake
    .collection('plans')
    .doc(plan.id)
    .update({
      requirements: [SAMPLE_REQUIREMENT],
      matchedProjects: [SAMPLE_MATCH],
      status: 'projects_matched',
    });
  const s1 = await createScene(plan.id, { title: 'Open', framingNotes: 'headshot', description: 'intro' }, asDb());
  const s2 = await createScene(plan.id, { title: 'Demo', framingNotes: 'screenshare', description: 'show it', projectRef: 'lead-pipeline' }, asDb());
  const s3 = await createScene(plan.id, { title: 'Close', framingNotes: 'headshot', description: 'cta' }, asDb());
  return { planId: plan.id, scenes: [s1, s2, s3] };
}

function makeScriptsReply(scenes: Scene[]): string {
  return JSON.stringify(
    scenes.map((s, i) => ({
      sceneId: s.id,
      // 30-word scripts for predictable runtime sums (30/2.5 = 12s each, 36s total).
      script: `Hi I am Rick scene ${i} word three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty twenty-one twenty-two twenty-three twenty-four twenty-five twenty-six twenty-seven twenty-eight twenty-nine.`,
      emphasisCues: ['Rick', 'demo'],
      pacingNotes: 'Slow on the open, brisk on the demo.',
      transitionNote: 'Cut clean to next.',
    })),
  );
}

beforeEach(() => {
  fake = createFakeFirestore();
});

describe('writeScripts — happy path', () => {
  it('writes scripts onto every scene, sums durations, advances status', async () => {
    const { planId, scenes } = await makeReadyPlanWithScenes();
    const provider = makeProvider([makeScriptsReply(scenes)]);
    const client = makeClient(VOICE_RESPONSE);

    const result = await writeScripts(planId, { provider, client, db: asDb() });

    expect(result.scenes).toHaveLength(3);
    expect(result.scenes[0]?.script).toContain('Hi I am Rick scene 0');
    expect(result.scenes[1]?.emphasisCues).toEqual(['Rick', 'demo']);
    expect(result.plan.status).toBe('scenes_generated');
    expect(result.plan.estimatedRuntimeSeconds).toBeGreaterThan(0);
    expect(result.retried).toBe(false);

    // Persistence check.
    const fromDb = await listScenes(planId, asDb());
    expect(fromDb.every((s) => s.script.length > 0)).toBe(true);
  });

  it('surfaces degraded when Neurocore reports it', async () => {
    const { planId, scenes } = await makeReadyPlanWithScenes();
    const result = await writeScripts(planId, {
      provider: makeProvider([makeScriptsReply(scenes)]),
      client: makeClient({
        ...VOICE_RESPONSE,
        metadata: { ...VOICE_RESPONSE.metadata, degraded: true },
      }),
      db: asDb(),
    });
    expect(result.degraded).toBe(true);
    expect(result.plan.status).toBe('scenes_generated');
  });
});

describe('writeScripts — retry / coverage validation', () => {
  it('retries when initial output is not parseable', async () => {
    const { planId, scenes } = await makeReadyPlanWithScenes();
    const result = await writeScripts(planId, {
      provider: makeProvider(['gibberish', makeScriptsReply(scenes)]),
      client: makeClient(VOICE_RESPONSE),
      db: asDb(),
    });
    expect(result.retried).toBe(true);
  });

  it('retries when initial output omits a sceneId, then succeeds', async () => {
    const { planId, scenes } = await makeReadyPlanWithScenes();
    // First reply only covers scenes 0 + 1 (missing scene 2)
    const partial = JSON.stringify(
      scenes.slice(0, 2).map((s) => ({
        sceneId: s.id,
        script: 'script text here for this scene',
        emphasisCues: [],
        pacingNotes: '',
        transitionNote: '',
      })),
    );
    const result = await writeScripts(planId, {
      provider: makeProvider([partial, makeScriptsReply(scenes)]),
      client: makeClient(VOICE_RESPONSE),
      db: asDb(),
    });
    expect(result.retried).toBe(true);
    expect(result.scenes).toHaveLength(3);
  });

  it('throws INVALID_OUTPUT when both attempts miss scenes', async () => {
    const { planId, scenes } = await makeReadyPlanWithScenes();
    const partial = JSON.stringify(
      scenes.slice(0, 1).map((s) => ({
        sceneId: s.id,
        script: 'only one',
        emphasisCues: [],
        pacingNotes: '',
        transitionNote: '',
      })),
    );
    await expect(
      writeScripts(planId, {
        provider: makeProvider([partial, partial]),
        client: makeClient(VOICE_RESPONSE),
        db: asDb(),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
    const data = (await fake.collection('plans').doc(planId).get()).data() as
      | { status?: string }
      | undefined;
    expect(data?.status).toBe('projects_matched'); // not advanced
  });

  it('filters out phantom sceneIds the LLM hallucinated', async () => {
    const { planId, scenes } = await makeReadyPlanWithScenes();
    // First reply covers all real scenes + 1 made-up scene id; should pass validation.
    const reply = JSON.stringify([
      ...scenes.map((s) => ({
        sceneId: s.id,
        script: 'real script',
        emphasisCues: [],
        pacingNotes: '',
        transitionNote: '',
      })),
      {
        sceneId: 'scene_phantom',
        script: 'phantom',
        emphasisCues: [],
        pacingNotes: '',
        transitionNote: '',
      },
    ]);
    const result = await writeScripts(planId, {
      provider: makeProvider([reply]),
      client: makeClient(VOICE_RESPONSE),
      db: asDb(),
    });
    expect(result.scenes).toHaveLength(3); // phantom dropped silently
  });
});

describe('writeScripts — input / state validation', () => {
  it('throws DISALLOWED_TRANSITION from awaiting_review (must run pipeline forward first)', async () => {
    const plan = await createPlan(
      {
        type: 'cover_letter',
        title: 'X',
        targetRuntimeSeconds: 60,
        sourceListingText: 'x',
      },
      asDb(),
    );
    await expect(
      writeScripts(plan.id, {
        provider: makeProvider(['[]']),
        client: makeClient(VOICE_RESPONSE),
        db: asDb(),
      }),
    ).rejects.toMatchObject({ code: 'DISALLOWED_TRANSITION' });
  });

  it('throws when plan has no scenes (Call 3 never ran)', async () => {
    const plan = await createPlan(
      {
        type: 'cover_letter',
        title: 'X',
        targetRuntimeSeconds: 60,
        sourceListingText: 'x',
        status: 'requirements_reviewed',
      },
      asDb(),
    );
    await fake.collection('plans').doc(plan.id).update({ status: 'projects_matched' });
    await expect(
      writeScripts(plan.id, {
        provider: makeProvider(['[]']),
        client: makeClient(VOICE_RESPONSE),
        db: asDb(),
      }),
    ).rejects.toMatchObject({ code: 'NO_PROJECT_MATCHES' });
  });
});

describe('writeScripts — external failures', () => {
  it('wraps NeurocoreError as LLM_FAILED', async () => {
    const { planId } = await makeReadyPlanWithScenes();
    await expect(
      writeScripts(planId, {
        provider: makeProvider(['[]']),
        client: makeClient({
          throws: new NeurocoreError('TIMEOUT', '/v1/memory/context', 'slow'),
        }),
        db: asDb(),
      }),
    ).rejects.toMatchObject({ code: 'LLM_FAILED' });
  });

  it('wraps LLMProviderError as LLM_FAILED', async () => {
    const { planId } = await makeReadyPlanWithScenes();
    await expect(
      writeScripts(planId, {
        provider: makeProvider([{ throws: new LLMProviderError('claude', 'TIMEOUT', 'slow') }]),
        client: makeClient(VOICE_RESPONSE),
        db: asDb(),
      }),
    ).rejects.toMatchObject({ code: 'LLM_FAILED' });
  });
});

describe('generatePlanContent — composite Call 3 + Call 4', () => {
  it('runs scene generation then script writing in sequence', async () => {
    const plan = await createPlan(
      {
        type: 'cover_letter',
        title: 'Backend Eng at Acme',
        targetRuntimeSeconds: 120,
        sourceListingText: 'text',
        status: 'requirements_reviewed',
      },
      asDb(),
    );
    await fake
      .collection('plans')
      .doc(plan.id)
      .update({
        requirements: [SAMPLE_REQUIREMENT],
        matchedProjects: [SAMPLE_MATCH],
        status: 'projects_matched',
      });

    // Call 3 reply first, then Call 4 reply.
    const scenesReply = JSON.stringify([
      { title: 'Open', description: 'intro', framingNotes: 'headshot', projectRef: null, estimatedDurationSeconds: 8, interfaceType: 'headshot' },
      { title: 'Demo', description: 'showit', framingNotes: 'screenshare', projectRef: 'lead-pipeline', estimatedDurationSeconds: 90, interfaceType: 'web-ui' },
      { title: 'Close', description: 'cta', framingNotes: 'headshot', projectRef: null, estimatedDurationSeconds: 7, interfaceType: 'headshot' },
    ]);

    // Reply to Call 4 needs sceneIds matching the persisted scenes — but we
    // don't know those ids ahead of time. So we have a thin provider that
    // dynamically constructs the reply on the second call after reading the
    // currently persisted scenes from Firestore.
    let callCount = 0;
    const provider: LLMProvider = {
      name: 'claude' as const,
      async generate() {
        callCount++;
        if (callCount === 1) return scenesReply;
        const persisted = await listScenes(plan.id, asDb());
        return makeScriptsReply(persisted);
      },
    };

    const result = await generatePlanContent(plan.id, {
      provider,
      client: makeClient(VOICE_RESPONSE),
      db: asDb(),
    });

    expect(result.scenesResult?.scenes).toHaveLength(3);
    expect(result.scriptsResult.plan.status).toBe('scenes_generated');
    expect(result.scriptsResult.scenes.every((s) => s.script.length > 0)).toBe(true);
  });

  it('skipScenes=true bypasses Call 3 and only runs Call 4', async () => {
    const { planId, scenes } = await makeReadyPlanWithScenes();
    const result = await generatePlanContent(planId, {
      skipScenes: true,
      provider: makeProvider([makeScriptsReply(scenes)]),
      client: makeClient(VOICE_RESPONSE),
      db: asDb(),
    });
    expect(result.scenesResult).toBeNull();
    expect(result.scriptsResult.scenes).toHaveLength(3);
  });
});
