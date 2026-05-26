import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';

vi.mock('../../src/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  },
}));

import { createFakeFirestore, type FakeFirestore } from '../db/fake-firestore.js';
import { createBrief } from '../../src/intake/service.js';
import {
  isTransformable,
  transformableReason,
  transformBrief,
} from '../../src/engine/transform-brief.js';
import { IntakeError } from '../../src/intake/errors.js';
import {
  _resetTechStackProfileClientForTests,
  clearTechStackProfileCache,
  type TechStackProfile,
} from '../../src/neurocore/tech-stacks.js';
import {
  _resetAudienceProfileClientForTests,
  clearAudienceProfileCache,
  type AudienceProfile,
} from '../../src/neurocore/audience-profiles.js';
import { patchPipelineBrief } from '../../src/db/pipeline-briefs.js';
import type { BriefScore } from '../../src/db/schemas.js';
import type { LLMProvider } from '../../src/providers/index.js';
import { LLMProviderError } from '../../src/providers/index.js';

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

const SAMPLE_AUDIENCE: AudienceProfile = {
  id: 'developer_longform',
  name: 'Developer / Learner — Long-form',
  description: 'AI/automation practitioners',
  watchPersona: 'Engineers watching to learn how to direct Claude Code',
  painPoints: ['marketing-heavy AI content', 'shallow tutorials'],
  buyingTriggers: ['recovery-on-camera', 'real client constraints'],
  voiceGuidelines: {
    tone: 'authoritative-warm',
    vocabulary: 'technical but accessible',
    sentenceLengthGuide: 'mixed',
    taboos: ["'guys'"],
  },
  hookPatterns: ['start with the failure'],
  pacingRules: { wordsPerMinute: 150, avgSentenceWords: 14, densityNote: 'pause after claims' },
  ctaStyle: {
    type: 'subscribe_and_long_form',
    phrasing: 'subscribe',
    placement: 'final 15s',
  },
  createdAt: '2026-05-18T14:00:00.000Z',
  updatedAt: '2026-05-18T14:00:00.000Z',
};

const SAMPLE_TECH_STACKS: TechStackProfile[] = [
  {
    id: 'tech_vapi',
    name: 'Vapi',
    category: 'voice_bot',
    ecosystem: ['voice', 'telephony'],
    popularityTier: 'emerging',
    filmableNotes: 'live phone call demo is visually compelling',
    exampleUseCases: ['voice agent', 'phone screening', 'AI receptionist'],
    status: 'active',
    createdAt: '2026-05-18T14:00:00.000Z',
    updatedAt: '2026-05-18T14:00:00.000Z',
  },
  {
    id: 'tech_n8n',
    name: 'n8n',
    category: 'workflow_automation',
    ecosystem: ['workflow', 'automation'],
    popularityTier: 'mainstream',
    filmableNotes: 'node graph builds visually',
    exampleUseCases: ['workflow automation', 'API orchestration', 'webhook routing'],
    status: 'active',
    createdAt: '2026-05-18T14:00:00.000Z',
    updatedAt: '2026-05-18T14:00:00.000Z',
  },
];

const HIGH_SCORE: BriefScore = {
  visualOutcome: 4,
  storyPotential: 4,
  scopeFit: 4,
  audienceMatch: 4,
  aggregate: 4.0,
};

const LOW_TECHNICAL_FIT_SCORE: BriefScore = {
  visualOutcome: 5,
  storyPotential: 5,
  scopeFit: 2,
  audienceMatch: 2,
  aggregate: 3.5,
};

const MINIMUM_GATE_SCORE: BriefScore = {
  visualOutcome: 2,
  storyPotential: 2,
  scopeFit: 3,
  audienceMatch: 3,
  aggregate: 2.5,
};

const SAMPLE_TRANSFORM_JSON = JSON.stringify({
  goal: 'Build a Vapi-driven inbound voice bot that screens leads and drops qualified ones into goHighLevel with a Gmail summary to Rick.',
  finalProduct: 'Viewer sees a live phone call into the bot, the transcript streaming in the Vapi dashboard, and a new contact appearing in goHighLevel with a Gmail summary fired off.',
  toolchain: [
    { name: 'Vapi', role: 'voice surface and call routing', source: 'given' },
    { name: 'goHighLevel', role: 'CRM destination for qualified leads', source: 'assumed' },
    { name: 'Gmail', role: 'notification sink for Rick', source: 'assumed' },
    { name: 'n8n', role: 'webhook routing between Vapi and downstream sinks', source: 'assumed' },
  ],
  phases: [
    {
      title: 'Inbound voice bot end-to-end',
      goal: 'A working Vapi assistant that handles a live inbound call, qualifies the caller, drops the contact into goHighLevel, and emails Rick a summary — demonstrated on a real test call.',
      buildSteps: [
        { title: 'Scaffold Vapi assistant', description: 'Create a new Vapi assistant with the qualification prompt + voice settings.', estimatedMinutes: 25 },
        { title: 'Wire n8n webhook', description: 'Stand up an n8n workflow that receives the post-call payload from Vapi.', estimatedMinutes: 30 },
        { title: 'Connect goHighLevel', description: 'Add a goHighLevel contact-create node downstream of the qualification branch.', estimatedMinutes: 35 },
        { title: 'Connect Gmail summary', description: 'Append a Gmail-send node so Rick gets a transcript + qualification verdict.', estimatedMinutes: 20 },
        { title: 'Live test call', description: 'Place a real phone call to verify the end-to-end loop fires and the right side-effects land.', estimatedMinutes: 30 },
      ],
      shotHints: [
        'Open Vapi dashboard, point to the call-flow editor and prompt',
        'Show n8n workflow canvas building node by node',
        'goHighLevel contacts list before/after the test call',
        'Gmail inbox showing the summary land',
        'Live test call with the transcript streaming on screen',
      ],
    },
  ],
  pinnedTechStack: {
    primary: 'tech_vapi',
    supporting: ['tech_n8n'],
    rationale: 'Vapi is the voice surface; n8n routes downstream actions. Both are filmable and complementary.',
  },
});

const MULTIPHASE_TRANSFORM_JSON = JSON.stringify({
  goal: 'A two-part series: build a Vapi voice bot, then layer in CRM routing in a follow-up video.',
  finalProduct: 'By end of phase 2, viewer sees a live call land in goHighLevel and a Gmail summary fire.',
  toolchain: [
    { name: 'Vapi', role: 'voice surface', source: 'given' },
    { name: 'n8n', role: 'webhook routing', source: 'assumed' },
    { name: 'goHighLevel', role: 'CRM destination', source: 'assumed' },
  ],
  phases: [
    {
      title: 'Working voice bot scaffold',
      goal: 'Phase 1 ships a working Vapi assistant that can answer a call and read back a qualification script — no downstream integration yet.',
      buildSteps: [
        { title: 'Scaffold Vapi assistant', description: 'Create Vapi assistant + qualification prompt.', estimatedMinutes: 60 },
        { title: 'Voice tuning', description: 'Pick voice + tune speech settings.', estimatedMinutes: 60 },
      ],
      shotHints: ['Vapi dashboard close-up', 'Live call demo at end of phase 1'],
    },
    {
      title: 'Wire CRM + email sink',
      goal: 'Phase 2 adds goHighLevel contact creation + Gmail notifications.',
      buildSteps: [
        { title: 'n8n webhook', description: 'Stand up n8n routing.', estimatedMinutes: 90 },
        { title: 'goHighLevel node', description: 'Connect CRM downstream.', estimatedMinutes: 60 },
      ],
      shotHints: ['n8n canvas wiring up', 'goHighLevel contact appearing'],
    },
  ],
  pinnedTechStack: {
    primary: 'tech_vapi',
    supporting: ['tech_n8n'],
    rationale: 'Two-phase Vapi+n8n stack split across a 2-video series.',
  },
});

// -----------------------------------------------------------------------------
// Mocks for Neurocore clients
// -----------------------------------------------------------------------------

vi.mock('../../src/neurocore/tech-stacks.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/neurocore/tech-stacks.js')
  >('../../src/neurocore/tech-stacks.js');
  return {
    ...actual,
    getTechStackProfileClient: () => ({
      list: vi.fn(async () => mockTechStacks),
      get: vi.fn(),
    }),
  };
});

vi.mock('../../src/neurocore/audience-profiles.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/neurocore/audience-profiles.js')
  >('../../src/neurocore/audience-profiles.js');
  return {
    ...actual,
    getAudienceProfileClient: () => ({
      list: vi.fn(),
      get: vi.fn(async (id: string) => {
        if (id === 'developer_longform') return mockAudience;
        throw new Error(`unexpected audience id ${id}`);
      }),
    }),
  };
});

vi.mock('../../src/neurocore/stack-performance.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/neurocore/stack-performance.js')
  >('../../src/neurocore/stack-performance.js');
  return {
    ...actual,
    getStackPerformanceClient: () => ({
      list: vi.fn(async () => []),
      get: vi.fn(async () => null),
    }),
  };
});

let mockTechStacks: TechStackProfile[] = SAMPLE_TECH_STACKS;
let mockAudience: AudienceProfile = SAMPLE_AUDIENCE;

/**
 * Build a syntactically-valid LLM transform payload with an overridable
 * primary tech stack id. Used by the retry / phantom-pick tests so they
 * can fail at the tech-stack-validation step (not at JSON schema parse).
 */
function makePlanJsonWithStack(primaryId: string): string {
  return JSON.stringify({
    goal: 'long enough goal sentence to clear the 20-char minimum length',
    finalProduct: 'long enough final product description to clear the 20-char minimum',
    toolchain: [{ name: 'X', role: 'something', source: 'given' }],
    phases: [
      {
        title: 'Single phase',
        goal: 'long enough phase goal sentence to clear the 20-char minimum',
        buildSteps: [
          { title: 'a', description: 'step one description', estimatedMinutes: 30 },
          { title: 'b', description: 'step two description', estimatedMinutes: 30 },
          { title: 'c', description: 'step three description', estimatedMinutes: 30 },
        ],
        shotHints: ['shot one hint here', 'shot two hint here'],
      },
    ],
    pinnedTechStack: { primary: primaryId, supporting: [], rationale: 'test fixture stack pick' },
  });
}

let fake: FakeFirestore;
const asDb = () => fake as unknown as Firestore;

function makeProvider(responses: Array<string | { throws: Error }>): LLMProvider {
  const queue = [...responses];
  return {
    name: 'claude' as const,
    async generate() {
      const next = queue.shift();
      if (next === undefined) {
        throw new Error('mock provider exhausted');
      }
      if (typeof next === 'object' && 'throws' in next) throw next.throws;
      return next;
    },
  };
}

beforeEach(() => {
  fake = createFakeFirestore();
  mockTechStacks = SAMPLE_TECH_STACKS;
  mockAudience = SAMPLE_AUDIENCE;
  clearTechStackProfileCache();
  clearAudienceProfileCache();
  _resetTechStackProfileClientForTests();
  _resetAudienceProfileClientForTests();
});

// -----------------------------------------------------------------------------
// isTransformable (new gate: scopeFit + audienceMatch >= 3.0, no narrative axes)
// -----------------------------------------------------------------------------

describe('isTransformable (M35 gate: scopeFit >= 2.0 AND audienceMatch >= 3.0)', () => {
  it('returns true at the gate minimum (scope=2, audience=3) — multi-day allowed', () => {
    expect(
      isTransformable({
        visualOutcome: 1,
        storyPotential: 1,
        scopeFit: 2,
        audienceMatch: 3,
        aggregate: 1.75,
      }),
    ).toBe(true);
  });

  it('returns true for the high-fit case', () => {
    expect(isTransformable(HIGH_SCORE)).toBe(true);
  });

  it('returns false when scopeFit is below 2.0 (sanity floor — true garbage)', () => {
    expect(
      isTransformable({
        visualOutcome: 5,
        storyPotential: 5,
        scopeFit: 1,
        audienceMatch: 5,
        aggregate: 4.0,
      }),
    ).toBe(false);
  });

  it('returns false when audienceMatch is below 3.0 (no audience → no video)', () => {
    expect(
      isTransformable({
        visualOutcome: 4,
        storyPotential: 4,
        scopeFit: 4,
        audienceMatch: 2,
        aggregate: 3.5,
      }),
    ).toBe(false);
  });

  it('passes Rick\'s 4/4/2/5 brief that previously failed (scopeFit=2 + audience=5)', () => {
    expect(
      isTransformable({
        visualOutcome: 4,
        storyPotential: 4,
        scopeFit: 2,
        audienceMatch: 5,
        aggregate: 3.75,
      }),
    ).toBe(true);
  });
});

describe('transformableReason — per-axis failure breakdown for the UI badge', () => {
  it('returns ok=true with no failures for a passing brief', () => {
    const r = transformableReason(HIGH_SCORE);
    expect(r.ok).toBe(true);
    expect(r.failedAxes).toEqual([]);
  });

  it('reports scopeFit failure', () => {
    const r = transformableReason({
      visualOutcome: 5,
      storyPotential: 5,
      scopeFit: 1,
      audienceMatch: 5,
      aggregate: 4.0,
    });
    expect(r.ok).toBe(false);
    expect(r.failedAxes).toEqual(['scopeFit']);
  });

  it('reports audienceMatch failure', () => {
    const r = transformableReason({
      visualOutcome: 4,
      storyPotential: 4,
      scopeFit: 4,
      audienceMatch: 2,
      aggregate: 3.5,
    });
    expect(r.ok).toBe(false);
    expect(r.failedAxes).toEqual(['audienceMatch']);
  });

  it('reports both axes failing in a single brief', () => {
    const r = transformableReason({
      visualOutcome: 5,
      storyPotential: 5,
      scopeFit: 1,
      audienceMatch: 1,
      aggregate: 3.0,
    });
    expect(r.ok).toBe(false);
    expect(r.failedAxes).toEqual(['scopeFit', 'audienceMatch']);
  });
});

// -----------------------------------------------------------------------------
// transformBrief — gate failures
// -----------------------------------------------------------------------------

describe('transformBrief — gate failures', () => {
  it('throws BRIEF_NOT_FOUND when brief id does not exist', async () => {
    const provider = makeProvider([]);
    try {
      await transformBrief('nonexistent', { provider, db: asDb(), useCritique: false });
      expect.fail('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(IntakeError);
      expect((err as IntakeError).code).toBe('BRIEF_NOT_FOUND');
    }
  });

  it('throws BRIEF_MISSING_SCORE when brief has no score', async () => {
    const brief = await createBrief({ title: 'T', rawText: 'r' }, asDb());
    const provider = makeProvider([]);
    try {
      await transformBrief(brief.id, { provider, db: asDb(), useCritique: false });
      expect.fail('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(IntakeError);
      expect((err as IntakeError).code).toBe('BRIEF_MISSING_SCORE');
    }
  });

  it('throws INVALID_OUTPUT when score fails the technical-fit gate', async () => {
    const brief = await createBrief({ title: 'T', rawText: 'r' }, asDb());
    await patchPipelineBrief(brief.id, { score: LOW_TECHNICAL_FIT_SCORE }, asDb());
    const provider = makeProvider([]);
    try {
      await transformBrief(brief.id, { provider, db: asDb(), useCritique: false });
      expect.fail('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(IntakeError);
      expect((err as IntakeError).code).toBe('INVALID_OUTPUT');
      expect((err as IntakeError).message).toMatch(/not transformable/);
    }
  });
});

// -----------------------------------------------------------------------------
// transformBrief — happy path
// -----------------------------------------------------------------------------

describe('transformBrief — happy path', () => {
  it('extracts a build plan and persists transformedBuildPlan + pinnedTechStack', async () => {
    const brief = await createBrief({ title: 'voice bot brief', rawText: 'create a voice bot using vapi' }, asDb());
    await patchPipelineBrief(brief.id, { score: HIGH_SCORE }, asDb());
    const provider = makeProvider([SAMPLE_TRANSFORM_JSON]);
    const result = await transformBrief(brief.id, { provider, db: asDb(), useCritique: false });

    expect(result.retried).toBe(false);
    expect(result.brief.transformedBuildPlan).not.toBeNull();
    const plan = result.brief.transformedBuildPlan!;
    expect(plan.goal).toMatch(/voice bot/);
    expect(plan.finalProduct).toMatch(/phone call|transcript/);
    expect(plan.toolchain).toHaveLength(4);
    expect(plan.toolchain[0]!.source).toBe('given');
    expect(plan.toolchain[1]!.source).toBe('assumed');
    expect(plan.buildSteps).toHaveLength(5);
    expect(plan.shotHints).toHaveLength(5);

    expect(result.brief.pinnedTechStack?.primary).toBe('tech_vapi');
    expect(result.brief.pinnedTechStack?.supporting).toEqual(['tech_n8n']);

    // Legacy fields stay null under the new transformer.
    expect(result.brief.transformedBriefText).toBeNull();
    expect(result.brief.transformedScore).toBeNull();
  });

  it('admits a brief that scored 5/5/3/3 (high narrative, just-meets technical gate)', async () => {
    const brief = await createBrief({ title: 'T', rawText: 'r' }, asDb());
    await patchPipelineBrief(
      brief.id,
      {
        score: {
          visualOutcome: 5,
          storyPotential: 5,
          scopeFit: 3,
          audienceMatch: 3,
          aggregate: 4.0,
        },
      },
      asDb(),
    );
    const provider = makeProvider([SAMPLE_TRANSFORM_JSON]);
    const result = await transformBrief(brief.id, { provider, db: asDb(), useCritique: false });
    expect(result.brief.transformedBuildPlan).not.toBeNull();
  });

  it('preserves phases AND flattens them into top-level buildSteps/shotHints', async () => {
    const brief = await createBrief({ title: 'T', rawText: 'r' }, asDb());
    await patchPipelineBrief(brief.id, { score: HIGH_SCORE }, asDb());
    const provider = makeProvider([MULTIPHASE_TRANSFORM_JSON]);
    const result = await transformBrief(brief.id, { provider, db: asDb(), useCritique: false });
    const plan = result.brief.transformedBuildPlan!;

    expect(plan.phases).toBeDefined();
    expect(plan.phases).toHaveLength(2);
    expect(plan.phases![0]!.title).toBe('Working voice bot scaffold');
    expect(plan.phases![1]!.title).toBe('Wire CRM + email sink');

    // Flattened top-level fields are concatenation of all phases.
    expect(plan.buildSteps).toHaveLength(4); // 2 + 2
    expect(plan.shotHints).toHaveLength(4); // 2 + 2
    expect(plan.buildSteps[0]!.title).toBe('Scaffold Vapi assistant');
    expect(plan.buildSteps[2]!.title).toBe('n8n webhook');
  });

  it('M35 gate: admits the previously-blocked 4/4/2/5 brief (multi-day series allowed)', async () => {
    const brief = await createBrief({ title: 'T', rawText: 'r' }, asDb());
    await patchPipelineBrief(
      brief.id,
      {
        score: {
          visualOutcome: 4,
          storyPotential: 4,
          scopeFit: 2,
          audienceMatch: 5,
          aggregate: 3.75,
        },
      },
      asDb(),
    );
    const provider = makeProvider([MULTIPHASE_TRANSFORM_JSON]);
    const result = await transformBrief(brief.id, { provider, db: asDb(), useCritique: false });
    expect(result.brief.transformedBuildPlan).not.toBeNull();
    expect(result.brief.transformedBuildPlan!.phases).toHaveLength(2);
  });
});

// -----------------------------------------------------------------------------
// transformBrief — retry path
// -----------------------------------------------------------------------------

describe('transformBrief — retry path', () => {
  it('retries once on bad JSON, then succeeds', async () => {
    const brief = await createBrief({ title: 'T', rawText: 'r' }, asDb());
    await patchPipelineBrief(brief.id, { score: HIGH_SCORE }, asDb());

    const provider = makeProvider(['not valid json', SAMPLE_TRANSFORM_JSON]);
    const result = await transformBrief(brief.id, { provider, db: asDb(), useCritique: false });
    expect(result.retried).toBe(true);
    expect(result.brief.transformedBuildPlan).not.toBeNull();
  });

  it('retries once when LLM picks a tech stack id not in the catalog', async () => {
    const brief = await createBrief({ title: 'T', rawText: 'r' }, asDb());
    await patchPipelineBrief(brief.id, { score: HIGH_SCORE }, asDb());

    const phantomPick = makePlanJsonWithStack('tech_phantom_does_not_exist');
    const provider = makeProvider([phantomPick, SAMPLE_TRANSFORM_JSON]);
    const result = await transformBrief(brief.id, { provider, db: asDb(), useCritique: false });
    expect(result.retried).toBe(true);
    expect(result.brief.pinnedTechStack?.primary).toBe('tech_vapi');
  });

  it('throws INVALID_OUTPUT when LLM picks phantom ids twice', async () => {
    const brief = await createBrief({ title: 'T', rawText: 'r' }, asDb());
    await patchPipelineBrief(brief.id, { score: HIGH_SCORE }, asDb());

    const phantom = makePlanJsonWithStack('tech_phantom');
    const provider = makeProvider([phantom, phantom]);
    try {
      await transformBrief(brief.id, { provider, db: asDb(), useCritique: false });
      expect.fail('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(IntakeError);
      expect((err as IntakeError).code).toBe('INVALID_OUTPUT');
    }
  });

  it('throws LLM_FAILED when provider throws LLMProviderError', async () => {
    const brief = await createBrief({ title: 'T', rawText: 'r' }, asDb());
    await patchPipelineBrief(brief.id, { score: HIGH_SCORE }, asDb());

    const provider = makeProvider([
      { throws: new LLMProviderError('claude', 'TIMEOUT', 'provider timed out') },
    ]);
    try {
      await transformBrief(brief.id, { provider, db: asDb(), useCritique: false });
      expect.fail('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(IntakeError);
      expect((err as IntakeError).code).toBe('LLM_FAILED');
    }
  });
});

// -----------------------------------------------------------------------------
// transformBrief — catalog integration
// -----------------------------------------------------------------------------

describe('transformBrief — catalog integration', () => {
  it('throws INVALID_OUTPUT when tech-stack catalog is empty', async () => {
    const brief = await createBrief({ title: 'T', rawText: 'r' }, asDb());
    await patchPipelineBrief(brief.id, { score: HIGH_SCORE }, asDb());

    mockTechStacks = [];
    const provider = makeProvider([]);
    try {
      await transformBrief(brief.id, { provider, db: asDb(), useCritique: false });
      expect.fail('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(IntakeError);
      expect((err as IntakeError).code).toBe('INVALID_OUTPUT');
      expect((err as IntakeError).message).toMatch(/catalog is empty/);
    }
  });
});

// -----------------------------------------------------------------------------
// transformBrief — M36 critique integration
// -----------------------------------------------------------------------------

describe('transformBrief — M36 critique + revisor integration', () => {
  function critiqueReply(findings: Array<{
    criterion_id: string;
    severity: 'high' | 'medium' | 'low';
    confidence: 'high' | 'medium' | 'low';
    issue: string;
    suggested_fix: string;
  }>): string {
    return JSON.stringify({ findings });
  }

  function revisorReply(opts: {
    revisedGoal: string;
    appliedIds: string[];
    skippedIds: string[];
    skipReasons: Record<string, string>;
  }): string {
    const transformed = JSON.parse(SAMPLE_TRANSFORM_JSON);
    return JSON.stringify({
      revised_plan: {
        goal: opts.revisedGoal,
        finalProduct: transformed.finalProduct,
        toolchain: transformed.toolchain,
        buildSteps: transformed.phases.flatMap((p: { buildSteps: unknown[] }) => p.buildSteps),
        shotHints: transformed.phases.flatMap((p: { shotHints: unknown[] }) => p.shotHints),
        phases: transformed.phases,
      },
      applied_finding_ids: opts.appliedIds,
      skipped_finding_ids: opts.skippedIds,
      skip_reasons: opts.skipReasons,
    });
  }

  it('runs critique + revise, persists findings, ships revised plan', async () => {
    const brief = await createBrief(
      { title: 'voice bot brief', rawText: 'create a voice bot using vapi' },
      asDb(),
    );
    await patchPipelineBrief(brief.id, { score: HIGH_SCORE }, asDb());

    // We don't know the persisted finding id yet, so the revisor reply
    // uses placeholder ids that get filtered out by the hallucination
    // guard. That's fine for this test — what we're verifying is that
    // the pipeline DID run critique + revise, persisted findings, and
    // shipped the revisor's revised plan (the guard's job to drop
    // hallucinated ids is exercised in revise-plan tests).
    const provider = makeProvider([
      SAMPLE_TRANSFORM_JSON,
      critiqueReply([
        {
          criterion_id: 'scope_honesty',
          severity: 'high',
          confidence: 'high',
          issue: 'Goal claims X but build delivers Y.',
          suggested_fix: 'Scope claim to "proof of concept".',
        },
      ]),
      revisorReply({
        revisedGoal: 'Build a CLI prototype (proof of concept) demonstrating vapi voice handling.',
        appliedIds: ['placeholder-revisor-doesnt-know-real-id'],
        skippedIds: [],
        skipReasons: {},
      }),
    ]);

    const result = await transformBrief(brief.id, { provider, db: asDb(), useCritique: true });

    expect(result.critiqueRan).toBe(true);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.criterionId).toBe('scope_honesty');
    expect(result.findings[0]!.status).toBe('unresolved');
    // Revised plan shipped (note: revisor's applied_ids didn't match
    // persisted ids, so revisorAppliedCount stays 0, but the revisedPlan
    // contents still ship — that's the correct semantic).
    expect(result.brief.transformedBuildPlan!.goal).toMatch(/proof of concept/);
  });

  it('ships draft plan unchanged when critique returns no findings', async () => {
    const brief = await createBrief({ title: 'T', rawText: 'r' }, asDb());
    await patchPipelineBrief(brief.id, { score: HIGH_SCORE }, asDb());

    const provider = makeProvider([
      SAMPLE_TRANSFORM_JSON,
      critiqueReply([]), // critic ran, found nothing
    ]);

    const result = await transformBrief(brief.id, { provider, db: asDb(), useCritique: true });

    expect(result.critiqueRan).toBe(true);
    expect(result.findings).toEqual([]);
    expect(result.revisorAppliedCount).toBe(0);
    // No revisor call should happen → only 2 provider calls consumed.
    // Final plan is the draft, unchanged.
    const drafted = JSON.parse(SAMPLE_TRANSFORM_JSON);
    expect(result.brief.transformedBuildPlan!.goal).toBe(drafted.goal);
  });

  it('ships draft plan when critique fails to parse, marks critiqueRan=false', async () => {
    const brief = await createBrief({ title: 'T', rawText: 'r' }, asDb());
    await patchPipelineBrief(brief.id, { score: HIGH_SCORE }, asDb());

    const provider = makeProvider([
      SAMPLE_TRANSFORM_JSON,
      // Critique retries up to 2x on bad JSON.
      'not json',
      'still not json',
      'never json',
    ]);

    const result = await transformBrief(brief.id, { provider, db: asDb(), useCritique: true });

    expect(result.critiqueRan).toBe(false);
    expect(result.findings).toEqual([]);
    expect(result.brief.transformedBuildPlan).not.toBeNull();
  });

  it('persists findings + keeps draft when revisor fails after critique succeeds', async () => {
    const brief = await createBrief({ title: 'T', rawText: 'r' }, asDb());
    await patchPipelineBrief(brief.id, { score: HIGH_SCORE }, asDb());

    const provider = makeProvider([
      SAMPLE_TRANSFORM_JSON,
      critiqueReply([
        {
          criterion_id: 'timeline_realism',
          severity: 'medium',
          confidence: 'medium',
          issue: 'A step is allocated unrealistically short time.',
          suggested_fix: 'Double the estimate.',
        },
      ]),
      // Revisor retries up to 2x on parse failure.
      'broken',
      'still broken',
      'never JSON',
    ]);

    const result = await transformBrief(brief.id, { provider, db: asDb(), useCritique: true });

    expect(result.critiqueRan).toBe(true);
    expect(result.findings).toHaveLength(1);
    expect(result.revisorAppliedCount).toBe(0);
    expect(result.revisorReason).toContain('parse_failed');
    // Draft plan shipped unchanged.
    const drafted = JSON.parse(SAMPLE_TRANSFORM_JSON);
    expect(result.brief.transformedBuildPlan!.goal).toBe(drafted.goal);
  });

  it('wipes old findings on re-transform before persisting new ones', async () => {
    const brief = await createBrief({ title: 'T', rawText: 'r' }, asDb());
    await patchPipelineBrief(brief.id, { score: HIGH_SCORE }, asDb());

    // First transform produces 2 findings.
    const provider1 = makeProvider([
      SAMPLE_TRANSFORM_JSON,
      critiqueReply([
        { criterion_id: 'scope_honesty', severity: 'high', confidence: 'high', issue: 'A', suggested_fix: 'a' },
        { criterion_id: 'risk_visibility', severity: 'medium', confidence: 'medium', issue: 'B', suggested_fix: 'b' },
      ]),
      revisorReply({
        revisedGoal: 'Build a voice bot prototype that handles inbound calls with vapi.',
        appliedIds: [],
        skippedIds: [],
        skipReasons: {},
      }),
    ]);
    const first = await transformBrief(brief.id, { provider: provider1, db: asDb(), useCritique: true });
    expect(first.findings).toHaveLength(2);

    // Re-transform with only 1 finding. Old 2 should be wiped, new 1 persisted.
    const provider2 = makeProvider([
      SAMPLE_TRANSFORM_JSON,
      critiqueReply([
        { criterion_id: 'effort_distribution', severity: 'low', confidence: 'low', issue: 'C', suggested_fix: 'c' },
      ]),
      revisorReply({
        revisedGoal: 'Build a voice bot prototype that handles inbound calls with vapi.',
        appliedIds: [],
        skippedIds: [],
        skipReasons: {},
      }),
    ]);
    const second = await transformBrief(brief.id, { provider: provider2, db: asDb(), useCritique: true });

    expect(second.findings).toHaveLength(1);
    expect(second.findings[0]!.criterionId).toBe('effort_distribution');
  });
});
