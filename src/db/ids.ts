import { randomUUID } from 'node:crypto';

/** Prefix-tagged id so the namespace is obvious in logs and Firestore.
 *  Example: makeId('plan') → 'plan_8b8e3c50a4e9...'. */
export type IdPrefix =
  | 'plan'
  | 'scene'
  | 'listing'
  // v2 entity prefixes
  | 'del'        // Deliverable
  | 'brief'      // PipelineBrief
  | 'hook'       // HookDraft
  | 'title'      // TitleConcept
  | 'thumb'      // ThumbnailConcept
  | 'pubmeta'    // PublishMetadata (only one per Deliverable, but prefixed for consistency)
  | 'rec'        // RecordingSession
  | 'finding';   // M36: CritiqueFinding (production-realism critic output)

export function makeId(prefix: IdPrefix): string {
  return `${prefix}_${randomUUID().replace(/-/g, '')}`;
}
