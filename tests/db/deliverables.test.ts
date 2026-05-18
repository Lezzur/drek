import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';

vi.mock('../../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() },
}));

import { createFakeFirestore, type FakeFirestore } from './fake-firestore.js';
import {
  createDeliverable,
  getDeliverable,
  listDeliverablesForPlan,
  patchDeliverable,
  deleteDeliverable,
  findLongFormDeliverable,
  DeliverableNotFoundError,
} from '../../src/db/deliverables.js';
import { createTitleConcept } from '../../src/db/title-concepts.js';

let fake: FakeFirestore;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asDb = () => fake as unknown as Firestore;

beforeEach(() => {
  fake = createFakeFirestore();
});

describe('createDeliverable', () => {
  it('creates a deliverable with draft status and a fresh id', async () => {
    const d = await createDeliverable(
      {
        planId: 'plan_1',
        kind: 'long_form',
        audienceProfileId: 'aud_1',
        title: 'My First Video',
      },
      asDb(),
    );
    expect(d.id).toMatch(/^del_/);
    expect(d.status).toBe('draft');
    expect(d.planId).toBe('plan_1');
    expect(d.kind).toBe('long_form');
    expect(d.audienceProfileId).toBe('aud_1');
    expect(d.title).toBe('My First Video');
    expect(d.createdAt).toBeInstanceOf(Date);
    expect(d.updatedAt).toBeInstanceOf(Date);
    expect(d.selectedTitleVariantId).toBeNull();
    expect(d.selectedThumbnailConceptId).toBeNull();
  });

  it('honors an explicit initial status', async () => {
    const d = await createDeliverable(
      {
        planId: 'plan_1',
        kind: 'short_clip',
        audienceProfileId: 'aud_1',
        title: 'Short One',
        status: 'scripts_ready',
      },
      asDb(),
    );
    expect(d.status).toBe('scripts_ready');
  });
});

describe('getDeliverable', () => {
  it('returns null when the deliverable does not exist', async () => {
    expect(await getDeliverable('del_missing', asDb())).toBeNull();
  });

  it('round-trips a created deliverable', async () => {
    const created = await createDeliverable(
      {
        planId: 'plan_1',
        kind: 'long_form',
        audienceProfileId: 'aud_2',
        title: 'Round Trip Video',
      },
      asDb(),
    );
    const fetched = await getDeliverable(created.id, asDb());
    expect(fetched?.id).toBe(created.id);
    expect(fetched?.title).toBe('Round Trip Video');
    expect(fetched?.planId).toBe('plan_1');
  });
});

describe('listDeliverablesForPlan', () => {
  it('returns all deliverables for a plan', async () => {
    await createDeliverable(
      { planId: 'plan_1', kind: 'long_form', audienceProfileId: 'aud_1', title: 'Long Form' },
      asDb(),
    );
    await createDeliverable(
      { planId: 'plan_1', kind: 'short_clip', audienceProfileId: 'aud_1', title: 'Short Clip' },
      asDb(),
    );
    const list = await listDeliverablesForPlan('plan_1', {}, asDb());
    expect(list).toHaveLength(2);
  });

  it('returns empty array when no deliverables exist for plan', async () => {
    const list = await listDeliverablesForPlan('plan_missing', {}, asDb());
    expect(list).toEqual([]);
  });

  it('filters by kind', async () => {
    await createDeliverable(
      { planId: 'plan_1', kind: 'long_form', audienceProfileId: 'aud_1', title: 'Long Form' },
      asDb(),
    );
    await createDeliverable(
      { planId: 'plan_1', kind: 'short_clip', audienceProfileId: 'aud_1', title: 'Short 1' },
      asDb(),
    );
    await createDeliverable(
      { planId: 'plan_1', kind: 'short_clip', audienceProfileId: 'aud_1', title: 'Short 2' },
      asDb(),
    );
    const shorts = await listDeliverablesForPlan('plan_1', { kind: 'short_clip' }, asDb());
    expect(shorts).toHaveLength(2);
    for (const s of shorts) expect(s.kind).toBe('short_clip');
  });
});

describe('patchDeliverable', () => {
  it('returns null when the deliverable does not exist', async () => {
    expect(await patchDeliverable('del_nope', { title: 'X' }, asDb())).toBeNull();
  });

  it('updates title and bumps updatedAt', async () => {
    const d = await createDeliverable(
      { planId: 'plan_1', kind: 'long_form', audienceProfileId: 'aud_1', title: 'Original' },
      asDb(),
    );
    const before = d.updatedAt.getTime();
    await new Promise((r) => setTimeout(r, 5));
    const patched = await patchDeliverable(d.id, { title: 'Updated' }, asDb());
    expect(patched?.title).toBe('Updated');
    expect(patched!.updatedAt.getTime()).toBeGreaterThan(before);
  });

  it('updates status to scripts_ready', async () => {
    const d = await createDeliverable(
      { planId: 'plan_1', kind: 'long_form', audienceProfileId: 'aud_1', title: 'My Video' },
      asDb(),
    );
    const patched = await patchDeliverable(d.id, { status: 'scripts_ready' }, asDb());
    expect(patched?.status).toBe('scripts_ready');
  });
});

describe('deleteDeliverable', () => {
  it('returns false when the deliverable does not exist', async () => {
    expect(await deleteDeliverable('del_nope', asDb())).toBe(false);
  });

  it('returns true and removes the deliverable', async () => {
    const d = await createDeliverable(
      { planId: 'plan_1', kind: 'long_form', audienceProfileId: 'aud_1', title: 'To Delete' },
      asDb(),
    );
    expect(await deleteDeliverable(d.id, asDb())).toBe(true);
    expect(await getDeliverable(d.id, asDb())).toBeNull();
  });

  it('cascades deletion to subcollections (title_concepts)', async () => {
    const d = await createDeliverable(
      { planId: 'plan_1', kind: 'long_form', audienceProfileId: 'aud_1', title: 'With Concepts' },
      asDb(),
    );
    await createTitleConcept(
      d.id,
      {
        titleText: 'A Great Title',
        archetype: 'curiosity_gap',
        predictedClickability: 8,
        reasoning: 'It creates curiosity by withholding the answer.',
      },
      asDb(),
    );
    // Verify concept exists before delete
    const dumpBefore = fake._dump();
    const conceptKeysBefore = Object.keys(dumpBefore).filter((k) =>
      k.includes('title_concepts'),
    );
    expect(conceptKeysBefore).toHaveLength(1);

    await deleteDeliverable(d.id, asDb());

    const dumpAfter = fake._dump();
    const conceptKeysAfter = Object.keys(dumpAfter).filter((k) =>
      k.includes('title_concepts'),
    );
    expect(conceptKeysAfter).toHaveLength(0);
    // Deliverable itself is gone
    expect(Object.keys(dumpAfter).filter((k) => k.startsWith('deliverables/'))).toHaveLength(0);
  });
});

describe('findLongFormDeliverable', () => {
  it('returns the long_form deliverable for a plan', async () => {
    const d = await createDeliverable(
      { planId: 'plan_A', kind: 'long_form', audienceProfileId: 'aud_1', title: 'Long Form Video' },
      asDb(),
    );
    const found = await findLongFormDeliverable('plan_A', asDb());
    expect(found.id).toBe(d.id);
    expect(found.kind).toBe('long_form');
  });

  it('throws DeliverableNotFoundError when no long_form exists', async () => {
    await expect(findLongFormDeliverable('plan_no_long_form', asDb())).rejects.toThrow(
      DeliverableNotFoundError,
    );
    await expect(findLongFormDeliverable('plan_no_long_form', asDb())).rejects.toThrow(
      /No long_form Deliverable for plan/,
    );
  });

  it('returns the first when multiple long_form deliverables exist (invariant violation, defensive)', async () => {
    const d1 = await createDeliverable(
      { planId: 'plan_B', kind: 'long_form', audienceProfileId: 'aud_1', title: 'First Long Form' },
      asDb(),
    );
    await createDeliverable(
      { planId: 'plan_B', kind: 'long_form', audienceProfileId: 'aud_1', title: 'Second Long Form' },
      asDb(),
    );
    const found = await findLongFormDeliverable('plan_B', asDb());
    // Returns first one found (not necessarily d1 since no ordering, just not null)
    expect(found).toBeDefined();
    expect(found.kind).toBe('long_form');
    expect(found.planId).toBe('plan_B');
    // The impl returns matches[0], which is the first in the fake's iteration order
    expect([d1.id]).toContain(found.id);
  });
});
