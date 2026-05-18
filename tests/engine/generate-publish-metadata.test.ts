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
import { createScene } from '../../src/db/scenes.js';
import { getPublishMetadata } from '../../src/db/publish-metadata.js';
import {
  generatePublishMetadata,
  renderPublishBundle,
} from '../../src/engine/generate-publish-metadata.js';
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

function makeValidReply(chapterCount: number): string {
  return JSON.stringify({
    description:
      'Hook line goes here.\n\nA full paragraph of body content. Another paragraph.\n\nSubscribe for more.',
    chapterLabels: Array.from({ length: chapterCount }, (_, i) => `Chapter ${i + 1}`),
    tags: Array.from({ length: 12 }, (_, i) => `tag${i}`),
    pinnedComment: 'What did you build with this? Drop a comment.',
    endScreenSuggestion: 'Watch the prior episode on lead pipeline foundations.',
  });
}

/**
 * Walk the plan through every status from awaiting_review to `finalized`,
 * patching the deliverable to have selectedTitleVariantId and
 * selectedThumbnailConceptId. Returns the plan id and the long-form
 * deliverable id.
 */
async function makeFinalizedDeliverable(opts: {
  scenes?: Array<{ beatTag?: string | null; durationSeconds?: number; title?: string }>;
} = {}): Promise<{ planId: string; deliverableId: string }> {
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
    {
      planId: plan.id,
      kind: 'long_form',
      audienceProfileId: 'developer_longform',
      title: 'lf',
    },
    asDb(),
  );
  const scenes = opts.scenes ?? [
    { beatTag: 'cold_open', durationSeconds: 30, title: 'Cold open' },
    { beatTag: 'demo', durationSeconds: 180, title: 'Demo' },
    { beatTag: 'outro', durationSeconds: 30, title: 'Outro' },
  ];
  for (const [i, s] of scenes.entries()) {
    await createScene(
      plan.id,
      {
        order: i + 1,
        title: s.title ?? `Scene ${i + 1}`,
        description: 'd',
        framingNotes: 'f',
        script: 'short script line one. short script line two.',
        scriptDraft: '',
        estimatedDurationSeconds: s.durationSeconds ?? 30,
        beatTag: (s.beatTag ?? null) as never,
      },
      asDb(),
    );
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
    'shorts_extracted',
    'finalized',
  ] as const) {
    await patchPlan(plan.id, { status }, asDb());
  }
  await patchDeliverable(
    del.id,
    {
      selectedTitleVariantId: 'title_x',
      selectedThumbnailConceptId: 'thumb_x',
    },
    asDb(),
  );
  return { planId: plan.id, deliverableId: del.id };
}

beforeEach(() => {
  fake = createFakeFirestore();
});

describe('generatePublishMetadata — happy path', () => {
  it('persists metadata, advances plan to metadata_generated, marks deliverable metadata_ready', async () => {
    const { planId, deliverableId } = await makeFinalizedDeliverable();
    const provider = makeProvider([makeValidReply(3)]);
    const result = await generatePublishMetadata(deliverableId, { provider, db: asDb() });

    expect(result.metadata.chapters).toHaveLength(3);
    expect(result.metadata.tags.length).toBeGreaterThanOrEqual(10);
    expect(result.metadata.tags.length).toBeLessThanOrEqual(15);
    expect(result.retried).toBe(false);

    const stored = await getPublishMetadata(deliverableId, asDb());
    expect(stored).not.toBeNull();
    expect(stored!.description).toContain('--- Chapters ---');

    const planDoc = fake._dump()[`plans/${planId}`] as Record<string, unknown>;
    expect(planDoc.status).toBe('metadata_generated');

    const delDoc = fake._dump()[`deliverables/${deliverableId}`] as Record<string, unknown>;
    expect(delDoc.status).toBe('metadata_ready');
    expect(delDoc.publishMetadataId).toBe('current');
  });

  it('computes chapter timestamps server-side from cumulative scene durations', async () => {
    const { deliverableId } = await makeFinalizedDeliverable({
      scenes: [
        { beatTag: 'cold_open', durationSeconds: 30, title: 'A' },
        { beatTag: 'demo', durationSeconds: 180, title: 'B' },
        { beatTag: 'outro', durationSeconds: 60, title: 'C' },
      ],
    });
    const provider = makeProvider([makeValidReply(3)]);
    const result = await generatePublishMetadata(deliverableId, { provider, db: asDb() });

    expect(result.metadata.chapters.map((c) => c.timestampSeconds)).toEqual([0, 30, 210]);
  });

  it('skips non-eligible beats from chapters', async () => {
    const { deliverableId } = await makeFinalizedDeliverable({
      scenes: [
        { beatTag: 'cold_open', durationSeconds: 30, title: 'A' },
        // 'sponsor_read' is NOT in CHAPTER_ELIGIBLE_BEATS
        { beatTag: 'sponsor_read' as never, durationSeconds: 60, title: 'Ad' },
        { beatTag: 'demo', durationSeconds: 180, title: 'B' },
      ],
    });
    const provider = makeProvider([makeValidReply(2)]);
    const result = await generatePublishMetadata(deliverableId, { provider, db: asDb() });

    expect(result.metadata.chapters).toHaveLength(2);
    // Cold open at 0, demo at 30+60 = 90 (sponsor scene was skipped but
    // its duration still counts toward the running total).
    expect(result.metadata.chapters.map((c) => c.timestampSeconds)).toEqual([0, 90]);
  });
});

describe('generatePublishMetadata — guards', () => {
  it('rejects when no title selected', async () => {
    const { deliverableId } = await makeFinalizedDeliverable();
    await patchDeliverable(deliverableId, { selectedTitleVariantId: null }, asDb());

    try {
      await generatePublishMetadata(deliverableId, {
        provider: makeProvider([]),
        db: asDb(),
      });
      expect.fail('should throw');
    } catch (err) {
      expect((err as PlanningEngineError).code).toBe('NO_REQUIREMENTS');
    }
  });

  it('rejects when no thumbnail selected', async () => {
    const { deliverableId } = await makeFinalizedDeliverable();
    await patchDeliverable(deliverableId, { selectedThumbnailConceptId: null }, asDb());

    try {
      await generatePublishMetadata(deliverableId, {
        provider: makeProvider([]),
        db: asDb(),
      });
      expect.fail('should throw');
    } catch (err) {
      expect((err as PlanningEngineError).code).toBe('NO_REQUIREMENTS');
    }
  });

  it('rejects wrong long-form plan status', async () => {
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
      {
        planId: plan.id,
        kind: 'long_form',
        audienceProfileId: 'developer_longform',
        title: 'T',
      },
      asDb(),
    );
    await patchDeliverable(
      del.id,
      {
        selectedTitleVariantId: 'title_x',
        selectedThumbnailConceptId: 'thumb_x',
      },
      asDb(),
    );
    // plan stays at awaiting_review — wrong status for metadata.

    try {
      await generatePublishMetadata(del.id, {
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
      {
        type: 'cover_letter',
        title: 'CL',
        targetRuntimeSeconds: 180,
      },
      asDb(),
    );
    const del = await createDeliverable(
      {
        planId: plan.id,
        kind: 'long_form',
        audienceProfileId: 'developer_longform',
        title: 'cl',
      },
      asDb(),
    );
    await patchDeliverable(
      del.id,
      {
        selectedTitleVariantId: 'title_x',
        selectedThumbnailConceptId: 'thumb_x',
      },
      asDb(),
    );

    try {
      await generatePublishMetadata(del.id, {
        provider: makeProvider([]),
        db: asDb(),
      });
      expect.fail('should throw');
    } catch (err) {
      expect((err as PlanningEngineError).code).toBe('WRONG_PLAN_TYPE');
    }
  });
});

describe('generatePublishMetadata — retry', () => {
  it('retries on unparseable output', async () => {
    const { deliverableId } = await makeFinalizedDeliverable();
    const provider = makeProvider(['garbage{not json', makeValidReply(3)]);
    const result = await generatePublishMetadata(deliverableId, { provider, db: asDb() });
    expect(result.retried).toBe(true);
  });

  it('retries when chapterLabels count is wrong', async () => {
    const { deliverableId } = await makeFinalizedDeliverable();
    const badReply = JSON.stringify({
      description: 'd',
      chapterLabels: ['only one'], // expected 3
      tags: Array.from({ length: 12 }, (_, i) => `t${i}`),
      pinnedComment: 'pc',
      endScreenSuggestion: 'es',
    });
    const provider = makeProvider([badReply, makeValidReply(3)]);
    const result = await generatePublishMetadata(deliverableId, { provider, db: asDb() });
    expect(result.retried).toBe(true);
  });

  it('retries when tag count is below 10', async () => {
    const { deliverableId } = await makeFinalizedDeliverable();
    const badReply = JSON.stringify({
      description: 'd',
      chapterLabels: ['a', 'b', 'c'],
      tags: ['only', 'five', 'tags', 'here', 'too few'],
      pinnedComment: 'pc',
      endScreenSuggestion: 'es',
    });
    const provider = makeProvider([badReply, makeValidReply(3)]);
    const result = await generatePublishMetadata(deliverableId, { provider, db: asDb() });
    expect(result.retried).toBe(true);
  });

  it('throws INVALID_OUTPUT after two failed parses', async () => {
    const { deliverableId } = await makeFinalizedDeliverable();
    try {
      await generatePublishMetadata(deliverableId, {
        provider: makeProvider(['garbage', 'still garbage']),
        db: asDb(),
      });
      expect.fail('should throw');
    } catch (err) {
      expect((err as PlanningEngineError).code).toBe('INVALID_OUTPUT');
    }
  });

  it('throws INVALID_OUTPUT after two failed validations', async () => {
    const { deliverableId } = await makeFinalizedDeliverable();
    const badReply = JSON.stringify({
      description: 'd',
      chapterLabels: ['only one'],
      tags: ['too', 'few'],
      pinnedComment: 'pc',
      endScreenSuggestion: 'es',
    });
    try {
      await generatePublishMetadata(deliverableId, {
        provider: makeProvider([badReply, badReply]),
        db: asDb(),
      });
      expect.fail('should throw');
    } catch (err) {
      expect((err as PlanningEngineError).code).toBe('INVALID_OUTPUT');
    }
  });
});

describe('renderPublishBundle', () => {
  it('produces a plain-text bundle with all sections', async () => {
    const { deliverableId } = await makeFinalizedDeliverable();
    const provider = makeProvider([makeValidReply(3)]);
    await generatePublishMetadata(deliverableId, { provider, db: asDb() });
    const stored = await getPublishMetadata(deliverableId, asDb());
    const bundle = renderPublishBundle({
      title: 'My Episode Title',
      metadata: stored!,
    });
    expect(bundle).toContain('=== TITLE ===');
    expect(bundle).toContain('My Episode Title');
    expect(bundle).toContain('=== DESCRIPTION ===');
    expect(bundle).toContain('=== CHAPTERS ===');
    expect(bundle).toContain('0:00');
    expect(bundle).toContain('=== TAGS ===');
    expect(bundle).toContain('=== PINNED COMMENT ===');
    expect(bundle).toContain('=== END SCREEN ===');
  });
});
