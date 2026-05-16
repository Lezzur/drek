/**
 * Type definitions for DREK's Neurocore client. These mirror the shapes
 * Neurocore returns from its v1 endpoints — kept narrow because DREK only
 * consumes a subset of what Neurocore exposes.
 */

export type PlanMode = 'cover_letter' | 'youtube';

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
    wasEdited: boolean;
  }>;
}
