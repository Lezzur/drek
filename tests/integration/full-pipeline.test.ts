import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';

vi.mock('../../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() },
}));

import { createFakeFirestore, type FakeFirestore } from '../db/fake-firestore.js';
import { createPlan, getPlan } from '../../src/db/plans.js';
import { listScenes } from '../../src/db/scenes.js';
import { detectRequirements } from '../../src/engine/detect-requirements.js';
import { matchProjects } from '../../src/engine/match-projects.js';
import { generatePlanContent } from '../../src/engine/write-scripts.js';
import { runPollCycle, _resetCycleMutexForTests } from '../../src/polling/service.js';
import type { LLMProvider } from '../../src/providers/index.js';
import type { NeurocoreClient, MemoryContextResponse, PendingListing } from '../../src/neurocore/index.js';

/**
 * End-to-end integration tests for DREK's full planning pipeline.
 *
 * These wire the real engine modules (M4-M6) + polling (M9) against a
 * fake Firestore and mocked LLM/Neurocore. They prove the four-step
 * pipeline composes correctly: data flows through plan state transitions,
 * the LLM gets the right inputs at each step, and a failure mid-pipeline
 * leaves the plan in a recoverable state.
 *
 * These are the only tests that exercise the real M4→M5→M6 wiring on
 * a real fake store. Unit tests cover each step in isolation; this file
 * covers the seams.
 */

let fake: FakeFirestore;
const asDb = () => fake as unknown as Firestore;

beforeEach(() => {
  fake = createFakeFirestore();
  _resetCycleMutexForTests();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProvider(responses: Array<string | { throws: Error } | ((info: { call: number }) => string)>): LLMProvider {
  let i = 0;
  return {
    name: 'claude' as const,
    async generate() {
      const next = responses[i++];
      if (next === undefined) throw new Error('provider queue empty');
      if (typeof next === 'string') return next;
      if (typeof next === 'function') return next({ call: i });
      throw next.throws;
    },
  };
}

function makeClient(opts: {
  projectContext: MemoryContextResponse;
  voiceProfile: MemoryContextResponse;
  pendingListings?: PendingListing[];
  acks?: string[];
}): NeurocoreClient {
  return {
    async getProjectContext() {
      return opts.projectContext;
    },
    async getVoiceProfile() {
      return opts.voiceProfile;
    },
    async pollPendingSignals() {
      return opts.pendingListings ?? [];
    },
    async ackSignal(memoryId: string) {
      opts.acks?.push(memoryId);
    },
    async sendApprovedScript() {
      // no-op
    },
  } as unknown as NeurocoreClient;
}

const SAMPLE_PROJECT_CONTEXT: MemoryContextResponse = {
  systemBlock: `<projects_portfolio>
  <project>
    <projectName>Lead Pipeline</projectName>
    <slug>lead-pipeline</slug>
  </project>
</projects_portfolio>`,
  metadata: {
    layersIncluded: ['profile', 'projects'],
    memoryRecordIds: [],
    estimatedTokens: 500,
    degraded: false,
    budget: { requested: 6000, clampedTo: 6000, effective: 6000 },
  },
};

const SAMPLE_VOICE_CONTEXT: MemoryContextResponse = {
  systemBlock: '<voice>cadence: short bursts.</voice>',
  metadata: {
    layersIncluded: ['voice'],
    memoryRecordIds: [],
    estimatedTokens: 200,
    degraded: false,
    budget: { requested: 8000, clampedTo: 8000, effective: 8000 },
  },
};

const REQUIREMENTS_REPLY = JSON.stringify([
  {
    skill: 'lead pipeline automation',
    category: 'automation',
    priority: 'must_show',
    evidence: 'build automation for our lead pipeline',
  },
]);

const PROJECT_MATCH_REPLY = JSON.stringify([
  {
    projectSlug: 'lead-pipeline',
    projectName: 'Lead Pipeline',
    matchedFeatures: ['routing dashboard'],
    relevanceScore: 0.92,
    suggestedDemoSequence: 'Open dashboard. Trigger lead. Show alert.',
  },
]);

const SCENES_REPLY = JSON.stringify([
  {
    title: 'Intro',
    description: 'Rick intros relevant experience.',
    framingNotes: 'Headshot, plain background.',
    projectRef: null,
    estimatedDurationSeconds: 10,
    interfaceType: 'headshot',
  },
  {
    title: 'Demo lead pipeline',
    description: 'Trigger lead, show alert.',
    framingNotes: 'Screenshare, dashboard visible.',
    projectRef: 'lead-pipeline',
    estimatedDurationSeconds: 95,
    interfaceType: 'web-ui',
  },
  {
    title: 'Closing',
    description: 'CTA + availability.',
    framingNotes: 'Headshot.',
    projectRef: null,
    estimatedDurationSeconds: 8,
    interfaceType: 'headshot',
  },
]);

// ---------------------------------------------------------------------------
// Cover letter end-to-end
// ---------------------------------------------------------------------------

describe('cover-letter pipeline: requirement → match → generate', () => {
  it('runs all four LLM steps in sequence and leaves the plan at scenes_generated', async () => {
    const plan = await createPlan(
      {
        type: 'cover_letter',
        title: 'Backend Eng at Acme',
        targetRuntimeSeconds: 120,
        sourceListingText: 'Looking for an engineer to build lead pipelines and record a 2-min Loom demo.',
      },
      asDb(),
    );

    // M4: requirements
    const reqResult = await detectRequirements(plan.id, {
      provider: makeProvider([REQUIREMENTS_REPLY]),
      db: asDb(),
    });
    expect(reqResult.plan.status).toBe('requirements_reviewed');
    expect(reqResult.requirements).toHaveLength(1);

    // M5: matched projects (needs Neurocore)
    const matchResult = await matchProjects(plan.id, {
      provider: makeProvider([PROJECT_MATCH_REPLY]),
      client: makeClient({
        projectContext: SAMPLE_PROJECT_CONTEXT,
        voiceProfile: SAMPLE_VOICE_CONTEXT,
      }),
      db: asDb(),
    });
    expect(matchResult.plan.status).toBe('projects_matched');
    expect(matchResult.matchedProjects).toHaveLength(1);

    // M6: scenes + scripts (composite)
    // The scripts reply must reference scene ids we don't know yet — so we
    // build a provider that reads persisted scenes between Call 3 and Call 4.
    let llmCall = 0;
    const provider: LLMProvider = {
      name: 'claude' as const,
      async generate() {
        llmCall++;
        if (llmCall === 1) return SCENES_REPLY;
        // Call 4 — read scenes that were just persisted by Call 3.
        const scenes = await listScenes(plan.id, asDb());
        return JSON.stringify(
          scenes.map((s, i) => ({
            sceneId: s.id,
            script:
              'one two three four five six seven eight nine ten ' +
              'eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen ' +
              `nineteen twenty scene number ${i + 1} closing words for the script`,
            emphasisCues: ['Rick'],
            pacingNotes: 'Slow on the open.',
            transitionNote: 'Cut to next.',
          })),
        );
      },
    };
    const genResult = await generatePlanContent(plan.id, {
      provider,
      client: makeClient({
        projectContext: SAMPLE_PROJECT_CONTEXT,
        voiceProfile: SAMPLE_VOICE_CONTEXT,
      }),
      db: asDb(),
    });
    expect(genResult.scenesResult?.scenes).toHaveLength(3);
    expect(genResult.scriptsResult.plan.status).toBe('scenes_generated');
    expect(genResult.scriptsResult.plan.estimatedRuntimeSeconds).toBeGreaterThan(0);

    // Verify final persisted state.
    const finalPlan = await getPlan(plan.id, asDb());
    expect(finalPlan?.status).toBe('scenes_generated');
    expect(finalPlan?.requirements).toHaveLength(1);
    expect(finalPlan?.matchedProjects).toHaveLength(1);
    const finalScenes = await listScenes(plan.id, asDb());
    expect(finalScenes).toHaveLength(3);
    expect(finalScenes.every((s) => s.script.length > 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// YouTube end-to-end
// ---------------------------------------------------------------------------

describe('youtube pipeline: match → generate (no requirements step)', () => {
  it('skips Call 1 and runs match → generate', async () => {
    const plan = await createPlan(
      {
        type: 'youtube_lite',
        title: 'How I built a lead pipeline that auto-routes inbound leads',
        targetRuntimeSeconds: 600,
        status: 'requirements_reviewed', // M10's youtube form sets this entry state
      },
      asDb(),
    );

    const matchResult = await matchProjects(plan.id, {
      provider: makeProvider([PROJECT_MATCH_REPLY]),
      client: makeClient({
        projectContext: SAMPLE_PROJECT_CONTEXT,
        voiceProfile: SAMPLE_VOICE_CONTEXT,
      }),
      db: asDb(),
    });
    expect(matchResult.plan.status).toBe('projects_matched');

    let llmCall = 0;
    const provider: LLMProvider = {
      name: 'claude' as const,
      async generate() {
        llmCall++;
        if (llmCall === 1) return SCENES_REPLY;
        const scenes = await listScenes(plan.id, asDb());
        return JSON.stringify(
          scenes.map((s) => ({
            sceneId: s.id,
            script: 'a b c d e f g h i j k l m n o p q r s t u v w x y z aa bb cc dd ee',
            emphasisCues: [],
            pacingNotes: '',
            transitionNote: '',
          })),
        );
      },
    };
    const genResult = await generatePlanContent(plan.id, {
      provider,
      client: makeClient({
        projectContext: SAMPLE_PROJECT_CONTEXT,
        voiceProfile: SAMPLE_VOICE_CONTEXT,
      }),
      db: asDb(),
    });
    expect(genResult.scriptsResult.plan.status).toBe('scenes_generated');
  });
});

// ---------------------------------------------------------------------------
// Failure isolation
// ---------------------------------------------------------------------------

describe('pipeline failure isolation', () => {
  it('a failure at M5 leaves the plan at requirements_reviewed for retry', async () => {
    const plan = await createPlan(
      {
        type: 'cover_letter',
        title: 'X',
        targetRuntimeSeconds: 60,
        sourceListingText: 'Looking for an engineer. Loom video required.',
      },
      asDb(),
    );

    // M4 succeeds.
    await detectRequirements(plan.id, {
      provider: makeProvider([REQUIREMENTS_REPLY]),
      db: asDb(),
    });
    expect((await getPlan(plan.id, asDb()))?.status).toBe('requirements_reviewed');

    // M5 fails both retry attempts.
    await expect(
      matchProjects(plan.id, {
        provider: makeProvider(['gibberish', 'still gibberish']),
        client: makeClient({
          projectContext: SAMPLE_PROJECT_CONTEXT,
          voiceProfile: SAMPLE_VOICE_CONTEXT,
        }),
        db: asDb(),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_OUTPUT' });

    // Plan should NOT have advanced to projects_matched.
    expect((await getPlan(plan.id, asDb()))?.status).toBe('requirements_reviewed');
    // Requirements should still be there.
    expect((await getPlan(plan.id, asDb()))?.requirements).toHaveLength(1);
  });

  it('a failure at M6 Call 4 leaves the plan at projects_matched with scenes intact', async () => {
    const plan = await createPlan(
      {
        type: 'cover_letter',
        title: 'X',
        targetRuntimeSeconds: 120,
        sourceListingText: 'Listing. Loom video required.',
      },
      asDb(),
    );
    await detectRequirements(plan.id, {
      provider: makeProvider([REQUIREMENTS_REPLY]),
      db: asDb(),
    });
    await matchProjects(plan.id, {
      provider: makeProvider([PROJECT_MATCH_REPLY]),
      client: makeClient({
        projectContext: SAMPLE_PROJECT_CONTEXT,
        voiceProfile: SAMPLE_VOICE_CONTEXT,
      }),
      db: asDb(),
    });

    // M6: Call 3 succeeds, Call 4 fails both retries.
    await expect(
      generatePlanContent(plan.id, {
        provider: makeProvider([SCENES_REPLY, 'bad json', 'still bad']),
        client: makeClient({
          projectContext: SAMPLE_PROJECT_CONTEXT,
          voiceProfile: SAMPLE_VOICE_CONTEXT,
        }),
        db: asDb(),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_OUTPUT' });

    // Plan stayed at projects_matched.
    expect((await getPlan(plan.id, asDb()))?.status).toBe('projects_matched');
    // Scenes persisted from Call 3 (so retry can run Call 4 alone).
    const scenes = await listScenes(plan.id, asDb());
    expect(scenes).toHaveLength(3);
    // Scripts empty — Call 4 didn't run successfully.
    expect(scenes.every((s) => s.script === '')).toBe(true);

    // Retry path: skipScenes=true and a clean Call 4 reply.
    let calls = 0;
    const provider: LLMProvider = {
      name: 'claude' as const,
      async generate() {
        calls++;
        const persisted = await listScenes(plan.id, asDb());
        return JSON.stringify(
          persisted.map((s) => ({
            sceneId: s.id,
            script: 'Recovered script with at least twenty words filler one two three four five six seven eight nine ten.',
            emphasisCues: [],
            pacingNotes: '',
            transitionNote: '',
          })),
        );
      },
    };
    const recovery = await generatePlanContent(plan.id, {
      skipScenes: true,
      provider,
      client: makeClient({
        projectContext: SAMPLE_PROJECT_CONTEXT,
        voiceProfile: SAMPLE_VOICE_CONTEXT,
      }),
      db: asDb(),
    });
    expect(calls).toBe(1); // only Call 4 ran
    expect(recovery.scriptsResult.plan.status).toBe('scenes_generated');
  });
});

// ---------------------------------------------------------------------------
// Polling + full pipeline
// ---------------------------------------------------------------------------

describe('polling → full pipeline end-to-end', () => {
  it('ingests a listing then runs the four-step pipeline against it', async () => {
    const acks: string[] = [];
    const pendingListing: PendingListing = {
      memoryId: 'mem_1',
      listingId: 'lst_1',
      company: 'Acme',
      role: 'Backend Engineer',
      videoRequirements: 'Show automation work on lead pipelines',
      keySkills: ['ts'],
      url: 'https://example.com/jobs/1',
      ingestedAt: '2026-05-15T00:00:00Z',
    };

    // 1. Poll cycle creates the plan + ack
    const cycle = await runPollCycle({
      client: makeClient({
        projectContext: SAMPLE_PROJECT_CONTEXT,
        voiceProfile: SAMPLE_VOICE_CONTEXT,
        pendingListings: [pendingListing],
        acks,
      }),
      db: asDb(),
    });
    expect(cycle.createdPlans).toBe(1);
    expect(cycle.acked).toBe(1);
    expect(acks).toEqual(['mem_1']);

    // Find the plan the poll created.
    const allPlans = await fake
      .collection('plans')
      .get();
    expect(allPlans.docs).toHaveLength(1);
    const planId = allPlans.docs[0]!.id;

    const plan = await getPlan(planId, asDb());
    expect(plan?.sourceListingId).toBe('lst_1');
    expect(plan?.status).toBe('awaiting_review');

    // 2. Run the engine pipeline as if Rick clicked the action buttons.
    await detectRequirements(planId, {
      provider: makeProvider([REQUIREMENTS_REPLY]),
      db: asDb(),
    });
    await matchProjects(planId, {
      provider: makeProvider([PROJECT_MATCH_REPLY]),
      client: makeClient({
        projectContext: SAMPLE_PROJECT_CONTEXT,
        voiceProfile: SAMPLE_VOICE_CONTEXT,
      }),
      db: asDb(),
    });

    let calls = 0;
    const dynamicProvider: LLMProvider = {
      name: 'claude' as const,
      async generate() {
        calls++;
        if (calls === 1) return SCENES_REPLY;
        const scenes = await listScenes(planId, asDb());
        return JSON.stringify(
          scenes.map((s) => ({
            sceneId: s.id,
            script: 'word one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen',
            emphasisCues: [],
            pacingNotes: '',
            transitionNote: '',
          })),
        );
      },
    };
    await generatePlanContent(planId, {
      provider: dynamicProvider,
      client: makeClient({
        projectContext: SAMPLE_PROJECT_CONTEXT,
        voiceProfile: SAMPLE_VOICE_CONTEXT,
      }),
      db: asDb(),
    });

    const finalPlan = await getPlan(planId, asDb());
    expect(finalPlan?.status).toBe('scenes_generated');
    const scenes = await listScenes(planId, asDb());
    expect(scenes).toHaveLength(3);
    expect(scenes.every((s) => s.script.length > 0)).toBe(true);
  });
});
