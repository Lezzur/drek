import { describe, it, expect } from 'vitest';
import {
  V1_CRITERIA,
  CRITERIA_VERSION,
  SEVERITY_LEVELS,
  CONFIDENCE_LEVELS,
  getCriterion,
  listCriteriaIds,
  formatCriterionForPrompt,
  criterionSchema,
} from '../../src/engine/critique-criteria.js';

describe('critique-criteria — V1 catalog', () => {
  it('declares 5 criteria for v1', () => {
    expect(V1_CRITERIA.length).toBe(5);
  });

  it('every criterion validates against its own schema', () => {
    for (const c of V1_CRITERIA) {
      const result = criterionSchema.safeParse(c);
      if (!result.success) {
        throw new Error(`Criterion ${c.id} failed schema: ${JSON.stringify(result.error.errors)}`);
      }
    }
  });

  it('uses unique criterion ids', () => {
    const ids = V1_CRITERIA.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('uses snake_case ids (cross-spoke convention)', () => {
    for (const c of V1_CRITERIA) {
      expect(c.id).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it('includes the 5 expected v1 criteria by id', () => {
    const ids = listCriteriaIds();
    expect(ids).toContain('scope_honesty');
    expect(ids).toContain('timeline_realism');
    expect(ids).toContain('dependency_completeness');
    expect(ids).toContain('effort_distribution');
    expect(ids).toContain('risk_visibility');
  });

  it('every criterion ships at least 2 failure examples and 2 pass examples', () => {
    for (const c of V1_CRITERIA) {
      expect(c.examplesOfFailure.length).toBeGreaterThanOrEqual(2);
      expect(c.examplesOfPass.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('failure examples are concrete (no empty placeholders)', () => {
    for (const c of V1_CRITERIA) {
      for (const ex of c.examplesOfFailure) {
        expect(ex.length).toBeGreaterThan(30);
        expect(ex).not.toMatch(/^TODO|^placeholder|^example /i);
      }
    }
  });

  it('exposes a versioned identifier for findings to reference', () => {
    expect(CRITERIA_VERSION).toMatch(/^v\d+\.\d{4}-\d{2}-\d{2}$/);
  });

  it('default severity is one of the declared levels', () => {
    for (const c of V1_CRITERIA) {
      expect(SEVERITY_LEVELS).toContain(c.defaultSeverity);
    }
  });
});

describe('SEVERITY_LEVELS / CONFIDENCE_LEVELS', () => {
  it('declares severity high/medium/low', () => {
    expect(SEVERITY_LEVELS).toEqual(['high', 'medium', 'low']);
  });

  it('declares confidence high/medium/low (same axis, different meaning)', () => {
    expect(CONFIDENCE_LEVELS).toEqual(['high', 'medium', 'low']);
  });
});

describe('getCriterion', () => {
  it('returns the criterion for a registered id', () => {
    const c = getCriterion('scope_honesty');
    expect(c).not.toBeNull();
    expect(c!.displayName).toBe('Scope Honesty');
  });

  it('returns null for an unknown id', () => {
    expect(getCriterion('made_up_thing')).toBeNull();
    expect(getCriterion('')).toBeNull();
  });
});

describe('formatCriterionForPrompt', () => {
  it('includes the criterion id header', () => {
    const c = getCriterion('scope_honesty')!;
    const out = formatCriterionForPrompt(c);
    expect(out).toContain('### CRITERION: scope_honesty');
  });

  it('includes display name and default severity', () => {
    const c = getCriterion('risk_visibility')!;
    const out = formatCriterionForPrompt(c);
    expect(out).toContain('Risk Visibility');
    expect(out).toContain('default severity: high');
  });

  it('includes every failure example as a bullet', () => {
    const c = getCriterion('timeline_realism')!;
    const out = formatCriterionForPrompt(c);
    for (const ex of c.examplesOfFailure) {
      expect(out).toContain(ex);
    }
  });

  it('includes every pass example as a bullet', () => {
    const c = getCriterion('dependency_completeness')!;
    const out = formatCriterionForPrompt(c);
    for (const ex of c.examplesOfPass) {
      expect(out).toContain(ex);
    }
  });

  it('separates FAILURE and PASS sections with labels', () => {
    const c = getCriterion('effort_distribution')!;
    const out = formatCriterionForPrompt(c);
    expect(out).toContain('Examples of FAILURE');
    expect(out).toContain('Examples of PASS');
    // FAILURE label appears before PASS label.
    expect(out.indexOf('FAILURE')).toBeLessThan(out.indexOf('PASS'));
  });
});
