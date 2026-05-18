import type { CompositionRules } from './composition-rules.js';
import { compositionRulesToPrompt } from './composition-rules.js';
import type { FormatProfile } from './format-profiles/types.js';
import type { AudienceProfile } from '../neurocore/audience-profiles.js';

/**
 * Prompt-composition gate. Routes every engine step's system-prompt
 * assembly through one function so v1 and v2 paths can never
 * accidentally cross-pollinate (the "mode-blending" risk Lisa flagged
 * during the tech-spec review).
 *
 * Contract per TECH-SPEC-drek-v2-youtube-2026-05-18.md §4.6:
 *   - Exactly ONE of these path shapes must be provided:
 *       a) v1: { v1CompositionRules, taskInstructions }
 *       b) v2: { formatProfile, audienceProfile, taskInstructions }
 *   - Other combinations throw PromptCompositionError
 *   - Block order in v2 is load-bearing: format first (structure),
 *     audience second (voice) — voice can override format defaults
 *
 * Stable headers so engine tests can assert presence without brittle
 * whitespace matching:
 *   === V1 COMPOSITION RULES ===
 *   === FORMAT PROFILE ===
 *   === AUDIENCE PROFILE ===
 *   === TASK INSTRUCTIONS ===
 */

export class PromptCompositionError extends Error {
  public readonly given: {
    hasV1Rules: boolean;
    hasFormatProfile: boolean;
    hasAudienceProfile: boolean;
    hasTaskInstructions: boolean;
  };
  constructor(message: string, given: PromptCompositionError['given']) {
    super(message);
    this.name = 'PromptCompositionError';
    this.given = given;
  }
}

export interface BuildSystemPromptOptions {
  v1CompositionRules?: CompositionRules;
  formatProfile?: FormatProfile;
  audienceProfile?: AudienceProfile;
  taskInstructions: string;
}

const SEPARATOR = '\n\n---\n\n';

export function buildSystemPrompt(opts: BuildSystemPromptOptions): string {
  const given = {
    hasV1Rules: !!opts.v1CompositionRules,
    hasFormatProfile: !!opts.formatProfile,
    hasAudienceProfile: !!opts.audienceProfile,
    hasTaskInstructions: !!opts.taskInstructions && opts.taskInstructions.trim().length > 0,
  };

  if (!given.hasTaskInstructions) {
    throw new PromptCompositionError(
      'buildSystemPrompt: taskInstructions is required and must be non-empty',
      given,
    );
  }

  const isV1Path = given.hasV1Rules && !given.hasFormatProfile && !given.hasAudienceProfile;
  const isV2Path =
    given.hasFormatProfile && given.hasAudienceProfile && !given.hasV1Rules;

  if (!isV1Path && !isV2Path) {
    throw new PromptCompositionError(
      'buildSystemPrompt: must provide either {v1CompositionRules} OR {formatProfile + audienceProfile}, not a mix. ' +
        'v2 prompt composition requires BOTH formatProfile AND audienceProfile.',
      given,
    );
  }

  const blocks: string[] = [];
  if (isV1Path) {
    blocks.push('=== V1 COMPOSITION RULES ===\n' + compositionRulesToPrompt(opts.v1CompositionRules!));
  } else {
    // v2 path — order is load-bearing: format first, then audience.
    blocks.push('=== FORMAT PROFILE ===\n' + renderFormatProfile(opts.formatProfile!));
    blocks.push('=== AUDIENCE PROFILE ===\n' + renderAudienceProfile(opts.audienceProfile!));
  }
  blocks.push('=== TASK INSTRUCTIONS ===\n' + opts.taskInstructions);
  return blocks.join(SEPARATOR);
}

function renderFormatProfile(p: FormatProfile): string {
  const beats = p.beats
    .map(
      (b, i) =>
        `  ${i + 1}. ${b.name} (~${b.targetDurationSeconds}s): ${b.description}\n     Shots: ${b.shotConventions.join(', ')}`,
    )
    .join('\n');
  return [
    `Format: ${p.displayName} (${p.id})`,
    p.description,
    '',
    `Runtime range: ${p.runtimeRange[0]}-${p.runtimeRange[1]}s`,
    `Scene count range: ${p.sceneRange[0]}-${p.sceneRange[1]}`,
    `Pacing: ${p.pacingRules.wordsPerMinute} wpm. ${p.pacingRules.sentenceLengthGuide}`,
    '',
    'Beats (use these exact names as beatTag values):',
    beats,
    '',
    'Hook guidelines:',
    p.hookGuidelines,
    '',
    'Anti-patterns to avoid:',
    p.antiPatterns.map((a) => `  - ${a}`).join('\n'),
    '',
    'CTA policy:',
    p.ctaPolicy,
  ].join('\n');
}

function renderAudienceProfile(a: AudienceProfile): string {
  return [
    '<audience_profile>',
    `Name: ${a.name}`,
    `Description: ${a.description}`,
    '',
    `Watch persona: ${a.watchPersona}`,
    '',
    'Pain points:',
    a.painPoints.map((p) => `  - ${p}`).join('\n'),
    '',
    'Buying triggers:',
    a.buyingTriggers.map((t) => `  - ${t}`).join('\n'),
    '',
    'Voice guidelines:',
    `  Tone: ${a.voiceGuidelines.tone}`,
    `  Vocabulary: ${a.voiceGuidelines.vocabulary}`,
    `  Sentence length: ${a.voiceGuidelines.sentenceLengthGuide}`,
    `  Taboos: ${a.voiceGuidelines.taboos.join(', ') || '(none)'}`,
    '',
    'Hook patterns (audience-specific):',
    a.hookPatterns.map((h) => `  - ${h}`).join('\n'),
    '',
    'Pacing rules (audience-specific — override format defaults if different):',
    `  Words per minute: ${a.pacingRules.wordsPerMinute}`,
    `  Avg sentence words: ${a.pacingRules.avgSentenceWords}`,
    `  Density: ${a.pacingRules.densityNote}`,
    '',
    'CTA style:',
    `  Type: ${a.ctaStyle.type}`,
    `  Placement: ${a.ctaStyle.placement}`,
    `  Example phrasing: ${a.ctaStyle.phrasing}`,
    '</audience_profile>',
  ].join('\n');
}
