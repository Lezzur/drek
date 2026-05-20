import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFakeFirestore, type FakeFirestore } from '../db/fake-firestore.js';

// Mock the AudienceProfile client BEFORE importing the service so the
// service's import-time wiring picks up the mock.
const profileGetMock = vi.fn();
vi.mock('../../src/neurocore/audience-profiles.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/neurocore/audience-profiles.js')
  >('../../src/neurocore/audience-profiles.js');
  return {
    ...actual,
    getAudienceProfileClient: () => ({
      list: vi.fn(),
      get: profileGetMock,
    }),
  };
});

// Silence logger.
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

import {
  applyBulkBriefAction,
  createBrief,
  deleteBrief,
  getBrief,
  listBriefs,
  promoteBriefToPlan,
  transitionBriefStage,
  updateBriefScore,
} from '../../src/intake/service.js';
import { getPipelineBrief } from '../../src/db/pipeline-briefs.js';
import { IntakeError } from '../../src/intake/errors.js';
import { AudienceProfileNotFoundError } from '../../src/neurocore/audience-profiles.js';
import type { BriefScore } from '../../src/db/schemas.js';
import type { Firestore } from 'firebase-admin/firestore';

let db: FakeFirestore;

beforeEach(() => {
  db = createFakeFirestore();
  profileGetMock.mockReset();
  profileGetMock.mockResolvedValue({
    id: 'developer_longform',
    name: 'Developer / Learner — Long-form',
  });
});

function validScore(): BriefScore {
  return {
    visualOutcome: 4,
    storyPotential: 4,
    scopeFit: 4,
    audienceMatch: 5,
    aggregate: 4.3,
  };
}

describe('createBrief / getBrief / listBriefs', () => {
  it('creates a brief with default stage candidate', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const brief = await createBrief({ title: 'Test', rawText: 'body' }, db as any);
    expect(brief.stage).toBe('candidate');
    expect(brief.id).toMatch(/^brief_/);
  });

  it('getBrief throws BRIEF_NOT_FOUND on unknown id', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(getBrief('missing', db as any)).rejects.toBeInstanceOf(IntakeError);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await getBrief('missing', db as any);
    } catch (err) {
      expect((err as IntakeError).code).toBe('BRIEF_NOT_FOUND');
    }
  });

  it('listBriefs returns all', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await createBrief({ title: 'A', rawText: 'a' }, db as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await createBrief({ title: 'B', rawText: 'b' }, db as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const all = await listBriefs({}, db as any);
    expect(all).toHaveLength(2);
  });
});

describe('updateBriefScore', () => {
  it('persists score + rationale', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const brief = await createBrief({ title: 'T', rawText: 'r' }, db as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updated = await updateBriefScore(brief.id, validScore(), 'why', db as any);
    expect(updated.score).toEqual(validScore());
    expect(updated.scoringRationale).toBe('why');
  });

  it('throws BRIEF_NOT_FOUND on unknown id', async () => {
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      updateBriefScore('missing', validScore(), undefined, db as any),
    ).rejects.toBeInstanceOf(IntakeError);
  });
});

describe('transitionBriefStage', () => {
  it('candidate → vetted accepted', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const brief = await createBrief({ title: 'T', rawText: 'r' }, db as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updated = await transitionBriefStage(brief.id, 'vetted', db as any);
    expect(updated.stage).toBe('vetted');
  });

  it('candidate → in_production rejected (must go through vetted+selected)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const brief = await createBrief({ title: 'T', rawText: 'r' }, db as any);
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      transitionBriefStage(brief.id, 'in_production', db as any),
    ).rejects.toBeInstanceOf(IntakeError);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await transitionBriefStage(brief.id, 'in_production', db as any);
    } catch (err) {
      expect((err as IntakeError).code).toBe('INVALID_STAGE_TRANSITION');
    }
  });
});

describe('promoteBriefToPlan', () => {
  it('creates a youtube_advanced plan + long_form deliverable + advances brief stage', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const brief = await createBrief({ title: 'Brief A', rawText: 'body' }, db as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await updateBriefScore(brief.id, validScore(), 'r', db as any);

    const result = await promoteBriefToPlan(brief.id, {
      formatProfileId: 'claude_code_build_along',
      audienceProfileId: 'developer_longform',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: db as any,
    });

    expect(result.planId).toMatch(/^plan_/);
    expect(result.deliverableId).toMatch(/^del_/);

    // Plan was written with v2 fields populated.
    const dump = db._dump();
    const planDoc = dump[`plans/${result.planId}`] as Record<string, unknown>;
    expect(planDoc.type).toBe('youtube_advanced');
    expect(planDoc.formatProfileId).toBe('claude_code_build_along');
    expect(planDoc.pipelineBriefId).toBe(brief.id);
    expect(planDoc.title).toBe('Brief A');
    expect(planDoc.status).toBe('awaiting_review');

    // Deliverable was written with audience binding.
    const delDoc = dump[`deliverables/${result.deliverableId}`] as Record<string, unknown>;
    expect(delDoc.planId).toBe(result.planId);
    expect(delDoc.kind).toBe('long_form');
    expect(delDoc.audienceProfileId).toBe('developer_longform');
    expect(delDoc.status).toBe('draft');

    // Brief stage advanced + promoted-id recorded.
    const briefDoc = dump[`pipeline_briefs/${brief.id}`] as Record<string, unknown>;
    expect(briefDoc.stage).toBe('selected');
    expect(briefDoc.promotedPlanId).toBe(result.planId);
  });

  it('uses formatProfile runtime midpoint when targetRuntimeSeconds is not provided', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const brief = await createBrief({ title: 'B', rawText: 'b' }, db as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await updateBriefScore(brief.id, validScore(), 'r', db as any);

    const result = await promoteBriefToPlan(brief.id, {
      formatProfileId: 'claude_code_build_along',
      audienceProfileId: 'developer_longform',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: db as any,
    });
    const planDoc = db._dump()[`plans/${result.planId}`] as Record<string, unknown>;
    // claude_code_build_along.runtimeRange is [1500, 2100] → midpoint 1800
    expect(planDoc.targetRuntimeSeconds).toBe(1800);
  });

  it('honors explicit targetRuntimeSeconds override', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const brief = await createBrief({ title: 'B', rawText: 'b' }, db as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await updateBriefScore(brief.id, validScore(), 'r', db as any);
    const result = await promoteBriefToPlan(brief.id, {
      formatProfileId: 'claude_code_build_along',
      audienceProfileId: 'developer_longform',
      targetRuntimeSeconds: 600,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: db as any,
    });
    const planDoc = db._dump()[`plans/${result.planId}`] as Record<string, unknown>;
    expect(planDoc.targetRuntimeSeconds).toBe(600);
  });

  it('throws BRIEF_NOT_FOUND on unknown brief id', async () => {
    await expect(
      promoteBriefToPlan('missing', {
        formatProfileId: 'claude_code_build_along',
        audienceProfileId: 'developer_longform',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        db: db as any,
      }),
    ).rejects.toBeInstanceOf(IntakeError);
  });

  it('throws BRIEF_MISSING_SCORE when brief has no score', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const brief = await createBrief({ title: 'B', rawText: 'b' }, db as any);
    try {
      await promoteBriefToPlan(brief.id, {
        formatProfileId: 'claude_code_build_along',
        audienceProfileId: 'developer_longform',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        db: db as any,
      });
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as IntakeError).code).toBe('BRIEF_MISSING_SCORE');
    }
  });

  it('throws BRIEF_ALREADY_PROMOTED on second promote', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const brief = await createBrief({ title: 'B', rawText: 'b' }, db as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await updateBriefScore(brief.id, validScore(), 'r', db as any);
    await promoteBriefToPlan(brief.id, {
      formatProfileId: 'claude_code_build_along',
      audienceProfileId: 'developer_longform',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: db as any,
    });
    try {
      await promoteBriefToPlan(brief.id, {
        formatProfileId: 'claude_code_build_along',
        audienceProfileId: 'developer_longform',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        db: db as any,
      });
      expect.fail('second promote should fail');
    } catch (err) {
      expect((err as IntakeError).code).toBe('BRIEF_ALREADY_PROMOTED');
    }
  });

  it('throws UNKNOWN_FORMAT_PROFILE when format id is unknown', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const brief = await createBrief({ title: 'B', rawText: 'b' }, db as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await updateBriefScore(brief.id, validScore(), 'r', db as any);
    try {
      await promoteBriefToPlan(brief.id, {
        formatProfileId: 'not_a_format',
        audienceProfileId: 'developer_longform',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        db: db as any,
      });
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as IntakeError).code).toBe('UNKNOWN_FORMAT_PROFILE');
    }
  });

  it('throws UNKNOWN_AUDIENCE_PROFILE when audience client returns 404', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const brief = await createBrief({ title: 'B', rawText: 'b' }, db as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await updateBriefScore(brief.id, validScore(), 'r', db as any);
    profileGetMock.mockRejectedValueOnce(new AudienceProfileNotFoundError('not_real'));
    try {
      await promoteBriefToPlan(brief.id, {
        formatProfileId: 'claude_code_build_along',
        audienceProfileId: 'not_real',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        db: db as any,
      });
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as IntakeError).code).toBe('UNKNOWN_AUDIENCE_PROFILE');
    }
  });

  it('bubbles up other Neurocore errors (timeout, 5xx)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const brief = await createBrief({ title: 'B', rawText: 'b' }, db as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await updateBriefScore(brief.id, validScore(), 'r', db as any);
    profileGetMock.mockRejectedValueOnce(new Error('Neurocore down'));
    await expect(
      promoteBriefToPlan(brief.id, {
        formatProfileId: 'claude_code_build_along',
        audienceProfileId: 'developer_longform',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        db: db as any,
      }),
    ).rejects.toThrow('Neurocore down');
  });
});

// ---------------------------------------------------------------------------
// Bulk actions (M26.5)
// ---------------------------------------------------------------------------

describe('applyBulkBriefAction — retire', () => {
  it('retires all matching briefs and reports succeeded count', async () => {
    const b1 = await createBrief({ title: 'A', rawText: 'a' }, db as unknown as Firestore);
    const b2 = await createBrief({ title: 'B', rawText: 'b' }, db as unknown as Firestore);
    const b3 = await createBrief({ title: 'C', rawText: 'c' }, db as unknown as Firestore);

    const result = await applyBulkBriefAction(
      [b1.id, b2.id, b3.id],
      'retire',
      db as unknown as Firestore,
    );

    expect(result.requested).toBe(3);
    expect(result.succeeded).toBe(3);
    expect(result.skipped).toBe(0);
    expect(result.failures).toEqual([]);

    const refreshed = await getPipelineBrief(b1.id, db as unknown as Firestore);
    expect(refreshed?.stage).toBe('retired');
  });

  it('skips already-retired briefs (idempotent)', async () => {
    const b = await createBrief({ title: 'X', rawText: 'x' }, db as unknown as Firestore);
    await applyBulkBriefAction([b.id], 'retire', db as unknown as Firestore);
    const second = await applyBulkBriefAction([b.id], 'retire', db as unknown as Firestore);
    expect(second.skipped).toBe(1);
    expect(second.succeeded).toBe(0);
  });

  it('skips non-existent briefIds without failing the batch', async () => {
    const b = await createBrief({ title: 'X', rawText: 'x' }, db as unknown as Firestore);
    const result = await applyBulkBriefAction(
      [b.id, 'brief_does_not_exist'],
      'retire',
      db as unknown as Firestore,
    );
    expect(result.succeeded).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.failures).toEqual([]);
  });
});

describe('applyBulkBriefAction — delete', () => {
  it('hard-deletes all matching briefs in one atomic batch', async () => {
    const b1 = await createBrief({ title: 'A', rawText: 'a' }, db as unknown as Firestore);
    const b2 = await createBrief({ title: 'B', rawText: 'b' }, db as unknown as Firestore);

    const result = await applyBulkBriefAction(
      [b1.id, b2.id],
      'delete',
      db as unknown as Firestore,
    );

    expect(result.action).toBe('delete');
    expect(result.requested).toBe(2);
    expect(result.succeeded).toBe(2);

    expect(await getPipelineBrief(b1.id, db as unknown as Firestore)).toBeNull();
    expect(await getPipelineBrief(b2.id, db as unknown as Firestore)).toBeNull();
  });

  it('counts non-existent ids as skipped', async () => {
    const b = await createBrief({ title: 'X', rawText: 'x' }, db as unknown as Firestore);
    const result = await applyBulkBriefAction(
      [b.id, 'brief_ghost1', 'brief_ghost2'],
      'delete',
      db as unknown as Firestore,
    );
    expect(result.succeeded).toBe(1);
    expect(result.skipped).toBe(2);
  });
});

describe('applyBulkBriefAction — guards', () => {
  it('empty briefIds returns a no-op summary', async () => {
    const result = await applyBulkBriefAction([], 'retire', db as unknown as Firestore);
    expect(result.requested).toBe(0);
    expect(result.succeeded).toBe(0);
  });

  it('throws BULK_TOO_LARGE when over 50 briefIds', async () => {
    const ids = Array.from({ length: 51 }, (_, i) => `brief_${i}`);
    await expect(
      applyBulkBriefAction(ids, 'retire', db as unknown as Firestore),
    ).rejects.toMatchObject({ code: 'BULK_TOO_LARGE' });
  });
});

describe('deleteBrief', () => {
  it('hard-deletes an existing brief', async () => {
    const b = await createBrief({ title: 'X', rawText: 'x' }, db as unknown as Firestore);
    const result = await deleteBrief(b.id, db as unknown as Firestore);
    expect(result.deleted).toBe(true);
    expect(await getPipelineBrief(b.id, db as unknown as Firestore)).toBeNull();
  });

  it('idempotent — returns deleted:false for unknown id', async () => {
    const result = await deleteBrief('brief_never_existed', db as unknown as Firestore);
    expect(result.deleted).toBe(false);
  });
});
