import type { Firestore } from 'firebase-admin/firestore';
import { logger } from '../logger.js';
import { getPlan } from '../db/plans.js';
import { getDeliverable, patchDeliverable } from '../db/deliverables.js';
import { getSelectedHookDraft } from '../db/hook-drafts.js';
import { getSelectedTitleConcept } from '../db/title-concepts.js';
import { getSelectedThumbnailConcept } from '../db/thumbnail-concepts.js';
import { getPipelineBriefByPromotedPlanId } from '../db/pipeline-briefs.js';
import { getPublishMetadata } from '../db/publish-metadata.js';
import { getNeurocoreClient } from '../neurocore/client.js';
import { NeurocoreError } from '../neurocore/errors.js';
import { enqueueContentCatalog } from '../neurocore/write-queue.js';
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

/** Strict extractor — pulls the 11-char video id from a canonical URL. The
 *  publish-time YOUTUBE_URL_REGEX above is intentionally more permissive
 *  (it just gates "is this YouTube-shaped enough to publish"); the
 *  ContentCatalog write needs the exact id, so we use this stricter form. */
const YOUTUBE_VIDEO_ID_REGEX =
  /https:\/\/(?:www\.)?(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/;

function extractYoutubeVideoId(url: string): string | null {
  const m = url.match(YOUTUBE_VIDEO_ID_REGEX);
  return m ? m[1]! : null;
}

export class InvalidYouTubeUrlError extends Error {
  constructor(url: string) {
    super(`URL does not match YouTube allowlist: ${url}`);
    this.name = 'InvalidYouTubeUrlError';
  }
}

export interface PublishDeliverableResult {
  deliverableId: string;
  signalSent: boolean;
  /** True if the ContentCatalog write was enqueued. False when there was
   *  no source brief, no pinnedTechStack on the brief, or the youtubeUrl
   *  failed strict id extraction. The queue handles actual delivery. */
  contentCatalogEnqueued: boolean;
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

  // ContentCatalog write — best-effort, durable. We enqueue rather than
  // POST directly: if Neurocore is down, the queue retries with backoff
  // and dead-letters after 5 attempts. Local publish never blocks on this.
  // Skipped when the brief lacks pinnedTechStack (pre-M29 briefs, or
  // plans created without going through Brief promotion).
  let contentCatalogEnqueued = false;
  try {
    const brief = await getPipelineBriefByPromotedPlanId(plan.id, opts.db);
    if (brief?.pinnedTechStack) {
      const videoId = extractYoutubeVideoId(youtubeUrl);
      if (!videoId) {
        // The publish-time YOUTUBE_URL_REGEX passed but the strict
        // extractor can't get an 11-char id — log and skip rather than
        // enqueue a payload Neurocore would reject.
        logger.warn(
          { deliverableId, youtubeUrl },
          'publish-deliverable: youtubeUrl passed publish regex but no 11-char id extractable — skipping ContentCatalog write',
        );
      } else {
        const metadata = await getPublishMetadata(deliverableId, opts.db).catch(() => null);
        const topicTags = metadata?.tags?.slice(0, 10) ?? [];
        await enqueueContentCatalog({
          deliverableId,
          planId: plan.id,
          kind: deliverable.kind,
          title: deliverable.title,
          youtubeUrl,
          youtubeVideoId: videoId,
          audienceProfileId: deliverable.audienceProfileId,
          primaryTechStackId: brief.pinnedTechStack.primary,
          supportingTechStackIds: brief.pinnedTechStack.supporting,
          topicTags,
          publishedAt: publishedAt.toISOString(),
          sourceApp: 'drek',
        });
        contentCatalogEnqueued = true;
      }
    } else {
      logger.debug(
        { deliverableId, planId: plan.id, hasBrief: brief !== null },
        'publish-deliverable: no pinnedTechStack on source brief — skipping ContentCatalog write',
      );
    }
  } catch (err) {
    // Queue enqueue should never throw under normal conditions (it only
    // hits disk if WORKSPACE_ROOT is set). If it does, don't block publish.
    logger.warn(
      { deliverableId, err: (err as Error).message },
      'publish-deliverable: ContentCatalog enqueue failed (non-fatal — local publish succeeded)',
    );
  }

  logger.info(
    {
      step: STEP_NAME,
      deliverableId,
      planId: plan.id,
      kind: deliverable.kind,
      signalSent,
      contentCatalogEnqueued,
    },
    'deliverable published',
  );

  return {
    deliverableId,
    signalSent,
    contentCatalogEnqueued,
    ...(signalError ? { signalError } : {}),
  };
}
