import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';

vi.mock('../../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() },
}));

import { createFakeFirestore, type FakeFirestore } from '../db/fake-firestore.js';
import { createPlan } from '../../src/db/plans.js';
import { createHookDraft, listHookDraftsForPlan, getSelectedHookDraft } from '../../src/db/hook-drafts.js';
import { getPlan } from '../../src/db/plans.js';
import { selectHook } from '../../src/engine/select-hook.js';
import { PlanningEngineError } from '../../src/engine/errors.js';

let fake: FakeFirestore;
const asDb = () => fake as unknown as Firestore;

function makeScriptText(wordCount: number): string {
  return Array.from({ length: wordCount }, (_, i) => `word${i + 1}`).join(' ');
}

async function makePlanWithHooks(status: string = 'hooks_generated'): Promise<{
  planId: string;
  hookIds: string[];
}> {
  const plan = await createPlan(
    {
      type: 'youtube_advanced',
      title: 'Hook test plan',
      targetRuntimeSeconds: 1800,
      formatProfileId: 'claude_code_build_along',
      status: status as 'hooks_generated',
    },
    asDb(),
  );

  const h1 = await createHookDraft(
    plan.id,
    { archetype: 'pattern_interrupt', scriptText: makeScriptText(35), predictedRetention: 'Good hook 1' },
    asDb(),
  );
  const h2 = await createHookDraft(
    plan.id,
    { archetype: 'bold_claim', scriptText: makeScriptText(35), predictedRetention: 'Good hook 2' },
    asDb(),
  );
  const h3 = await createHookDraft(
    plan.id,
    { archetype: 'demo_first', scriptText: makeScriptText(35), predictedRetention: 'Good hook 3' },
    asDb(),
  );

  return { planId: plan.id, hookIds: [h1.id, h2.id, h3.id] };
}

beforeEach(() => {
  fake = createFakeFirestore();
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('selectHook — happy path', () => {
  it('selects hook, marks only chosen hook as selected, updates plan status + selectedHookVariantId', async () => {
    const { planId, hookIds } = await makePlanWithHooks('hooks_generated');
    const chosenId = hookIds[1]!;

    await selectHook(planId, chosenId, asDb());

    // All hooks: only chosen has selected=true.
    const allHooks = await listHookDraftsForPlan(planId, asDb());
    for (const h of allHooks) {
      if (h.id === chosenId) {
        expect(h.selected).toBe(true);
      } else {
        expect(h.selected).toBe(false);
      }
    }

    // Plan status advanced to hook_selected.
    const plan = await getPlan(planId, asDb());
    expect(plan?.status).toBe('hook_selected');
    expect(plan?.selectedHookVariantId).toBe(chosenId);

    // getSelectedHookDraft returns the chosen one.
    const selected = await getSelectedHookDraft(planId, asDb());
    expect(selected?.id).toBe(chosenId);
  });
});

describe('selectHook — re-selection from hook_selected', () => {
  it('allows re-selection from hook_selected status and flips to a different hook', async () => {
    const { planId, hookIds } = await makePlanWithHooks('hooks_generated');
    const firstId = hookIds[0]!;
    const secondId = hookIds[2]!;

    // Select first hook.
    await selectHook(planId, firstId, asDb());
    const planAfterFirst = await getPlan(planId, asDb());
    expect(planAfterFirst?.selectedHookVariantId).toBe(firstId);
    expect(planAfterFirst?.status).toBe('hook_selected');

    // Re-select a different hook from hook_selected.
    await selectHook(planId, secondId, asDb());
    const planAfterSecond = await getPlan(planId, asDb());
    expect(planAfterSecond?.selectedHookVariantId).toBe(secondId);
    expect(planAfterSecond?.status).toBe('hook_selected');

    const selected = await getSelectedHookDraft(planId, asDb());
    expect(selected?.id).toBe(secondId);
  });
});

// ---------------------------------------------------------------------------
// Error cases
// ---------------------------------------------------------------------------

describe('selectHook — DISALLOWED_TRANSITION', () => {
  it('throws DISALLOWED_TRANSITION when plan status is scenes_generated', async () => {
    const { planId, hookIds } = await makePlanWithHooks('scenes_generated');
    await expect(
      selectHook(planId, hookIds[0]!, asDb()),
    ).rejects.toMatchObject({ code: 'DISALLOWED_TRANSITION' });
  });

  it('throws DISALLOWED_TRANSITION when plan status is awaiting_review', async () => {
    const plan = await createPlan(
      { type: 'youtube_advanced', title: 'X', targetRuntimeSeconds: 1800, formatProfileId: 'claude_code_build_along' },
      asDb(),
    );
    await expect(
      selectHook(plan.id, 'hook_nonexistent', asDb()),
    ).rejects.toMatchObject({ code: 'DISALLOWED_TRANSITION' });
  });
});

describe('selectHook — HOOK_NOT_FOUND', () => {
  it('throws HOOK_NOT_FOUND for an unknown hookId', async () => {
    const { planId } = await makePlanWithHooks('hooks_generated');
    await expect(
      selectHook(planId, 'hook_unknown_xyz', asDb()),
    ).rejects.toMatchObject({ code: 'HOOK_NOT_FOUND' });
  });
});

describe('selectHook — PLAN_NOT_FOUND', () => {
  it('throws PLAN_NOT_FOUND for an unknown planId', async () => {
    await expect(
      selectHook('plan_nonexistent', 'hook_any', asDb()),
    ).rejects.toMatchObject({ code: 'PLAN_NOT_FOUND' });
  });
});
