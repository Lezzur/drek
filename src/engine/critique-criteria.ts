/**
 * Production-Realism Criteria Catalog (M36)
 *
 * Each criterion is a structured prompt for the critic LLM. The critic
 * evaluates a draft build plan against every criterion in a selected
 * catalog and returns findings keyed by `criterionId`.
 *
 * Criteria are **data, not signal types** — the critic emits a single
 * `plan.critique_finding_emitted` signal per finding with the criterion id
 * in the payload. This avoids the signal-enum explosion that would happen
 * if every new criterion required a new signal type.
 *
 * v1 catalog ships with 5 criteria covering the gaps surfaced in the
 * CRE Intelligence Platform and Privato planning conversations (May 2026).
 * New criteria can be added by appending to V1_CRITERIA and bumping
 * CRITERIA_VERSION; findings persist the version they were produced
 * against so older findings remain interpretable.
 *
 * The critic centralization (see DEFERRED.md #10) will eventually move
 * this catalog into Neurocore; the public shape is designed to be a
 * straight lift — no DREK-specific imports, no DREK-specific terms.
 */

import { z } from 'zod';

export const CRITERIA_VERSION = 'v1.2026-05-25';

export const SEVERITY_LEVELS = ['high', 'medium', 'low'] as const;
export type Severity = (typeof SEVERITY_LEVELS)[number];

export const CONFIDENCE_LEVELS = ['high', 'medium', 'low'] as const;
export type Confidence = (typeof CONFIDENCE_LEVELS)[number];

export const criterionSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().min(1),
  examplesOfFailure: z.array(z.string().min(1)).min(2).max(8),
  examplesOfPass: z.array(z.string().min(1)).min(2).max(8),
  defaultSeverity: z.enum(SEVERITY_LEVELS),
});

export type Criterion = z.infer<typeof criterionSchema>;

const SCOPE_HONESTY: Criterion = {
  id: 'scope_honesty',
  displayName: 'Scope Honesty',
  description:
    'Does the plan promise outcomes that exceed what the build steps actually deliver? Goal claims, "wow shot" descriptions, and final-product framing must match the scope of work the plan is committing to.',
  examplesOfFailure: [
    'Goal claims "justifies an institutional exit multiple" but the deliverable is a CLI prototype with seed data.',
    'Final product description includes "production-ready monitoring and alerting" but no monitoring step appears in the plan.',
    'Goal mentions "supports 100k concurrent users" but the build only addresses single-user CRUD flows.',
    'Plan description says "complete CI/CD pipeline" but no test or deploy automation steps exist.',
  ],
  examplesOfPass: [
    'Goal: "Build a proof-of-concept that demonstrates the scoring algorithm against seed data" + build steps that match.',
    'Final product framed as a CLI prototype, not enterprise software, when that\'s what the steps deliver.',
    'Plan explicitly notes "production hardening deferred to follow-up" when scope is constrained.',
  ],
  defaultSeverity: 'high',
};

const TIMELINE_REALISM: Criterion = {
  id: 'timeline_realism',
  displayName: 'Timeline Realism',
  description:
    'Are the per-step duration estimates achievable given the stated complexity? Watch for steps that compress non-trivial work into unrealistically short windows, or treat "Use Claude Code to implement X" as a fixed-cost operation regardless of X\'s complexity.',
  examplesOfFailure: [
    'A step labeled "Implement OAuth integration with token refresh" allocated 15 minutes.',
    'A step labeled "Design and implement the canonical PostgreSQL schema across 6 tables with indexes" allocated 35 minutes.',
    'A step labeled "Verify scores are intuitive by spot-checking against pipeline history" allocated 20 minutes — actual validation of a scoring algorithm against historical data is 4+ hours minimum.',
    'A 10-hour total budget for what is clearly a 30-hour build, with no acknowledgement of the gap.',
  ],
  examplesOfPass: [
    'Each step\'s duration is roughly proportional to its surface area (~5-10 min per file touched, ~30+ min for cross-file integration).',
    'Plan explicitly notes "20 min to scaffold; 4-6 hours of separate validation work deferred to a separate phase".',
    'Total runtime is presented as "compute time" not "watch time" when filming context applies.',
  ],
  defaultSeverity: 'medium',
};

const DEPENDENCY_COMPLETENESS: Criterion = {
  id: 'dependency_completeness',
  displayName: 'Dependency Completeness',
  description:
    'Are external dependencies (API access, third-party setup, prerequisite data, OAuth flows, rate-limit considerations) named and sequenced — or assumed away? A build plan that depends on "live API credentials" without specifying how those are provisioned or what scopes they need has a hidden blocker.',
  examplesOfFailure: [
    'Plan says "Run both pipelines live and verify counts" but no earlier step provisions or verifies the API credentials.',
    'GoHighLevel ingestion step lacks any mention of rate limits, retry logic, or pagination state — will hit 429s on real data.',
    'OAuth flow is referenced as "set up auth" without scoping which provider, which scopes, where tokens persist.',
    'pgvector embedding pipeline planned without acknowledging the OpenAI/Voyage API cost ceiling.',
  ],
  examplesOfPass: [
    'Phase 1 step 1 is "Verify GHL admin token has scopes X, Y, Z; if not, request elevation".',
    'Ingestion step includes "retry with backoff + jitter, checkpoint into ingestion_checkpoints table".',
    'API cost ceiling explicit: "Embedding ~500 transcripts at $0.02/1M tokens ≈ $0.10 — within budget".',
  ],
  defaultSeverity: 'high',
};

const EFFORT_DISTRIBUTION: Criterion = {
  id: 'effort_distribution',
  displayName: 'Effort Distribution',
  description:
    'Is work distributed appropriately across phases, or front-loaded/back-loaded in a way that creates schedule risk? Watch for plans where Phase 1 is 80% of total effort, or where the final phase is suspiciously light because the planner ran out of energy.',
  examplesOfFailure: [
    'Phase 1: 170 min · Phase 2: 135 min · Phase 3: 150 min · Phase 4: 160 min — but Phase 4 has 6 steps including a full MatchingEngine that\'s clearly 6+ hours of real work.',
    'Phase 1 contains all the integration setup (4 hours); Phase 4 contains the actual product logic (45 min) — the build delivers nothing useful until 90% complete.',
    'Five phases listed but Phase 5 has only one step "polish and ship" with no concrete deliverable.',
  ],
  examplesOfPass: [
    'Each phase delivers a self-contained, demonstrable artifact. A viewer of Phase 1 alone sees something working end-to-end at Phase 1\'s scope.',
    'Per-phase totals are within 30% of each other unless there\'s an explicit narrative reason for imbalance.',
    'Final phase is sized for genuine work, not "polish" — or the polish is explicit and budgeted.',
  ],
  defaultSeverity: 'medium',
};

const RISK_VISIBILITY: Criterion = {
  id: 'risk_visibility',
  displayName: 'Risk Visibility',
  description:
    'Are known failure modes named in the plan? This catches the subtle but high-leverage gaps: LLM auto-mutating persistent state based on unvalidated confidence scores, hand-wavy math ("weighted overlap") that conflates incommensurable dimensions, single-point-of-failure infrastructure choices, and "happy path only" implementations of inherently fault-prone integrations.',
  examplesOfFailure: [
    'IntelligenceService persists Claude\'s output and "updates the owner motivation score if confidence > 0.7" — LLM confidence is not calibrated; this auto-mutates a load-bearing score based on a feeling.',
    'MatchingEngine described as "weighted JSONB overlap" across price range, market, property type, and cap rate — these are four different distance functions, not one overlap. The framing hides the math problem.',
    'A step generates 50 outreach messages via Claude in a loop with no rate-limit handling, no retry, and no per-message validation.',
    'Plan calls for "OpenAI or Voyage AI embeddings" without picking one — embedding dimension affects every downstream schema (vector(1536) vs vector(1024)).',
  ],
  examplesOfPass: [
    'Plan explicitly flags "auto-update only on confidence > 0.7 AND human review" with a callout that LLM confidence is uncalibrated.',
    'MatchingEngine step defines a per-criterion scoring function: price-range distance, geographic Haversine, exact-match category — explicit math.',
    'Bulk LLM operation includes a "retry with exponential backoff, dead-letter on 5 failures" wrapper.',
    'Embedding model is pinned to a specific provider+model with the dimension committed in the schema migration.',
  ],
  defaultSeverity: 'high',
};

/**
 * V1 criteria, in evaluation order. The order shouldn't affect findings
 * (each criterion is independent) but stable ordering makes the
 * critic prompt deterministic and the findings UI scannable.
 */
export const V1_CRITERIA: readonly Criterion[] = [
  SCOPE_HONESTY,
  TIMELINE_REALISM,
  DEPENDENCY_COMPLETENESS,
  EFFORT_DISTRIBUTION,
  RISK_VISIBILITY,
] as const;

const CRITERIA_BY_ID = new Map(V1_CRITERIA.map((c) => [c.id, c]));

export function getCriterion(id: string): Criterion | null {
  return CRITERIA_BY_ID.get(id) ?? null;
}

export function listCriteriaIds(): string[] {
  return V1_CRITERIA.map((c) => c.id);
}

/**
 * Render the criterion block for inclusion in the critic prompt. Keeps the
 * format compact — the critic doesn't need verbose markdown, just a
 * structured instruction.
 */
export function formatCriterionForPrompt(c: Criterion): string {
  return [
    `### CRITERION: ${c.id}`,
    `**${c.displayName}** (default severity: ${c.defaultSeverity})`,
    '',
    c.description,
    '',
    'Examples of FAILURE (a plan that exhibits this should produce a finding):',
    ...c.examplesOfFailure.map((e) => `- ${e}`),
    '',
    'Examples of PASS (a plan that does this should NOT produce a finding for this criterion):',
    ...c.examplesOfPass.map((e) => `- ${e}`),
  ].join('\n');
}
