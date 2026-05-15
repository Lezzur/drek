import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';

vi.mock('../../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() },
}));

import { createFakeFirestore, type FakeFirestore } from './fake-firestore.js';
import {
  createScene,
  getScene,
  listScenes,
  patchScene,
  deleteScene,
  reorderScenes,
} from '../../src/db/scenes.js';

let fake: FakeFirestore;
const asDb = () => fake as unknown as Firestore;

beforeEach(() => {
  fake = createFakeFirestore();
});

describe('createScene', () => {
  it('appends scenes with auto-incrementing order when order is omitted', async () => {
    const s1 = await createScene('plan_1', { title: 'Intro' }, asDb());
    const s2 = await createScene('plan_1', { title: 'Demo' }, asDb());
    expect(s1.order).toBe(1);
    expect(s2.order).toBe(2);
  });

  it('honors an explicit order', async () => {
    const s = await createScene('plan_1', { title: 'Wrap', order: 7 }, asDb());
    expect(s.order).toBe(7);
  });

  it('defaults nullable/empty fields cleanly', async () => {
    const s = await createScene('plan_1', { title: 'Intro' }, asDb());
    expect(s.description).toBe('');
    expect(s.script).toBe('');
    expect(s.emphasisCues).toEqual([]);
    expect(s.projectRef).toBeNull();
    expect(s.storyboardImageUrl).toBeNull();
  });
});

describe('listScenes', () => {
  it('returns scenes sorted by order ascending', async () => {
    const s3 = await createScene('plan_1', { title: 'Third', order: 3 }, asDb());
    const s1 = await createScene('plan_1', { title: 'First', order: 1 }, asDb());
    const s2 = await createScene('plan_1', { title: 'Second', order: 2 }, asDb());
    const list = await listScenes('plan_1', asDb());
    expect(list.map((s) => s.id)).toEqual([s1.id, s2.id, s3.id]);
  });

  it('returns an empty array when the plan has no scenes', async () => {
    expect(await listScenes('plan_empty', asDb())).toEqual([]);
  });
});

describe('patchScene', () => {
  it('updates the script in place', async () => {
    const s = await createScene('plan_1', { title: 'Intro', script: 'v1' }, asDb());
    const patched = await patchScene('plan_1', s.id, { script: 'v2' }, asDb());
    expect(patched?.script).toBe('v2');
    expect(patched?.title).toBe('Intro');
  });

  it('returns null when the scene does not exist', async () => {
    expect(await patchScene('plan_1', 'scene_nope', { title: 'X' }, asDb())).toBeNull();
  });

  it('is a no-op when no patch fields are provided', async () => {
    const s = await createScene('plan_1', { title: 'Intro' }, asDb());
    const out = await patchScene('plan_1', s.id, {}, asDb());
    expect(out?.id).toBe(s.id);
  });
});

describe('deleteScene', () => {
  it('removes a scene and returns true', async () => {
    const s = await createScene('plan_1', { title: 'Intro' }, asDb());
    expect(await deleteScene('plan_1', s.id, asDb())).toBe(true);
    expect(await getScene('plan_1', s.id, asDb())).toBeNull();
  });

  it('returns false when nothing was there', async () => {
    expect(await deleteScene('plan_1', 'scene_nope', asDb())).toBe(false);
  });
});

describe('reorderScenes', () => {
  it('renumbers scenes per the given mapping', async () => {
    const s1 = await createScene('plan_1', { title: 'A' }, asDb());
    const s2 = await createScene('plan_1', { title: 'B' }, asDb());
    const s3 = await createScene('plan_1', { title: 'C' }, asDb());
    // Swap s1 and s3
    await reorderScenes(
      'plan_1',
      [
        { id: s1.id, order: 3 },
        { id: s3.id, order: 1 },
      ],
      asDb(),
    );
    const list = await listScenes('plan_1', asDb());
    expect(list.map((s) => s.title)).toEqual(['C', 'B', 'A']);
    expect(list.find((s) => s.id === s2.id)?.order).toBe(2); // untouched
  });

  it('is a no-op on an empty mapping', async () => {
    await expect(reorderScenes('plan_1', [], asDb())).resolves.toBeUndefined();
  });
});
