import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';

vi.mock('../../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() },
}));

import { createFakeFirestore, type FakeFirestore } from './fake-firestore.js';
import {
  logRecordingSession,
  listSessionsForPlan,
  deleteRecordingSession,
  computeSceneCoverage,
} from '../../src/db/recording-sessions.js';

let fake: FakeFirestore;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asDb = () => fake as unknown as Firestore;

const PLAN_ID = 'plan_rec_test_1';

const SESSION_A = {
  planId: PLAN_ID,
  dateRecorded: new Date('2026-05-15T10:00:00Z'),
  sessionType: 'build_session' as const,
  filePath: '/recordings/2026-05-15/build-session-01.mp4',
  durationSeconds: 7200,
  scenesCovered: ['scene_intro', 'scene_setup'],
};

const SESSION_B = {
  planId: PLAN_ID,
  dateRecorded: new Date('2026-05-16T14:00:00Z'),
  sessionType: 'demo_session' as const,
  filePath: '/recordings/2026-05-16/demo-session-01.mp4',
  durationSeconds: 3600,
  scenesCovered: ['scene_demo', 'scene_wrap'],
};

beforeEach(() => {
  fake = createFakeFirestore();
});

describe('logRecordingSession', () => {
  it('creates a recording session with a fresh id', async () => {
    const s = await logRecordingSession(SESSION_A, asDb());
    expect(s.id).toMatch(/^rec_/);
    expect(s.planId).toBe(PLAN_ID);
    expect(s.sessionType).toBe('build_session');
    expect(s.filePath).toBe('/recordings/2026-05-15/build-session-01.mp4');
    expect(s.durationSeconds).toBe(7200);
    expect(s.scenesCovered).toEqual(['scene_intro', 'scene_setup']);
    expect(s.notes).toBeNull();
    expect(s.createdAt).toBeInstanceOf(Date);
  });

  it('stores optional notes when provided', async () => {
    const s = await logRecordingSession(
      { ...SESSION_A, notes: 'Good take, no retakes needed.' },
      asDb(),
    );
    expect(s.notes).toBe('Good take, no retakes needed.');
  });

  it('persists to the recording_sessions collection', async () => {
    const s = await logRecordingSession(SESSION_A, asDb());
    const dump = fake._dump();
    const key = `recording_sessions/${s.id}`;
    expect(dump[key]).toBeDefined();
    expect(dump[key]!.planId).toBe(PLAN_ID);
  });
});

describe('listSessionsForPlan', () => {
  it('returns sessions for a plan sorted by dateRecorded descending', async () => {
    // SESSION_A is older (May 15), SESSION_B is newer (May 16)
    const sA = await logRecordingSession(SESSION_A, asDb());
    const sB = await logRecordingSession(SESSION_B, asDb());

    const list = await listSessionsForPlan(PLAN_ID, asDb());
    expect(list).toHaveLength(2);
    // Newest first
    expect(list[0]!.id).toBe(sB.id);
    expect(list[1]!.id).toBe(sA.id);
  });

  it('filters by planId — does not return other plans sessions', async () => {
    await logRecordingSession(SESSION_A, asDb());
    await logRecordingSession(
      { ...SESSION_B, planId: 'plan_other' },
      asDb(),
    );
    const list = await listSessionsForPlan(PLAN_ID, asDb());
    expect(list).toHaveLength(1);
    expect(list[0]!.planId).toBe(PLAN_ID);
  });

  it('returns empty array when no sessions exist for plan', async () => {
    const list = await listSessionsForPlan('plan_empty', asDb());
    expect(list).toEqual([]);
  });
});

describe('deleteRecordingSession', () => {
  it('returns false when the session does not exist', async () => {
    expect(await deleteRecordingSession('rec_missing', asDb())).toBe(false);
  });

  it('returns true and removes the session', async () => {
    const s = await logRecordingSession(SESSION_A, asDb());
    expect(await deleteRecordingSession(s.id, asDb())).toBe(true);
    const list = await listSessionsForPlan(PLAN_ID, asDb());
    expect(list).toHaveLength(0);
  });
});

describe('computeSceneCoverage', () => {
  it('happy path: 3 scenes, 1 session covering 2 of them', async () => {
    const sceneIds = ['scene_intro', 'scene_demo', 'scene_wrap'];
    const s = await logRecordingSession(
      {
        ...SESSION_A,
        scenesCovered: ['scene_intro', 'scene_demo'],
      },
      asDb(),
    );

    const coverage = await computeSceneCoverage(PLAN_ID, sceneIds, asDb());

    expect(coverage['scene_intro']!.covered).toBe(true);
    expect(coverage['scene_intro']!.sessionIds).toEqual([s.id]);

    expect(coverage['scene_demo']!.covered).toBe(true);
    expect(coverage['scene_demo']!.sessionIds).toEqual([s.id]);

    expect(coverage['scene_wrap']!.covered).toBe(false);
    expect(coverage['scene_wrap']!.sessionIds).toEqual([]);
  });

  it('multiple sessions contribute to coverage of the same scene', async () => {
    const sceneIds = ['scene_intro', 'scene_demo'];
    const s1 = await logRecordingSession(
      { ...SESSION_A, scenesCovered: ['scene_intro'] },
      asDb(),
    );
    const s2 = await logRecordingSession(
      { ...SESSION_B, scenesCovered: ['scene_intro', 'scene_demo'] },
      asDb(),
    );

    const coverage = await computeSceneCoverage(PLAN_ID, sceneIds, asDb());

    expect(coverage['scene_intro']!.covered).toBe(true);
    // Both sessions cover scene_intro — order depends on query (dateRecorded desc so s2 first)
    expect(coverage['scene_intro']!.sessionIds).toContain(s1.id);
    expect(coverage['scene_intro']!.sessionIds).toContain(s2.id);

    expect(coverage['scene_demo']!.covered).toBe(true);
    expect(coverage['scene_demo']!.sessionIds).toEqual([s2.id]);
  });

  it('silently drops phantom sceneIds from session data', async () => {
    // Session references 'scene_phantom' which is not in validSceneIds
    const sceneIds = ['scene_intro', 'scene_demo'];
    await logRecordingSession(
      {
        ...SESSION_A,
        scenesCovered: ['scene_intro', 'scene_phantom'],
      },
      asDb(),
    );

    const coverage = await computeSceneCoverage(PLAN_ID, sceneIds, asDb());

    // scene_intro is covered (legitimate)
    expect(coverage['scene_intro']!.covered).toBe(true);
    // scene_demo is not covered
    expect(coverage['scene_demo']!.covered).toBe(false);
    // scene_phantom is not in the output at all
    expect(coverage['scene_phantom']).toBeUndefined();
  });

  it('returns all false when no sessions exist', async () => {
    const sceneIds = ['scene_a', 'scene_b', 'scene_c'];
    const coverage = await computeSceneCoverage(PLAN_ID, sceneIds, asDb());
    for (const id of sceneIds) {
      expect(coverage[id]!.covered).toBe(false);
      expect(coverage[id]!.sessionIds).toEqual([]);
    }
  });
});
