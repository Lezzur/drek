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
    filmableNotes: 'node graph builds visually, real-time execution traces are good b-roll',
    exampleUseCases: ['workflow automation', 'API orchestration', 'webhook routing'],
    status: 'active',
    createdAt: '2026-05-18T14:00:00.000Z',
    updatedAt: '2026-05-18T14:00:00.000Z',
  },
];

const TRANSFORMABLE_SCORE: BriefScore = {
  visualOutcome: 2,
  storyPotential: 2,
  scopeFit: 4,
  audienceMatch: 4,
  aggregate: 3.0,
};

const NON_TRANSFORMABLE_SCORE: BriefScore = {
  visualOutcome: 4,
  storyPotential: 4,
  scopeFit: 4,
  audienceMatch: 4,
  aggregate: 4.0,
};

const SAMPLE_TRANSFORM_JSON = JSON.stringify({
  visualOutcome: 'Viewer sees Claude scaffolding the Vapi config in the editor, then a live phone call demo at the end.',
  storyPotential: 'Client pain: hires can\'t take calls. Constraint: Vapi only — no Twilio.  Reveal: working voice agent.',
  pinnedTechStack: {
    primary: 'tech_vapi',
    supporting: ['tech_n8n'],
    rationale: 'Vapi is the voice surface; n8n routes downstream actions. Both are filmable and emerging.',
  },
  transformedBriefText: 'A small clinic needs an AI phone-screening agent. We build it with Vapi, route routine intakes through n8n, and demo the working call live on camera. The audience watches a real client constraint shape an architectural pick.',
});

const SAMPLE_RESCORE_JSON = JSON.stringify({
  visualOutcome: 4,
  storyPotential: 4,
  scopeFit: 4,
  audienceMatch: 4,
  rationale: 'After framing: visible phone demo + clear arc; project unchanged.',
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

let mockTechStacks: TechStackProfile[] = SAMPLE_TECH_STACKS;
let mockAudience: AudienceProfile = SAMPLE_AUDIENCE;

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
// isTransformable
// -----------------------------------------------------------------------------

describe('isTransformable', () => {
  it('returns true when both technical axes >= 3.5 and a narrative axis < 3.0', () => {
    expect(
      isTransformable({
        visualOutcome: 2,
        storyPotential: 4,
        scopeFit: 4,
        audienceMatch: 4,
        aggregate: 3.5,
      }),
    ).toBe(true);
    expect(
      isTransformable({
        visualOutcome: 4,
        storyPotential: 2,
        scopeFit: 3.5,
        audienceMatch: 3.5,
        aggregate: 3.25,
      }),
    ).toBe(true);
  });

  it('returns false when both narrative axes are >= 3.0 (no rewrite needed)', () => {
    expect(isTransformable(NON_TRANSFORMABLE_SCORE)).toBe(false);
  });

  it('returns false when scopeFit < 3.5 (technical fit too weak)', () => {
    expect(
      isTransformable({
        visualOutcome: 1,
        storyPotential: 1,
        scopeFit: 3,
        audienceMatch: 5,
        aggregate: 2.5,
      }),
    ).toBe(false);
  });

  it('returns false when audienceMatch < 3.5 (wrong tribe)', () => {
    expect(
      isTransformable({
        visualOutcome: 1,
        storyPotential: 1,
        scopeFit: 5,
        audienceMatch: 3,
        aggregate: 2.5,
      }),
    ).toBe(false);
  });

  it('accepts the Lisa-revised ideal candidate (visualOutcome 1.5 + storyPotential 1.5 + aggregate 2.75)', () => {
    expect(
      isTransformable({
        visualOutcome: 1.5,
        storyPotential: 1.5,
        scopeFit: 4,
        audienceMatch: 4,
        aggregate: 2.75,
      }),
    ).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// transformBrief — gate failures
// -----------------------------------------------------------------------------

describe('transformBrief — gate failures', () => {
  it('throws BRIEF_NOT_FOUND when brief id does not exist', async () => {
    const provider = makeProvider([]);
    try {
      await transformBrief('nonexistent', { provider, db: asDb() });
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
      await transformBrief(brief.id, { provider, db: asDb() });
      expect.fail('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(IntakeError);
      expect((err as IntakeError).code).toBe('BRIEF_MISSING_SCORE');
    }
  });

  it('throws INVALID_OUTPUT when score does not meet transformability gate', async () => {
    const brief = await createBrief({ title: 'T', rawText: 'r' }, asDb());
    await patchPipelineBrief(brief.id, { score: NON_TRANSFORMABLE_SCORE }, asDb());

    const provider = makeProvider([]);
    try {
      await transformBrief(brief.id, { provider, db: asDb() });
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
  it('transforms a transformable brief and persists all three M29 fields', async () => {
    const brief = await createBrief({ title: 'T', rawText: 'r' }, asDb());
    await patchPipelineBrief(brief.id, { score: TRANSFORMABLE_SCORE }, asDb());

    const provider = makeProvider([SAMPLE_TRANSFORM_JSON, SAMPLE_RESCORE_JSON]);
    const result = await transformBrief(brief.id, { provider, db: asDb() });

    expect(result.retried).toBe(false);
    expect(result.brief.transformedBriefText).toMatch(/clinic needs an AI phone/);
    expect(result.brief.pinnedTechStack?.primary).toBe('tech_vapi');
    expect(result.brief.pinnedTechStack?.supporting).toEqual(['tech_n8n']);
    expect(result.brief.transformedScore?.aggregate).toBe(4.0);
  });

  it('reports drift on the visual+story axes (improvement is expected)', async () => {
    const brief = await createBrief({ title: 'T', rawText: 'r' }, asDb());
    await patchPipelineBrief(brief.id, { score: TRANSFORMABLE_SCORE }, asDb());

    const provider = makeProvider([SAMPLE_TRANSFORM_JSON, SAMPLE_RESCORE_JSON]);
    const result = await transformBrief(brief.id, { provider, db: asDb() });

    expect(result.drift.visualOutcomeDelta).toBeCloseTo(2);
    expect(result.drift.storyPotentialDelta).toBeCloseTo(2);
    expect(result.drift.scopeFitDelta).toBeCloseTo(0);
    expect(result.drift.audienceMatchDelta).toBeCloseTo(0);
    expect(result.drift.flagged).toBe(false);
  });

  it('flags drift when technical-axis delta exceeds threshold', async () => {
    const brief = await createBrief({ title: 'T', rawText: 'r' }, asDb());
    await patchPipelineBrief(brief.id, { score: TRANSFORMABLE_SCORE }, asDb());

    // Re-score returns a score where scopeFit moved from 4 -> 2 (delta -2).
    const driftedRescore = JSON.stringify({
      visualOutcome: 4,
      storyPotential: 4,
      scopeFit: 2,
      audienceMatch: 4,
      rationale: 'transformer rewrote what the project is, not just framing',
    });
    const provider = makeProvider([SAMPLE_TRANSFORM_JSON, driftedRescore]);
    const result = await transformBrief(brief.id, { provider, db: asDb() });

    expect(result.drift.scopeFitDelta).toBeCloseTo(-2);
    expect(result.drift.flagged).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// transformBrief — retry path
// -----------------------------------------------------------------------------

describe('transformBrief — retry path', () => {
  it('retries once on bad JSON from transform call, then succeeds', async () => {
    const brief = await createBrief({ title: 'T', rawText: 'r' }, asDb());
    await patchPipelineBrief(brief.id, { score: TRANSFORMABLE_SCORE }, asDb());

    const provider = makeProvider([
      'not valid json at all',
      SAMPLE_TRANSFORM_JSON,
      SAMPLE_RESCORE_JSON,
    ]);
    const result = await transformBrief(brief.id, { provider, db: asDb() });
    expect(result.retried).toBe(true);
    expect(result.brief.transformedBriefText).toBeTruthy();
  });

  it('retries once when LLM picks a tech stack id not in the catalog', async () => {
    const brief = await createBrief({ title: 'T', rawText: 'r' }, asDb());
    await patchPipelineBrief(brief.id, { score: TRANSFORMABLE_SCORE }, asDb());

    const phantomPick = JSON.stringify({
      pinnedTechStack: {
        primary: 'tech_phantom_does_not_exist',
        supporting: [],
        rationale: 'invalid pick',
      },
      transformedBriefText: 'long-enough transformed brief text body to satisfy the schema minimum of 100 characters which is the rule.',
    });
    const provider = makeProvider([phantomPick, SAMPLE_TRANSFORM_JSON, SAMPLE_RESCORE_JSON]);
    const result = await transformBrief(brief.id, { provider, db: asDb() });
    expect(result.retried).toBe(true);
    expect(result.brief.pinnedTechStack?.primary).toBe('tech_vapi');
  });

  it('throws INVALID_OUTPUT when LLM picks phantom ids twice', async () => {
    const brief = await createBrief({ title: 'T', rawText: 'r' }, asDb());
    await patchPipelineBrief(brief.id, { score: TRANSFORMABLE_SCORE }, asDb());

    const phantom = JSON.stringify({
      pinnedTechStack: {
        primary: 'tech_phantom',
        supporting: [],
        rationale: 'still wrong',
      },
      transformedBriefText: 'long-enough transformed brief text body to satisfy the schema minimum of 100 characters which is the rule.',
    });
    const provider = makeProvider([phantom, phantom]);
    try {
      await transformBrief(brief.id, { provider, db: asDb() });
      expect.fail('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(IntakeError);
      expect((err as IntakeError).code).toBe('INVALID_OUTPUT');
    }
  });

  it('throws LLM_FAILED when provider throws LLMProviderError', async () => {
    const brief = await createBrief({ title: 'T', rawText: 'r' }, asDb());
    await patchPipelineBrief(brief.id, { score: TRANSFORMABLE_SCORE }, asDb());

    const provider = makeProvider([
      { throws: new LLMProviderError('claude', 'TIMEOUT', 'provider timed out') },
    ]);
    try {
      await transformBrief(brief.id, { provider, db: asDb() });
      expect.fail('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(IntakeError);
      expect((err as IntakeError).code).toBe('LLM_FAILED');
    }
  });
});

// -----------------------------------------------------------------------------
// transformBrief — catalog/audience integration
// -----------------------------------------------------------------------------

describe('transformBrief — catalog integration', () => {
  it('throws INVALID_OUTPUT when tech-stack catalog is empty', async () => {
    const brief = await createBrief({ title: 'T', rawText: 'r' }, asDb());
    await patchPipelineBrief(brief.id, { score: TRANSFORMABLE_SCORE }, asDb());

    mockTechStacks = [];
    const provider = makeProvider([]);
    try {
      await transformBrief(brief.id, { provider, db: asDb() });
      expect.fail('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(IntakeError);
      expect((err as IntakeError).code).toBe('INVALID_OUTPUT');
      expect((err as IntakeError).message).toMatch(/catalog is empty/);
    }
  });
});
