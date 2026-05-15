import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';

vi.mock('../../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() },
}));

import { createFakeFirestore, type FakeFirestore } from './fake-firestore.js';
import {
  createPlan,
  getPlan,
  listPlans,
  patchPlan,
  deletePlan,
  findPlanByListing,
} from '../../src/db/plans.js';

let fake: FakeFirestore;
const asDb = () => fake as unknown as Firestore;

beforeEach(() => {
  fake = createFakeFirestore();
});

describe('createPlan', () => {
  it('creates a plan with awaiting_review status and a fresh id', async () => {
    const p = await createPlan(
      {
        type: 'cover_letter',
        title: 'Backend Eng at Acme',
        targetRuntimeSeconds: 120,
        sourceListingId: 'lst_1',
        sourceListingText: 'we need video',
      },
      asDb(),
    );
    expect(p.id).toMatch(/^plan_/);
    expect(p.status).toBe('awaiting_review');
    expect(p.type).toBe('cover_letter');
    expect(p.title).toBe('Backend Eng at Acme');
    expect(p.sourceListingId).toBe('lst_1');
    expect(p.requirements).toEqual([]);
    expect(p.matchedProjects).toEqual([]);
    expect(p.estimatedRuntimeSeconds).toBe(0);
    expect(p.createdAt).toBeInstanceOf(Date);
  });

  it('honors an explicit initial status', async () => {
    const p = await createPlan(
      {
        type: 'youtube',
        title: 'Manual topic',
        targetRuntimeSeconds: 600,
        status: 'requirements_reviewed',
      },
      asDb(),
    );
    expect(p.status).toBe('requirements_reviewed');
  });
});

describe('getPlan', () => {
  it('returns null when the plan does not exist', async () => {
    expect(await getPlan('plan_missing', asDb())).toBeNull();
  });

  it('round-trips a created plan', async () => {
    const created = await createPlan(
      { type: 'cover_letter', title: 'X', targetRuntimeSeconds: 90 },
      asDb(),
    );
    const fetched = await getPlan(created.id, asDb());
    expect(fetched?.id).toBe(created.id);
    expect(fetched?.title).toBe('X');
  });
});

describe('listPlans', () => {
  it('returns plans newest-first', async () => {
    const a = await createPlan(
      { type: 'cover_letter', title: 'A', targetRuntimeSeconds: 60 },
      asDb(),
    );
    // small delay so createdAt timestamps differ deterministically
    await new Promise((r) => setTimeout(r, 5));
    const b = await createPlan(
      { type: 'youtube', title: 'B', targetRuntimeSeconds: 600 },
      asDb(),
    );
    const { plans } = await listPlans({}, asDb());
    expect(plans.map((p) => p.id)).toEqual([b.id, a.id]);
  });

  it('filters by type', async () => {
    await createPlan(
      { type: 'cover_letter', title: 'A', targetRuntimeSeconds: 60 },
      asDb(),
    );
    const b = await createPlan(
      { type: 'youtube', title: 'B', targetRuntimeSeconds: 600 },
      asDb(),
    );
    const { plans } = await listPlans({ type: 'youtube' }, asDb());
    expect(plans).toHaveLength(1);
    expect(plans[0]?.id).toBe(b.id);
  });

  it('filters by status', async () => {
    const p = await createPlan(
      { type: 'cover_letter', title: 'A', targetRuntimeSeconds: 60, status: 'finalized' },
      asDb(),
    );
    await createPlan(
      { type: 'cover_letter', title: 'B', targetRuntimeSeconds: 60 },
      asDb(),
    );
    const { plans } = await listPlans({ status: 'finalized' }, asDb());
    expect(plans).toHaveLength(1);
    expect(plans[0]?.id).toBe(p.id);
  });
});

describe('patchPlan', () => {
  it('updates title and bumps updatedAt', async () => {
    const p = await createPlan(
      { type: 'cover_letter', title: 'A', targetRuntimeSeconds: 60 },
      asDb(),
    );
    const before = p.updatedAt.getTime();
    await new Promise((r) => setTimeout(r, 5));
    const patched = await patchPlan(p.id, { title: 'A revised' }, asDb());
    expect(patched?.title).toBe('A revised');
    expect(patched!.updatedAt.getTime()).toBeGreaterThan(before);
  });

  it('honors valid status transitions', async () => {
    const p = await createPlan(
      { type: 'cover_letter', title: 'A', targetRuntimeSeconds: 60 },
      asDb(),
    );
    const ok = await patchPlan(p.id, { status: 'requirements_reviewed' }, asDb());
    expect(ok?.status).toBe('requirements_reviewed');
  });

  it('rejects invalid status transitions', async () => {
    const p = await createPlan(
      { type: 'cover_letter', title: 'A', targetRuntimeSeconds: 60 },
      asDb(),
    );
    await expect(
      patchPlan(p.id, { status: 'exported' }, asDb()),
    ).rejects.toThrow(/Disallowed plan transition/);
  });

  it('sets exportedAt when transitioning to exported', async () => {
    const p = await createPlan(
      {
        type: 'cover_letter',
        title: 'A',
        targetRuntimeSeconds: 60,
        status: 'finalized',
      },
      asDb(),
    );
    const exported = await patchPlan(p.id, { status: 'exported' }, asDb());
    expect(exported?.exportedAt).toBeInstanceOf(Date);
  });
});

describe('deletePlan', () => {
  it('returns false when the plan does not exist', async () => {
    expect(await deletePlan('plan_nope', asDb())).toBe(false);
  });

  it('returns true and removes the plan', async () => {
    const p = await createPlan(
      { type: 'cover_letter', title: 'A', targetRuntimeSeconds: 60 },
      asDb(),
    );
    expect(await deletePlan(p.id, asDb())).toBe(true);
    expect(await getPlan(p.id, asDb())).toBeNull();
  });
});

describe('findPlanByListing', () => {
  it('finds a plan by its source listing id', async () => {
    const p = await createPlan(
      {
        type: 'cover_letter',
        title: 'A',
        targetRuntimeSeconds: 60,
        sourceListingId: 'lst_42',
      },
      asDb(),
    );
    const found = await findPlanByListing('lst_42', asDb());
    expect(found?.id).toBe(p.id);
  });

  it('returns null when no plan matches', async () => {
    expect(await findPlanByListing('lst_missing', asDb())).toBeNull();
  });
});
