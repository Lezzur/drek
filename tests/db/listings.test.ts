import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';

vi.mock('../../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() },
}));

import { createFakeFirestore, type FakeFirestore } from './fake-firestore.js';
import {
  upsertListing,
  getListing,
  listListings,
  markListingSelected,
  deleteListing,
} from '../../src/db/listings.js';

let fake: FakeFirestore;
const asDb = () => fake as unknown as Firestore;

beforeEach(() => {
  fake = createFakeFirestore();
});

describe('upsertListing', () => {
  it('inserts a listing with the supplied id', async () => {
    const l = await upsertListing(
      { id: 'lst_1', title: 'Backend Eng', company: 'Acme', summary: null, rawText: null },
      asDb(),
    );
    expect(l.id).toBe('lst_1');
    expect(l.title).toBe('Backend Eng');
    expect(l.company).toBe('Acme');
    expect(l.selectedAt).toBeNull();
    expect(l.planId).toBeNull();
  });

  it('overwrites on re-upsert with the same id (idempotency)', async () => {
    await upsertListing({ id: 'lst_1', title: 'v1', company: 'A', summary: null, rawText: null }, asDb());
    await upsertListing({ id: 'lst_1', title: 'v2', company: 'A', summary: null, rawText: null }, asDb());
    const l = await getListing('lst_1', asDb());
    expect(l?.title).toBe('v2');
  });
});

describe('listListings', () => {
  it('returns most-recent first', async () => {
    await upsertListing(
      {
        id: 'lst_1', title: 'A', company: null, summary: null, rawText: null,
        receivedAt: new Date('2026-05-10T00:00:00Z'),
      },
      asDb(),
    );
    await upsertListing(
      {
        id: 'lst_2', title: 'B', company: null, summary: null, rawText: null,
        receivedAt: new Date('2026-05-15T00:00:00Z'),
      },
      asDb(),
    );
    const list = await listListings({}, asDb());
    expect(list.map((l) => l.id)).toEqual(['lst_2', 'lst_1']);
  });

  it('respects unselectedOnly', async () => {
    await upsertListing({ id: 'lst_1', title: 'A', company: null, summary: null, rawText: null }, asDb());
    await upsertListing({ id: 'lst_2', title: 'B', company: null, summary: null, rawText: null }, asDb());
    await markListingSelected('lst_1', 'plan_1', asDb());
    const list = await listListings({ unselectedOnly: true }, asDb());
    expect(list.map((l) => l.id)).toEqual(['lst_2']);
  });
});

describe('markListingSelected', () => {
  it('records selectedAt and planId', async () => {
    await upsertListing({ id: 'lst_1', title: 'A', company: null, summary: null, rawText: null }, asDb());
    const out = await markListingSelected('lst_1', 'plan_42', asDb());
    expect(out?.planId).toBe('plan_42');
    expect(out?.selectedAt).toBeInstanceOf(Date);
  });

  it('returns null when the listing does not exist', async () => {
    expect(await markListingSelected('lst_missing', 'plan_1', asDb())).toBeNull();
  });
});

describe('deleteListing', () => {
  it('removes a listing', async () => {
    await upsertListing({ id: 'lst_1', title: 'A', company: null, summary: null, rawText: null }, asDb());
    expect(await deleteListing('lst_1', asDb())).toBe(true);
    expect(await getListing('lst_1', asDb())).toBeNull();
  });

  it('returns false when nothing was there', async () => {
    expect(await deleteListing('lst_nope', asDb())).toBe(false);
  });
});
