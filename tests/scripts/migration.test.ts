import { describe, it, expect, beforeEach } from 'vitest';
import { createFakeFirestore, type FakeFirestore } from '../db/fake-firestore.js';
import { migrateYoutubeToYoutubeLite } from '../../scripts/migrate-youtube-to-youtube-lite.js';
import { migrateYoutubeLiteToYoutube } from '../../scripts/migrate-youtube-lite-to-youtube.js';

type AnyDb = FakeFirestore & {
  collection: (name: string) => {
    doc: (id: string) => { set: (data: Record<string, unknown>) => Promise<void> };
  };
};

async function seedPlans(db: FakeFirestore): Promise<void> {
  const col = (db as AnyDb).collection('plans');
  // Three v1 youtube plans + two cover_letter plans + one already-migrated
  // youtube_lite plan. The migration should only touch the three 'youtube'
  // docs and leave everything else alone.
  await col.doc('p_yt_1').set({ type: 'youtube', title: 'A', extra: 1 });
  await col.doc('p_yt_2').set({ type: 'youtube', title: 'B', extra: 2 });
  await col.doc('p_yt_3').set({ type: 'youtube', title: 'C', extra: 3 });
  await col.doc('p_cl_1').set({ type: 'cover_letter', title: 'CL1' });
  await col.doc('p_cl_2').set({ type: 'cover_letter', title: 'CL2' });
  await col.doc('p_yt_lite_pre').set({ type: 'youtube_lite', title: 'pre' });
}

function typeOf(db: FakeFirestore, id: string): string | undefined {
  const dump = db._dump();
  return (dump[`plans/${id}`] as Record<string, unknown> | undefined)?.type as
    | string
    | undefined;
}

let db: FakeFirestore;

beforeEach(() => {
  db = createFakeFirestore();
});

describe('migrateYoutubeToYoutubeLite', () => {
  it('dry run reports matched count without writing', async () => {
    await seedPlans(db);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await migrateYoutubeToYoutubeLite({ db: db as any });
    expect(result.matched).toBe(3);
    expect(result.updated).toBe(0);
    expect(typeOf(db, 'p_yt_1')).toBe('youtube'); // untouched
  });

  it('--execute flips all youtube docs to youtube_lite', async () => {
    await seedPlans(db);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await migrateYoutubeToYoutubeLite({ execute: true, db: db as any });
    expect(result.matched).toBe(3);
    expect(result.updated).toBe(3);
    expect(typeOf(db, 'p_yt_1')).toBe('youtube_lite');
    expect(typeOf(db, 'p_yt_2')).toBe('youtube_lite');
    expect(typeOf(db, 'p_yt_3')).toBe('youtube_lite');
  });

  it('preserves all other fields on migrated docs', async () => {
    await seedPlans(db);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await migrateYoutubeToYoutubeLite({ execute: true, db: db as any });
    const dump = db._dump();
    const updated = dump['plans/p_yt_1'] as Record<string, unknown>;
    expect(updated.title).toBe('A');
    expect(updated.extra).toBe(1);
  });

  it('leaves cover_letter and already-migrated youtube_lite docs untouched', async () => {
    await seedPlans(db);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await migrateYoutubeToYoutubeLite({ execute: true, db: db as any });
    expect(typeOf(db, 'p_cl_1')).toBe('cover_letter');
    expect(typeOf(db, 'p_cl_2')).toBe('cover_letter');
    expect(typeOf(db, 'p_yt_lite_pre')).toBe('youtube_lite');
  });

  it('is idempotent — second run is a no-op', async () => {
    await seedPlans(db);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await migrateYoutubeToYoutubeLite({ execute: true, db: db as any });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const second = await migrateYoutubeToYoutubeLite({ execute: true, db: db as any });
    expect(second.matched).toBe(0);
    expect(second.updated).toBe(0);
  });
});

describe('migrateYoutubeLiteToYoutube (rollback)', () => {
  it('reverses the up migration cleanly', async () => {
    await seedPlans(db);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await migrateYoutubeToYoutubeLite({ execute: true, db: db as any });
    // After up: 3 originals + 1 pre-existing = 4 youtube_lite
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rb = await migrateYoutubeLiteToYoutube({ execute: true, db: db as any });
    expect(rb.matched).toBe(4);
    expect(rb.updated).toBe(4);
    expect(typeOf(db, 'p_yt_1')).toBe('youtube');
    expect(typeOf(db, 'p_yt_lite_pre')).toBe('youtube');
    expect(typeOf(db, 'p_cl_1')).toBe('cover_letter');
  });

  it('is idempotent', async () => {
    await seedPlans(db);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await migrateYoutubeLiteToYoutube({ execute: true, db: db as any });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const second = await migrateYoutubeLiteToYoutube({ execute: true, db: db as any });
    expect(second.matched).toBe(0);
    expect(second.updated).toBe(0);
  });
});
