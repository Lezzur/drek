import { describe, it, expect, vi } from 'vitest';
import {
  filterToKnownReferences,
  ensureCompleteCoverage,
  HALLUCINATION_SIGNAL_TYPE,
} from '../../src/engine/llm-output-guards.js';

describe('filterToKnownReferences', () => {
  it('keeps items whose id is in the known set', () => {
    const result = filterToKnownReferences({
      items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      selectId: (i) => i.id,
      knownIds: new Set(['a', 'b', 'c']),
    });
    expect(result.kept).toHaveLength(3);
    expect(result.dropped).toEqual([]);
    expect(result.hallucinationRate).toBe(0);
  });

  it('drops items whose id is NOT in the known set', () => {
    const result = filterToKnownReferences({
      items: [{ id: 'a' }, { id: 'fake' }, { id: 'b' }],
      selectId: (i) => i.id,
      knownIds: ['a', 'b'],
    });
    expect(result.kept.map((i) => i.id)).toEqual(['a', 'b']);
    expect(result.dropped.map((i) => i.id)).toEqual(['fake']);
    expect(result.hallucinationRate).toBeCloseTo(1 / 3);
  });

  it('fires onHallucination per dropped item with the expected payload', () => {
    const calls: Array<{ hallucinatedId: string; expectedSetSize: number }> = [];
    filterToKnownReferences({
      items: [{ id: 'a' }, { id: 'fake_1' }, { id: 'fake_2' }],
      selectId: (i) => i.id,
      knownIds: ['a', 'b'],
      onHallucination: (event) => calls.push(event),
    });
    expect(calls).toEqual([
      { hallucinatedId: 'fake_1', expectedSetSize: 2 },
      { hallucinatedId: 'fake_2', expectedSetSize: 2 },
    ]);
  });

  it('passes the original item to onHallucination for context-aware logging', () => {
    const items = [{ id: 'fake', meta: 'flag-this' }];
    const onHallucination = vi.fn();
    filterToKnownReferences({
      items,
      selectId: (i) => i.id,
      knownIds: ['a'],
      onHallucination,
    });
    expect(onHallucination).toHaveBeenCalledWith(
      expect.objectContaining({ hallucinatedId: 'fake' }),
      items[0],
    );
  });

  it('does not fire onHallucination on a clean pass', () => {
    const onHallucination = vi.fn();
    filterToKnownReferences({
      items: [{ id: 'a' }, { id: 'b' }],
      selectId: (i) => i.id,
      knownIds: ['a', 'b'],
      onHallucination,
    });
    expect(onHallucination).not.toHaveBeenCalled();
  });

  it('handles empty input cleanly (0 rate, no crashes)', () => {
    const result = filterToKnownReferences({
      items: [],
      selectId: (i: { id: string }) => i.id,
      knownIds: ['a', 'b'],
    });
    expect(result.kept).toEqual([]);
    expect(result.dropped).toEqual([]);
    expect(result.hallucinationRate).toBe(0);
  });

  it('accepts iterables (Set, Array) interchangeably for knownIds', () => {
    const set = filterToKnownReferences({
      items: [{ id: 'a' }],
      selectId: (i) => i.id,
      knownIds: new Set(['a']),
    });
    const array = filterToKnownReferences({
      items: [{ id: 'a' }],
      selectId: (i) => i.id,
      knownIds: ['a'],
    });
    expect(set.kept).toHaveLength(1);
    expect(array.kept).toHaveLength(1);
  });
});

describe('ensureCompleteCoverage', () => {
  it('returns clean partition when applied + skipped cover every expected id', () => {
    const result = ensureCompleteCoverage({
      appliedIds: ['a', 'b'],
      skippedIds: ['c'],
      expectedIds: ['a', 'b', 'c'],
    });
    expect(result.applied).toEqual(['a', 'b']);
    expect(result.skipped).toEqual(['c']);
    expect(result.orphans).toEqual([]);
    expect(result.coverageRate).toBe(1);
  });

  it('identifies orphans (expected ids in neither applied nor skipped)', () => {
    const result = ensureCompleteCoverage({
      appliedIds: ['a'],
      skippedIds: ['b'],
      expectedIds: ['a', 'b', 'c', 'd'],
    });
    expect(result.orphans).toEqual(['c', 'd']);
    expect(result.coverageRate).toBeCloseTo(2 / 4);
  });

  it('drops hallucinated ids from applied (ids not in expected)', () => {
    const result = ensureCompleteCoverage({
      appliedIds: ['a', 'fake_applied'],
      skippedIds: ['b'],
      expectedIds: ['a', 'b'],
    });
    expect(result.applied).toEqual(['a']);
    expect(result.applied).not.toContain('fake_applied');
  });

  it('drops hallucinated ids from skipped (ids not in expected)', () => {
    const result = ensureCompleteCoverage({
      appliedIds: ['a'],
      skippedIds: ['b', 'fake_skipped'],
      expectedIds: ['a', 'b'],
    });
    expect(result.skipped).toEqual(['b']);
    expect(result.skipped).not.toContain('fake_skipped');
  });

  it('fires onOrphan per missing id with expected payload', () => {
    const calls: Array<{ hallucinatedId: string; expectedSetSize: number }> = [];
    ensureCompleteCoverage({
      appliedIds: ['a'],
      skippedIds: [],
      expectedIds: ['a', 'b', 'c'],
      onOrphan: (event) => calls.push(event),
    });
    expect(calls).toEqual([
      { hallucinatedId: 'b', expectedSetSize: 3 },
      { hallucinatedId: 'c', expectedSetSize: 3 },
    ]);
  });

  it('does not fire onOrphan when coverage is complete', () => {
    const onOrphan = vi.fn();
    ensureCompleteCoverage({
      appliedIds: ['a', 'b'],
      skippedIds: [],
      expectedIds: ['a', 'b'],
      onOrphan,
    });
    expect(onOrphan).not.toHaveBeenCalled();
  });

  it('handles empty expected set (coverage trivially 1)', () => {
    const result = ensureCompleteCoverage({
      appliedIds: [],
      skippedIds: [],
      expectedIds: [],
    });
    expect(result.coverageRate).toBe(1);
    expect(result.orphans).toEqual([]);
  });

  it('treats expected ids appearing in BOTH applied and skipped as accounted (no double-count orphan)', () => {
    // The LLM technically shouldn't do this, but we don't want to flag it
    // as a coverage gap — it's accounted for, even if redundantly.
    const result = ensureCompleteCoverage({
      appliedIds: ['a'],
      skippedIds: ['a'],
      expectedIds: ['a', 'b'],
    });
    expect(result.orphans).toEqual(['b']);
  });
});

describe('HALLUCINATION_SIGNAL_TYPE', () => {
  it('exposes the signal name shared with Neurocore', () => {
    expect(HALLUCINATION_SIGNAL_TYPE).toBe('llm.reference_hallucination_emitted');
  });
});
