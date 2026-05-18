import type { PlanType } from '../db/schemas.js';

/**
 * Composition rules for DREK's v1 planning modes — verbatim from PRD §8.
 *
 * v2 introduces a richer format-profile registry (`src/engine/format-profiles/`)
 * for `youtube_advanced` plans. These constants continue to drive the
 * `cover_letter` and `youtube_lite` paths unchanged.
 *
 * These define HOW each video is structured: tone, pacing, audience,
 * the literal structure template, the rules to follow, and the
 * anti-patterns to avoid. Rendered into the system prompts for both
 * scene generation (M6 Call 3) and script writing (M6 Call 4).
 *
 * Kept as TypeScript constants (not Firestore config) on purpose: these
 * are prompt engineering. Changing them is a code change that gets
 * reviewed and tested, not a runtime toggle Rick fiddles with from a UI.
 */

export interface CompositionRules {
  mode: PlanType;
  audience: string;
  tone: string;
  pacing: string;
  structureTemplate: string;
  rules: string[];
  antiPatterns: string[];
  defaultRuntimeSeconds: number;
  /** Inclusive scene count guidance for THIS mode at the DEFAULT runtime.
   *  The runtime-calc helpers scale this for plans with custom runtimes. */
  typicalSceneRange: [number, number];
  wordsPerMinute: number;
}

export const COVER_LETTER_RULES: CompositionRules = {
  mode: 'cover_letter',
  audience: 'Hiring managers and recruiters (evaluative). They watch to decide whether Rick can do the work the listing asks for. They are not impressed by polish — they are impressed by proof.',
  tone: 'Professional, direct, trust-building. No fluff, no salesmanship.',
  pacing: 'Brisk but not rushed. Every second earns its place. A hiring manager has many tabs open; the video should respect that.',
  structureTemplate: `1. Opening (5-10s): Brief, confident intro. State relevant experience. No fluff. No "Hi I'm excited" boilerplate.
2. Demonstrations (bulk of video): One scene per skill/requirement. Show the thing, explain what it does, move on. No tangential showcasing.
3. Closing (5-10s): Clear call to action — availability, next steps, contact.`,
  rules: [
    'Demonstrate exact skills requested. Nothing extra.',
    'No storytelling structure — this is not a YouTube video.',
    'No personality flourishes, humor, or casual asides.',
    'Each demo point is concise: show → explain → next.',
    'Total runtime must respect target. Cut scope before cutting quality.',
  ],
  antiPatterns: [
    'Generic introductions ("Hi, I\'m excited about this role...")',
    'Demonstrating skills not in the listing',
    'Spending time on project backstory',
    'Ending without a clear next step',
  ],
  defaultRuntimeSeconds: 120,
  typicalSceneRange: [3, 5],
  wordsPerMinute: 150,
};

export const YOUTUBE_RULES: CompositionRules = {
  mode: 'youtube_lite',
  audience: 'Primary: potential clients — business owners, founders, ops leads who want AI systems and automations built for their businesses. Secondary: practitioners and aspiring builders. DREK does not optimize for practitioners at the expense of clients, but content must remain technically credible enough to not repel them.',
  tone: 'Authoritative but approachable, client-facing. Rick\'s personality carries the delivery — warmth, authority, occasional humor.',
  pacing: 'Deliberate, with room for emphasis and pauses. Not rushed — clients need to follow the business reasoning, not just the demo.',
  structureTemplate: `1. Hook (15-30s): Frame the business problem. NOT the technology. Make the viewer feel the pain a business deals with today.
2. Problem / cost (60-90s): What this costs a business today. Manual process, time waste, error rate, opportunity cost. Quantify when possible.
3. Solution walkthrough (bulk): Show how the system works. Client/user perspective FIRST, then technical details. Include "proof moments" — real data, real interfaces, real results.
4. Results (60-90s): What changed. Numbers if available. Business impact, not implementation novelty.
5. Closing (15-30s): What this means for the viewer's business. Channel CTA.`,
  rules: [
    'Lead with business outcomes, not technology.',
    'Frame showcases as "here\'s what this does for a business" not "here\'s how I built this."',
    'Rick\'s spoken voice and personality carry the delivery — warmth, authority, occasional humor.',
    'Include real artifacts: dashboards, outputs, metrics.',
    'Technically credible enough that practitioners respect it.',
  ],
  antiPatterns: [
    'Opening with "Hey guys, today we\'re going to..."',
    'Leading with tech stack or architecture',
    'Talking about the build process before showing the result',
    'Generic advice without concrete examples from Rick\'s portfolio',
    'Ending without connecting back to the viewer\'s business needs',
  ],
  defaultRuntimeSeconds: 600,
  typicalSceneRange: [8, 12],
  wordsPerMinute: 150,
};

/**
 * Pick v1 composition rules for a given plan type. `youtube_advanced` is NOT
 * a v1 mode and throws — the v2 path uses the format-profile registry +
 * compose-prompt.ts, not these constants.
 */
export function getCompositionRules(mode: PlanType): CompositionRules {
  if (mode === 'cover_letter') return COVER_LETTER_RULES;
  if (mode === 'youtube_lite') return YOUTUBE_RULES;
  throw new Error(
    `getCompositionRules(): mode ${mode} is not a v1 mode — youtube_advanced uses the format-profile registry, not v1 composition rules`,
  );
}

/**
 * Render the composition rules into a single prompt block. Same block is
 * used by both Call 3 (scene gen) and Call 4 (script writing) so the LLM
 * sees identical guidance at every step of the pipeline.
 */
export function compositionRulesToPrompt(rules: CompositionRules): string {
  return [
    `MODE: ${rules.mode}`,
    `AUDIENCE: ${rules.audience}`,
    `TONE: ${rules.tone}`,
    `PACING: ${rules.pacing}`,
    '',
    'STRUCTURE:',
    rules.structureTemplate,
    '',
    'RULES:',
    ...rules.rules.map((r) => `- ${r}`),
    '',
    'ANTI-PATTERNS — DO NOT DO THESE:',
    ...rules.antiPatterns.map((a) => `- ${a}`),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Runtime calibration
// ---------------------------------------------------------------------------

/**
 * Convert target runtime into a target word count for the entire video.
 * Used to (a) tell the LLM how many words of script to write and (b)
 * estimate scene durations from script length in M11 (export).
 */
export function runtimeToWordCount(seconds: number, wpm = 150): number {
  return Math.round((seconds * wpm) / 60);
}

/**
 * Scale the mode's typical scene range by how much the requested runtime
 * differs from the mode default. A 2-min cover letter gets 3-5 scenes
 * (defaults); a 4-min cover letter gets roughly double-ish; a 1-min
 * cover letter gets fewer. Clamped to sensible floors/ceilings.
 */
export function runtimeToSceneRange(
  seconds: number,
  rules: CompositionRules,
): [number, number] {
  const ratio = seconds / rules.defaultRuntimeSeconds;
  const [defaultMin, defaultMax] = rules.typicalSceneRange;
  const min = Math.max(1, Math.round(defaultMin * ratio));
  const max = Math.max(min + 1, Math.round(defaultMax * ratio));
  return [min, max];
}

/** Target script word count per scene. Used in M6 Call 4 prompts so the
 *  model knows how much spoken text to write for each scene. */
export function wordBudgetPerScene(
  totalWords: number,
  sceneCount: number,
): number {
  if (sceneCount <= 0) return totalWords;
  return Math.round(totalWords / sceneCount);
}

/** Estimate seconds for a given script string. Used to render the runtime
 *  bar in the M8 scene cards UI and to surface mismatch warnings. */
export function estimateSceneSeconds(script: string, wpm = 150): number {
  const words = script.trim().split(/\s+/).filter(Boolean).length;
  return Math.round((words / wpm) * 60);
}
