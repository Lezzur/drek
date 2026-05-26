import { describe, it, expect, beforeEach } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore, type FakeFirestore } from './fake-firestore.js';
import {
  persistFindings,
  listFindingsByBriefId,
  countUnresolvedFindings,
  overrideFinding,
  markResolvedByUser,
  markAppliedByRevisor,
  deleteFindingsByBriefId,
  listUnresolvedBySeverity,
} from '../../src/db/critique-findings.js';
import type { CritiqueFindingCreate } from '../../src/db/schemas.js';

let fake: FakeFirestore;
const asDb = () => fake as unknown as Firestore;

beforeEach(() => {
  fake = createFakeFirestore();
});

function mkInput(overrides: Partial<CritiqueFindingCreate> = {}): CritiqueFindingCreate {
  return {
    briefId: 'brief_abc',
    criterionId: 'scope_honesty',
    severity: 'high',
    confidence: 'high',
    issue: 'Goal claims X but build delivers Y.',
    suggestedFix: 'Scope claim to "proof of concept".',
    stepRef: null,
    criteriaVersion: 'v1.2026-05-25',
    modelUsed: 'claude-opus-4-7',
    ...overrides,
  };
}

describe('persistFindings', () => {
  it('returns empty array on empty input (no DB writes)', async () => {
    const result = await persistFindings([], asDb());
    expect(result).toEqual([]);
  });

  it('writes findings with status=unresolved and createdAt set', async () => {
    const findings = await persistFindings(
      [mkInput(), mkInput({ criterionId: 'risk_visibility' })],
      asDb(),
    );
    expect(findings).toHaveLength(2);
    for (const f of findings) {
      expect(f.id).toMatch(/^finding_[0-9a-f]{32}$/);
      expect(f.status).toBe('unresolved');
      expect(f.createdAt).toBeInstanceOf(Date);
      expect(f.overrideAt).toBeNull();
      expect(f.resolvedAt).toBeNull();
      expect(f.overrideReason).toBeNull();
    }
  });

  it('preserves each finding\'s input fields', async () => {
    const [persisted] = await persistFindings(
      [mkInput({ stepRef: 'Phase 2 step 3', confidence: 'low' })],
      asDb(),
    );
    expect(persisted!.criterionId).toBe('scope_honesty');
    expect(persisted!.confidence).toBe('low');
    expect(persisted!.stepRef).toBe('Phase 2 step 3');
    expect(persisted!.criteriaVersion).toBe('v1.2026-05-25');
    expect(persisted!.modelUsed).toBe('claude-opus-4-7');
  });
});

describe('listFindingsByBriefId', () => {
  it('returns empty array when no findings exist', async () => {
    expect(await listFindingsByBriefId('brief_abc', asDb())).toEqual([]);
  });

  it('returns empty array for empty briefId (defensive)', async () => {
    expect(await listFindingsByBriefId('', asDb())).toEqual([]);
  });

  it('returns only findings for the requested brief', async () => {
    await persistFindings(
      [
        mkInput({ briefId: 'brief_a' }),
        mkInput({ briefId: 'brief_a', criterionId: 'risk_visibility' }),
        mkInput({ briefId: 'brief_b' }),
      ],
      asDb(),
    );
    const aOnly = await listFindingsByBriefId('brief_a', asDb());
    expect(aOnly).toHaveLength(2);
    expect(aOnly.every((f) => f.briefId === 'brief_a')).toBe(true);
  });
});

describe('countUnresolvedFindings', () => {
  it('returns 0 when no findings exist', async () => {
    expect(await countUnresolvedFindings('brief_abc', asDb())).toBe(0);
  });

  it('counts only unresolved status (not overridden / resolved / applied)', async () => {
    const findings = await persistFindings(
      [mkInput(), mkInput({ criterionId: 'risk_visibility' }), mkInput({ criterionId: 'timeline_realism' })],
      asDb(),
    );
    // Override one, apply one — leaving one unresolved.
    await overrideFinding(findings[0]!.id, 'critic was wrong', asDb());
    await markAppliedByRevisor([findings[1]!.id], asDb());

    const count = await countUnresolvedFindings('brief_abc', asDb());
    expect(count).toBe(1);
  });

  it('handles empty briefId (defensive)', async () => {
    expect(await countUnresolvedFindings('', asDb())).toBe(0);
  });
});

describe('overrideFinding', () => {
  it('sets status=overridden, records reason + timestamp', async () => {
    const [f] = await persistFindings([mkInput()], asDb());
    const updated = await overrideFinding(f!.id, 'critic was wrong', asDb());
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe('overridden');
    expect(updated!.overrideReason).toBe('critic was wrong');
    expect(updated!.overrideAt).toBeInstanceOf(Date);
  });

  it('accepts null reason (UI allows override without explanation)', async () => {
    const [f] = await persistFindings([mkInput()], asDb());
    const updated = await overrideFinding(f!.id, null, asDb());
    expect(updated!.overrideReason).toBeNull();
    expect(updated!.status).toBe('overridden');
  });

  it('returns null when finding does not exist', async () => {
    const result = await overrideFinding('finding_nonexistent', 'x', asDb());
    expect(result).toBeNull();
  });
});

describe('markResolvedByUser', () => {
  it('sets status=resolved_by_user with resolvedAt timestamp', async () => {
    const [f] = await persistFindings([mkInput()], asDb());
    const updated = await markResolvedByUser(f!.id, asDb());
    expect(updated!.status).toBe('resolved_by_user');
    expect(updated!.resolvedAt).toBeInstanceOf(Date);
  });

  it('returns null when finding does not exist', async () => {
    expect(await markResolvedByUser('finding_nonexistent', asDb())).toBeNull();
  });
});

describe('markAppliedByRevisor', () => {
  it('is a no-op for empty input', async () => {
    await expect(markAppliedByRevisor([], asDb())).resolves.toBeUndefined();
  });

  it('flips multiple findings to applied_by_revisor in one batch', async () => {
    const findings = await persistFindings(
      [mkInput(), mkInput({ criterionId: 'risk_visibility' })],
      asDb(),
    );
    await markAppliedByRevisor(
      findings.map((f) => f.id),
      asDb(),
    );
    const after = await listFindingsByBriefId('brief_abc', asDb());
    expect(after.every((f) => f.status === 'applied_by_revisor')).toBe(true);
    expect(after.every((f) => f.resolvedAt !== null)).toBe(true);
  });
});

describe('deleteFindingsByBriefId', () => {
  it('deletes every finding for the brief, returns count', async () => {
    await persistFindings(
      [
        mkInput({ briefId: 'brief_a' }),
        mkInput({ briefId: 'brief_a', criterionId: 'risk_visibility' }),
        mkInput({ briefId: 'brief_b' }),
      ],
      asDb(),
    );
    const result = await deleteFindingsByBriefId('brief_a', asDb());
    expect(result.deleted).toBe(2);
    expect(await listFindingsByBriefId('brief_a', asDb())).toEqual([]);
    // Other brief untouched.
    expect((await listFindingsByBriefId('brief_b', asDb())).length).toBe(1);
  });

  it('returns deleted=0 when nothing matches', async () => {
    expect(await deleteFindingsByBriefId('brief_nonexistent', asDb())).toEqual({
      deleted: 0,
    });
  });

  it('handles empty briefId (defensive, no scan)', async () => {
    expect(await deleteFindingsByBriefId('', asDb())).toEqual({ deleted: 0 });
  });
});

describe('listUnresolvedBySeverity', () => {
  it('returns only unresolved findings at the given severity', async () => {
    const findings = await persistFindings(
      [
        mkInput({ severity: 'high' }),
        mkInput({ severity: 'high', criterionId: 'risk_visibility' }),
        mkInput({ severity: 'medium', criterionId: 'timeline_realism' }),
      ],
      asDb(),
    );
    // Override one of the high ones — should drop out of the unresolved list.
    await overrideFinding(findings[0]!.id, null, asDb());

    const highOnly = await listUnresolvedBySeverity('high', 100, asDb());
    expect(highOnly).toHaveLength(1);
    expect(highOnly[0]!.severity).toBe('high');
    expect(highOnly[0]!.status).toBe('unresolved');
  });

  it('clamps limit to [1, 500] range', async () => {
    // Just exercise the boundary — no assertion needed besides not throwing.
    await expect(listUnresolvedBySeverity('high', 0, asDb())).resolves.toEqual([]);
    await expect(listUnresolvedBySeverity('high', 99999, asDb())).resolves.toEqual([]);
  });
});
