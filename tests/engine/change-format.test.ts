import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';

vi.mock('../../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() },
}));

import { createFakeFirestore, type FakeFirestore } from '../db/fake-firestore.js';
import { createPlan } from '../../src/db/plans.js';
import { createScene, listScenes } from '../../src/db/scenes.js';
import {
  createDeliverable,
  listDeliverablesForPlan,
} from '../../src/db/deliverables.js';
import { logRecordingSession, listSessionsForPlan } from '../../src/db/recording-sessions.js';
import { changePlanFormatProfile } from '../../src/engine/change-format.js';
import { PlanningEngineError } from '../../src/engine/errors.js';
import type { PlanStatus } from '../../src/db/schemas.js';

let fake: FakeFirestore;
const asDb = () => fake as unknown as Firestore;

beforeEach(() => {
  fake = createFakeFirestore();
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Seed a plan at the given status with scenes, hook drafts, deliverables, and a recording session. */
async function seedFullPlan(status: PlanStatus) {
  const plan = await createPlan(
    {
      type: 'youtube_advanced',
      title: 'Test Episode',
      targetRuntimeSeconds: 1800,
      formatProfileId: 'claude_code_build_along',
      pipelineBriefId: 'brief_123',
      status,
    },
    asDb(),
  );

  // Manually patch in matched projects and requirements so the plan has them.
  await fake.collection('plans').doc(plan.id).update({
    matchedProjects: [
      {
        projectSlug: 'my-project',
        projectName: 'My Project',
        matchedFeatures: ['feature-a'],
        relevanceScore: 0.9,
        suggestedDemoSequence: 'Open, demo, close.',
      },
    ],
    requirements: [
      {
        skill: 'episode_plan',
        category: 'episode_outline',
        priority: 'must_show',
        evidence: '{"episodeAngle":"test"}',
      },
    ],
    selectedHookVariantId: 'hook_001',
    selectedTitleVariantId: 'title_001',
    selectedThumbnailConceptId: 'thumb_001',
    estimatedRuntimeSeconds: 1800,
  });

  // Create scenes.
  const scene1 = await createScene(plan.id, { title: 'cold_open scene', beatTag: 'cold_open' }, asDb());
  const scene2 = await createScene(plan.id, { title: 'outro scene', beatTag: 'outro' }, asDb());

  // Create hook draft.
  await fake
    .collection('plans')
    .doc(plan.id)
    .collection('hook_drafts')
    .doc('hook_001')
    .set({
      archetype: 'demo_first',
      scriptText: 'Watch this build run live — no cuts.',
      predictedRetention: 'High retention',
      selected: true,
      createdAt: new Date(),
    });

  // Create long_form Deliverable.
  const longForm = await createDeliverable(
    {
      planId: plan.id,
      kind: 'long_form',
      audienceProfileId: 'developer_longform',
      title: plan.title,
      status: 'scripts_ready',
      selectedTitleVariantId: 'title_001',
      selectedThumbnailConceptId: 'thumb_001',
      publishMetadataId: 'meta_001',
    },
    asDb(),
  );

  // Seed title_concepts subcollection on the long_form deliverable.
  await fake
    .collection('deliverables')
    .doc(longForm.id)
    .collection('title_concepts')
    .doc('title_001')
    .set({ titleText: 'Cool title', archetype: 'specificity', predictedClickability: 8, reasoning: 'r', selected: true, createdAt: new Date() });

  // Seed thumbnail_concepts subcollection.
  await fake
    .collection('deliverables')
    .doc(longForm.id)
    .collection('thumbnail_concepts')
    .doc('thumb_001')
    .set({ composition: 'Split screen', textHook: 'AI Codes', colorPalette: ['#ff0000'], conceptSummary: 'summary', selected: true, createdAt: new Date() });

  // Seed publish_metadata subcollection.
  await fake
    .collection('deliverables')
    .doc(longForm.id)
    .collection('publish_metadata')
    .doc('current')
    .set({ description: 'desc', chapters: [], tags: ['ai'], generatedAt: new Date() });

  // Create a short_clip Deliverable.
  const shortClip = await createDeliverable(
    {
      planId: plan.id,
      kind: 'short_clip',
      audienceProfileId: 'business_owner_shorts',
      title: 'Short from cold_open',
      status: 'draft',
    },
    asDb(),
  );

  // Create a recording session (should survive the wipe).
  const session = await logRecordingSession(
    {
      planId: plan.id,
      dateRecorded: new Date(),
      sessionType: 'build_session',
      filePath: '/recordings/episode1.mp4',
      durationSeconds: 3600,
      scenesCovered: [scene1.id, scene2.id],
    },
    asDb(),
  );

  return { plan, scene1, scene2, longForm, shortClip, session };
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('changePlanFormatProfile — happy path wipe-and-revert', () => {
  it('wipes scenes, hook_drafts, long-form subcollections; deletes short_clips; reverts plan to projects_matched', async () => {
    const { plan, longForm, shortClip, session } = await seedFullPlan('titles_generated');

    await changePlanFormatProfile(plan.id, 'claude_code_build_along', asDb());

    // Scenes wiped.
    const scenes = await listScenes(plan.id, asDb());
    expect(scenes).toHaveLength(0);

    // Hook drafts wiped.
    const hooksSnap = await fake.collection('plans').doc(plan.id).collection('hook_drafts').get();
    expect(hooksSnap.docs).toHaveLength(0);

    // Long-form deliverable preserved but subcollections wiped and fields reset.
    const longFormSnap = await fake.collection('deliverables').doc(longForm.id).get();
    expect(longFormSnap.exists).toBe(true);
    const lfData = longFormSnap.data() as Record<string, unknown>;
    expect(lfData.selectedTitleVariantId).toBeNull();
    expect(lfData.selectedThumbnailConceptId).toBeNull();
    expect(lfData.publishMetadataId).toBeNull();
    expect(lfData.status).toBe('draft');

    const titlesSnap = await fake.collection('deliverables').doc(longForm.id).collection('title_concepts').get();
    expect(titlesSnap.docs).toHaveLength(0);

    const thumbsSnap = await fake.collection('deliverables').doc(longForm.id).collection('thumbnail_concepts').get();
    expect(thumbsSnap.docs).toHaveLength(0);

    const metaSnap = await fake.collection('deliverables').doc(longForm.id).collection('publish_metadata').get();
    expect(metaSnap.docs).toHaveLength(0);

    // Short-clip deliverable deleted.
    const shortClipSnap = await fake.collection('deliverables').doc(shortClip.id).get();
    expect(shortClipSnap.exists).toBe(false);

    // Plan fields reset.
    const planSnap = await fake.collection('plans').doc(plan.id).get();
    const planData = planSnap.data() as Record<string, unknown>;
    expect(planData.selectedHookVariantId).toBeNull();
    expect(planData.selectedTitleVariantId).toBeNull();
    expect(planData.selectedThumbnailConceptId).toBeNull();
    expect(planData.estimatedRuntimeSeconds).toBe(0);
    expect(planData.formatProfileId).toBe('claude_code_build_along');
    expect(planData.status).toBe('projects_matched');

    // Preserved: matchedProjects, requirements, pipelineBriefId.
    expect(Array.isArray(planData.matchedProjects) && (planData.matchedProjects as unknown[]).length).toBe(1);
    expect(planData.pipelineBriefId).toBe('brief_123');

    // Recording session PRESERVED.
    const sessions = await listSessionsForPlan(plan.id, asDb());
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe(session.id);
  });

  it('preserves the long_form Deliverable record (not deleted) + its audienceProfileId', async () => {
    const { plan, longForm } = await seedFullPlan('scenes_generated');

    await changePlanFormatProfile(plan.id, 'claude_code_build_along', asDb());

    const snap = await fake.collection('deliverables').doc(longForm.id).get();
    expect(snap.exists).toBe(true);
    const data = snap.data() as Record<string, unknown>;
    expect(data.audienceProfileId).toBe('developer_longform');
  });
});

// ---------------------------------------------------------------------------
// No-op short-circuit for plans without scenes yet
// ---------------------------------------------------------------------------

describe('changePlanFormatProfile — no-op for plans without scenes', () => {
  it('updates only formatProfileId for a projects_matched plan (no wipe)', async () => {
    const plan = await createPlan(
      {
        type: 'youtube_advanced',
        title: 'No scenes yet',
        targetRuntimeSeconds: 1800,
        formatProfileId: 'claude_code_build_along',
        pipelineBriefId: 'brief_abc',
        status: 'projects_matched',
      },
      asDb(),
    );

    // There are no scenes — ensure the call doesn't crash and just updates formatProfileId.
    await changePlanFormatProfile(plan.id, 'claude_code_build_along', asDb());

    const planSnap = await fake.collection('plans').doc(plan.id).get();
    const planData = planSnap.data() as Record<string, unknown>;
    expect(planData.formatProfileId).toBe('claude_code_build_along');
    // Status unchanged.
    expect(planData.status).toBe('projects_matched');
  });

  it('updates only formatProfileId for awaiting_review plan', async () => {
    const plan = await createPlan(
      {
        type: 'youtube_advanced',
        title: 'Fresh plan',
        targetRuntimeSeconds: 1800,
        formatProfileId: 'claude_code_build_along',
        status: 'awaiting_review',
      },
      asDb(),
    );

    await changePlanFormatProfile(plan.id, 'claude_code_build_along', asDb());

    const planData = (await fake.collection('plans').doc(plan.id).get()).data() as Record<string, unknown>;
    expect(planData.status).toBe('awaiting_review');
  });
});

// ---------------------------------------------------------------------------
// Pre-condition rejections
// ---------------------------------------------------------------------------

describe('changePlanFormatProfile — pre-condition rejections', () => {
  it('throws PLAN_NOT_FOUND for unknown planId', async () => {
    await expect(
      changePlanFormatProfile('plan_missing', 'claude_code_build_along', asDb()),
    ).rejects.toMatchObject({ code: 'PLAN_NOT_FOUND' });
  });

  it('throws WRONG_PLAN_TYPE when plan is not youtube_advanced', async () => {
    const plan = await createPlan(
      {
        type: 'cover_letter',
        title: 'Cover letter',
        targetRuntimeSeconds: 120,
        sourceListingText: 'listing text',
        status: 'projects_matched',
      },
      asDb(),
    );
    await expect(
      changePlanFormatProfile(plan.id, 'claude_code_build_along', asDb()),
    ).rejects.toMatchObject({ code: 'WRONG_PLAN_TYPE' });
  });

  it('throws CANNOT_CHANGE_AFTER_PUBLISH when status is exported', async () => {
    const plan = await createPlan(
      {
        type: 'youtube_advanced',
        title: 'Exported',
        targetRuntimeSeconds: 1800,
        formatProfileId: 'claude_code_build_along',
        status: 'exported',
      },
      asDb(),
    );
    await expect(
      changePlanFormatProfile(plan.id, 'claude_code_build_along', asDb()),
    ).rejects.toMatchObject({ code: 'CANNOT_CHANGE_AFTER_PUBLISH' });
  });

  it('throws UNKNOWN_FORMAT_PROFILE for an unrecognized formatProfileId', async () => {
    const plan = await createPlan(
      {
        type: 'youtube_advanced',
        title: 'X',
        targetRuntimeSeconds: 1800,
        formatProfileId: 'claude_code_build_along',
        status: 'scenes_generated',
      },
      asDb(),
    );
    await expect(
      changePlanFormatProfile(plan.id, 'nonexistent_format', asDb()),
    ).rejects.toMatchObject({ code: 'UNKNOWN_FORMAT_PROFILE' });
  });
});

// ---------------------------------------------------------------------------
// Recording sessions explicitly preserved
// ---------------------------------------------------------------------------

describe('changePlanFormatProfile — recording sessions preserved', () => {
  it('recording sessions survive the wipe at all levels', async () => {
    const { plan, session } = await seedFullPlan('hook_selected');

    await changePlanFormatProfile(plan.id, 'claude_code_build_along', asDb());

    // Verify session is untouched.
    const sessions = await listSessionsForPlan(plan.id, asDb());
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.filePath).toBe('/recordings/episode1.mp4');
    expect(sessions[0]?.id).toBe(session.id);
  });
});
