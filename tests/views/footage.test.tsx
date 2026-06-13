import { describe, it, expect } from 'vitest';
import { FootageTab } from '../../src/views/footage.js';
import type { Plan, Scene, RecordingSession } from '../../src/db/schemas.js';

const toHtml = (node: unknown) => String(node);

function fakePlan(overrides: Partial<Plan> = {}): Plan {
  return {
    id: 'plan_1',
    type: 'youtube_advanced',
    status: 'shot_list_generated',
    title: 'Test Plan',
    sourceListingId: null,
    sourceListingText: null,
    requirements: [],
    matchedProjects: [],
    targetRuntimeSeconds: 1800,
    estimatedRuntimeSeconds: 0,
    userConstraints: null,
    createdAt: new Date('2026-05-18T10:00:00Z'),
    updatedAt: new Date('2026-05-18T10:00:00Z'),
    exportedAt: null,
    formatProfileId: 'claude_code_build_along',
    pipelineBriefId: null,
    workspacePath: '/tmp/ws/plan_1-test-plan',
    selectedHookVariantId: null,
    selectedTitleVariantId: null,
    selectedThumbnailConceptId: null,
    pipelineState: 'idle' as const,
    pipelineError: null,
    ...overrides,
  };
}

function fakeScene(overrides: Partial<Scene> = {}): Scene {
  return {
    id: 'scene_1',
    planId: 'plan_1',
    order: 1,
    title: 'Cold open',
    description: 'd',
    framingNotes: 'f',
    script: 's',
    scriptDraft: '',
    emphasisCues: [],
    pacingNotes: '',
    transitionNote: '',
    estimatedDurationSeconds: 30,
    projectRef: null,
    storyboardImageUrl: null,
    beatTag: 'cold_open',
    primaryShot: null,
    brollItems: [],
    shotListItems: [],
    onScreenTextOverlays: [],
    cutPoints: [],
    ...overrides,
  };
}

function fakeSession(overrides: Partial<RecordingSession> = {}): RecordingSession {
  return {
    id: 'rec_1',
    planId: 'plan_1',
    dateRecorded: new Date('2026-05-18T14:00:00Z'),
    sessionType: 'build_session',
    filePath: 'recordings/build-2026-05-18.mp4',
    durationSeconds: 7200,
    scenesCovered: ['scene_1'],
    notes: null,
    createdAt: new Date('2026-05-18T16:00:00Z'),
    ...overrides,
  };
}

describe('FootageTab — empty state', () => {
  it('shows the log-session form even with no scenes', () => {
    const html = toHtml(
      FootageTab({
        plan: fakePlan(),
        scenes: [],
        sessions: [],
        coverage: {},
      }),
    );
    expect(html).toContain('Footage · Test Plan');
    expect(html).toContain('Log a recording session');
    expect(html).toContain('No scenes yet');
    expect(html).toContain('No recording sessions logged yet');
  });
});

describe('FootageTab — with data', () => {
  const scenes = [
    fakeScene({ id: 'a', order: 1, title: 'Cold open' }),
    fakeScene({ id: 'b', order: 2, title: 'Demo' }),
    fakeScene({ id: 'c', order: 3, title: 'Outro' }),
  ];

  it('renders coverage summary with covered/total counts', () => {
    const html = toHtml(
      FootageTab({
        plan: fakePlan(),
        scenes,
        sessions: [],
        coverage: {
          a: { covered: true, sessionIds: ['s1'] },
          b: { covered: false, sessionIds: [] },
          c: { covered: false, sessionIds: [] },
        },
      }),
    );
    expect(html).toContain('Coverage · 1 / 3 scenes');
    expect(html).toContain('uncovered');
  });

  it('renders session list with file path + type badge', () => {
    const html = toHtml(
      FootageTab({
        plan: fakePlan(),
        scenes,
        sessions: [fakeSession()],
        coverage: { a: { covered: true, sessionIds: ['rec_1'] }, b: { covered: false, sessionIds: [] }, c: { covered: false, sessionIds: [] } },
      }),
    );
    expect(html).toContain('Build session');
    expect(html).toContain('recordings/build-2026-05-18.mp4');
    expect(html).toContain('Logged sessions · 1');
  });

  it('shows scene-by-scene coverage rows in the summary', () => {
    const html = toHtml(
      FootageTab({
        plan: fakePlan(),
        scenes,
        sessions: [],
        coverage: {
          a: { covered: true, sessionIds: ['s1', 's2'] },
          b: { covered: false, sessionIds: [] },
          c: { covered: false, sessionIds: [] },
        },
      }),
    );
    expect(html).toContain('Cold open');
    expect(html).toContain('Demo');
    expect(html).toContain('Outro');
    expect(html).toContain('✓ 2 session(s)');
  });

  it('delete button is wired with hx-delete + hx-confirm', () => {
    const html = toHtml(
      FootageTab({
        plan: fakePlan(),
        scenes,
        sessions: [fakeSession({ id: 'rec_xyz' })],
        coverage: {},
      }),
    );
    expect(html).toContain('hx-delete="/recording-sessions/rec_xyz"');
    expect(html).toContain('hx-confirm');
  });

  it('back link points to plan', () => {
    const html = toHtml(
      FootageTab({
        plan: fakePlan({ id: 'plan_xyz' }),
        scenes: [],
        sessions: [],
        coverage: {},
      }),
    );
    expect(html).toContain('href="/plans/plan_xyz"');
    expect(html).toContain('Back to plan');
  });
});
