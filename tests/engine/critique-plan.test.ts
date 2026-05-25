import { describe, it, expect, vi, beforeEach } from 'vitest';
import { critiquePlan, buildCriticPrompt } from '../../src/engine/critique-plan.js';
import { LLMProviderError, type LLMProvider } from '../../src/providers/index.js';
import { getCriterion } from '../../src/engine/critique-criteria.js';
import type { TransformedBuildPlan } from '../../src/db/schemas.js';

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

function makeProvider(responses: Array<string | { throws: Error }>): LLMProvider {
  const queue = [...responses];
  return {
    name: 'claude' as const,
    async generate() {
      const next = queue.shift();
      if (next === undefined) {
        throw new Error('mock provider exhausted — test queued too few responses');
      }
      if (typeof next === 'object' && 'throws' in next) throw next.throws;
      return next;
    },
  };
}

function samplePlan(): TransformedBuildPlan {
  return {
    goal: 'Build a CRE intelligence prototype that scores owner motivation and matches buyers.',
    finalProduct:
      'A CLI command that takes an owner_id and emits a ranked buyer list plus a personalised outreach message.',
    toolchain: [
      {
        name: 'Claude Code CLI',
        role: 'Drives the entire build.',
        source: 'given',
      },
    ],
    buildSteps: [
      { title: 'Scaffold project', estimatedMinutes: 20, description: 'Set up Python project + Docker Compose.' },
      { title: 'Schema migration', estimatedMinutes: 35, description: 'Six tables with indexes.' },
      { title: 'GHL ingestion', estimatedMinutes: 40, description: 'Page through GHL contacts + upsert.' },
    ],
    shotHints: [
      'Terminal: docker compose up',
      'psql: \\d owners',
      'Browser: GHL API Explorer',
    ],
  };
}

const NORMAL_REPLY = JSON.stringify({
  findings: [
    {
      criterion_id: 'scope_honesty',
      severity: 'high',
      confidence: 'high',
      issue: 'Goal claims "institutional exit multiple" but build delivers a CLI prototype.',
      suggested_fix: 'Scope the goal claim down to "proof of concept".',
      step_ref: 'Goal',
    },
    {
      criterion_id: 'dependency_completeness',
      severity: 'medium',
      confidence: 'medium',
      issue: 'GHL ingestion lacks rate-limit handling or pagination state.',
      suggested_fix: 'Add retry+backoff wrapper and persist ingestion checkpoints.',
      step_ref: 'Phase 1 step 3',
    },
  ],
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('critiquePlan — happy path', () => {
  it('returns parsed findings with stable shape', async () => {
    const provider = makeProvider([NORMAL_REPLY]);
    const result = await critiquePlan({
      plan: samplePlan(),
      goalSummary: 'CRE intelligence platform prototype.',
      criteriaIds: ['scope_honesty', 'dependency_completeness'],
      provider,
    });

    expect(result.ran).toBe(true);
    if (!result.ran) throw new Error('unreachable');
    expect(result.findings).toHaveLength(2);
    expect(result.findings[0]!.criterionId).toBe('scope_honesty');
    expect(result.findings[0]!.severity).toBe('high');
    expect(result.findings[0]!.confidence).toBe('high');
    expect(result.findings[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.findings[0]!.criteriaVersion).toMatch(/^v\d+\.\d{4}-\d{2}-\d{2}$/);
    expect(result.attemptCount).toBe(1);
  });

  it('accepts empty findings (plan passes every criterion)', async () => {
    const provider = makeProvider([JSON.stringify({ findings: [] })]);
    const result = await critiquePlan({
      plan: samplePlan(),
      goalSummary: 'CRE intelligence prototype.',
      criteriaIds: ['scope_honesty'],
      provider,
    });
    expect(result.ran).toBe(true);
    if (!result.ran) throw new Error('unreachable');
    expect(result.findings).toEqual([]);
  });

  it('handles JSON wrapped in markdown fences', async () => {
    const wrapped = '```json\n' + NORMAL_REPLY + '\n```';
    const provider = makeProvider([wrapped]);
    const result = await critiquePlan({
      plan: samplePlan(),
      goalSummary: 'x',
      criteriaIds: ['scope_honesty', 'dependency_completeness'],
      provider,
    });
    expect(result.ran).toBe(true);
    if (!result.ran) throw new Error('unreachable');
    expect(result.findings).toHaveLength(2);
  });

  it('drops findings for criterion ids that were not requested', async () => {
    const replyWithExtra = JSON.stringify({
      findings: [
        ...JSON.parse(NORMAL_REPLY).findings,
        {
          criterion_id: 'risk_visibility', // NOT in requested list
          severity: 'high',
          confidence: 'high',
          issue: 'Not requested.',
          suggested_fix: 'Ignore.',
        },
      ],
    });
    const provider = makeProvider([replyWithExtra]);
    const result = await critiquePlan({
      plan: samplePlan(),
      goalSummary: 'x',
      criteriaIds: ['scope_honesty', 'dependency_completeness'],
      provider,
    });
    expect(result.ran).toBe(true);
    if (!result.ran) throw new Error('unreachable');
    expect(result.findings.map((f) => f.criterionId)).toEqual([
      'scope_honesty',
      'dependency_completeness',
    ]);
  });
});

describe('critiquePlan — graceful degradation', () => {
  it('returns ran:false when criteriaIds is empty', async () => {
    const provider = makeProvider([]); // never called
    const result = await critiquePlan({
      plan: samplePlan(),
      goalSummary: 'x',
      criteriaIds: [],
      provider,
    });
    expect(result.ran).toBe(false);
    if (result.ran) throw new Error('unreachable');
    expect(result.reason).toBe('no_valid_criteria');
    expect(result.attemptCount).toBe(0);
  });

  it('returns ran:false when no requested criterion ids resolve', async () => {
    const provider = makeProvider([]);
    const result = await critiquePlan({
      plan: samplePlan(),
      goalSummary: 'x',
      criteriaIds: ['fake_criterion_1', 'fake_criterion_2'],
      provider,
    });
    expect(result.ran).toBe(false);
    if (result.ran) throw new Error('unreachable');
    expect(result.reason).toBe('no_valid_criteria');
  });

  it('retries on parse failure (malformed JSON) up to 2 retries', async () => {
    const provider = makeProvider([
      'not even close to JSON',
      '{ broken',
      NORMAL_REPLY,
    ]);
    const result = await critiquePlan({
      plan: samplePlan(),
      goalSummary: 'x',
      criteriaIds: ['scope_honesty', 'dependency_completeness'],
      provider,
    });
    expect(result.ran).toBe(true);
    if (!result.ran) throw new Error('unreachable');
    expect(result.attemptCount).toBe(3);
    expect(result.findings).toHaveLength(2);
  });

  it('returns ran:false after exhausting retries on persistent parse failure', async () => {
    const provider = makeProvider(['bad', 'still bad', 'never JSON']);
    const result = await critiquePlan({
      plan: samplePlan(),
      goalSummary: 'x',
      criteriaIds: ['scope_honesty'],
      provider,
    });
    expect(result.ran).toBe(false);
    if (result.ran) throw new Error('unreachable');
    expect(result.reason).toContain('parse_failed_after');
  });

  it('returns ran:false on schema mismatch (missing required field)', async () => {
    const provider = makeProvider([
      JSON.stringify({
        findings: [
          { criterion_id: 'scope_honesty', severity: 'high' /* missing issue, fix, confidence */ },
        ],
      }),
      JSON.stringify({ findings: [{ criterion_id: 'scope_honesty' }] }), // still bad
      JSON.stringify({ findings: [{ criterion_id: 'scope_honesty' }] }), // still bad
    ]);
    const result = await critiquePlan({
      plan: samplePlan(),
      goalSummary: 'x',
      criteriaIds: ['scope_honesty'],
      provider,
    });
    expect(result.ran).toBe(false);
  });

  it('returns ran:false on provider TIMEOUT (does not retry past MAX_RETRIES)', async () => {
    const provider = makeProvider([
      { throws: new LLMProviderError('claude', 'TIMEOUT', 'timed out') },
      { throws: new LLMProviderError('claude', 'TIMEOUT', 'timed out') },
      { throws: new LLMProviderError('claude', 'TIMEOUT', 'timed out') },
    ]);
    const result = await critiquePlan({
      plan: samplePlan(),
      goalSummary: 'x',
      criteriaIds: ['scope_honesty'],
      provider,
    });
    expect(result.ran).toBe(false);
    if (result.ran) throw new Error('unreachable');
    expect(result.reason).toBe('provider_timeout');
  });

  it('retries past a transient provider error and succeeds', async () => {
    const provider = makeProvider([
      { throws: new LLMProviderError('claude', 'TIMEOUT', 'timed out') },
      NORMAL_REPLY,
    ]);
    const result = await critiquePlan({
      plan: samplePlan(),
      goalSummary: 'x',
      criteriaIds: ['scope_honesty', 'dependency_completeness'],
      provider,
    });
    expect(result.ran).toBe(true);
    if (!result.ran) throw new Error('unreachable');
    expect(result.attemptCount).toBe(2);
  });
});

describe('buildCriticPrompt — information isolation', () => {
  it('includes the plan JSON', () => {
    const criteria = [getCriterion('scope_honesty')!];
    const prompt = buildCriticPrompt(samplePlan(), 'goal summary', criteria);
    expect(prompt).toContain('"goal":');
    expect(prompt).toContain('CRE intelligence prototype');
  });

  it('includes the goal summary verbatim', () => {
    const criteria = [getCriterion('scope_honesty')!];
    const sentinel = 'sentinel_goal_summary_for_test_isolation';
    const prompt = buildCriticPrompt(samplePlan(), sentinel, criteria);
    expect(prompt).toContain(sentinel);
  });

  it('includes every criterion definition by id', () => {
    const criteria = [
      getCriterion('scope_honesty')!,
      getCriterion('timeline_realism')!,
      getCriterion('risk_visibility')!,
    ];
    const prompt = buildCriticPrompt(samplePlan(), 'x', criteria);
    for (const c of criteria) {
      expect(prompt).toContain(`### CRITERION: ${c.id}`);
    }
  });

  it('emits the exact JSON output schema callout', () => {
    const criteria = [getCriterion('scope_honesty')!];
    const prompt = buildCriticPrompt(samplePlan(), 'x', criteria);
    expect(prompt).toContain('"findings":');
    expect(prompt).toContain('"criterion_id":');
    expect(prompt).toContain('"severity":');
    expect(prompt).toContain('"confidence":');
    expect(prompt).toContain('"suggested_fix":');
  });

  it('instructs JSON-only output with no preamble', () => {
    const criteria = [getCriterion('scope_honesty')!];
    const prompt = buildCriticPrompt(samplePlan(), 'x', criteria);
    expect(prompt).toMatch(/Output ONLY the JSON object/i);
  });
});
