/**
 * Format profile registry — TypeScript constants encoding the structural
 * rules for each YouTube format DREK v2 supports. The contract per
 * TECH-SPEC-drek-v2-youtube-2026-05-18.md §4.2 Component G + §8:
 *
 *   - Format profiles define STRUCTURE (beats, scene counts, runtime
 *     ranges, shot conventions, anti-patterns)
 *   - AudienceProfiles (separate, Neurocore-side) define VOICE (tone,
 *     pacing wpm, hook patterns, CTA style)
 *
 * Composition order in prompts is load-bearing: format first, audience
 * second. See compose-prompt.ts (Phase 3) for the assembly.
 */

export interface FormatProfileBeat {
  /** Named beat per the channel master doc — e.g. `cold_open`, `war_room`,
   *  `outro`. Scenes carry this tag in their `beatTag` field so downstream
   *  generators (publishing metadata, Shorts extractor) can route per beat. */
  name: string;
  /** Suggested duration in seconds. Cumulative beat targets should land
   *  inside the profile's runtimeRange. */
  targetDurationSeconds: number;
  /** Plain-English description fed verbatim into the LLM prompt. */
  description: string;
  /** Expected primary shot type(s) for this beat — e.g. ["screenshare",
   *  "diagram_overlay"]. Free-form strings; the shot-list engine step in
   *  Phase 7 reuses these as hints, not a hard enum. */
  shotConventions: string[];
}

export interface FormatProfile {
  /** Snake_case id used in the registry and on plan documents. */
  id: string;
  displayName: string;
  description: string;
  /** [min, max] scene count the LLM should produce. */
  sceneRange: [number, number];
  /** [min, max] runtime in seconds. */
  runtimeRange: [number, number];
  /** Ordered beat templates. The LLM is told to produce scenes that follow
   *  this skeleton; beat names must be drawn from this array. */
  beats: FormatProfileBeat[];
  /** Multi-line prompt block describing what makes a good hook for this
   *  format. Injected verbatim into Call 5 (generate-hook-variants). */
  hookGuidelines: string;
  /** Format-level pacing defaults. AudienceProfile.pacingRules can override
   *  these per-deliverable when both are composed in a prompt. */
  pacingRules: {
    wordsPerMinute: number;
    sentenceLengthGuide: string;
  };
  /** "DO NOT" injections — appended to system prompts so the LLM has explicit
   *  anti-patterns to avoid. */
  antiPatterns: string[];
  /** Free-form CTA policy for the outro beat. Composed with AudienceProfile
   *  ctaStyle to produce the final CTA. */
  ctaPolicy: string;
}

export class FormatProfileNotFoundError extends Error {
  public readonly formatProfileId: string;
  constructor(id: string) {
    super(`FormatProfile not found: ${id}`);
    this.name = 'FormatProfileNotFoundError';
    this.formatProfileId = id;
  }
}
