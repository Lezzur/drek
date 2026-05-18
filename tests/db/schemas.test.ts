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
  PLAN_TYPES,
  DEFAULT_POLLING_CONFIG,
  // v2 entities
  deliverableSchema,
  deliverableCreateSchema,
  pipelineBriefSchema,
  pipelineBriefCreateSchema,
  briefScoreSchema,
  isAllowedBriefStageTransition,
  hookDraftSchema,
  titleConceptSchema,
  thumbnailConceptSchema,
  publishMetadataSchema,
  recordingSessionSchema,
  DELIVERABLE_KINDS,
  BRIEF_STAGES,
  HOOK_ARCHETYPES,
  TITLE_ARCHETYPES,
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
        type: 'youtube_lite',
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

// =========================================================================
// v2 — additive Plan/Scene fields + 7 new entities
// =========================================================================

describe('planSchema v2 regression', () => {
  const v1Plan = {
    id: 'plan_1',
    type: 'cover_letter' as const,
    status: 'awaiting_review' as const,
    title: 'A',
    sourceListingId: null,
    sourceListingText: null,
    requirements: [],
    matchedProjects: [],
    targetRuntimeSeconds: 120,
    estimatedRuntimeSeconds: 0,
    userConstraints: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    exportedAt: null,
  };

  it('v1-shaped plan (no v2 fields) parses and defaults v2 fields to null', () => {
    const out = planSchema.safeParse(v1Plan);
    expect(out.success).toBe(true);
    if (out.success) {
      expect(out.data.formatProfileId).toBeNull();
      expect(out.data.pipelineBriefId).toBeNull();
      expect(out.data.workspacePath).toBeNull();
      expect(out.data.selectedHookVariantId).toBeNull();
      expect(out.data.selectedTitleVariantId).toBeNull();
      expect(out.data.selectedThumbnailConceptId).toBeNull();
    }
  });

  it('PLAN_TYPES contains the v2 enum values in order', () => {
    expect(PLAN_TYPES).toEqual(['cover_letter', 'youtube_lite', 'youtube_advanced']);
  });

  it('all 9 v2 status values are accepted', () => {
    const v2Statuses = [
      'hooks_generated',
      'hook_selected',
      'shot_list_generated',
      'titles_generated',
      'title_selected',
      'thumbnails_generated',
      'thumbnail_selected',
      'shorts_extracted',
      'metadata_generated',
    ] as const;
    for (const s of v2Statuses) {
      expect(PLAN_STATUSES).toContain(s);
      const out = planSchema.safeParse({ ...v1Plan, status: s });
      expect(out.success).toBe(true);
    }
  });

  it('v2 transitions are allowed', () => {
    const pairs: Array<[(typeof PLAN_STATUSES)[number], (typeof PLAN_STATUSES)[number]]> = [
      ['scenes_generated', 'hooks_generated'],
      ['hooks_generated', 'hook_selected'],
      ['hook_selected', 'shot_list_generated'],
      ['shot_list_generated', 'titles_generated'],
      ['titles_generated', 'title_selected'],
      ['title_selected', 'thumbnails_generated'],
      ['thumbnails_generated', 'thumbnail_selected'],
      ['thumbnail_selected', 'shorts_extracted'],
      ['shorts_extracted', 'finalized'],
      ['finalized', 'metadata_generated'],
      ['metadata_generated', 'exported'],
    ];
    for (const [from, to] of pairs) {
      expect(isAllowedPlanTransition(from, to)).toBe(true);
    }
  });

  it('rejects direct jump from requirements_reviewed to hooks_generated', () => {
    expect(isAllowedPlanTransition('requirements_reviewed', 'hooks_generated')).toBe(false);
  });

  it('rejects youtube_advanced jump from scenes_generated to metadata_generated directly', () => {
    expect(isAllowedPlanTransition('scenes_generated', 'metadata_generated')).toBe(false);
  });

  it('planCreateSchema accepts youtube_advanced with formatProfileId', () => {
    expect(
      planCreateSchema.safeParse({
        type: 'youtube_advanced',
        title: 'Episode',
        targetRuntimeSeconds: 1800,
        formatProfileId: 'claude_code_build_along',
      }).success,
    ).toBe(true);
  });
});

describe('sceneSchema v2 regression', () => {
  const v1Scene = {
    id: 'scene_1',
    planId: 'plan_1',
    order: 1,
    title: 'Intro',
    description: 'Rick intros.',
    framingNotes: 'Headshot.',
    script: 'Hi.',
    scriptDraft: '',
    emphasisCues: [],
    pacingNotes: '',
    transitionNote: '',
    estimatedDurationSeconds: 5,
    projectRef: null,
    storyboardImageUrl: null,
  };

  it('v1-shaped scene (no v2 fields) parses; v2 fields default to null/[]', () => {
    const out = sceneSchema.safeParse(v1Scene);
    expect(out.success).toBe(true);
    if (out.success) {
      expect(out.data.beatTag).toBeNull();
      expect(out.data.primaryShot).toBeNull();
      expect(out.data.brollItems).toEqual([]);
      expect(out.data.shotListItems).toEqual([]);
      expect(out.data.onScreenTextOverlays).toEqual([]);
      expect(out.data.cutPoints).toEqual([]);
    }
  });

  it('accepts v2 fields populated', () => {
    const out = sceneSchema.safeParse({
      ...v1Scene,
      beatTag: 'cold_open',
      primaryShot: { type: 'terminal' as const, description: 'claude cli' },
      brollItems: [
        {
          type: 'web-ui' as const,
          description: 'dashboard',
          source: 'pull_from_finished_demo' as const,
          durationSeconds: 5,
        },
      ],
      onScreenTextOverlays: [
        { textContent: 'Yes', timingHint: '0:01', styleHint: 'callout' as const },
      ],
      cutPoints: [{ scriptLineNumber: 3, reason: 'breath' }],
    });
    expect(out.success).toBe(true);
  });

  it('rejects on-screen text overlay over 80 chars', () => {
    expect(
      sceneSchema.safeParse({
        ...v1Scene,
        onScreenTextOverlays: [
          {
            textContent: 'x'.repeat(81),
            timingHint: 'now',
            styleHint: 'callout' as const,
          },
        ],
      }).success,
    ).toBe(false);
  });
});

describe('deliverableSchema', () => {
  const base = {
    id: 'del_1',
    planId: 'plan_1',
    kind: 'long_form' as const,
    audienceProfileId: 'developer_longform',
    title: 'Episode 1',
    status: 'draft' as const,
    scriptOverrideSceneIds: null,
    customScripts: null,
    selectedTitleVariantId: null,
    selectedThumbnailConceptId: null,
    publishMetadataId: null,
    youtubeUrl: null,
    publishedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  it('accepts a minimal long_form deliverable', () => {
    expect(deliverableSchema.safeParse(base).success).toBe(true);
  });

  it.each(DELIVERABLE_KINDS)('accepts kind=%s', (kind) => {
    expect(deliverableSchema.safeParse({ ...base, kind }).success).toBe(true);
  });

  it('rejects an invalid YouTube URL', () => {
    expect(
      deliverableSchema.safeParse({ ...base, youtubeUrl: 'not a url' }).success,
    ).toBe(false);
  });

  it('deliverableCreateSchema accepts a minimal create payload', () => {
    expect(
      deliverableCreateSchema.safeParse({
        planId: 'plan_1',
        kind: 'long_form',
        audienceProfileId: 'developer_longform',
        title: 'x',
      }).success,
    ).toBe(true);
  });
});

describe('pipelineBriefSchema + briefScoreSchema', () => {
  const base = {
    id: 'brief_1',
    title: 'Build an automation',
    company: 'Acme',
    sourceUrl: 'https://upwork.com/job/123',
    rawText: 'Long description...',
    score: null,
    scoringRationale: null,
    stage: 'candidate' as const,
    promotedPlanId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  it('accepts a minimal candidate brief', () => {
    expect(pipelineBriefSchema.safeParse(base).success).toBe(true);
  });

  it('rejects raw text exceeding 50,000 chars', () => {
    expect(
      pipelineBriefSchema.safeParse({ ...base, rawText: 'x'.repeat(50_001) }).success,
    ).toBe(false);
  });

  it.each(BRIEF_STAGES)('accepts stage=%s', (stage) => {
    expect(pipelineBriefSchema.safeParse({ ...base, stage }).success).toBe(true);
  });

  it('briefScoreSchema enforces 1-5 bounds on each dimension', () => {
    const ok = briefScoreSchema.safeParse({
      visualOutcome: 3,
      storyPotential: 4,
      scopeFit: 5,
      audienceMatch: 4,
      aggregate: 4,
    });
    expect(ok.success).toBe(true);

    const bad = briefScoreSchema.safeParse({
      visualOutcome: 0,
      storyPotential: 3,
      scopeFit: 3,
      audienceMatch: 3,
      aggregate: 3,
    });
    expect(bad.success).toBe(false);
  });

  it('pipelineBriefCreateSchema requires title + rawText', () => {
    expect(
      pipelineBriefCreateSchema.safeParse({
        title: 'x',
        rawText: 'y',
      }).success,
    ).toBe(true);
    expect(
      pipelineBriefCreateSchema.safeParse({ rawText: 'y' }).success,
    ).toBe(false);
  });

  it('stage transitions: candidate → vetted allowed; candidate → published rejected', () => {
    expect(isAllowedBriefStageTransition('candidate', 'vetted')).toBe(true);
    expect(isAllowedBriefStageTransition('candidate', 'published')).toBe(false);
    expect(isAllowedBriefStageTransition('candidate', 'retired')).toBe(true);
  });
});

describe('hookDraftSchema', () => {
  const base = {
    id: 'h_1',
    archetype: 'pattern_interrupt' as const,
    scriptText:
      'You shipped a build that almost crashed in the demo. Here is exactly how Claude Code saved it in fifteen seconds.',
    predictedRetention: 'Pattern interrupt hits hard',
    selected: false,
    createdAt: new Date(),
  };

  it('accepts a valid hook', () => {
    expect(hookDraftSchema.safeParse(base).success).toBe(true);
  });

  it.each(HOOK_ARCHETYPES)('accepts archetype=%s', (a) => {
    expect(hookDraftSchema.safeParse({ ...base, archetype: a }).success).toBe(true);
  });

  it('rejects script under 50 chars', () => {
    expect(
      hookDraftSchema.safeParse({ ...base, scriptText: 'too short' }).success,
    ).toBe(false);
  });
});

describe('titleConceptSchema', () => {
  const base = {
    id: 't_1',
    titleText: 'I built a $50k automation in 2 hours with Claude Code',
    archetype: 'specificity' as const,
    predictedClickability: 8,
    reasoning: 'Specific dollar figure + short time grabs business owners',
    keywordsSurfaced: ['Claude Code', 'automation'],
    selected: false,
    createdAt: new Date(),
  };

  it('accepts a valid concept', () => {
    expect(titleConceptSchema.safeParse(base).success).toBe(true);
  });

  it('rejects titleText over 70 chars', () => {
    expect(
      titleConceptSchema.safeParse({ ...base, titleText: 'x'.repeat(71) }).success,
    ).toBe(false);
  });

  it.each(TITLE_ARCHETYPES)('accepts archetype=%s', (a) => {
    expect(titleConceptSchema.safeParse({ ...base, archetype: a }).success).toBe(true);
  });

  it('rejects predictedClickability outside 1-10', () => {
    expect(
      titleConceptSchema.safeParse({ ...base, predictedClickability: 11 }).success,
    ).toBe(false);
  });
});

describe('thumbnailConceptSchema', () => {
  const base = {
    id: 'th_1',
    composition: 'split: terminal left, headshot right',
    textHook: 'SAVED IT',
    expression: 'relieved smile',
    colorPalette: ['#0a0a0a', '#22c55e'],
    assetsRequired: ['screenshot of failed test', 'headshot'],
    conceptSummary: 'demo-saved moment with green accent',
    selected: false,
    createdAt: new Date(),
  };

  it('accepts a valid concept', () => {
    expect(thumbnailConceptSchema.safeParse(base).success).toBe(true);
  });

  it('rejects textHook over 4 words', () => {
    expect(
      thumbnailConceptSchema.safeParse({
        ...base,
        textHook: 'this is way too many words',
      }).success,
    ).toBe(false);
  });

  it('rejects palette entry with invalid hex', () => {
    expect(
      thumbnailConceptSchema.safeParse({
        ...base,
        colorPalette: ['#zzzzzz'],
      }).success,
    ).toBe(false);
  });
});

describe('publishMetadataSchema', () => {
  const base = {
    description: 'A short description.',
    chapters: [{ timestampSeconds: 0, label: 'Intro' }],
    tags: ['claude code', 'automation'],
    pinnedComment: 'What would you build first?',
    endScreenSuggestion: 'Watch the related episode',
    generatedAt: new Date(),
    lastEditedAt: null,
  };

  it('accepts a minimal metadata document', () => {
    expect(publishMetadataSchema.safeParse(base).success).toBe(true);
  });

  it('rejects more than 20 tags', () => {
    expect(
      publishMetadataSchema.safeParse({
        ...base,
        tags: Array(21).fill('tag'),
      }).success,
    ).toBe(false);
  });
});

describe('recordingSessionSchema', () => {
  const base = {
    id: 'rec_1',
    planId: 'plan_1',
    dateRecorded: new Date(),
    sessionType: 'build_session' as const,
    filePath: 'recordings/build-2026-05-18.mp4',
    durationSeconds: 7200,
    scenesCovered: ['scene_1', 'scene_2'],
    notes: null,
    createdAt: new Date(),
  };

  it('accepts a minimal session', () => {
    expect(recordingSessionSchema.safeParse(base).success).toBe(true);
  });

  it('rejects empty scenesCovered', () => {
    expect(
      recordingSessionSchema.safeParse({ ...base, scenesCovered: [] }).success,
    ).toBe(false);
  });

  it('rejects durationSeconds over 24h', () => {
    expect(
      recordingSessionSchema.safeParse({ ...base, durationSeconds: 86_401 }).success,
    ).toBe(false);
  });
});
