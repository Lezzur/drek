/**
 * LLM Output Guards (M36 Phase 2.4b)
 *
 * Shared utilities for defending against **reference hallucination** — when
 * an LLM cites an ID, key, or name that does not exist in the input set.
 *
 * This is the one category of hallucination zod can't catch (because the
 * valid set is runtime-dependent), and it kept showing up in M36's
 * services as ad-hoc filters. This module centralizes the pattern so:
 *   1. Every call site applies the same defensive logic.
 *   2. Hallucination events emit a consistent shape we can aggregate.
 *   3. Future spokes get the same guard for free.
 *
 * Callers wire the `onHallucination` callback to their domain-specific
 * signal emission (e.g., `emitSignal('llm.reference_hallucination_emitted',
 * { operation, hallucinated_id, expected_set_size })`). This module
 * intentionally does NOT import the Neurocore client — keeping it pure
 * makes it trivial to lift into Neurocore as a shared utility (DEFERRED.md
 * #10 territory) and trivial to test without network mocks.
 *
 * Categories of hallucination covered:
 *   - Reference hallucination: filterToKnownReferences()
 *   - Coverage hallucination (orphans):  ensureCompleteCoverage()
 *
 * NOT covered here (other layers handle them):
 *   - Enum hallucination → zod enum
 *   - Schema hallucination → zod safeParse
 *   - Format hallucination → extractJson + JSON.parse retry
 *   - Fact hallucination → the critic itself (M36's whole point)
 */

export interface HallucinationEvent {
  /** The id the LLM emitted that didn't exist in the known set. */
  hallucinatedId: string;
  /** The full known set size at filter time (for rate-base calculation). */
  expectedSetSize: number;
}

export interface FilterToKnownReferencesOpts<T> {
  /** The items the LLM emitted. */
  items: T[];
  /** Extract the id from each item. */
  selectId: (item: T) => string;
  /** The set of ids that are actually valid. */
  knownIds: Iterable<string>;
  /**
   * Called once per hallucinated item. Use this to emit signals or log
   * with operation-specific context.
   */
  onHallucination?: (event: HallucinationEvent, item: T) => void;
}

export interface FilterToKnownReferencesResult<T> {
  /** Items whose id was in knownIds. */
  kept: T[];
  /** Items whose id was NOT in knownIds. */
  dropped: T[];
  /** Convenience: the hallucination rate as a fraction in [0, 1]. */
  hallucinationRate: number;
}

/**
 * Filter LLM-emitted items to only those whose id is in the known set.
 * Fires `onHallucination` once per dropped item so the caller can emit
 * a signal with operation-specific context (spoke, operation, model).
 *
 * Example: filter LLM-emitted finding objects so only those citing
 * registered criterion_ids survive.
 */
export function filterToKnownReferences<T>(
  opts: FilterToKnownReferencesOpts<T>,
): FilterToKnownReferencesResult<T> {
  const known = opts.knownIds instanceof Set
    ? (opts.knownIds as Set<string>)
    : new Set(opts.knownIds);
  const expectedSetSize = known.size;
  const kept: T[] = [];
  const dropped: T[] = [];

  for (const item of opts.items) {
    const id = opts.selectId(item);
    if (known.has(id)) {
      kept.push(item);
    } else {
      dropped.push(item);
      opts.onHallucination?.({ hallucinatedId: id, expectedSetSize }, item);
    }
  }

  const total = opts.items.length;
  const hallucinationRate = total === 0 ? 0 : dropped.length / total;

  return { kept, dropped, hallucinationRate };
}

export interface EnsureCompleteCoverageOpts {
  /** The ids the LLM claimed to have processed (e.g., applied). */
  appliedIds: string[];
  /** The ids the LLM claimed to have skipped. */
  skippedIds: string[];
  /** Every id the LLM should have accounted for (applied + skipped union). */
  expectedIds: string[];
  /**
   * Called once per orphan (an expected id mentioned in neither applied
   * nor skipped). Use this to emit a coverage-gap signal.
   */
  onOrphan?: (event: HallucinationEvent) => void;
}

export interface EnsureCompleteCoverageResult {
  /** applied ids that were in expectedIds (hallucinated applied dropped). */
  applied: string[];
  /** skipped ids that were in expectedIds (hallucinated skipped dropped). */
  skipped: string[];
  /** expectedIds the LLM forgot to mention in either list. */
  orphans: string[];
  /** [0, 1] fraction of expected ids that were accounted for. */
  coverageRate: number;
}

/**
 * Detect coverage gaps in an applied/skipped partition. If the LLM
 * forgot to mention an id from the expected set, it becomes an orphan
 * that the caller can handle however makes sense (default to skipped,
 * mark as needs-review, etc.).
 *
 * Also filters hallucinated ids out of applied/skipped so this is a
 * one-stop shop for reference hygiene on partitioning outputs.
 *
 * Example: the revisor returns applied_finding_ids + skipped_finding_ids.
 * Ensure every input finding id is in one of those arrays; forgotten
 * ones get added to a "needs review" list.
 */
export function ensureCompleteCoverage(
  opts: EnsureCompleteCoverageOpts,
): EnsureCompleteCoverageResult {
  const expected = new Set(opts.expectedIds);
  const applied = opts.appliedIds.filter((id) => expected.has(id));
  const skipped = opts.skippedIds.filter((id) => expected.has(id));
  const accounted = new Set([...applied, ...skipped]);

  const orphans: string[] = [];
  const expectedSetSize = expected.size;
  for (const id of opts.expectedIds) {
    if (!accounted.has(id)) {
      orphans.push(id);
      opts.onOrphan?.({ hallucinatedId: id, expectedSetSize });
    }
  }

  const coverageRate =
    expectedSetSize === 0 ? 1 : (expectedSetSize - orphans.length) / expectedSetSize;

  return { applied, skipped, orphans, coverageRate };
}

/**
 * Signal type for cross-spoke reference-hallucination tracking.
 * Mirrored in Neurocore's SIGNAL_TYPES (pending registration; until
 * then, signals land in the unknown_signal_buffer thanks to M36 Phase 1.1).
 */
export const HALLUCINATION_SIGNAL_TYPE = 'llm.reference_hallucination_emitted';

export interface ReferenceHallucinationSignalPayload {
  /** Which spoke detected the hallucination (e.g., 'drek'). */
  spoke: string;
  /** Operation that produced the hallucinated reference (e.g., 'critique', 'revise'). */
  operation: string;
  /** The id the LLM cited that didn't exist. */
  hallucinatedId: string;
  /** Size of the known set at filter time — lets Neurocore normalize rate. */
  expectedSetSize: number;
  /** Optional: model identifier so per-model rates can be computed. */
  modelId?: string;
}
