import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';

vi.mock('../../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() },
}));

import { createFakeFirestore, type FakeFirestore } from '../db/fake-firestore.js';
import { createPlan, patchPlan } from '../../src/db/plans.js';
import { createDeliverable, patchDeliverable, getDeliverable } from '../../src/db/deliverables.js';
import { createTitleConcept, listTitleConceptsForDeliverable } from '../../src/db/title-concepts.js';
import { createThumbnailConcept, listThumbnailConceptsForDeliverable } from '../../src/db/thumbnail-concepts.js';
import { selectTitle } from '../../src/engine/select-title.js';
import { selectThumbnail } from '../../src/engine/select-thumbnail.js';
import { PlanningEngineError } from '../../src/engine/errors.js';

let fake: FakeFirestore;
const asDb = () => fake as unknown as Firestore;

async function setupAtTitlesGenerated() {
  const plan = await createPlan(
    {
      type: 'youtube_advanced',
      title: 'Ep',
      targetRuntimeSeconds: 1800,
      formatProfileId: 'claude_code_build_along',
    },
    asDb(),
  );
  const del = await createDeliverable(
    { planId: plan.id, kind: 'long_form', audienceProfileId: 'developer_longform', title: 'lf' },
    asDb(),
  );
  for (const s of [
    'requirements_reviewed',
    'projects_matched',
    'scenes_generated',
    'hooks_generated',
    'hook_selected',
    'shot_list_generated',
    'titles_generated',
  ] as const) {
    await patchPlan(plan.id, { status: s }, asDb());
  }
  // Seed 3 title concepts
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const c = await createTitleConcept(
      del.id,
      {
        titleText: `Title ${i + 1}`,
        archetype: 'specificity',
        predictedClickability: 7,
        reasoning: 'r',
        keywordsSurfaced: [],
        selected: false,
      },
      asDb(),
    );
    ids.push(c.id);
  }
  return { planId: plan.id, deliverableId: del.id, conceptIds: ids };
}

beforeEach(() => {
  fake = createFakeFirestore();
});

describe('selectTitle', () => {
  it('flips selected on the chosen concept, advances plan status', async () => {
    const { planId, deliverableId, conceptIds } = await setupAtTitlesGenerated();
    await selectTitle(deliverableId, conceptIds[1]!, asDb());

    const concepts = await listTitleConceptsForDeliverable(deliverableId, asDb());
    const map = Object.fromEntries(concepts.map((c) => [c.id, c.selected]));
    expect(map[conceptIds[0]!]).toBe(false);
    expect(map[conceptIds[1]!]).toBe(true);
    expect(map[conceptIds[2]!]).toBe(false);

    const planDoc = fake._dump()[`plans/${planId}`] as Record<string, unknown>;
    expect(planDoc.status).toBe('title_selected');
    expect(planDoc.selectedTitleVariantId).toBe(conceptIds[1]);

    const del = await getDeliverable(deliverableId, asDb());
    expect(del?.selectedTitleVariantId).toBe(conceptIds[1]);
  });

  it('re-selection from title_selected flips to a different concept', async () => {
    const { planId, deliverableId, conceptIds } = await setupAtTitlesGenerated();
    await selectTitle(deliverableId, conceptIds[0]!, asDb());
    await selectTitle(deliverableId, conceptIds[2]!, asDb());
    const concepts = await listTitleConceptsForDeliverable(deliverableId, asDb());
    const map = Object.fromEntries(concepts.map((c) => [c.id, c.selected]));
    expect(map[conceptIds[0]!]).toBe(false);
    expect(map[conceptIds[2]!]).toBe(true);
    const planDoc = fake._dump()[`plans/${planId}`] as Record<string, unknown>;
    expect(planDoc.selectedTitleVariantId).toBe(conceptIds[2]);
  });

  it('throws on unknown conceptId', async () => {
    const { deliverableId } = await setupAtTitlesGenerated();
    try {
      await selectTitle(deliverableId, 'title_unknown', asDb());
      expect.fail('should throw');
    } catch (err) {
      expect((err as PlanningEngineError).code).toBe('PLAN_NOT_FOUND');
    }
  });

  it('throws when plan status is wrong', async () => {
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
    const concept = await createTitleConcept(
      del.id,
      {
        titleText: 'X',
        archetype: 'specificity',
        predictedClickability: 5,
        reasoning: 'r',
        keywordsSurfaced: [],
      },
      asDb(),
    );
    // Plan still at awaiting_review
    try {
      await selectTitle(del.id, concept.id, asDb());
      expect.fail('should throw');
    } catch (err) {
      expect((err as PlanningEngineError).code).toBe('DISALLOWED_TRANSITION');
    }
  });
});

describe('selectThumbnail', () => {
  async function setupAtThumbnailsGenerated() {
    const ready = await setupAtTitlesGenerated();
    await patchPlan(ready.planId, { status: 'title_selected', selectedTitleVariantId: ready.conceptIds[0] }, asDb());
    await patchDeliverable(ready.deliverableId, { selectedTitleVariantId: ready.conceptIds[0] }, asDb());
    await patchPlan(ready.planId, { status: 'thumbnails_generated' }, asDb());
    // Seed 3 thumbnail concepts
    const thumbIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const t = await createThumbnailConcept(
        ready.deliverableId,
        {
          composition: `c${i}`,
          textHook: 'Hook',
          expression: null,
          colorPalette: ['#000000', '#ffffff'],
          assetsRequired: [],
          conceptSummary: 's',
        },
        asDb(),
      );
      thumbIds.push(t.id);
    }
    return { ...ready, thumbIds };
  }

  it('flips selected on chosen thumbnail and advances plan status', async () => {
    const { planId, deliverableId, thumbIds } = await setupAtThumbnailsGenerated();
    await selectThumbnail(deliverableId, thumbIds[1]!, asDb());

    const concepts = await listThumbnailConceptsForDeliverable(deliverableId, asDb());
    const map = Object.fromEntries(concepts.map((c) => [c.id, c.selected]));
    expect(map[thumbIds[1]!]).toBe(true);
    expect(map[thumbIds[0]!]).toBe(false);

    const planDoc = fake._dump()[`plans/${planId}`] as Record<string, unknown>;
    expect(planDoc.status).toBe('thumbnail_selected');
    expect(planDoc.selectedThumbnailConceptId).toBe(thumbIds[1]);
  });

  it('throws on unknown thumbnail concept id', async () => {
    const { deliverableId } = await setupAtThumbnailsGenerated();
    try {
      await selectThumbnail(deliverableId, 'thumb_unknown', asDb());
      expect.fail('should throw');
    } catch (err) {
      expect((err as PlanningEngineError).code).toBe('PLAN_NOT_FOUND');
    }
  });
});
