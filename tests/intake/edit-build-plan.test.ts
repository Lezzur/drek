import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';

vi.mock('../../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() },
}));

import { createFakeFirestore, type FakeFirestore } from '../db/fake-firestore.js';
import { createBrief } from '../../src/intake/service.js';
import { patchPipelineBrief } from '../../src/db/pipeline-briefs.js';
import { editBuildPlan, computeChangedSummary } from '../../src/intake/edit-build-plan.js';
import { IntakeError } from '../../src/intake/errors.js';
import { NeurocoreError } from '../../src/neurocore/errors.js';
import type { NeurocoreClient } from '../../src/neurocore/client.js';
import type { BuildPlanEditedSignal } from '../../src/neurocore/types.js';
import type {
  PinnedTechStack,
  TransformedBuildPlan,
} from '../../src/db/schemas.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ORIGINAL_PLAN: TransformedBuildPlan = {
  goal: 'Build a Vapi voice bot for inbound lead screening.',
  finalProduct: 'Live phone call demo with transcript streaming on screen.',
  toolchain: [
    { name: 'Vapi', role: 'voice surface', source: 'given' },
    { name: 'Gmail', role: 'notification sink', source: 'assumed' },
    { name: 'n8n', role: 'webhook routing', source: 'assumed' },
  ],
  buildSteps: [
    { title: 'Scaffold Vapi assistant', description: 'Create the assistant config.', estimatedMinutes: 25 },
    { title: 'Wire webhook', description: 'n8n receives Vapi events.', estimatedMinutes: 30 },
    { title: 'Live test call', description: 'Place a real phone call to verify.', estimatedMinutes: 30 },
  ],
  shotHints: [
    'Open Vapi dashboard',
    'Show webhook firing',
    'Live phone call with transcript',
  ],
};

const ORIGINAL_STACK: PinnedTechStack = {
  primary: 'tech_vapi',
  supporting: ['tech_n8n'],
  rationale: 'Vapi surface + n8n routing.',
};

let fake: FakeFirestore;
const asDb = () => fake as unknown as Firestore;

interface FakeClient {
  client: NeurocoreClient;
  sent: BuildPlanEditedSignal[];
  failNext: (err: Error) => void;
}

function makeFakeClient(): FakeClient {
  const sent: BuildPlanEditedSignal[] = [];
  let nextError: Error | null = null;
  const client: Partial<NeurocoreClient> = {
    async sendBuildPlanEdited(payload: BuildPlanEditedSignal) {
      if (nextError) {
        const e = nextError;
        nextError = null;
        throw e;
      }
      sent.push(payload);
    },
  };
  return {
    client: client as NeurocoreClient,
    sent,
    failNext(err: Error) {
      nextError = err;
    },
  };
}

async function seedBriefWithPlan(): Promise<string> {
  const brief = await createBrief({ title: 'Voice bot brief', rawText: 'create a voice bot using vapi' }, asDb());
  await patchPipelineBrief(
    brief.id,
    {
      score: { visualOutcome: 4, storyPotential: 4, scopeFit: 4, audienceMatch: 4, aggregate: 4.0 },
      transformedBuildPlan: ORIGINAL_PLAN,
      pinnedTechStack: ORIGINAL_STACK,
    },
    asDb(),
  );
  return brief.id;
}

beforeEach(() => {
  fake = createFakeFirestore();
});

// ---------------------------------------------------------------------------
// computeChangedSummary — coarse-diff correctness
// ---------------------------------------------------------------------------

describe('computeChangedSummary', () => {
  it('marks no changes when before === after', () => {
    const c = computeChangedSummary(ORIGINAL_PLAN, ORIGINAL_STACK, ORIGINAL_PLAN, ORIGINAL_STACK);
    expect(c.goal).toBe(false);
    expect(c.finalProduct).toBe(false);
    expect(c.pinnedTechStack).toBe(false);
    expect(c.toolchain.added).toEqual([]);
    expect(c.toolchain.removed).toEqual([]);
    expect(c.toolchain.roleEdits).toBe(0);
    expect(c.buildSteps.added).toBe(0);
    expect(c.buildSteps.removed).toBe(0);
    expect(c.buildSteps.edited).toBe(0);
    expect(c.buildSteps.totalMinutesDelta).toBe(0);
    expect(c.shotHints.added).toBe(0);
    expect(c.shotHints.removed).toBe(0);
  });

  it('detects toolchain swap (Gmail → Slack)', () => {
    const edited: TransformedBuildPlan = {
      ...ORIGINAL_PLAN,
      toolchain: [
        ORIGINAL_PLAN.toolchain[0]!,
        { name: 'Slack', role: 'notification sink', source: 'assumed' },
        ORIGINAL_PLAN.toolchain[2]!,
      ],
    };
    const c = computeChangedSummary(ORIGINAL_PLAN, ORIGINAL_STACK, edited, ORIGINAL_STACK);
    expect(c.toolchain.added).toEqual(['Slack']);
    expect(c.toolchain.removed).toEqual(['Gmail']);
    expect(c.toolchain.roleEdits).toBe(0);
  });

  it('detects role edits (same tool, different role)', () => {
    const edited: TransformedBuildPlan = {
      ...ORIGINAL_PLAN,
      toolchain: [
        ORIGINAL_PLAN.toolchain[0]!,
        { name: 'Gmail', role: 'lead-tracking sink', source: 'assumed' }, // role changed
        ORIGINAL_PLAN.toolchain[2]!,
      ],
    };
    const c = computeChangedSummary(ORIGINAL_PLAN, ORIGINAL_STACK, edited, ORIGINAL_STACK);
    expect(c.toolchain.roleEdits).toBe(1);
    expect(c.toolchain.added).toEqual([]);
    expect(c.toolchain.removed).toEqual([]);
  });

  it('detects added/removed build steps + total-minute delta', () => {
    const edited: TransformedBuildPlan = {
      ...ORIGINAL_PLAN,
      buildSteps: [
        ORIGINAL_PLAN.buildSteps[0]!,
        ORIGINAL_PLAN.buildSteps[1]!,
        { title: 'Add CRM connection', description: 'Wire HubSpot.', estimatedMinutes: 20 },
        { title: 'Live test call', description: 'Place a real phone call to verify.', estimatedMinutes: 30 },
      ],
    };
    const c = computeChangedSummary(ORIGINAL_PLAN, ORIGINAL_STACK, edited, ORIGINAL_STACK);
    expect(c.buildSteps.added).toBe(1);
    expect(c.buildSteps.removed).toBe(0);
    expect(c.buildSteps.edited).toBe(0);
    expect(c.buildSteps.totalMinutesDelta).toBe(20);
  });

  it('detects edited step (same title, changed description or minutes)', () => {
    const edited: TransformedBuildPlan = {
      ...ORIGINAL_PLAN,
      buildSteps: [
        { ...ORIGINAL_PLAN.buildSteps[0]!, estimatedMinutes: 40 },
        ORIGINAL_PLAN.buildSteps[1]!,
        ORIGINAL_PLAN.buildSteps[2]!,
      ],
    };
    const c = computeChangedSummary(ORIGINAL_PLAN, ORIGINAL_STACK, edited, ORIGINAL_STACK);
    expect(c.buildSteps.edited).toBe(1);
    expect(c.buildSteps.totalMinutesDelta).toBe(15);
  });

  it('detects shotHints diff', () => {
    const edited: TransformedBuildPlan = {
      ...ORIGINAL_PLAN,
      shotHints: [
        'Open Vapi dashboard',
        'Show webhook firing',
        'Show CRM contacts page',
        'Live phone call with transcript',
      ],
    };
    const c = computeChangedSummary(ORIGINAL_PLAN, ORIGINAL_STACK, edited, ORIGINAL_STACK);
    expect(c.shotHints.added).toBe(1);
    expect(c.shotHints.removed).toBe(0);
  });

  it('detects pinnedTechStack changes (primary swap)', () => {
    const editedStack: PinnedTechStack = { ...ORIGINAL_STACK, primary: 'tech_retell' };
    const c = computeChangedSummary(ORIGINAL_PLAN, ORIGINAL_STACK, ORIGINAL_PLAN, editedStack);
    expect(c.pinnedTechStack).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// editBuildPlan — happy path + failure modes
// ---------------------------------------------------------------------------

describe('editBuildPlan', () => {
  it('persists the edit and fires build_plan.edited signal', async () => {
    const briefId = await seedBriefWithPlan();
    const fc = makeFakeClient();
    const edited: TransformedBuildPlan = {
      ...ORIGINAL_PLAN,
      goal: 'Build a Vapi voice bot for inbound lead screening with HubSpot routing.',
    };
    const result = await editBuildPlan(briefId, edited, ORIGINAL_STACK, {
      db: asDb(),
      client: fc.client,
    });

    expect(result.signalSent).toBe(true);
    expect(result.brief.transformedBuildPlan?.goal).toMatch(/HubSpot routing/);
    expect(fc.sent).toHaveLength(1);
    expect(fc.sent[0]!.briefId).toBe(briefId);
    expect(fc.sent[0]!.changed.goal).toBe(true);
    expect(fc.sent[0]!.changed.toolchain.added).toEqual([]);
  });

  it('throws BRIEF_NOT_FOUND when brief does not exist', async () => {
    const fc = makeFakeClient();
    try {
      await editBuildPlan('missing', ORIGINAL_PLAN, ORIGINAL_STACK, {
        db: asDb(),
        client: fc.client,
      });
      expect.fail('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(IntakeError);
      expect((err as IntakeError).code).toBe('BRIEF_NOT_FOUND');
    }
  });

  it('throws INVALID_OUTPUT when brief has no transformed plan yet', async () => {
    const brief = await createBrief({ title: 'T', rawText: 'r' }, asDb());
    const fc = makeFakeClient();
    try {
      await editBuildPlan(brief.id, ORIGINAL_PLAN, ORIGINAL_STACK, {
        db: asDb(),
        client: fc.client,
      });
      expect.fail('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(IntakeError);
      expect((err as IntakeError).code).toBe('INVALID_OUTPUT');
    }
  });

  it('still saves locally when Neurocore signal fails', async () => {
    const briefId = await seedBriefWithPlan();
    const fc = makeFakeClient();
    fc.failNext(new NeurocoreError('UNREACHABLE', '/v1/memory/signals', 'down'));

    const edited: TransformedBuildPlan = { ...ORIGINAL_PLAN, goal: 'Edited goal text long enough to clear validation.' };
    const result = await editBuildPlan(briefId, edited, ORIGINAL_STACK, {
      db: asDb(),
      client: fc.client,
    });

    expect(result.signalSent).toBe(false);
    expect(result.signalError).toContain('UNREACHABLE');
    // Local persisted regardless.
    expect(result.brief.transformedBuildPlan?.goal).toMatch(/Edited goal text/);
  });
});
