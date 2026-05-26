/**
 * Plan Revisor (M36 Phase 2.3)
 *
 * Takes a draft build plan + critique findings and produces a revised plan
 * that addresses as many findings as possible. Findings the revisor chose
 * not to apply are returned alongside the revised plan with a per-finding
 * reason so the UI can show them as "unresolved" and the user can override.
 *
 * Design constraints (locked, mirror critique-plan.ts):
 *   - Stateless function, provider injected, no shared state.
 *   - Strict zod validation on the revised plan (must match the existing
 *     transformedBuildPlanSchema — no schema drift through revision).
 *   - Up to 2 retries on parse failure with retry-nudge.
 *   - Graceful degradation: if all retries fail, return ORIGINAL plan with
 *     every finding skipped (reason: revisor_failed). Pipeline never blocks.
 *   - Information isolation NOT enforced here — the revisor needs the full
 *     plan and findings to do useful work, but it doesn't see the brief or
 *     drafter reasoning either.
 */

import { z } from 'zod';
import { LLMProviderError, type LLMProvider } from '../providers/index.js';
import { extractJson } from './json-utils.js';
import { logger } from '../logger.js';
import { transformedBuildPlanSchema, type TransformedBuildPlan } from '../db/schemas.js';
import type { CritiqueFinding } from './critique-plan.js';
import { ensureCompleteCoverage } from './llm-output-guards.js';

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_RETRIES = 2;

/* ─── Input ────────────────────────────────────────────────────────────── */

export interface ReviseInput {
  plan: TransformedBuildPlan;
  findings: CritiqueFinding[];
  provider: LLMProvider;
  timeoutMs?: number;
  /**
   * Optional: fires once per orphan finding (input id the revisor forgot to
   * account for). Caller uses this to emit hallucination signals. Stays
   * optional so the service has no Neurocore-client coupling.
   */
  onReferenceHallucination?: (event: {
    hallucinatedId: string;
    expectedSetSize: number;
  }) => void;
}

/* ─── Output ───────────────────────────────────────────────────────────── */

const llmOutputSchema = z.object({
  revised_plan: transformedBuildPlanSchema,
  applied_finding_ids: z.array(z.string().min(1)),
  skipped_finding_ids: z.array(z.string().min(1)),
  skip_reasons: z.record(z.string().min(1), z.string().min(1)),
});

export interface ReviseResult {
  revisedPlan: TransformedBuildPlan;
  appliedFindingIds: string[];
  skippedFindingIds: string[];
  skipReasons: Record<string, string>;
  ran: true;
  modelUsed: string;
  durationMs: number;
  attemptCount: number;
}

export interface ReviseUnavailable {
  revisedPlan: TransformedBuildPlan; // = original plan, unchanged
  appliedFindingIds: [];
  skippedFindingIds: string[];
  skipReasons: Record<string, string>;
  ran: false;
  reason: string;
  durationMs: number;
  attemptCount: number;
}

/* ─── Service entry point ──────────────────────────────────────────────── */

/**
 * Apply findings to a draft plan. Never throws — failure modes degrade to
 * the original plan with every finding marked unresolved.
 */
export async function revisePlan(input: ReviseInput): Promise<ReviseResult | ReviseUnavailable> {
  const start = Date.now();

  if (input.findings.length === 0) {
    // No findings = nothing to revise. Skip the LLM call entirely.
    return {
      revisedPlan: input.plan,
      appliedFindingIds: [],
      skippedFindingIds: [],
      skipReasons: {},
      ran: true,
      modelUsed: 'no-op',
      durationMs: Date.now() - start,
      attemptCount: 0,
    };
  }

  const { provider } = input;
  const prompt = buildRevisorPrompt(input.plan, input.findings);
  const allFindingIds = input.findings.map((f) => f.id);

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
          'revisor: provider error',
        );
        if (attempt > MAX_RETRIES) {
          return degradedResult(
            input.plan,
            allFindingIds,
            `provider_${err.code.toLowerCase()}`,
            attempt,
            start,
          );
        }
        continue;
      }
      throw err; // re-throw non-LLM errors
    }

    const parsed = parseAndValidate(raw);
    if (parsed.ok) {
      const coverage = ensureCompleteCoverage({
        appliedIds: parsed.value.applied_finding_ids,
        skippedIds: parsed.value.skipped_finding_ids,
        expectedIds: allFindingIds,
        onOrphan: (event) => {
          logger.warn(
            {
              operation: 'revise',
              orphanFindingId: event.hallucinatedId,
              expectedSetSize: event.expectedSetSize,
            },
            'revise: finding id forgotten by revisor, defaulting to skipped',
          );
          input.onReferenceHallucination?.(event);
        },
      });

      // Hallucinated ids appearing in applied/skipped that weren't in input
      // are surfaced by comparing input → after-filter counts.
      const hallucinatedApplied =
        parsed.value.applied_finding_ids.length - coverage.applied.length;
      const hallucinatedSkipped =
        parsed.value.skipped_finding_ids.length - coverage.skipped.length;
      if (hallucinatedApplied + hallucinatedSkipped > 0) {
        logger.warn(
          {
            operation: 'revise',
            hallucinatedApplied,
            hallucinatedSkipped,
            expectedSetSize: allFindingIds.length,
          },
          'revise: dropped hallucinated finding ids from applied/skipped',
        );
      }

      // Orphans default-skip with revisor_did_not_address reason.
      const skipReasons: Record<string, string> = { ...parsed.value.skip_reasons };
      for (const id of coverage.orphans) {
        if (!(id in skipReasons)) skipReasons[id] = 'revisor_did_not_address';
      }
      const skipped = [...coverage.skipped, ...coverage.orphans];

      logger.info(
        {
          appliedCount: coverage.applied.length,
          skippedCount: skipped.length,
          orphanCount: coverage.orphans.length,
          coverageRate: coverage.coverageRate,
          attempt,
          durationMs: Date.now() - start,
        },
        'revisor: succeeded',
      );

      return {
        revisedPlan: parsed.value.revised_plan,
        appliedFindingIds: coverage.applied,
        skippedFindingIds: skipped,
        skipReasons,
        ran: true,
        modelUsed: provider.name,
        durationMs: Date.now() - start,
        attemptCount: attempt,
      };
    }

    logger.warn(
      { attempt, reason: parsed.reason, detail: parsed.detail },
      'revisor: parse failed, retrying',
    );
    if (attempt > MAX_RETRIES) {
      return degradedResult(
        input.plan,
        allFindingIds,
        `parse_failed_after_${MAX_RETRIES}_retries`,
        attempt,
        start,
      );
    }
  }

  // Unreachable — defensive fallback.
  return degradedResult(input.plan, allFindingIds, 'unexpected_exit', MAX_RETRIES + 1, start);
}

/* ─── Helpers ──────────────────────────────────────────────────────────── */

function degradedResult(
  originalPlan: TransformedBuildPlan,
  allFindingIds: string[],
  reason: string,
  attemptCount: number,
  start: number,
): ReviseUnavailable {
  const skipReasons: Record<string, string> = {};
  for (const id of allFindingIds) skipReasons[id] = reason;
  return {
    revisedPlan: originalPlan,
    appliedFindingIds: [],
    skippedFindingIds: allFindingIds,
    skipReasons,
    ran: false,
    reason,
    durationMs: Date.now() - start,
    attemptCount,
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
  return `${originalPrompt}\n\n---\nIMPORTANT: Previous attempt failed to produce valid JSON matching the output schema. Output ONLY the JSON object with the four required keys (revised_plan, applied_finding_ids, skipped_finding_ids, skip_reasons). The revised_plan MUST conform to the same schema as the original plan — no extra keys, no missing required keys.`;
}

/* ─── Prompt construction ──────────────────────────────────────────────── */

export function buildRevisorPrompt(
  plan: TransformedBuildPlan,
  findings: CritiqueFinding[],
): string {
  const planJson = JSON.stringify(plan, null, 2);
  const findingsBlock = findings
    .map(
      (f) => `### Finding ${f.id}
- **Criterion:** ${f.criterionId} (severity: ${f.severity}, confidence: ${f.confidence})
- **Issue:** ${f.issue}
- **Suggested fix:** ${f.suggestedFix}${f.stepRef ? `\n- **Step ref:** ${f.stepRef}` : ''}`,
    )
    .join('\n\n');

  return `You are a plan revisor. You receive a draft build plan and a list of findings from a production-realism critic. Your job is to revise the plan to address as many findings as possible — but only when the suggested fix makes the plan genuinely better. Skip findings that you can't address cleanly, and explain why.

# Draft build plan

\`\`\`json
${planJson}
\`\`\`

# Findings to address

${findingsBlock}

# Output format

Emit ONLY a single JSON object matching this exact shape:

\`\`\`json
{
  "revised_plan": { ... full plan object, same schema as the input ... },
  "applied_finding_ids": ["<id of each finding you addressed in the revised plan>"],
  "skipped_finding_ids": ["<id of each finding you intentionally did not address>"],
  "skip_reasons": {
    "<finding_id>": "<one sentence explaining why you skipped it>"
  }
}
\`\`\`

# Rules

1. Output ONLY the JSON object — no markdown fences, no preamble, no commentary.
2. revised_plan MUST be the same schema as the input plan. All required keys present (goal, finalProduct, toolchain, buildSteps, shotHints; phases optional). No extra keys.
3. Preserve the plan's overall structure. Don't rename phases, drop steps, or add steps unrelated to a finding's suggested fix.
4. When applying a finding, change the minimum number of fields needed to address it. A finding on scope_honesty usually rewrites goal/finalProduct text. A finding on dependency_completeness usually appends a new buildStep or augments an existing step description.
5. Every finding id MUST appear in either applied_finding_ids or skipped_finding_ids — no orphans. The two arrays must be disjoint.
6. For every id in skipped_finding_ids, include a corresponding key in skip_reasons.
7. Skip a finding when (a) the suggested fix would conflict with another finding, (b) the fix would expand the plan beyond its scope, or (c) the finding is plausible but the plan already addresses it implicitly. State the reason crisply.
8. If you can't address ANY finding cleanly, return the original plan unchanged with all findings in skipped_finding_ids.

Now emit the JSON.`;
}
