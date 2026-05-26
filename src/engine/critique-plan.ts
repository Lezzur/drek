/**
 * Production-Realism Critic (M36 Phase 2.2)
 *
 * Stateless service that evaluates a draft build plan against a list of
 * criteria and returns structured findings.
 *
 * Design constraints (locked during M36 planning):
 *   - Stateless function — no shared state across calls; safe to invoke
 *     concurrently from multiple spokes once this lifts into Neurocore.
 *   - The critic receives the plan + ONE-SENTENCE goal summary + criteria
 *     ONLY. No brief text, no drafter reasoning, no conversation context.
 *     Information isolation is enforced at prompt construction.
 *   - Critic LLM is configured per-function via Neurocore model config
 *     (defaults to the same tier as the drafter — see M36 tech spec §3.2).
 *   - Strict zod validation on output; up to 2 retries on parse failure;
 *     graceful degradation (return empty findings + flagged error) if all
 *     retries fail. The pipeline must never block on the critic.
 */

import { z } from 'zod';
import { LLMProviderError, type LLMProvider } from '../providers/index.js';
import { extractJson } from './json-utils.js';
import { logger } from '../logger.js';
import {
  CRITERIA_VERSION,
  CONFIDENCE_LEVELS,
  SEVERITY_LEVELS,
  formatCriterionForPrompt,
  getCriterion,
  type Confidence,
  type Severity,
} from './critique-criteria.js';
import { filterToKnownReferences } from './llm-output-guards.js';
import type { TransformedBuildPlan } from '../db/schemas.js';

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_RETRIES = 2;

/* ─── Input ────────────────────────────────────────────────────────────── */

export interface CritiqueInput {
  /** The draft build plan to evaluate. */
  plan: TransformedBuildPlan;
  /**
   * A short summary of the brief's intent — one sentence ideally. Used by
   * the scope_honesty criterion to compare promised outcome vs deliverable.
   * Caller decides what to put here; typical source is the brief's title
   * or a transformer-extracted intent string.
   */
  goalSummary: string;
  /** Criterion ids to evaluate against. Unknown ids are skipped with a warn. */
  criteriaIds: string[];
  /** Provider to call. Injected so tests can supply a deterministic mock. */
  provider: LLMProvider;
  /** Override the default 60s per-pass timeout. */
  timeoutMs?: number;
  /**
   * Optional: called once per reference-hallucination caught by the guard
   * (LLM cited a criterion_id not in the requested set). Caller uses this
   * to emit signals with operation-specific context (briefId, model).
   * Stays optional so the service has no Neurocore-client coupling.
   */
  onReferenceHallucination?: (event: {
    hallucinatedId: string;
    expectedSetSize: number;
  }) => void;
}

/* ─── Output ───────────────────────────────────────────────────────────── */

const llmFindingSchema = z.object({
  criterion_id: z.string().min(1),
  severity: z.enum(SEVERITY_LEVELS),
  confidence: z.enum(CONFIDENCE_LEVELS),
  issue: z.string().min(1).max(2000),
  suggested_fix: z.string().min(1).max(2000),
  step_ref: z.string().max(200).optional().nullable(),
});

const llmOutputSchema = z.object({
  findings: z.array(llmFindingSchema).max(50),
});

type LLMFinding = z.infer<typeof llmFindingSchema>;

export interface CritiqueFinding {
  id: string;
  criterionId: string;
  severity: Severity;
  confidence: Confidence;
  issue: string;
  suggestedFix: string;
  stepRef: string | null;
  criteriaVersion: string;
}

export interface CritiqueResult {
  findings: CritiqueFinding[];
  ran: true;
  modelUsed: string;
  durationMs: number;
  attemptCount: number;
}

export interface CritiqueUnavailable {
  findings: never[];
  ran: false;
  reason: string;
  durationMs: number;
  attemptCount: number;
}

/* ─── Service entry point ──────────────────────────────────────────────── */

/**
 * Run the critic against a draft plan. Never throws — failures degrade
 * to `{ ran: false, reason }` so the pipeline can ship the plan with a
 * "critique unavailable" notice.
 */
export async function critiquePlan(input: CritiqueInput): Promise<CritiqueResult | CritiqueUnavailable> {
  const start = Date.now();
  const criteria = resolveCriteria(input.criteriaIds);

  if (criteria.length === 0) {
    logger.warn({ requestedIds: input.criteriaIds }, 'critique: no valid criteria');
    return {
      findings: [],
      ran: false,
      reason: 'no_valid_criteria',
      durationMs: Date.now() - start,
      attemptCount: 0,
    };
  }

  const { provider } = input;
  const prompt = buildCriticPrompt(input.plan, input.goalSummary, criteria);

  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    let raw: string;
    try {
      raw = await provider.generate(attempt === 1 ? prompt : addRetryNudge(prompt), {
        timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
    } catch (err) {
      if (err instanceof LLMProviderError) {
        logger.warn(
          { code: err.code, attempt, provider: provider.name },
          'critique: provider error',
        );
        if (attempt > MAX_RETRIES) {
          return {
            findings: [],
            ran: false,
            reason: `provider_${err.code.toLowerCase()}`,
            durationMs: Date.now() - start,
            attemptCount: attempt,
          };
        }
        continue;
      }
      throw err; // re-throw non-LLM errors (programmer bugs)
    }

    const parsed = parseAndValidate(raw);
    if (parsed.ok) {
      const allowed = new Set(criteria.map((c) => c.id));
      const filtered = filterToKnownReferences({
        items: parsed.value.findings,
        selectId: (f) => f.criterion_id,
        knownIds: allowed,
        onHallucination: (event, item) => {
          logger.warn(
            {
              operation: 'critique',
              hallucinatedCriterionId: event.hallucinatedId,
              expectedSetSize: event.expectedSetSize,
              issue: item.issue.slice(0, 120),
            },
            'critique: dropped finding citing unknown criterion id (reference hallucination)',
          );
          input.onReferenceHallucination?.(event);
        },
      });
      const findings = filtered.kept.map((f) => toDomainFinding(f));

      logger.info(
        {
          findingsCount: findings.length,
          droppedCount: filtered.dropped.length,
          hallucinationRate: filtered.hallucinationRate,
          attempt,
          criteriaCount: criteria.length,
          durationMs: Date.now() - start,
        },
        'critique: succeeded',
      );

      return {
        findings,
        ran: true,
        modelUsed: provider.name,
        durationMs: Date.now() - start,
        attemptCount: attempt,
      };
    }

    logger.warn(
      { attempt, reason: parsed.reason, detail: parsed.detail },
      'critique: parse failed, retrying',
    );
    if (attempt > MAX_RETRIES) {
      return {
        findings: [],
        ran: false,
        reason: `parse_failed_after_${MAX_RETRIES}_retries`,
        durationMs: Date.now() - start,
        attemptCount: attempt,
      };
    }
  }

  // Unreachable — the loop returns in every branch — but TS doesn't know.
  return {
    findings: [],
    ran: false,
    reason: 'unexpected_exit',
    durationMs: Date.now() - start,
    attemptCount: MAX_RETRIES + 1,
  };
}

/* ─── Helpers ──────────────────────────────────────────────────────────── */

function resolveCriteria(ids: string[]): ReturnType<typeof getCriterion>[] extends (infer T)[]
  ? Exclude<T, null>[]
  : never {
  const out: Exclude<ReturnType<typeof getCriterion>, null>[] = [];
  for (const id of ids) {
    const c = getCriterion(id);
    if (c) out.push(c);
    else logger.warn({ id }, 'critique: unknown criterion id, skipping');
  }
  return out as ReturnType<typeof resolveCriteria>;
}

function toDomainFinding(f: LLMFinding): CritiqueFinding {
  return {
    id: crypto.randomUUID(),
    criterionId: f.criterion_id,
    severity: f.severity,
    confidence: f.confidence,
    issue: f.issue,
    suggestedFix: f.suggested_fix,
    stepRef: f.step_ref ?? null,
    criteriaVersion: CRITERIA_VERSION,
  };
}

function parseAndValidate(
  raw: string,
):
  | { ok: true; value: z.infer<typeof llmOutputSchema> }
  | { ok: false; reason: string; detail: unknown } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(raw));
  } catch (err) {
    return { ok: false, reason: 'not_valid_json', detail: (err as Error).message };
  }
  const v = llmOutputSchema.safeParse(parsed);
  if (!v.success) {
    return { ok: false, reason: 'schema_mismatch', detail: v.error.flatten() };
  }
  return { ok: true, value: v.data };
}

function addRetryNudge(originalPrompt: string): string {
  return `${originalPrompt}\n\n---\nIMPORTANT: Previous attempt failed to produce valid JSON matching the output schema. Output ONLY the JSON object — no markdown fences, no commentary, no preamble. The findings array MUST conform to the schema described above.`;
}

/* ─── Prompt construction ──────────────────────────────────────────────── */

/**
 * Build the critic prompt. Information isolation is enforced HERE: we only
 * pass the plan + goalSummary + criteria. No brief text, no drafter
 * chain-of-thought, no conversation context.
 */
export function buildCriticPrompt(
  plan: TransformedBuildPlan,
  goalSummary: string,
  criteria: NonNullable<ReturnType<typeof getCriterion>>[],
): string {
  const criteriaBlock = criteria.map(formatCriterionForPrompt).join('\n\n');
  const planJson = JSON.stringify(plan, null, 2);

  return `You are a production-realism critic. Your job is to read a draft build plan and identify places where it falls short of production-ready standards.

You evaluate the plan against ${criteria.length} specific criteria. For each criterion, decide whether the plan FAILS that criterion. Only emit a finding if it fails — silence means pass.

# Goal summary (one sentence describing what the plan is meant to achieve)
${goalSummary}

# Draft build plan (the artifact under review)
\`\`\`json
${planJson}
\`\`\`

# Criteria to evaluate against

${criteriaBlock}

# Output format

Emit ONLY a single JSON object matching this exact shape:

\`\`\`json
{
  "findings": [
    {
      "criterion_id": "<one of the criterion ids above>",
      "severity": "<high | medium | low>",
      "confidence": "<high | medium | low>",
      "issue": "<one sentence describing what's wrong with the plan>",
      "suggested_fix": "<one sentence describing what should change>",
      "step_ref": "<optional: phase/step reference like 'Phase 2 step 3', or omit>"
    }
  ]
}
\`\`\`

# Rules

1. Output ONLY the JSON object — no markdown fences, no preamble, no commentary.
2. Emit a finding ONLY when the criterion clearly fails. If a criterion is satisfied or only borderline, omit it.
3. Each finding addresses ONE criterion. If the plan fails the same criterion in multiple places, emit one finding citing the most representative location in step_ref.
4. Severity reflects how badly the plan fails (start from the criterion's default severity, adjust based on blast radius).
5. Confidence reflects how certain you are that the finding is real. Use \"low\" when the failure is plausible but the plan might justify it elsewhere; \"high\" when the failure is obvious and load-bearing.
6. Findings count is capped at 50. If you'd produce more, prioritize highest-severity / highest-confidence.
7. If the plan looks production-ready by every criterion, output \`{ \"findings\": [] }\`.

Now emit the JSON.`;
}
