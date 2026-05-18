import type { Firestore } from 'firebase-admin/firestore';
import { logger } from '../logger.js';
import { getPlan } from '../db/plans.js';
import { getDeliverable, patchDeliverable } from '../db/deliverables.js';
import { getSelectedHookDraft } from '../db/hook-drafts.js';
import { getSelectedTitleConcept } from '../db/title-concepts.js';
import { getSelectedThumbnailConcept } from '../db/thumbnail-concepts.js';
import { getNeurocoreClient } from '../neurocore/client.js';
import { NeurocoreError } from '../neurocore/errors.js';
import { PlanningEngineError } from './errors.js';
import type { NeurocoreClient } from '../neurocore/client.js';

/**
 * Mark a Deliverable as published and emit the script.published signal to
 * Neurocore. Signal emission is best-effort — if Neurocore is unreachable,
 * the local status transition still succeeds and the failure is logged.
 *
 * Pre-conditions:
 * - Deliverable exists and current status allows transition to 'published'
 *   (any status except already 'published' — Rick can correct a URL by
 *   re-submitting; idempotency key on the signal collapses duplicates).
 * - youtubeUrl matches the URL allowlist regex.
 */

const STEP_NAME = 'publish-deliverable';

/**
 * Per tech-spec §6 security: YouTube URL allowlist. Restrict the protocol,
 * host, and path charset so we don't accidentally publish a URL that
 * Neurocore later treats as a fetch target.
 */
export const YOUTUBE_URL_REGEX = /^https:\/\/(www\.)?(youtube\.com|youtu\.be)\/[\w?=&/-]+$/;

export class InvalidYouTubeUrlError extends Error {
  constructor(url: string) {
    super(`URL does not match YouTube allowlist: ${url}`);
    this.name = 'InvalidYouTubeUrlError';
  }
}

export interface PublishDeliverableResult {
  deliverableId: string;
  signalSent: boolean;
  signalError?: string;
}

export async function publishDeliverable(
  deliverableId: string,
  youtubeUrl: string,
  opts: { db?: Firestore; client?: NeurocoreClient } = {},
): Promise<PublishDeliverableResult> {
  if (!YOUTUBE_URL_REGEX.test(youtubeUrl)) {
    throw new InvalidYouTubeUrlError(youtubeUrl);
  }

  const deliverable = await getDeliverable(deliverableId, opts.db);
  if (!deliverable) {
    throw new PlanningEngineError(
      STEP_NAME,
      'PLAN_NOT_FOUND',
      `no deliverable ${deliverableId}`,
      { detail: { deliverableId } },
    );
  }

  const plan = await getPlan(deliverable.planId, opts.db);
  if (!plan) {
    throw new PlanningEngineError(
      STEP_NAME,
      'PLAN_NOT_FOUND',
      `parent plan ${deliverable.planId} missing`,
      { planId: deliverable.planId },
    );
  }

  const publishedAt = new Date();
  await patchDeliverable(
    deliverableId,
    {
      status: 'published',
      youtubeUrl,
      publishedAt,
    },
    opts.db,
  );

  // Lookup the archetype/composition fields for signal enrichment. All are
  // optional — Shorts may not have a long-form hook; some flows may publish
  // without a selected title (manual override).
  let selectedHookArchetype: string | undefined;
  let selectedTitleArchetype: string | undefined;
  let selectedThumbnailComposition: string | undefined;

  if (deliverable.kind === 'long_form' && plan.selectedHookVariantId) {
    try {
      const hook = await getSelectedHookDraft(plan.id, opts.db);
      if (hook) selectedHookArchetype = hook.archetype;
    } catch (err) {
      logger.warn(
        { deliverableId, err: (err as Error).message },
        'publish-deliverable: hook lookup failed (continuing)',
      );
    }
  }
  try {
    const title = await getSelectedTitleConcept(deliverableId, opts.db);
    if (title) selectedTitleArchetype = title.archetype;
  } catch (err) {
    logger.warn(
      { deliverableId, err: (err as Error).message },
      'publish-deliverable: title lookup failed (continuing)',
    );
  }
  try {
    const thumb = await getSelectedThumbnailConcept(deliverableId, opts.db);
    if (thumb) selectedThumbnailComposition = thumb.composition;
  } catch (err) {
    logger.warn(
      { deliverableId, err: (err as Error).message },
      'publish-deliverable: thumbnail lookup failed (continuing)',
    );
  }

  // Best-effort signal: fire-and-forget, never blocks the publish state.
  const client = opts.client ?? getNeurocoreClient();
  let signalSent = false;
  let signalError: string | undefined;
  try {
    await client.sendPublishedScript({
      planId: plan.id,
      deliverableId,
      kind: deliverable.kind === 'short_clip' ? 'short_clip' : 'long_form',
      audienceProfileId: deliverable.audienceProfileId,
      youtubeUrl,
      title: deliverable.title,
      ...(selectedHookArchetype !== undefined ? { selectedHookArchetype } : {}),
      ...(selectedTitleArchetype !== undefined ? { selectedTitleArchetype } : {}),
      ...(selectedThumbnailComposition !== undefined
        ? { selectedThumbnailComposition }
        : {}),
      publishedAt: publishedAt.toISOString(),
    });
    signalSent = true;
  } catch (err) {
    signalError =
      err instanceof NeurocoreError
        ? `${err.code}: ${err.message}`
        : (err as Error).message;
    logger.warn(
      { deliverableId, planId: plan.id, signalError },
      'publish-deliverable: script.published signal failed (non-fatal — local publish succeeded)',
    );
  }

  logger.info(
    {
      step: STEP_NAME,
      deliverableId,
      planId: plan.id,
      kind: deliverable.kind,
      signalSent,
    },
    'deliverable published',
  );

  return { deliverableId, signalSent, ...(signalError ? { signalError } : {}) };
}
