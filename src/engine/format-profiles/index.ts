import type { FormatProfile } from './types.js';
import { FormatProfileNotFoundError } from './types.js';
import { claude_code_build_along } from './claude-code-build-along.js';

// Phase 3 will fill in the remaining 6 profiles (tutorial, case_study,
// comparison, essay_opinion, listicle, reaction_review). For Phase 1 only
// the default profile is registered so the pipeline + plan-creation flows
// have something concrete to bind to.

/**
 * Registry of all available format profiles, keyed by id. Marked Readonly so
 * callers can't accidentally mutate the registry at runtime — adding a
 * profile means adding a TypeScript file and updating this import block.
 */
export const FORMAT_PROFILES: Readonly<Record<string, FormatProfile>> = Object.freeze({
  [claude_code_build_along.id]: claude_code_build_along,
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
