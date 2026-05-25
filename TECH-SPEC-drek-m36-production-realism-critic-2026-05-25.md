# TECH-SPEC — DREK M36: Production-Realism Critic

**Date:** 2026-05-25
**Version target:** `v2.2.0`
**Author:** Tony Stark (lead dev) — reviewed by Lisa (coordination), critique architecture refined with Rick
**Status:** Draft — pending Rick's go-ahead before build
**Companion docs:**
- [`PRD-drek-2026-05-15.md`](./PRD-drek-2026-05-15.md) — base PRD
- [`TECH-SPEC-drek-v2.1-content-substrate-2026-05-19.md`](./TECH-SPEC-drek-v2.1-content-substrate-2026-05-19.md) — previous spec
- [`../neurocore/TECH-SPEC-neurocore-m36-supporting-2026-05-25.md`](../neurocore/TECH-SPEC-neurocore-m36-supporting-2026-05-25.md) — Neurocore-side companion
- [`../neurocore/DEFERRED.md`](../neurocore/DEFERRED.md) — registry of items deferred from this spec

---

## 1. Summary

DREK currently turns a brief into a phased build plan via a single LLM call. The plan looks polished but consistently misses production-realism details — rate limits, math specificity, scope honesty, LLM safety patterns. Reviewing the CRE intelligence platform plan and the Privato plan both surfaced the same gaps.

M36 adds a **critique-and-revise pass** between plan generation and delivery:

```
Brief → Transform (draft) → Critique → Revise → Final Plan + Findings (user-visible)
```

The critic is a separate stateless LLM call. It receives the draft plan + a one-sentence goal summary + a list of criteria — and only those. No brief. No drafter chain-of-thought. It returns structured findings. The revisor applies fixes. Both the final plan and the findings list reach the user.

Beyond the critic itself, M36 ships the supporting infrastructure for cross-spoke intelligence to start accumulating:

- **Model selection in Neurocore Settings** (per-function: drafter, critic, reviser)
- **Plan-edit affordance + signal** (separate from override)
- **Findings UI** (panel on detail view, badge on list view, re-evaluate button)
- **Signal emission** for cross-spoke learning loop

---

## 2. Goals and Non-Goals

### Goals
- Every plan DREK ships has been reviewed by an explicit production-realism checklist before the user sees it
- User sees the findings (not silently corrected) — findings build trust and feed learning
- Critic is structurally independent from drafter (stateless, scoped prompt, fresh API call)
- Infrastructure shipped supports cross-spoke learning when more spokes are added later
- Model selection is configurable per function via Neurocore Settings — no hardcoded models in spoke code

### Non-Goals
- Auto-tuning criterion weights based on override patterns (deferred to Neurocore module — DEFERRED.md #1)
- Cross-family critic models (deferred until non-Anthropic providers land — DEFERRED.md #2, #4, #5)
- Moving the critic itself to Neurocore (deferred — DEFERRED.md #10)
- Multi-spoke category negotiation (deferred — DEFERRED.md #8)

---

## 3. Architecture Decisions — Locked

### 3.1 Critic prompt scope (information isolation)

The critic receives **only**:
- The draft plan (JSON)
- A one-sentence summary of the goal
- The list of criteria IDs to evaluate against

The critic does NOT receive:
- The original brief
- The drafter's reasoning, chain-of-thought, or any drafter messages
- Any conversation context

This is enforced at prompt construction (composed in `src/engine/critique-plan.ts`), not as a side effect. Independence at the prompt layer matters more than independence at the model layer — same model, scoped prompt > different model, full context.

### 3.2 Model selection — both functions use the same tier

**v1 decision:** drafter = Claude Opus, critic = Claude Opus, reviser = Claude Opus.

A critic less capable than its drafter is structurally blind to errors above its capability ceiling. Independence cannot be bought at the cost of capability. Independence comes from **prompt scope** (see 3.1), not from downgrading the critic.

**Configurable, not hardcoded:** model selection per function lives in Neurocore Settings. The defaults above are seed values; the operator can change them at any time. Spoke caches the config and re-polls every 15 minutes.

### 3.3 Contamination layers — all three addressed

| Type | Risk | Mitigation |
|---|---|---|
| Memory contamination | Critic remembers writing the plan | Stateless API call — no conversation history shared. Each call is a fresh process by default. |
| Information contamination | Critic primed to validate drafter's reasoning | Critic receives plan + goal + criteria only. See 3.1. |
| Model bias contamination | Same model has same blind spots | Acknowledged limitation. v1 ships same-tier same-family. Cross-family is DEFERRED.md #2. Prompt scope independence is the v1 defense. |

### 3.4 Critic + revisor location — DREK for v1

The critique service lives in DREK for v1. Will move to Neurocore as a hosted service (DEFERRED.md #10) when a second spoke needs critique functionality.

**Design constraint:** the critique service must take `(artifact, criteria_ids[], model_config)` as parameters — no DREK-specific imports for the core logic. This makes the eventual lift trivial.

### 3.5 Findings visibility — user-facing

Findings are surfaced to the user, not silently corrected. The user sees:
- The final (revised) plan
- The list of findings the critic identified
- Which findings the revisor applied vs. which it skipped

Override and edit are two separate user actions emitting distinct signals (see §6).

---

## 4. Critique Categories — V1 Criteria Set

Categories are **payload metadata**, not signal type names. The signal name is `plan.critique_finding_emitted` for all findings; the category lives in the payload as `{ "criterion_id": "scope_honesty", "confidence": "high", ... }`. This avoids signal-enum explosion when new criteria are added.

### V1 catalog (5 criteria)

| Criterion ID | What it checks |
|---|---|
| `scope_honesty` | Does the plan promise outcomes that exceed the actual deliverable? Goal claims should match what the build steps deliver. |
| `timeline_realism` | Are deadlines achievable given stated dependencies, step durations, and assumed team size? |
| `dependency_completeness` | Are blockers (API access, third-party setup, prerequisite data) named and sequenced, or assumed away? |
| `effort_distribution` | Is the work front-loaded, back-loaded, or distributed appropriately across phases? |
| `risk_visibility` | Are known failure modes surfaced in the plan, or buried? Rate limits, API quota concerns, idempotency, LLM-output safety, etc. |

Each criterion definition lives in `src/engine/critique-criteria.ts` with:
- `id` (stable identifier used in signals and overrides)
- `display_name`
- `description` (the criterion question)
- `examples_of_failure` (3-5 examples used in the critic prompt)
- `examples_of_pass` (3-5 examples)
- `default_severity` (`high` / `medium` / `low`)

### Per-criterion confidence scoring

Each finding includes a `confidence` field (`high` / `medium` / `low`). Lets users triage: a high-confidence finding on scope honesty carries more weight than a low-confidence stylistic note.

---

## 5. Module Structure

New files:

```
src/engine/critique-plan.ts          // critique service (stateless function)
src/engine/critique-criteria.ts      // v1 criteria catalog
src/engine/revise-plan.ts            // revisor service (stateless function)
src/engine/model-config.ts           // cached model config from Neurocore
src/services/findings-store.ts       // persists findings to Firestore
src/routes/findings.ts               // override + re-evaluate endpoints
src/views/findings-panel.tsx         // UI for finding display
src/views/settings.tsx               // Settings page (toggle + model selection)
```

Modified files:

```
src/engine/transform-brief.ts        // wire critique + revise into pipeline
src/views/intake-detail.tsx          // add findings panel below plan
src/views/intake.tsx                 // add findings badge to list view
src/views/layout.tsx                 // add Settings link to nav
src/db/schemas.ts                    // add critiqueFindingSchema, extend buildPhaseSchema
src/routes/intake.tsx                // add re-evaluate endpoint
```

### 5.1 Critique service interface

```typescript
// src/engine/critique-plan.ts

export interface CritiqueInput {
  plan: BuildPhase[];           // the draft plan
  goalSummary: string;          // one-sentence summary of the brief's goal
  criteriaIds: string[];        // which criteria to evaluate against
  modelConfig: ModelConfig;     // pulled from cached Neurocore config
}

export interface CritiqueFinding {
  id: string;                   // stable UUID
  criterion_id: string;         // from the criteria catalog
  severity: 'high' | 'medium' | 'low';
  confidence: 'high' | 'medium' | 'low';
  issue: string;                // what's wrong, in plain text
  suggested_fix: string;        // what to change
  step_ref?: string;            // optional reference to a specific plan step
}

export interface CritiqueResult {
  findings: CritiqueFinding[];
  model_used: string;           // for audit
  prompt_tokens: number;
  completion_tokens: number;
  duration_ms: number;
}

export async function critiquePlan(input: CritiqueInput): Promise<CritiqueResult>;
```

### 5.2 Revisor service interface

```typescript
// src/engine/revise-plan.ts

export interface ReviseInput {
  plan: BuildPhase[];
  findings: CritiqueFinding[];
  modelConfig: ModelConfig;
}

export interface ReviseResult {
  revised_plan: BuildPhase[];
  applied_finding_ids: string[];    // findings whose fix was applied
  skipped_finding_ids: string[];    // findings the revisor chose not to apply
  skip_reasons: Record<string, string>;  // finding_id → why skipped
  model_used: string;
  duration_ms: number;
}

export async function revisePlan(input: ReviseInput): Promise<ReviseResult>;
```

### 5.3 Model config — cache + fallback

```typescript
// src/engine/model-config.ts

export interface ModelConfig {
  drafter: { provider: string; model_id: string };
  critic: { provider: string; model_id: string };
  reviser: { provider: string; model_id: string };
  embedder: { provider: string; model_id: string };
  cached_at: number;            // epoch ms
  source: 'neurocore' | 'env_fallback';
}

export async function getModelConfig(): Promise<ModelConfig>;
export async function refreshModelConfig(): Promise<void>;
```

Behavior:
- On boot, fetch from Neurocore. On success, cache in memory.
- Re-poll every 15 minutes.
- If Neurocore is unreachable AND no cache exists, fall back to env defaults (`DEFAULT_DRAFTER_MODEL`, `DEFAULT_CRITIC_MODEL`, etc.). Log a loud warning.
- If Neurocore is unreachable mid-run, keep using cached config until reachable again.
- Manual refresh endpoint: `POST /admin/refresh-model-config` — for instant propagation when settings change.

---

## 6. Pipeline Integration

`src/engine/transform-brief.ts` is the existing entry point. Critique + revise wire in as follows:

```typescript
async function transformBrief(brief: Brief): Promise<TransformResult> {
  const modelConfig = await getModelConfig();
  const settings = await getLLMSettings();

  // 1. Existing draft generation
  const draftPlan = await draftPlan(brief, modelConfig.drafter);

  // 2. Critique pass (skippable via settings)
  let findings: CritiqueFinding[] = [];
  let critiqueRan = false;
  if (settings.useCritique) {
    try {
      const result = await critiquePlan({
        plan: draftPlan,
        goalSummary: extractGoalSummary(brief),
        criteriaIds: settings.activeCriteriaIds, // defaults to all 5 v1 criteria
        modelConfig: modelConfig.critic,
      });
      findings = result.findings;
      critiqueRan = true;
      emitSignal('plan.critique_run_completed', { /* ... */ });
    } catch (err) {
      // Graceful degradation: ship the draft plan, log critique unavailable
      emitSignal('plan.critique_unavailable', { reason: err.message });
    }
  }

  // 3. Revise pass (only if findings exist)
  let finalPlan = draftPlan;
  let revisorResult: ReviseResult | null = null;
  if (findings.length > 0) {
    try {
      revisorResult = await revisePlan({
        plan: draftPlan,
        findings,
        modelConfig: modelConfig.reviser,
      });
      finalPlan = revisorResult.revised_plan;
      emitSignal('plan.revised_after_critique', { /* ... */ });
    } catch (err) {
      // Graceful degradation: ship the draft with findings unresolved
      emitSignal('plan.revisor_failed', { reason: err.message });
    }
  }

  // 4. Persist findings alongside the plan
  await persistFindings(briefId, findings, revisorResult);

  return { plan: finalPlan, findings, critiqueRan };
}
```

Per-pass timeouts: 60s each, independent of overall transform timeout.

Failure modes:
- Critic fails → log + skip revisor + ship draft with `critiqueRan: false`
- Revisor fails → keep findings as unresolved + ship original draft
- Both Neurocore + cache + env defaults fail → spoke logs `model_config_unavailable` and refuses to transform (cannot run LLM without knowing which model)

---

## 7. Signal Emission

All signals are emitted to Neurocore. Per Neurocore-side companion spec, the **unknown signal buffer** is in place BEFORE M36 deploys (see `../neurocore/TECH-SPEC-neurocore-m36-supporting-2026-05-25.md` §3) — so even if Neurocore hasn't registered handlers for these signal types yet, they're buffered safely.

### Spoke-emitted signals (DREK)

| Signal Type | When | Key Payload Fields |
|---|---|---|
| `plan.transform_started` | start of transform | `brief_id`, `model_id` |
| `plan.transform_completed` | end of transform | `brief_id`, `duration_ms`, `critique_ran`, `findings_count` |
| `plan.critique_finding_emitted` | per finding | `finding_id`, `criterion_id`, `severity`, `confidence`, `brief_id` |
| `plan.critique_finding_overridden` | user clicks Override | `finding_id`, `criterion_id`, `reason?`, `brief_id` |
| `plan.revised_after_critique` | revisor applied any finding | `brief_id`, `applied_count`, `skipped_count` |
| `plan.user_edited` | user edits any plan field | `brief_id`, `field_path`, `before`, `after` |
| `plan.critique_unavailable` | critic call failed | `brief_id`, `reason` |
| `plan.revisor_failed` | revisor call failed | `brief_id`, `reason` |
| `llm.output_validation_failure_rate` | per LLM call | `function` ('drafter'/'critic'/'reviser'), `model_id`, `failed`, `total` |
| `llm.retry_count` | per LLM call | `function`, `model_id`, `retry_count` |
| `llm.cost_per_operation` | per LLM call | `function`, `model_id`, `prompt_tokens`, `completion_tokens`, `usd_cost` |
| `user.override_pattern` | aggregated nightly (or on threshold) | `spoke`, `operation_type`, `override_count`, `total_count` |

### Why these matter for cross-spoke learning

- `plan.critique_finding_overridden` accumulated → Neurocore detects miscalibrated criteria (DEFERRED.md #1 trigger).
- `llm.output_validation_failure_rate` + `llm.retry_count` → cross-spoke model reliability baselines.
- `llm.cost_per_operation` → cross-spoke cost intelligence (DEFERRED.md #7 input).
- `user.override_pattern` → meta-signal across spokes about when humans overrule machines.

---

## 8. UI Changes

### 8.1 Plan detail view (`src/views/intake-detail.tsx`)

New section **below the plan body**, above the existing brief text:

```
┌─ Final Build Plan ──────────────────────┐
│ [existing plan rendering]              │
└────────────────────────────────────────┘

┌─ Production-Realism Findings (3) ──────┐
│ ☐ scope_honesty · HIGH · HIGH confidence│
│   Issue: Goal claims "institutional     │
│   exit multiple" but build delivers     │
│   a prototype.                          │
│   Fix: Scope claim to "proof of         │
│   concept".                             │
│   [Override] [Mark Resolved]            │
│                                         │
│ ☑ timeline_realism · MED · HIGH conf   │
│   [Applied by revisor — see Phase 2]   │
│                                         │
│ ☐ risk_visibility · MED · LOW conf     │
│   [Override] [Mark Resolved]            │
└────────────────────────────────────────┘

[Re-evaluate Plan]
```

Each finding card shows:
- Criterion name (with link to catalog entry)
- Severity badge (high/medium/low)
- Confidence badge
- Issue text
- Suggested fix
- Status: applied / unresolved / overridden
- Actions: Override (with optional reason), Mark Resolved, View Catalog Entry

### 8.2 Intake list view (`src/views/intake.tsx`)

Plan rows gain a findings badge column:

```
| Brief | Score | Findings | Created | Actions |
|-------|-------|----------|---------|---------|
| ...   | 4.2   | ● 3      | 2h ago  | ...     |
| ...   | 3.8   | ● 0      | 5h ago  | ...     |
```

Findings badge:
- Hidden if `findings_count === 0`
- Yellow dot if `findings_count > 0` AND any unresolved
- Green dot if all findings resolved or overridden

### 8.3 Settings page (`src/views/settings.tsx`)

New page at `/settings`. Two sections:

**Production-Realism Critic:**
- Toggle: enabled / disabled (default: enabled)
- Active criteria checklist (v1: all 5 enabled by default)

**Model Selection:** (data pulled from Neurocore Model Registry)
- Drafter: dropdown
- Critic: dropdown
- Reviser: dropdown
- Embedder: dropdown (placeholder for future)

Each dropdown lists:
- Claude variants (all functional)
- OpenAI variants ("coming soon" — disabled)
- Gemini variants ("coming soon" — disabled)

"Save" button persists to Neurocore Settings via API call.

### 8.4 Re-evaluate button

On any plan detail view, a "Re-evaluate Plan" button at the bottom. Fires a fresh critique pass against the current plan state. Useful when the user has manually edited a plan after delivery.

POST to `/intake/:id/re-evaluate` — runs critique + revise against current persisted plan, returns new findings list.

---

## 9. Database Schema Changes

### 9.1 Firestore — new collection `critique_findings`

```typescript
// One document per finding
{
  finding_id: string,              // doc ID
  brief_id: string,                // ref to pipeline_briefs
  criterion_id: string,            // from catalog
  severity: 'high' | 'medium' | 'low',
  confidence: 'high' | 'medium' | 'low',
  issue: string,
  suggested_fix: string,
  step_ref?: string,
  status: 'unresolved' | 'applied_by_revisor' | 'overridden' | 'resolved_by_user',
  override_reason?: string,        // populated when status = 'overridden'
  override_at?: Timestamp,
  resolved_at?: Timestamp,
  criteria_version: string,        // which version of the catalog produced this
  model_used: string,
  created_at: Timestamp,
}
```

Required composite index (add to `firestore.indexes.json`):
- `critique_findings(brief_id ASC, created_at DESC)` — for listing per-brief findings
- `critique_findings(status ASC, severity ASC)` — for queries like "all unresolved high-severity"

### 9.2 Extend `buildPhaseSchema` (in `src/db/schemas.ts`)

Add optional fields to the existing schema:
- `critique_ran: boolean`
- `findings_count: number` (denormalized for list view performance)
- `revisor_applied_count: number`

---

## 10. Test Plan

Per DREK convention, every new module gets vitest coverage. Target: 100% green before deploy.

| File | Test focus |
|---|---|
| `tests/engine/critique-plan.test.ts` | Stateless behavior; prompt scope (no brief leaked); structured output parse; graceful degradation on LLM failure |
| `tests/engine/revise-plan.test.ts` | Applies findings; logs skipped reasons; preserves plan structure |
| `tests/engine/model-config.test.ts` | Cache behavior; refresh interval; env fallback; manual refresh |
| `tests/services/findings-store.test.ts` | Persistence; status transitions; query by brief_id |
| `tests/routes/findings.test.ts` | Override endpoint; re-evaluate endpoint; auth |
| `tests/views/findings-panel.test.tsx` | Render with various statuses; action buttons; empty state |
| `tests/views/settings.test.tsx` | Toggle persistence; model dropdown population; save |

Plus updates to existing tests:
- `tests/engine/transform-brief.test.ts` — add critique/revise pipeline coverage
- `tests/views/intake.test.tsx` — findings badge rendering

Static checks (must pass):
- `tests/db/firestore-indexes-coverage.test.ts` — confirm new indexes are declared

---

## 11. Build Sequence

Per Lisa's sequencing — Neurocore-side prerequisites land BEFORE DREK M36 deploys.

### Phase 0 (today, before any code)
- DEFERRED.md created in Neurocore repo with 11 initial entries — **DONE**
- This tech spec committed to DREK repo — **in progress**
- Companion Neurocore spec committed to Neurocore repo — see `../neurocore/TECH-SPEC-neurocore-m36-supporting-2026-05-25.md`

### Phase 1 (Neurocore prerequisites — ship first)
1. Unknown signal buffer (~1 hour)
2. Model registry + Settings model selection UI (~2 hours)
3. Settings page scaffolding in Neurocore (~1 hour)
4. Deploy + verify

### Phase 2 (DREK M36 core — depends on Phase 1)
1. Critic prompt template + criteria catalog (`src/engine/critique-criteria.ts`)
2. Critique service (`src/engine/critique-plan.ts`)
3. Revisor service (`src/engine/revise-plan.ts`)
4. Model config cache (`src/engine/model-config.ts`)
5. Findings store + Firestore schema + indexes (`src/services/findings-store.ts`)
6. Pipeline integration in `transform-brief.ts`
7. Signal emission
8. UI: findings panel, badge in list view, re-evaluate button, Settings page
9. Tests
10. Deploy

### Phase 3 (Post-deploy verification)
1. Watch signals flowing into Neurocore
2. Eat-our-own-dog-food: run the CRE intelligence plan through the critic, confirm it catches the issues we identified manually
3. Run the Privato plan through it, confirm same
4. Update DEFERRED.md with any new items surfaced during the build

### Estimated effort
- Phase 1: ~4 hours (Neurocore-side prerequisites)
- Phase 2: ~9-11 hours (DREK M36 core)
- Phase 3: ~1 hour verification
- **Total: ~14-16 hours**

Single-sitting feasible if uninterrupted; otherwise 2-3 sessions.

---

## 12. Open Questions

None at spec-finalization time. All earlier open questions resolved:

- ✅ Critic capability tier — locked to drafter tier (Rick: "critic cannot be less intelligent")
- ✅ Model independence approach — prompt scope, not model tier (Tony walked back the Sonnet recommendation)
- ✅ Where critic lives v1 — DREK, with clean interface for future Neurocore lift
- ✅ Override vs. edit affordances — both first-class with distinct signals (Rick's flag)
- ✅ Why defer items — they're real defers, but the bootstrap registry (DEFERRED.md) prevents forgetting
- ✅ Model config staleness — 15min cache + env fallback (Lisa's catch)
- ✅ Signal deploy ordering — unknown signal buffer ships first (Lisa's catch, also fixes 3 past incidents)
- ✅ in_progress without "shipped" creates clutter — full lifecycle (open → in_progress → shipped/dropped) baked in (Rick's catch)

---

## 13. Risk Register

| Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|
| Critic produces low-signal findings (mostly noise) | High — users disable the feature | Medium | Override-rate monitoring; if a criterion is overridden >40%, surface to operator (auto-tuning deferred but data starts accumulating immediately) |
| Critique adds significant latency to transform | Medium — UX regression | Low | Per-pass 60s timeout; critique runs in series after draft, not in parallel (could parallelize in v3 if needed); cost monitoring via signals |
| Cost spike from 3x LLM calls per transform | Medium — bill surprise | Medium | `llm.cost_per_operation` signal lets us see this. Operator can disable critique in Settings if cost outpaces value. |
| Findings break existing intake list UI | Low — visual regression | Low | Tests cover badge rendering; rollback is one commit |
| Neurocore unreachable at deploy time | High — DREK can't determine which model to use | Low | Env fallback layer; manual refresh endpoint |

---

## 14. Out of Scope (Tracked in DEFERRED.md)

See `../neurocore/DEFERRED.md` for full descriptions. Summary:

1. Auto-tuning criterion weights (#1)
2. Cross-family critic models (#2)
3. Criterion auto-sunsetting (#3)
4. OpenAI provider implementation (#4)
5. Gemini provider implementation (#5)
6. API key management for non-Anthropic providers (#6)
7. Per-function cost tracking dashboards (#7)
8. Multi-spoke category negotiation (#8)
9. Deferred Registry — proper Neurocore module (#9)
10. Critic + revisor centralization to Neurocore (#10)

---

*End of spec. Ready to build pending Rick's go-ahead.*
