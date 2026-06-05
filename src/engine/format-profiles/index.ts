import type { FormatProfile } from './types.js';
import { FormatProfileNotFoundError } from './types.js';
import { claude_code_build_along } from './claude-code-build-along.js';
import { tutorial } from './tutorial.js';

// Phase 3 originally planned 6 additional profiles (tutorial, case_study,
// comparison, essay_opinion, listicle, reaction_review). `tutorial` is now
// authored at depth; the remaining 5 still need their own files.

/**
 * Registry of all available format profiles, keyed by id. Marked Readonly so
 * callers can't accidentally mutate the registry at runtime — adding a
 * profile means adding a TypeScript file and updating this import block.
 */
export const FORMAT_PROFILES: Readonly<Record<string, FormatProfile>> = Object.freeze({
  [claude_code_build_along.id]: claude_code_build_along,
  [tutorial.id]: tutorial,
});

/** Default format profile id for new `youtube_advanced` plans. */
export const DEFAULT_FORMAT_PROFILE_ID = claude_code_build_along.id;

export function getFormatProfile(id: string): FormatProfile {
  const profile = FORMAT_PROFILES[id];
  if (!profile) throw new FormatProfileNotFoundError(id);
  return profile;
}

export function listFormatProfiles(): FormatProfile[] {
  return Object.values(FORMAT_PROFILES);
}

export { FormatProfileNotFoundError };
export type { FormatProfile, FormatProfileBeat } from './types.js';
