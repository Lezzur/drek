import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';

vi.mock('../../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() },
}));

import { createFakeFirestore, type FakeFirestore } from '../db/fake-firestore.js';
import { createPlan } from '../../src/db/plans.js';
import { listScenes, createScene } from '../../src/db/scenes.js';
import { generateScenes } from '../../src/engine/generate-scenes.js';
import { LLMProviderError, type LLMProvider } from '../../src/providers/index.js';
import type { MatchedProject, Requirement } from '../../src/db/schemas.js';

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

const SAMPLE_REQUIREMENT: Requirement = {
  skill: 'lead pipeline automation',
  category: 'automation',
  priority: 'must_show',
  evidence: 'build automation for our lead pipeline',
};

const SAMPLE_MATCH: MatchedProject = {
  projectSlug: 'lead-pipeline',
  projectName: 'Lead Pipeline',
  matchedFeatures: ['real-time routing dashboard', 'slack alerts'],
  relevanceScore: 0.9,
  suggestedDemoSequence: 'Open dashboard. Trigger a lead. Show alert.',
};

const SAMPLE_LLM_REPLY = JSON.stringify([
  {
    title: 'Open with relevant experience',
    description: 'Rick states 8 years of automation engineering, names one prior pipeline build.',
    framingNotes: 'Headshot, well-lit, plain background.',
    projectRef: null,
    estimatedDurationSeconds: 8,
    interfaceType: 'headshot',
  },
  {
    title: 'Demo lead pipeline live',
    description: 'Trigger a new lead via the form, show worker logs picking it up, cut to Slack alert.',
    framingNotes: 'Screenshare, dashboard visible.',
    projectRef: 'lead-pipeline',
    estimatedDurationSeconds: 90,
    interfaceType: 'web-ui',
  },
  {
    title: 'Close with availability',
    description: 'Rick names start date and asks for next step.',
    framingNotes: 'Headshot.',
    projectRef: null,
    estimatedDurationSeconds: 7,
    interfaceType: 'headshot',
  },
]);

async function makeReadyPlan(): Promise<string> {
  const plan = await createPlan(
    {
      type: 'cover_letter',
      title: 'Backend Eng at Acme',
      targetRuntimeSeconds: 120,
      sourceListingText: 'listing text',
      status: 'requirements_reviewed',
    },
    asDb(),
  );
  // Patch in requirements + matched projects + advance state to projects_matched.
  await fake
    .collection('plans')
    .doc(plan.id)
    .update({
      requirements: [SAMPLE_REQUIREMENT],
      matchedProjects: [SAMPLE_MATCH],
      status: 'projects_matched',
    });
  return plan.id;
}

beforeEach(() => {
  fake = createFakeFirestore();
});

describe('generateScenes — happy path', () => {
  it('persists 3 scenes under the plan and does not advance status', async () => {
    const planId = await makeReadyPlan();
    const result = await generateScenes(planId, {
      provider: makeProvider([SAMPLE_LLM_REPLY]),
      db: asDb(),
    });
    expect(result.scenes).toHaveLength(3);
    expect(result.scenes[0]?.order).toBe(1);
    expect(result.scenes[1]?.order).toBe(2);
    expect(result.scenes[2]?.order).toBe(3);
    expect(result.scenes[1]?.projectRef).toBe('lead-pipeline');
    expect(result.scenes[0]?.script).toBe(''); // Call 4 fills this
    // Plan status NOT advanced — Call 4 does that.
    const stored = (await fake.collection('plans').doc(planId).get()).data() as
      | { status?: string }
      | undefined;
    expect(stored?.status).toBe('projects_matched');
  });

  it('wipes existing scenes on regenerate', async () => {
    const planId = await makeReadyPlan();
    // Seed two existing scenes that should be deleted.
    await createScene(planId, { title: 'old A' }, asDb());
    await createScene(planId, { title: 'old B' }, asDb());
    expect((await listScenes(planId, asDb())).map((s) => s.title)).toEqual(['old A', 'old B']);
    await generateScenes(planId, {
      provider: makeProvider([SAMPLE_LLM_REPLY]),
      db: asDb(),
    });
    const after = await listScenes(planId, asDb());
    expect(after.map((s) => s.title)).toEqual([
      'Open with relevant experience',
      'Demo lead pipeline live',
      'Close with availability',
    ]);
  });

  it('allows regeneration from scenes_generated status', async () => {
    const planId = await makeReadyPlan();
    await fake.collection('plans').doc(planId).update({ status: 'scenes_generated' });
    const result = await generateScenes(planId, {
      provider: makeProvider([SAMPLE_LLM_REPLY]),
      db: asDb(),
    });
    expect(result.scenes).toHaveLength(3);
  });
});

describe('generateScenes — retry on bad output', () => {
  it('retries once and succeeds', async () => {
    const planId = await makeReadyPlan();
    const result = await generateScenes(planId, {
      provider: makeProvider(['gibberish', SAMPLE_LLM_REPLY]),
      db: asDb(),
    });
    expect(result.retried).toBe(true);
    expect(result.scenes).toHaveLength(3);
  });

  it('throws INVALID_OUTPUT when both attempts fail', async () => {
    const planId = await makeReadyPlan();
    await expect(
      generateScenes(planId, {
        provider: makeProvider(['nope', 'also nope']),
        db: asDb(),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_OUTPUT', step: 'generate-scenes' });
    // No scenes persisted on failure.
    expect(await listScenes(planId, asDb())).toEqual([]);
  });

  it('rejects scenes missing required fields', async () => {
    const planId = await makeReadyPlan();
    const broken = JSON.stringify([
      { title: 'x', description: 'y' }, // missing framingNotes
    ]);
    await expect(
      generateScenes(planId, {
        provider: makeProvider([broken, broken]),
        db: asDb(),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
  });

  it('rejects an empty scene array', async () => {
    const planId = await makeReadyPlan();
    await expect(
      generateScenes(planId, {
        provider: makeProvider(['[]', '[]']),
        db: asDb(),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
  });
});

describe('generateScenes — input / state validation', () => {
  it('PLAN_NOT_FOUND for unknown id', async () => {
    await expect(
      generateScenes('plan_missing', {
        provider: makeProvider([SAMPLE_LLM_REPLY]),
        db: asDb(),
      }),
    ).rejects.toMatchObject({ code: 'PLAN_NOT_FOUND' });
  });

  it('WRONG_PLAN_STATUS for plans not in projects_matched or scenes_generated', async () => {
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
    await expect(
      generateScenes(plan.id, {
        provider: makeProvider([SAMPLE_LLM_REPLY]),
        db: asDb(),
      }),
    ).rejects.toMatchObject({ code: 'WRONG_PLAN_STATUS' });
  });

  it('NO_PROJECT_MATCHES when matched projects is empty', async () => {
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
    // Advance to projects_matched but with no matches.
    await fake.collection('plans').doc(plan.id).update({ status: 'projects_matched' });
    await expect(
      generateScenes(plan.id, {
        provider: makeProvider([SAMPLE_LLM_REPLY]),
        db: asDb(),
      }),
    ).rejects.toMatchObject({ code: 'NO_PROJECT_MATCHES' });
  });
});

describe('generateScenes — failure mapping', () => {
  it('wraps LLMProviderError as LLM_FAILED', async () => {
    const planId = await makeReadyPlan();
    await expect(
      generateScenes(planId, {
        provider: makeProvider([
          { throws: new LLMProviderError('claude', 'TIMEOUT', 'slow') },
        ]),
        db: asDb(),
      }),
    ).rejects.toMatchObject({ code: 'LLM_FAILED' });
  });
});
