import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';

vi.mock('../../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() },
}));

import { createFakeFirestore, type FakeFirestore } from './fake-firestore.js';
import {
  createHookDraft,
  listHookDraftsForPlan,
  getSelectedHookDraft,
  setSelectedHookDraft,
  deleteAllHookDraftsForPlan,
} from '../../src/db/hook-drafts.js';

let fake: FakeFirestore;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asDb = () => fake as unknown as Firestore;

const PLAN_ID = 'plan_hook_test_1';

const HOOK_A = {
  archetype: 'pattern_interrupt' as const,
  scriptText:
    'Most developers spend weeks building a portfolio. I built mine in four hours using an AI that writes code. Here is exactly how I did it.',
  predictedRetention:
    'Pattern interrupt on conventional wisdom — developers expect weeks, not hours. Strong completion signal.',
};

const HOOK_B = {
  archetype: 'bold_claim' as const,
  scriptText:
    'Claude Code is the most productive coding tool I have ever used. In this video I prove it by building an entire SaaS backend live on camera.',
  predictedRetention:
    'Bold superlative claim demands justification — viewers stay to see if it holds up.',
};

const HOOK_C = {
  archetype: 'retention_question' as const,
  scriptText:
    'What if you could ship a production-ready app without writing a single line of code yourself? Stay until minute three and I will show you exactly how.',
  predictedRetention:
    'Direct retention instruction paired with curiosity about the mechanism. High watch-time prediction.',
};

beforeEach(() => {
  fake = createFakeFirestore();
});

describe('createHookDraft', () => {
  it('creates a hook draft with a fresh id and defaults selected to false', async () => {
    const h = await createHookDraft(PLAN_ID, HOOK_A, asDb());
    expect(h.id).toMatch(/^hook_/);
    expect(h.archetype).toBe('pattern_interrupt');
    expect(h.scriptText).toBe(HOOK_A.scriptText);
    expect(h.predictedRetention).toBe(HOOK_A.predictedRetention);
    expect(h.selected).toBe(false);
    expect(h.createdAt).toBeInstanceOf(Date);
  });

  it('stores the draft under the correct plan path', async () => {
    const h = await createHookDraft(PLAN_ID, HOOK_B, asDb());
    const dump = fake._dump();
    const key = `plans/${PLAN_ID}/hook_drafts/${h.id}`;
    expect(dump[key]).toBeDefined();
    expect(dump[key]!.archetype).toBe('bold_claim');
  });
});

describe('listHookDraftsForPlan', () => {
  it('returns hook drafts ordered by createdAt ascending', async () => {
    const h1 = await createHookDraft(PLAN_ID, HOOK_A, asDb());
    await new Promise((r) => setTimeout(r, 5));
    const h2 = await createHookDraft(PLAN_ID, HOOK_B, asDb());
    await new Promise((r) => setTimeout(r, 5));
    const h3 = await createHookDraft(PLAN_ID, HOOK_C, asDb());

    const list = await listHookDraftsForPlan(PLAN_ID, asDb());
    expect(list).toHaveLength(3);
    expect(list.map((h) => h.id)).toEqual([h1.id, h2.id, h3.id]);
  });

  it('returns empty array when no drafts exist', async () => {
    const list = await listHookDraftsForPlan('plan_empty', asDb());
    expect(list).toEqual([]);
  });
});

describe('getSelectedHookDraft', () => {
  it('returns null when none are selected', async () => {
    await createHookDraft(PLAN_ID, HOOK_A, asDb());
    const selected = await getSelectedHookDraft(PLAN_ID, asDb());
    expect(selected).toBeNull();
  });

  it('returns the selected draft after selection', async () => {
    const h = await createHookDraft(PLAN_ID, HOOK_B, asDb());
    await setSelectedHookDraft(PLAN_ID, h.id, asDb());
    const selected = await getSelectedHookDraft(PLAN_ID, asDb());
    expect(selected?.id).toBe(h.id);
    expect(selected?.selected).toBe(true);
  });
});

describe('setSelectedHookDraft', () => {
  it('atomic toggle: selecting #2 clears #1 and #3', async () => {
    const h1 = await createHookDraft(PLAN_ID, HOOK_A, asDb());
    const h2 = await createHookDraft(PLAN_ID, HOOK_B, asDb());
    const h3 = await createHookDraft(PLAN_ID, HOOK_C, asDb());

    // Select #2
    await setSelectedHookDraft(PLAN_ID, h2.id, asDb());
    const list1 = await listHookDraftsForPlan(PLAN_ID, asDb());
    const byId1 = Object.fromEntries(list1.map((h) => [h.id, h]));
    expect(byId1[h2.id]!.selected).toBe(true);
    expect(byId1[h1.id]!.selected).toBe(false);
    expect(byId1[h3.id]!.selected).toBe(false);

    // Now select #3 — #2 should become false
    await setSelectedHookDraft(PLAN_ID, h3.id, asDb());
    const list2 = await listHookDraftsForPlan(PLAN_ID, asDb());
    const byId2 = Object.fromEntries(list2.map((h) => [h.id, h]));
    expect(byId2[h3.id]!.selected).toBe(true);
    expect(byId2[h1.id]!.selected).toBe(false);
    expect(byId2[h2.id]!.selected).toBe(false);
  });

  it('throws when the hook draft id does not exist under the plan', async () => {
    await expect(
      setSelectedHookDraft(PLAN_ID, 'hook_nonexistent', asDb()),
    ).rejects.toThrow(/HookDraft hook_nonexistent not found under plan/);
  });
});

describe('deleteAllHookDraftsForPlan', () => {
  it('returns 0 when no drafts exist', async () => {
    const count = await deleteAllHookDraftsForPlan('plan_empty', asDb());
    expect(count).toBe(0);
  });

  it('deletes all drafts and returns the count', async () => {
    await createHookDraft(PLAN_ID, HOOK_A, asDb());
    await createHookDraft(PLAN_ID, HOOK_B, asDb());
    await createHookDraft(PLAN_ID, HOOK_C, asDb());

    const count = await deleteAllHookDraftsForPlan(PLAN_ID, asDb());
    expect(count).toBe(3);

    const list = await listHookDraftsForPlan(PLAN_ID, asDb());
    expect(list).toEqual([]);

    const dump = fake._dump();
    const remaining = Object.keys(dump).filter((k) => k.includes('hook_drafts'));
    expect(remaining).toHaveLength(0);
  });
});
