import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';

vi.mock('../../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() },
}));

// Default mock returns the shorts profile. Individual tests override via
// audienceClient.get.mockRejectedValueOnce(...) to simulate missing profile.
const audienceClientGet = vi.fn();
vi.mock('../../src/neurocore/audience-profiles.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/neurocore/audience-profiles.js')>(
    '../../src/neurocore/audience-profiles.js',
  );
  return {
    ...actual,
    getAudienceProfileClient: () => ({ get: audienceClientGet }),
  };
});

const SHORTS_PROFILE = {
  id: 'business_owner_shorts',
  name: 'Biz Owner',
  description: 'x',
  watchPersona: 'biz',
  painPoints: ['p'],
  buyingTriggers: ['t'],
  voiceGuidelines: { tone: 'w', vocabulary: 'plain', sentenceLengthGuide: 'short', taboos: [] },
  hookPatterns: ['h'],
  pacingRules: { wordsPerMinute: 165, avgSentenceWords: 12, densityNote: 'n' },
  ctaStyle: { type: 'subscribe_only', phrasing: 's', placement: 'end' },
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

import { createFakeFirestore, type FakeFirestore } from '../db/fake-firestore.js';
import { createPlan, patchPlan } from '../../src/db/plans.js';
import { createDeliverable, listDeliverablesForPlan } from '../../src/db/deliverables.js';
import { createScene } from '../../src/db/scenes.js';
import {
  extractShortsCandidates,
  approveShortCandidate,
  BEAT_WEIGHTS,
  type ShortCandidate,
} from '../../src/engine/extract-shorts.js';
import { PlanningEngineError } from '../../src/engine/errors.js';
import { AudienceProfileNotFoundError } from '../../src/neurocore/audience-profiles.js';
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

/**
 * Build a reworkedScript with `wc` words. Used for word-count validation.
 */
function script(wc: number): string {
  return Array.from({ length: wc }, (_, i) => `word${i}`).join(' ');
}

function rawCandidate(
  sceneIds: string[],
  opts: { wordCount?: number; beatScore?: number } = {},
) {
  return {
    sourceSceneIds: sceneIds,
    cutWindow: { startLine: 1, endLine: 10 },
    reworkedScript: script(opts.wordCount ?? 180),
    hookText: 'Hook line that grabs attention immediately.',
    verticalReframingNotes: 'Crop tight on the terminal; preserve face at top.',
    suggestedTitleHint: 'How to ship in 60s',
    suggestedThumbnailHint: 'Big red SHIPPED text over terminal screenshot.',
    beatImportanceScore: opts.beatScore ?? 9,
  };
}

async function makeReadyPlan(opts: {
  status?: 'metadata_generated' | 'finalized';
} = {}): Promise<{ planId: string; sceneIds: string[] }> {
  const plan = await createPlan(
    {
      type: 'youtube_advanced',
      title: 'Ep 1',
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
      title: 'lf',
    },
    asDb(),
  );
  const sceneIds: string[] = [];
  const sceneSeeds = [
    { beatTag: 'cold_open', title: 'Cold open' },
    { beatTag: 'problem', title: 'Problem' },
    { beatTag: 'demo', title: 'Demo' },
    { beatTag: 'outro', title: 'Outro' },
  ];
  for (const [i, s] of sceneSeeds.entries()) {
    const scene = await createScene(
      plan.id,
      {
        order: i + 1,
        title: s.title,
        description: 'd',
        framingNotes: 'f',
        script: 'line one\nline two\nline three\nline four\nline five',
        scriptDraft: '',
        estimatedDurationSeconds: 60,
        beatTag: s.beatTag as never,
      },
      asDb(),
    );
    sceneIds.push(scene.id);
  }
  // Walk transitions to reach metadata_generated or finalized.
  for (const status of [
    'requirements_reviewed',
    'projects_matched',
    'scenes_generated',
    'hooks_generated',
    'hook_selected',
    'shot_list_generated',
    'titles_generated',
    'title_selected',
    'thumbnails_generated',
    'thumbnail_selected',
    'shorts_extracted',
    'finalized',
  ] as const) {
    await patchPlan(plan.id, { status }, asDb());
  }
  if ((opts.status ?? 'finalized') === 'metadata_generated') {
    await patchPlan(plan.id, { status: 'metadata_generated' }, asDb());
  }
  return { planId: plan.id, sceneIds };
}

beforeEach(() => {
  fake = createFakeFirestore();
  audienceClientGet.mockReset();
  audienceClientGet.mockResolvedValue(SHORTS_PROFILE);
});

describe('extractShortsCandidates — happy path', () => {
  it('returns 4 candidates with generated ids, no Deliverables created', async () => {
    const { planId, sceneIds } = await makeReadyPlan();
    const reply = JSON.stringify([
      rawCandidate([sceneIds[0]!]),
      rawCandidate([sceneIds[1]!]),
      rawCandidate([sceneIds[2]!]),
      rawCandidate([sceneIds[3]!]),
    ]);
    const provider = makeProvider([reply]);

    const result = await extractShortsCandidates(planId, { provider, db: asDb() });

    expect(result.candidates).toHaveLength(4);
    for (const c of result.candidates) {
      expect(c.id).toMatch(/^short_/);
    }
    // Plan was at 'finalized' coming in — re-extraction does NOT roll status
    // back to shorts_extracted.
    const planDoc = fake._dump()[`plans/${planId}`] as Record<string, unknown>;
    expect(planDoc.status).toBe('finalized');

    // No new short_clip deliverables were created at extraction time.
    const shortDels = await listDeliverablesForPlan(
      planId,
      { kind: 'short_clip' },
      asDb(),
    );
    expect(shortDels).toHaveLength(0);
  });

  it('advances status thumbnail_selected -> shorts_extracted on first run', async () => {
    const plan = await createPlan(
      {
        type: 'youtube_advanced',
        title: 'Ep 2',
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
        title: 'lf',
      },
      asDb(),
    );
    const sceneIds: string[] = [];
    for (const i of [1, 2, 3] as const) {
      const s = await createScene(
        plan.id,
        {
          order: i,
          title: `s${i}`,
          description: 'd',
          framingNotes: 'f',
          script: 'a b c d e',
          scriptDraft: '',
          estimatedDurationSeconds: 60,
          beatTag: 'demo' as never,
        },
        asDb(),
      );
      sceneIds.push(s.id);
    }
    for (const status of [
      'requirements_reviewed',
      'projects_matched',
      'scenes_generated',
      'hooks_generated',
      'hook_selected',
      'shot_list_generated',
      'titles_generated',
      'title_selected',
      'thumbnails_generated',
      'thumbnail_selected',
    ] as const) {
      await patchPlan(plan.id, { status }, asDb());
    }
    const reply = JSON.stringify([
      rawCandidate([sceneIds[0]!]),
      rawCandidate([sceneIds[1]!]),
      rawCandidate([sceneIds[2]!]),
    ]);
    await extractShortsCandidates(plan.id, {
      provider: makeProvider([reply]),
      db: asDb(),
    });
    const planDoc = fake._dump()[`plans/${plan.id}`] as Record<string, unknown>;
    expect(planDoc.status).toBe('shorts_extracted');
  });

  it('accepts metadata_generated as a valid entry status', async () => {
    const { planId, sceneIds } = await makeReadyPlan({ status: 'metadata_generated' });
    const reply = JSON.stringify([
      rawCandidate([sceneIds[0]!]),
      rawCandidate([sceneIds[1]!]),
      rawCandidate([sceneIds[2]!]),
    ]);
    const provider = makeProvider([reply]);

    const result = await extractShortsCandidates(planId, { provider, db: asDb() });
    expect(result.candidates).toHaveLength(3);
  });

  it('BEAT_WEIGHTS exports demo=10 (strongest Shorts moment)', () => {
    expect(BEAT_WEIGHTS.demo).toBe(10);
    expect(BEAT_WEIGHTS.outro).toBe(8);
    expect(BEAT_WEIGHTS.cold_open).toBe(7);
  });
});

describe('extractShortsCandidates — guards', () => {
  it('rejects plans not in metadata_generated / finalized / shorts_extracted', async () => {
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
        title: 'lf',
      },
      asDb(),
    );
    // Plan stays at awaiting_review.

    try {
      await extractShortsCandidates(plan.id, {
        provider: makeProvider([]),
        db: asDb(),
      });
      expect.fail('should throw');
    } catch (err) {
      expect((err as PlanningEngineError).code).toBe('DISALLOWED_TRANSITION');
    }
  });

  it('rejects non-youtube_advanced plans', async () => {
    const plan = await createPlan(
      { type: 'cover_letter', title: 'CL', targetRuntimeSeconds: 180 },
      asDb(),
    );
    try {
      await extractShortsCandidates(plan.id, {
        provider: makeProvider([]),
        db: asDb(),
      });
      expect.fail('should throw');
    } catch (err) {
      expect((err as PlanningEngineError).code).toBe('WRONG_PLAN_TYPE');
    }
  });

  it('throws helpful NO_FORMAT_PROFILE when business_owner_shorts missing', async () => {
    const { planId } = await makeReadyPlan();
    audienceClientGet.mockReset();
    audienceClientGet.mockRejectedValue(
      new AudienceProfileNotFoundError('business_owner_shorts'),
    );

    try {
      await extractShortsCandidates(planId, {
        provider: makeProvider([]),
        db: asDb(),
      });
      expect.fail('should throw');
    } catch (err) {
      expect((err as PlanningEngineError).code).toBe('NO_FORMAT_PROFILE');
      expect((err as PlanningEngineError).message).toContain('M14 Track A');
    }
  });
});

describe('extractShortsCandidates — validation + retry', () => {
  it('retries on phantom sourceSceneId', async () => {
    const { planId, sceneIds } = await makeReadyPlan();
    const bad = JSON.stringify([
      rawCandidate(['scene_does_not_exist']),
      rawCandidate([sceneIds[1]!]),
      rawCandidate([sceneIds[2]!]),
    ]);
    const good = JSON.stringify([
      rawCandidate([sceneIds[0]!]),
      rawCandidate([sceneIds[1]!]),
      rawCandidate([sceneIds[2]!]),
    ]);
    const provider = makeProvider([bad, good]);

    const result = await extractShortsCandidates(planId, { provider, db: asDb() });
    expect(result.retried).toBe(true);
    expect(result.candidates).toHaveLength(3);
  });

  it('retries when reworkedScript word count is below 150', async () => {
    const { planId, sceneIds } = await makeReadyPlan();
    const bad = JSON.stringify([
      rawCandidate([sceneIds[0]!], { wordCount: 50 }), // too few
      rawCandidate([sceneIds[1]!]),
      rawCandidate([sceneIds[2]!]),
    ]);
    const good = JSON.stringify([
      rawCandidate([sceneIds[0]!]),
      rawCandidate([sceneIds[1]!]),
      rawCandidate([sceneIds[2]!]),
    ]);
    const provider = makeProvider([bad, good]);

    const result = await extractShortsCandidates(planId, { provider, db: asDb() });
    expect(result.retried).toBe(true);
  });

  it('retries when reworkedScript word count exceeds 225', async () => {
    const { planId, sceneIds } = await makeReadyPlan();
    const bad = JSON.stringify([
      rawCandidate([sceneIds[0]!], { wordCount: 400 }), // way over
      rawCandidate([sceneIds[1]!]),
      rawCandidate([sceneIds[2]!]),
    ]);
    const good = JSON.stringify([
      rawCandidate([sceneIds[0]!]),
      rawCandidate([sceneIds[1]!]),
      rawCandidate([sceneIds[2]!]),
    ]);
    const provider = makeProvider([bad, good]);

    const result = await extractShortsCandidates(planId, { provider, db: asDb() });
    expect(result.retried).toBe(true);
  });

  it('retries when candidate count is outside 3-5', async () => {
    const { planId, sceneIds } = await makeReadyPlan();
    const bad = JSON.stringify([rawCandidate([sceneIds[0]!])]); // only 1
    const good = JSON.stringify([
      rawCandidate([sceneIds[0]!]),
      rawCandidate([sceneIds[1]!]),
      rawCandidate([sceneIds[2]!]),
    ]);
    const provider = makeProvider([bad, good]);

    const result = await extractShortsCandidates(planId, { provider, db: asDb() });
    expect(result.retried).toBe(true);
  });

  it('throws INVALID_OUTPUT after two failed parses', async () => {
    const { planId } = await makeReadyPlan();
    try {
      await extractShortsCandidates(planId, {
        provider: makeProvider(['garbage', 'still garbage']),
        db: asDb(),
      });
      expect.fail('should throw');
    } catch (err) {
      expect((err as PlanningEngineError).code).toBe('INVALID_OUTPUT');
    }
    // Status invariant: should NOT have advanced.
    const planDoc = fake._dump()[`plans/${planId}`] as Record<string, unknown>;
    expect(planDoc.status).toBe('finalized');
  });
});

describe('approveShortCandidate', () => {
  it('creates a short_clip Deliverable with the correct fields', async () => {
    const { planId, sceneIds } = await makeReadyPlan();
    const candidate: ShortCandidate = {
      id: 'short_ephemeral',
      sourceSceneIds: [sceneIds[0]!, sceneIds[1]!],
      cutWindow: { startLine: 1, endLine: 8 },
      reworkedScript: script(180),
      hookText: 'You will not believe what shipped today.',
      verticalReframingNotes: 'Tight on terminal; face top-right.',
      suggestedTitleHint: 'Shipped in 60s',
      suggestedThumbnailHint: 'Big SHIPPED text',
      beatImportanceScore: 9,
    };

    const { deliverableId } = await approveShortCandidate(planId, candidate, {
      db: asDb(),
    });

    expect(deliverableId).toMatch(/^del_/);
    const delDoc = fake._dump()[`deliverables/${deliverableId}`] as Record<string, unknown>;
    expect(delDoc.kind).toBe('short_clip');
    expect(delDoc.audienceProfileId).toBe('business_owner_shorts');
    expect(delDoc.title).toBe('Shipped in 60s');
    expect(delDoc.status).toBe('scripts_ready');
    expect(delDoc.scriptOverrideSceneIds).toEqual([sceneIds[0]!, sceneIds[1]!]);
    expect(Array.isArray(delDoc.customScripts)).toBe(true);
    expect((delDoc.customScripts as Array<{ script: string }>)[0]!.script).toBe(
      candidate.reworkedScript,
    );
  });

  it('rejects when plan missing', async () => {
    try {
      await approveShortCandidate('plan_nope', {
        id: 'x',
        sourceSceneIds: ['s'],
        cutWindow: { startLine: 1, endLine: 2 },
        reworkedScript: script(180),
        hookText: 'h',
        verticalReframingNotes: 'v',
        suggestedTitleHint: 't',
        suggestedThumbnailHint: 'th',
        beatImportanceScore: 5,
      }, { db: asDb() });
      expect.fail('should throw');
    } catch (err) {
      expect((err as PlanningEngineError).code).toBe('PLAN_NOT_FOUND');
    }
  });

  it('rejects non-youtube_advanced plans', async () => {
    const plan = await createPlan(
      { type: 'cover_letter', title: 'CL', targetRuntimeSeconds: 180 },
      asDb(),
    );
    try {
      await approveShortCandidate(plan.id, {
        id: 'x',
        sourceSceneIds: ['s'],
        cutWindow: { startLine: 1, endLine: 2 },
        reworkedScript: script(180),
        hookText: 'h',
        verticalReframingNotes: 'v',
        suggestedTitleHint: 't',
        suggestedThumbnailHint: 'th',
        beatImportanceScore: 5,
      }, { db: asDb() });
      expect.fail('should throw');
    } catch (err) {
      expect((err as PlanningEngineError).code).toBe('WRONG_PLAN_TYPE');
    }
  });
});
