import { describe, it, expect } from 'vitest';
import {
  planSchema,
  planCreateSchema,
  sceneSchema,
  availableListingSchema,
  pollingConfigSchema,
  requirementSchema,
  matchedProjectSchema,
  isAllowedPlanTransition,
  PLAN_STATUSES,
  DEFAULT_POLLING_CONFIG,
} from '../../src/db/schemas.js';

describe('requirementSchema', () => {
  it('accepts a valid requirement', () => {
    expect(
      requirementSchema.safeParse({
        skill: 'lead pipeline automation',
        category: 'integration',
        priority: 'must_show',
        evidence: 'job desc mentions lead routing',
      }).success,
    ).toBe(true);
  });

  it('rejects an unknown priority', () => {
    expect(
      requirementSchema.safeParse({
        skill: 'x', category: 'y', priority: 'maybe', evidence: 'z',
      }).success,
    ).toBe(false);
  });
});

describe('matchedProjectSchema', () => {
  it('clamps relevanceScore to [0, 1]', () => {
    const ok = matchedProjectSchema.safeParse({
      projectSlug: 'neurocore',
      projectName: 'Neurocore',
      matchedFeatures: ['memory injection'],
      relevanceScore: 0.85,
      suggestedDemoSequence: 'show context endpoint',
    });
    expect(ok.success).toBe(true);
    const out = matchedProjectSchema.safeParse({
      projectSlug: 'x', projectName: 'x', matchedFeatures: [],
      relevanceScore: 1.5, suggestedDemoSequence: 'x',
    });
    expect(out.success).toBe(false);
  });
});

describe('planSchema', () => {
  const valid = {
    id: 'plan_abc',
    type: 'cover_letter' as const,
    status: 'awaiting_review' as const,
    title: 'Backend Eng at Acme',
    sourceListingId: 'lst_1',
    sourceListingText: 'we need video',
    requirements: [],
    matchedProjects: [],
    targetRuntimeSeconds: 120,
    estimatedRuntimeSeconds: 0,
    userConstraints: null,
    createdAt: new Date('2026-05-15T00:00:00Z'),
    updatedAt: new Date('2026-05-15T00:00:00Z'),
    exportedAt: null,
  };

  it('round-trips a fully-formed plan', () => {
    expect(planSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects targetRuntimeSeconds below 30 (too short)', () => {
    expect(
      planSchema.safeParse({ ...valid, targetRuntimeSeconds: 5 }).success,
    ).toBe(false);
  });

  it('rejects targetRuntimeSeconds above 3600 (too long)', () => {
    expect(
      planSchema.safeParse({ ...valid, targetRuntimeSeconds: 99_999 }).success,
    ).toBe(false);
  });

  it('rejects an unknown status', () => {
    expect(
      planSchema.safeParse({ ...valid, status: 'half_baked' as never }).success,
    ).toBe(false);
  });

  it('allows null sourceListingId/sourceListingText (manual YouTube)', () => {
    expect(
      planSchema.safeParse({
        ...valid,
        sourceListingId: null,
        sourceListingText: null,
      }).success,
    ).toBe(true);
  });
});

describe('planCreateSchema', () => {
  it('requires type, title, and targetRuntimeSeconds', () => {
    expect(planCreateSchema.safeParse({}).success).toBe(false);
    expect(
      planCreateSchema.safeParse({
        type: 'youtube',
        title: 'How I built x',
        targetRuntimeSeconds: 600,
      }).success,
    ).toBe(true);
  });
});

describe('isAllowedPlanTransition', () => {
  it('allows the happy path forward through the lifecycle', () => {
    const path: typeof PLAN_STATUSES[number][] = [
      'awaiting_review',
      'requirements_reviewed',
      'projects_matched',
      'scenes_generated',
      'finalized',
      'exported',
    ];
    for (let i = 0; i < path.length - 1; i++) {
      expect(isAllowedPlanTransition(path[i]!, path[i + 1]!)).toBe(true);
    }
  });

  it('allows dismissing from early states', () => {
    expect(isAllowedPlanTransition('awaiting_review', 'dismissed')).toBe(true);
    expect(isAllowedPlanTransition('requirements_reviewed', 'dismissed')).toBe(true);
  });

  it('allows un-dismissing back to awaiting_review', () => {
    expect(isAllowedPlanTransition('dismissed', 'awaiting_review')).toBe(true);
  });

  it('allows backward edits within the editing lane', () => {
    expect(isAllowedPlanTransition('scenes_generated', 'projects_matched')).toBe(true);
    expect(isAllowedPlanTransition('projects_matched', 'requirements_reviewed')).toBe(true);
    expect(isAllowedPlanTransition('exported', 'finalized')).toBe(true);
  });

  it('blocks skip-ahead transitions', () => {
    expect(isAllowedPlanTransition('awaiting_review', 'scenes_generated')).toBe(false);
    expect(isAllowedPlanTransition('projects_matched', 'exported')).toBe(false);
  });

  it('blocks transitions from terminal-ish dismissed → editing states', () => {
    expect(isAllowedPlanTransition('dismissed', 'finalized')).toBe(false);
  });

  it('is reflexive (same → same always allowed)', () => {
    for (const s of PLAN_STATUSES) {
      expect(isAllowedPlanTransition(s, s)).toBe(true);
    }
  });
});

describe('sceneSchema', () => {
  it('accepts a minimal scene', () => {
    const ok = sceneSchema.safeParse({
      id: 'scene_1',
      planId: 'plan_1',
      order: 1,
      title: 'Intro',
      description: 'Brief Rick on camera',
      framingNotes: 'headshot',
      script: 'Hi I am Rick.',
      emphasisCues: [],
      pacingNotes: '',
      transitionNote: '',
      estimatedDurationSeconds: 12,
      projectRef: null,
      storyboardImageUrl: null,
    });
    expect(ok.success).toBe(true);
  });

  it('rejects an order < 1', () => {
    expect(
      sceneSchema.safeParse({
        id: 'scene_1', planId: 'plan_1', order: 0, title: 'x',
        description: '', framingNotes: '', script: '',
        emphasisCues: [], pacingNotes: '', transitionNote: '',
        estimatedDurationSeconds: 0, projectRef: null, storyboardImageUrl: null,
      }).success,
    ).toBe(false);
  });

  it('rejects an empty title', () => {
    expect(
      sceneSchema.safeParse({
        id: 'scene_1', planId: 'plan_1', order: 1, title: '',
        description: '', framingNotes: '', script: '',
        emphasisCues: [], pacingNotes: '', transitionNote: '',
        estimatedDurationSeconds: 0, projectRef: null, storyboardImageUrl: null,
      }).success,
    ).toBe(false);
  });
});

describe('availableListingSchema', () => {
  it('round-trips a listing with nullable fields', () => {
    expect(
      availableListingSchema.safeParse({
        id: 'lst_1',
        title: 'Backend Eng',
        company: null,
        summary: null,
        rawText: null,
        receivedAt: new Date(),
        selectedAt: null,
        planId: null,
      }).success,
    ).toBe(true);
  });
});

describe('pollingConfigSchema', () => {
  it('applies defaults when fields are missing', () => {
    const out = pollingConfigSchema.safeParse({});
    expect(out.success).toBe(true);
    if (out.success) {
      expect(out.data.pollingEnabled).toBe(true);
      expect(out.data.pollingIntervalMs).toBe(30 * 60 * 1000);
      expect(out.data.lastPollAt).toBeNull();
    }
  });

  it('rejects pollingIntervalMs under the 1-minute floor', () => {
    expect(
      pollingConfigSchema.safeParse({ pollingIntervalMs: 1000 }).success,
    ).toBe(false);
  });

  it('DEFAULT_POLLING_CONFIG itself validates', () => {
    expect(pollingConfigSchema.safeParse(DEFAULT_POLLING_CONFIG).success).toBe(true);
  });
});
