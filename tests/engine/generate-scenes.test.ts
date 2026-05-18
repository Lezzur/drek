import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';

vi.mock('../../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() },
}));

// Mock audience profile client so v2 tests don't need Neurocore.
vi.mock('../../src/neurocore/audience-profiles.js', () => {
  const fakeProfile = {
    id: 'developer_longform',
    name: 'Developer Longform',
    description: 'Test profile',
    watchPersona: 'Developers',
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

// ===========================================================================
// youtube_advanced (v2) tests
// ===========================================================================

/** Beat names from the claude_code_build_along profile. */
const BEATS = ['cold_open', 'problem', 'war_room', 'build_reel', 'breakdown', 'demo', 'outro'];

/** Build a valid 6-scene LLM reply that covers all required beats (minus one, still valid range 5-7). */
function makeV2ScenesReply(beats = BEATS.slice(0, 6), projectSlug = 'lead-pipeline'): string {
  return JSON.stringify(
    beats.map((beatTag, i) => ({
      beatTag,
      title: `${beatTag} scene`,
      description: `Description for ${beatTag}`,
      framingNotes: `Framing for ${beatTag}`,
      estimatedDurationSeconds: 250,
      projectRef: i === 3 ? projectSlug : null,
    })),
  );
}

async function makeV2ReadyPlan(): Promise<string> {
  const plan = await createPlan(
    {
      type: 'youtube_advanced',
      title: 'Lead Scoring Episode',
      targetRuntimeSeconds: 1800,
      formatProfileId: 'claude_code_build_along',
      pipelineBriefId: null,
      status: 'projects_matched',
    },
    asDb(),
  );
  await fake.collection('plans').doc(plan.id).update({
    matchedProjects: [SAMPLE_MATCH],
    requirements: [
      {
        skill: 'episode_plan',
        category: 'episode_outline',
        priority: 'must_show',
        evidence: JSON.stringify({
          episodeAngle: 'Build a real lead scoring system',
          antiAngle: 'Not a tutorial',
          technicalScope: 'Shows integration',
          intendedTakeaway: 'Viewer learns scoping',
          risksToFlag: ['API rate limits'],
        }),
      },
    ],
  });
  // Create long_form deliverable (youtube_advanced invariant).
  await createDeliverable(
    {
      planId: plan.id,
      kind: 'long_form',
      audienceProfileId: 'developer_longform',
      title: plan.title,
      status: 'draft',
    },
    asDb(),
  );
  return plan.id;
}

describe('generateScenes — youtube_advanced happy path', () => {
  it('persists scenes with beatTag, transitions status to scenes_generated', async () => {
    const planId = await makeV2ReadyPlan();
    const result = await generateScenes(planId, {
      provider: makeProvider([makeV2ScenesReply()]),
      db: asDb(),
    });

    expect(result.scenes).toHaveLength(6);
    expect(result.scenes[0]?.beatTag).toBe('cold_open');
    expect(result.scenes[1]?.beatTag).toBe('problem');
    expect(result.scenes[3]?.projectRef).toBe('lead-pipeline');
    expect(result.scenes[0]?.script).toBe(''); // write-scripts fills this
    expect(result.plan.status).toBe('scenes_generated');
    expect(result.retried).toBe(false);
  });

  it('wipes existing scenes on regeneration', async () => {
    const planId = await makeV2ReadyPlan();
    await createScene(planId, { title: 'old scene A' }, asDb());
    await createScene(planId, { title: 'old scene B' }, asDb());
    expect((await listScenes(planId, asDb()))).toHaveLength(2);

    await generateScenes(planId, {
      provider: makeProvider([makeV2ScenesReply()]),
      db: asDb(),
    });

    const after = await listScenes(planId, asDb());
    expect(after).toHaveLength(6);
    expect(after.map((s) => s.title)).not.toContain('old scene A');
  });
});

describe('generateScenes — youtube_advanced retry on unknown beatTag', () => {
  it('retries once when beatTag is unknown, succeeds on second attempt', async () => {
    const planId = await makeV2ReadyPlan();
    const badReply = makeV2ScenesReply(['cold_open', 'problem', 'WAR_ROOM_WRONG', 'build_reel', 'breakdown', 'demo']);
    const goodReply = makeV2ScenesReply();

    const result = await generateScenes(planId, {
      provider: makeProvider([badReply, goodReply]),
      db: asDb(),
    });

    expect(result.retried).toBe(true);
    expect(result.scenes).toHaveLength(6);
    expect(result.scenes[2]?.beatTag).toBe('war_room');
  });

  it('throws INVALID_OUTPUT when scene count is outside sceneRange after retry', async () => {
    const planId = await makeV2ReadyPlan();
    // Produce 2 scenes (below min of 5) twice.
    const tooFew = JSON.stringify([
      { beatTag: 'cold_open', title: 'A', description: 'D', framingNotes: 'F', estimatedDurationSeconds: 300, projectRef: null },
      { beatTag: 'problem', title: 'B', description: 'D', framingNotes: 'F', estimatedDurationSeconds: 300, projectRef: null },
    ]);
    await expect(
      generateScenes(planId, {
        provider: makeProvider([tooFew, tooFew]),
        db: asDb(),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
  });
});

describe('generateScenes — youtube_advanced status guards', () => {
  it('throws WRONG_PLAN_STATUS when plan is not projects_matched or scenes_generated', async () => {
    const plan = await createPlan(
      {
        type: 'youtube_advanced',
        title: 'X',
        targetRuntimeSeconds: 1800,
        formatProfileId: 'claude_code_build_along',
        status: 'requirements_reviewed',
      },
      asDb(),
    );
    await fake.collection('plans').doc(plan.id).update({ matchedProjects: [SAMPLE_MATCH] });
    await expect(
      generateScenes(plan.id, {
        provider: makeProvider([makeV2ScenesReply()]),
        db: asDb(),
      }),
    ).rejects.toMatchObject({ code: 'WRONG_PLAN_STATUS' });
  });
});
