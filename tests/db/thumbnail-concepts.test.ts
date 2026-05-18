import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';

vi.mock('../../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() },
}));

import { createFakeFirestore, type FakeFirestore } from './fake-firestore.js';
import {
  createThumbnailConcept,
  listThumbnailConceptsForDeliverable,
  getSelectedThumbnailConcept,
  setSelectedThumbnailConcept,
  deleteAllThumbnailConceptsForDeliverable,
} from '../../src/db/thumbnail-concepts.js';

let fake: FakeFirestore;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asDb = () => fake as unknown as Firestore;

const DEL_ID = 'del_thumb_test_1';

const CONCEPT_A = {
  composition: 'Side-by-side split screen showing code on left, terminal output on right',
  textHook: 'Ships In Hours',
  expression: 'focused',
  colorPalette: ['#0a0a0a', '#22c55e'],
  assetsRequired: ['screen-recording-clip.mp4'],
  conceptSummary: 'High-contrast dark theme with green accent to convey speed.',
};

const CONCEPT_B = {
  composition: 'Close-up of Rick at laptop with shocked expression, code on second monitor',
  textHook: 'It Just Works',
  expression: 'shocked',
  colorPalette: ['#1e1b4b', '#f59e0b'],
  assetsRequired: ['headshot-shocked.jpg', 'monitor-screenshot.png'],
  conceptSummary: 'Reaction thumbnail pattern with warm highlight color for visibility.',
};

const CONCEPT_C = {
  composition: 'Clean white background, large bold text, minimal icon',
  textHook: 'Zero to Shipped',
  expression: null,
  colorPalette: ['#ffffff', '#3b82f6', '#1e40af'],
  assetsRequired: [],
  conceptSummary: 'Minimalist design targeting developer aesthetic.',
};

beforeEach(() => {
  fake = createFakeFirestore();
});

describe('createThumbnailConcept', () => {
  it('creates a concept with a fresh id and defaults selected to false', async () => {
    const c = await createThumbnailConcept(DEL_ID, CONCEPT_A, asDb());
    expect(c.id).toMatch(/^thumb_/);
    expect(c.composition).toBe(CONCEPT_A.composition);
    expect(c.textHook).toBe('Ships In Hours');
    expect(c.colorPalette).toEqual(['#0a0a0a', '#22c55e']);
    expect(c.selected).toBe(false);
    expect(c.createdAt).toBeInstanceOf(Date);
  });

  it('stores the concept under the correct deliverable path', async () => {
    const c = await createThumbnailConcept(DEL_ID, CONCEPT_B, asDb());
    const dump = fake._dump();
    const key = `deliverables/${DEL_ID}/thumbnail_concepts/${c.id}`;
    expect(dump[key]).toBeDefined();
    expect(dump[key]!.textHook).toBe('It Just Works');
  });

  it('defaults expression to null when not provided', async () => {
    const c = await createThumbnailConcept(DEL_ID, CONCEPT_C, asDb());
    expect(c.expression).toBeNull();
  });
});

describe('listThumbnailConceptsForDeliverable', () => {
  it('returns all concepts for a deliverable', async () => {
    await createThumbnailConcept(DEL_ID, CONCEPT_A, asDb());
    await createThumbnailConcept(DEL_ID, CONCEPT_B, asDb());
    await createThumbnailConcept(DEL_ID, CONCEPT_C, asDb());
    const list = await listThumbnailConceptsForDeliverable(DEL_ID, asDb());
    expect(list).toHaveLength(3);
  });

  it('returns empty array when no concepts exist', async () => {
    const list = await listThumbnailConceptsForDeliverable('del_empty', asDb());
    expect(list).toEqual([]);
  });
});

describe('getSelectedThumbnailConcept', () => {
  it('returns null when none are selected', async () => {
    await createThumbnailConcept(DEL_ID, CONCEPT_A, asDb());
    const selected = await getSelectedThumbnailConcept(DEL_ID, asDb());
    expect(selected).toBeNull();
  });

  it('returns the selected concept after selection', async () => {
    const c = await createThumbnailConcept(DEL_ID, CONCEPT_B, asDb());
    await setSelectedThumbnailConcept(DEL_ID, c.id, asDb());
    const selected = await getSelectedThumbnailConcept(DEL_ID, asDb());
    expect(selected?.id).toBe(c.id);
    expect(selected?.selected).toBe(true);
  });
});

describe('setSelectedThumbnailConcept', () => {
  it('atomic toggle: selecting #2 clears #1 and #3', async () => {
    const c1 = await createThumbnailConcept(DEL_ID, CONCEPT_A, asDb());
    const c2 = await createThumbnailConcept(DEL_ID, CONCEPT_B, asDb());
    const c3 = await createThumbnailConcept(DEL_ID, CONCEPT_C, asDb());

    // Select #2
    await setSelectedThumbnailConcept(DEL_ID, c2.id, asDb());
    const list1 = await listThumbnailConceptsForDeliverable(DEL_ID, asDb());
    const byId1 = Object.fromEntries(list1.map((c) => [c.id, c]));
    expect(byId1[c2.id]!.selected).toBe(true);
    expect(byId1[c1.id]!.selected).toBe(false);
    expect(byId1[c3.id]!.selected).toBe(false);

    // Now select #3 — #2 should become false
    await setSelectedThumbnailConcept(DEL_ID, c3.id, asDb());
    const list2 = await listThumbnailConceptsForDeliverable(DEL_ID, asDb());
    const byId2 = Object.fromEntries(list2.map((c) => [c.id, c]));
    expect(byId2[c3.id]!.selected).toBe(true);
    expect(byId2[c1.id]!.selected).toBe(false);
    expect(byId2[c2.id]!.selected).toBe(false);
  });

  it('throws when the concept id does not exist under the deliverable', async () => {
    await expect(
      setSelectedThumbnailConcept(DEL_ID, 'thumb_nonexistent', asDb()),
    ).rejects.toThrow(/ThumbnailConcept thumb_nonexistent not found under deliverable/);
  });
});

describe('deleteAllThumbnailConceptsForDeliverable', () => {
  it('returns 0 when no concepts exist', async () => {
    const count = await deleteAllThumbnailConceptsForDeliverable('del_empty', asDb());
    expect(count).toBe(0);
  });

  it('deletes all concepts and returns the count', async () => {
    await createThumbnailConcept(DEL_ID, CONCEPT_A, asDb());
    await createThumbnailConcept(DEL_ID, CONCEPT_B, asDb());
    await createThumbnailConcept(DEL_ID, CONCEPT_C, asDb());

    const count = await deleteAllThumbnailConceptsForDeliverable(DEL_ID, asDb());
    expect(count).toBe(3);

    const list = await listThumbnailConceptsForDeliverable(DEL_ID, asDb());
    expect(list).toEqual([]);

    const dump = fake._dump();
    const remaining = Object.keys(dump).filter((k) => k.includes('thumbnail_concepts'));
    expect(remaining).toHaveLength(0);
  });
});
