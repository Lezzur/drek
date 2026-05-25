import { describe, it, expect, vi } from 'vitest';
import { revisePlan, buildRevisorPrompt } from '../../src/engine/revise-plan.js';
import { LLMProviderError, type LLMProvider } from '../../src/providers/index.js';
import type { CritiqueFinding } from '../../src/engine/critique-plan.js';
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
        throw new Error('mock provider exhausted');
      }
      if (typeof next === 'object' && 'throws' in next) throw next.throws;
      return next;
    },
  };
}

function samplePlan(): TransformedBuildPlan {
  return {
    goal: 'Build a prototype that scores owner motivation and matches buyers via CLI.',
    finalProduct: 'A CLI that emits ranked buyer matches plus a draft outreach message.',
    toolchain: [{ name: 'Claude Code CLI', role: 'Primary build tool.', source: 'given' }],
    buildSteps: [
      { title: 'Scaffold project', estimatedMinutes: 20, description: 'Init Python + Docker Compose.' },
      { title: 'Schema migration', estimatedMinutes: 35, description: 'Six tables with indexes.' },
      { title: 'GHL ingestion', estimatedMinutes: 40, description: 'Page through GHL contacts.' },
    ],
    shotHints: ['Terminal: docker up', 'psql: \\d owners', 'Browser: GHL Explorer'],
  };
}

function reviseToMakeBetter(plan: TransformedBuildPlan): TransformedBuildPlan {
  return {
    ...plan,
    goal: 'Build a CLI prototype (proof of concept) that scores owner motivation and matches buyers.',
  };
}

function findingId(n: number): string {
  return `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
}

function fakeFinding(n: number, criterionId = 'scope_honesty'): CritiqueFinding {
  return {
    id: findingId(n),
    criterionId,
    severity: 'high',
    confidence: 'high',
    issue: `Issue ${n}`,
    suggestedFix: `Fix ${n}`,
    stepRef: null,
    criteriaVersion: 'v1.2026-05-25',
  };
}

function llmReply(opts: {
  revisedPlan: TransformedBuildPlan;
  applied: string[];
  skipped: string[];
  skipReasons: Record<string, string>;
}): string {
  return JSON.stringify({
    revised_plan: opts.revisedPlan,
    applied_finding_ids: opts.applied,
    skipped_finding_ids: opts.skipped,
    skip_reasons: opts.skipReasons,
  });
}

describe('revisePlan — happy path', () => {
  it('returns the revised plan + accounted finding ids', async () => {
    const plan = samplePlan();
    const f1 = fakeFinding(1);
    const f2 = fakeFinding(2, 'dependency_completeness');
    const provider = makeProvider([
      llmReply({
        revisedPlan: reviseToMakeBetter(plan),
        applied: [f1.id],
        skipped: [f2.id],
        skipReasons: { [f2.id]: 'No clean fix.' },
      }),
    ]);

    const result = await revisePlan({ plan, findings: [f1, f2], provider });

    expect(result.ran).toBe(true);
    if (!result.ran) throw new Error('unreachable');
    expect(result.appliedFindingIds).toEqual([f1.id]);
    expect(result.skippedFindingIds).toEqual([f2.id]);
    expect(result.skipReasons[f2.id]).toBe('No clean fix.');
    expect(result.revisedPlan.goal).toContain('proof of concept');
    expect(result.modelUsed).toBe('claude');
  });

  it('skips the LLM call entirely when findings is empty', async () => {
    const provider = makeProvider([]); // never called
    const result = await revisePlan({ plan: samplePlan(), findings: [], provider });
    expect(result.ran).toBe(true);
    if (!result.ran) throw new Error('unreachable');
    expect(result.modelUsed).toBe('no-op');
    expect(result.appliedFindingIds).toEqual([]);
    expect(result.attemptCount).toBe(0);
  });

  it('drops applied_finding_ids that the LLM hallucinated (not in original list)', async () => {
    const plan = samplePlan();
    const f1 = fakeFinding(1);
    const fakeId = findingId(99);
    const provider = makeProvider([
      llmReply({
        revisedPlan: reviseToMakeBetter(plan),
        applied: [f1.id, fakeId], // fakeId is hallucinated
        skipped: [],
        skipReasons: {},
      }),
    ]);
    const result = await revisePlan({ plan, findings: [f1], provider });
    expect(result.ran).toBe(true);
    if (!result.ran) throw new Error('unreachable');
    expect(result.appliedFindingIds).toEqual([f1.id]);
    expect(result.appliedFindingIds).not.toContain(fakeId);
  });

  it('moves orphan findings (neither applied nor skipped) to skipped with default reason', async () => {
    const plan = samplePlan();
    const f1 = fakeFinding(1);
    const f2 = fakeFinding(2);
    const provider = makeProvider([
      llmReply({
        revisedPlan: reviseToMakeBetter(plan),
        applied: [f1.id],
        skipped: [], // f2 forgotten — should be added defensively
        skipReasons: {},
      }),
    ]);
    const result = await revisePlan({ plan, findings: [f1, f2], provider });
    expect(result.ran).toBe(true);
    if (!result.ran) throw new Error('unreachable');
    expect(result.skippedFindingIds).toContain(f2.id);
    expect(result.skipReasons[f2.id]).toBe('revisor_did_not_address');
  });
});

describe('revisePlan — graceful degradation', () => {
  it('retries on parse failure and succeeds on later attempt', async () => {
    const plan = samplePlan();
    const f1 = fakeFinding(1);
    const provider = makeProvider([
      'not JSON',
      llmReply({
        revisedPlan: reviseToMakeBetter(plan),
        applied: [f1.id],
        skipped: [],
        skipReasons: {},
      }),
    ]);
    const result = await revisePlan({ plan, findings: [f1], provider });
    expect(result.ran).toBe(true);
    if (!result.ran) throw new Error('unreachable');
    expect(result.attemptCount).toBe(2);
  });

  it('returns original plan + all findings as skipped after retry exhaustion', async () => {
    const plan = samplePlan();
    const f1 = fakeFinding(1);
    const f2 = fakeFinding(2);
    const provider = makeProvider(['bad', 'bad', 'bad']);
    const result = await revisePlan({ plan, findings: [f1, f2], provider });
    expect(result.ran).toBe(false);
    if (result.ran) throw new Error('unreachable');
    expect(result.revisedPlan).toBe(plan); // SAME reference
    expect(result.skippedFindingIds).toEqual([f1.id, f2.id]);
    expect(result.skipReasons[f1.id]).toBe(result.reason);
  });

  it('returns original plan on provider TIMEOUT after exhaustion', async () => {
    const plan = samplePlan();
    const f1 = fakeFinding(1);
    const provider = makeProvider([
      { throws: new LLMProviderError('claude', 'TIMEOUT', 'timed out') },
      { throws: new LLMProviderError('claude', 'TIMEOUT', 'timed out') },
      { throws: new LLMProviderError('claude', 'TIMEOUT', 'timed out') },
    ]);
    const result = await revisePlan({ plan, findings: [f1], provider });
    expect(result.ran).toBe(false);
    if (result.ran) throw new Error('unreachable');
    expect(result.reason).toBe('provider_timeout');
    expect(result.revisedPlan).toBe(plan);
  });

  it('rejects revised plan that does not conform to the plan schema', async () => {
    const plan = samplePlan();
    const f1 = fakeFinding(1);
    const garbledPlan = { goal: 'too short' }; // missing required keys
    const provider = makeProvider([
      JSON.stringify({
        revised_plan: garbledPlan,
        applied_finding_ids: [f1.id],
        skipped_finding_ids: [],
        skip_reasons: {},
      }),
      JSON.stringify({
        revised_plan: garbledPlan,
        applied_finding_ids: [f1.id],
        skipped_finding_ids: [],
        skip_reasons: {},
      }),
      JSON.stringify({
        revised_plan: garbledPlan,
        applied_finding_ids: [f1.id],
        skipped_finding_ids: [],
        skip_reasons: {},
      }),
    ]);
    const result = await revisePlan({ plan, findings: [f1], provider });
    expect(result.ran).toBe(false);
  });
});

describe('buildRevisorPrompt', () => {
  it('includes the original plan JSON', () => {
    const prompt = buildRevisorPrompt(samplePlan(), [fakeFinding(1)]);
    expect(prompt).toContain('"goal":');
    expect(prompt).toContain('Scaffold project');
  });

  it('includes every finding by id with issue + suggested fix', () => {
    const f1 = fakeFinding(1);
    const f2 = fakeFinding(2);
    const prompt = buildRevisorPrompt(samplePlan(), [f1, f2]);
    expect(prompt).toContain(f1.id);
    expect(prompt).toContain(f1.issue);
    expect(prompt).toContain(f1.suggestedFix);
    expect(prompt).toContain(f2.id);
  });

  it('specifies the four required output keys', () => {
    const prompt = buildRevisorPrompt(samplePlan(), [fakeFinding(1)]);
    expect(prompt).toContain('"revised_plan"');
    expect(prompt).toContain('"applied_finding_ids"');
    expect(prompt).toContain('"skipped_finding_ids"');
    expect(prompt).toContain('"skip_reasons"');
  });

  it('demands JSON-only output with no preamble', () => {
    const prompt = buildRevisorPrompt(samplePlan(), [fakeFinding(1)]);
    expect(prompt).toMatch(/Output ONLY the JSON object/i);
  });
});
