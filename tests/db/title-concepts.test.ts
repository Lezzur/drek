import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';

vi.mock('../../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() },
}));

import { createFakeFirestore, type FakeFirestore } from './fake-firestore.js';
import {
  createTitleConcept,
  listTitleConceptsForDeliverable,
  getSelectedTitleConcept,
  setSelectedTitleConcept,
  deleteAllTitleConceptsForDeliverable,
} from '../../src/db/title-concepts.js';

let fake: FakeFirestore;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asDb = () => fake as unknown as Firestore;

const DEL_ID = 'del_test_1';

const CONCEPT_A = {
  titleText: 'I Built a Portfolio in 4 Hours',
  archetype: 'specificity' as const,
  predictedClickability: 7,
  reasoning: 'Specificity in time builds credibility and curiosity.',
};

const CONCEPT_B = {
  titleText: 'Why Most Developers Fail at This',
  archetype: 'curiosity_gap' as const,
  predictedClickability: 9,
  reasoning: 'Creates a strong curiosity gap by implying a hidden failure point.',
};

const CONCEPT_C = {
  titleText: 'The Claude Code Tutorial Nobody Made',
  archetype: 'payoff_promise' as const,
  predictedClickability: 6,
  reasoning: 'Promises unique, hard-to-find insight.',
};

beforeEach(() => {
  fake = createFakeFirestore();
});

describe('createTitleConcept', () => {
  it('creates a concept with a fresh id and defaults selected to false', async () => {
    const c = await createTitleConcept(DEL_ID, CONCEPT_A, asDb());
    expect(c.id).toMatch(/^title_/);
    expect(c.titleText).toBe(CONCEPT_A.titleText);
    expect(c.archetype).toBe('specificity');
    expect(c.predictedClickability).toBe(7);
    expect(c.selected).toBe(false);
    expect(c.createdAt).toBeInstanceOf(Date);
  });

  it('stores the concept under the correct deliverable path', async () => {
    const c = await createTitleConcept(DEL_ID, CONCEPT_B, asDb());
    const dump = fake._dump();
    const key = `deliverables/${DEL_ID}/title_concepts/${c.id}`;
    expect(dump[key]).toBeDefined();
    expect(dump[key]!.titleText).toBe(CONCEPT_B.titleText);
  });
});

describe('listTitleConceptsForDeliverable', () => {
  it('returns concepts sorted by predictedClickability descending', async () => {
    await createTitleConcept(DEL_ID, CONCEPT_A, asDb()); // clickability 7
    await createTitleConcept(DEL_ID, CONCEPT_B, asDb()); // clickability 9
    await createTitleConcept(DEL_ID, CONCEPT_C, asDb()); // clickability 6
    const list = await listTitleConceptsForDeliverable(DEL_ID, asDb());
    expect(list).toHaveLength(3);
    expect(list[0]!.predictedClickability).toBe(9);
    expect(list[1]!.predictedClickability).toBe(7);
    expect(list[2]!.predictedClickability).toBe(6);
  });

  it('returns empty array when no concepts exist', async () => {
    const list = await listTitleConceptsForDeliverable('del_empty', asDb());
    expect(list).toEqual([]);
  });
});

describe('getSelectedTitleConcept', () => {
  it('returns null when none are selected', async () => {
    await createTitleConcept(DEL_ID, CONCEPT_A, asDb());
    const selected = await getSelectedTitleConcept(DEL_ID, asDb());
    expect(selected).toBeNull();
  });

  it('returns the selected concept after selection', async () => {
    const c = await createTitleConcept(DEL_ID, CONCEPT_B, asDb());
    await setSelectedTitleConcept(DEL_ID, c.id, asDb());
    const selected = await getSelectedTitleConcept(DEL_ID, asDb());
    expect(selected?.id).toBe(c.id);
    expect(selected?.selected).toBe(true);
  });
});

describe('setSelectedTitleConcept', () => {
  it('atomic toggle: selecting #2 clears #1 and #3', async () => {
    const c1 = await createTitleConcept(DEL_ID, CONCEPT_A, asDb());
    const c2 = await createTitleConcept(DEL_ID, CONCEPT_B, asDb());
    const c3 = await createTitleConcept(DEL_ID, CONCEPT_C, asDb());

    // Select #2
    await setSelectedTitleConcept(DEL_ID, c2.id, asDb());
    const list1 = await listTitleConceptsForDeliverable(DEL_ID, asDb());
    const byId1 = Object.fromEntries(list1.map((c) => [c.id, c]));
    expect(byId1[c2.id]!.selected).toBe(true);
    expect(byId1[c1.id]!.selected).toBe(false);
    expect(byId1[c3.id]!.selected).toBe(false);

    // Now select #3 — #2 should become false
    await setSelectedTitleConcept(DEL_ID, c3.id, asDb());
    const list2 = await listTitleConceptsForDeliverable(DEL_ID, asDb());
    const byId2 = Object.fromEntries(list2.map((c) => [c.id, c]));
    expect(byId2[c3.id]!.selected).toBe(true);
    expect(byId2[c1.id]!.selected).toBe(false);
    expect(byId2[c2.id]!.selected).toBe(false);
  });

  it('throws when the concept id does not exist under the deliverable', async () => {
    await expect(
      setSelectedTitleConcept(DEL_ID, 'title_nonexistent', asDb()),
    ).rejects.toThrow(/TitleConcept title_nonexistent not found under deliverable/);
  });
});

describe('deleteAllTitleConceptsForDeliverable', () => {
  it('returns 0 when no concepts exist', async () => {
    const count = await deleteAllTitleConceptsForDeliverable('del_empty', asDb());
    expect(count).toBe(0);
  });

  it('deletes all concepts and returns the count', async () => {
    await createTitleConcept(DEL_ID, CONCEPT_A, asDb());
    await createTitleConcept(DEL_ID, CONCEPT_B, asDb());
    await createTitleConcept(DEL_ID, CONCEPT_C, asDb());

    const count = await deleteAllTitleConceptsForDeliverable(DEL_ID, asDb());
    expect(count).toBe(3);

    const list = await listTitleConceptsForDeliverable(DEL_ID, asDb());
    expect(list).toEqual([]);

    const dump = fake._dump();
    const remaining = Object.keys(dump).filter((k) => k.includes('title_concepts'));
    expect(remaining).toHaveLength(0);
  });
});
