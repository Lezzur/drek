/**
 * Type definitions for DREK's Neurocore client. These mirror the shapes
 * Neurocore returns from its v1 endpoints — kept narrow because DREK only
 * consumes a subset of what Neurocore exposes.
 */

/**
 * Plan type used when DREK calls Neurocore for project context + voice
 * profile. Both `youtube_lite` and `youtube_advanced` map to Neurocore's
 * `videoPlanYoutube` / `scriptYoutube` task types — Neurocore doesn't yet
 * differentiate the two formats on its side. If v2.1 introduces format-
 * specific Neurocore task types, this mapping evolves in client.ts.
 */
export type PlanMode = 'cover_letter' | 'youtube_lite' | 'youtube_advanced';

/** Response shape from POST /v1/memory/context. The systemBlock is XML-ish
 *  text we feed directly into LLM prompts; metadata is for logging/diagnostics. */
export interface MemoryContextResponse {
  systemBlock: string;
  metadata: {
    layersIncluded: string[];
    memoryRecordIds: string[];
    estimatedTokens: number;
    degraded: boolean;
    budget: {
      requested: number;
      clampedTo: number;
      effective: number;
    };
  };
}

/** Single listing returned by GET /v1/signals/pending-video. All fields except
 *  memoryId can be null because PI sometimes can't extract them at ingest time
 *  (see Gap 5 schema relaxation). */
export interface PendingListing {
  memoryId: string;
  listingId: string | null;
  listingTitle: string | null;
  listingText: string | null;
  company: string | null;
  role: string | null;
  videoRequirements: string | null;
  keySkills: string[];
  url: string | null;
  ingestedAt: string | null;
}

/** Response shape from GET /v1/signals/pending-video. */
export interface PendingListingsResponse {
  listings: PendingListing[];
}

/** Approved-script signal payload DREK sends to POST /v1/memory/signals. */
export interface ApprovedScriptSignal {
  planId: string;
  planMode: PlanMode;
  scenes: Array<{
    script: string;
    scriptDraft: string;
    wasEdited: boolean;
  }>;
}

/** Published-script signal payload — fired when Rick marks a Deliverable as
 *  published with a YouTube URL. Includes the archetype/composition choices
 *  so Neurocore can correlate hook/title/thumbnail choices with eventual
 *  performance data. */
export interface PublishedScriptSignal {
  planId: string;
  deliverableId: string;
  kind: 'long_form' | 'short_clip';
  audienceProfileId: string;
  youtubeUrl: string;
  title: string;
  selectedHookArchetype?: string;
  selectedTitleArchetype?: string;
  selectedThumbnailComposition?: string;
  publishedAt: string;
}

/** ContentCatalog create payload — POST /v1/content-catalog. Server fills
 *  id + createdAt + updatedAt. The endpoint is upsert-by-deliverableId,
 *  so a re-publish for the same Deliverable updates in place rather
 *  than duplicating. */
export interface ContentCatalogCreatePayload {
  deliverableId: string;
  planId: string;
  kind: 'long_form' | 'short_clip' | 'lead_magnet';
  title: string;
  youtubeUrl: string;
  youtubeVideoId: string;
  audienceProfileId: string;
  primaryTechStackId: string;
  supportingTechStackIds: string[];
  topicTags: string[];
  publishedAt: string;
  sourceApp: 'drek';
}

/** ContentCatalog response shape — { profile, created }. We narrow the
 *  profile to the bare fields the queue needs for logging; the full
 *  shape lives on the Neurocore side. */
export interface ContentCatalogResponse {
  profile: {
    id: string;
    deliverableId: string;
    publishedAt: string;
  };
  created: boolean;
}
