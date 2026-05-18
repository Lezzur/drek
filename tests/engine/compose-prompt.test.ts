import { describe, it, expect } from 'vitest';
import {
  buildSystemPrompt,
  PromptCompositionError,
} from '../../src/engine/compose-prompt.js';
import { COVER_LETTER_RULES, YOUTUBE_RULES } from '../../src/engine/composition-rules.js';
import { getFormatProfile } from '../../src/engine/format-profiles/index.js';
import type { AudienceProfile } from '../../src/neurocore/audience-profiles.js';

const stubAudience: AudienceProfile = {
  id: 'developer_longform',
  name: 'Developer / Learner — Long-form',
  description: 'AI/automation practitioners.',
  watchPersona: 'Engineers who sit through 25-min builds.',
  painPoints: ['marketing-heavy AI content'],
  buyingTriggers: ['sees Rick handle a failure calmly'],
  voiceGuidelines: {
    tone: 'authoritative-warm',
    vocabulary: 'technical but accessible',
    sentenceLengthGuide: 'mix short and medium',
    taboos: ["'guys'"],
  },
  hookPatterns: ['start with the failure'],
  pacingRules: {
    wordsPerMinute: 150,
    avgSentenceWords: 14,
    densityNote: 'Pauses after big claims.',
  },
  ctaStyle: {
    type: 'subscribe_and_long_form',
    phrasing: 'subscribe — the next one is...',
    placement: 'final 15 seconds',
  },
  createdAt: '2026-05-18T14:00:00.000Z',
  updatedAt: '2026-05-18T14:00:00.000Z',
};

const TASK = 'Extract the structured output below.';

describe('buildSystemPrompt — v1 path', () => {
  it('renders only v1 + task blocks for cover_letter rules', () => {
    const out = buildSystemPrompt({
      v1CompositionRules: COVER_LETTER_RULES,
      taskInstructions: TASK,
    });
    expect(out).toContain('=== V1 COMPOSITION RULES ===');
    expect(out).toContain('=== TASK INSTRUCTIONS ===');
    expect(out).toContain(TASK);
    expect(out).not.toContain('=== FORMAT PROFILE ===');
    expect(out).not.toContain('=== AUDIENCE PROFILE ===');
  });

  it('renders v1 path for youtube_lite rules', () => {
    const out = buildSystemPrompt({
      v1CompositionRules: YOUTUBE_RULES,
      taskInstructions: TASK,
    });
    expect(out).toContain('=== V1 COMPOSITION RULES ===');
    expect(out).not.toContain('=== FORMAT PROFILE ===');
  });
});

describe('buildSystemPrompt — v2 path', () => {
  const formatProfile = getFormatProfile('claude_code_build_along');

  it('renders format + audience + task blocks in correct order', () => {
    const out = buildSystemPrompt({
      formatProfile,
      audienceProfile: stubAudience,
      taskInstructions: TASK,
    });
    expect(out).toContain('=== FORMAT PROFILE ===');
    expect(out).toContain('=== AUDIENCE PROFILE ===');
    expect(out).toContain('=== TASK INSTRUCTIONS ===');
    expect(out).not.toContain('=== V1 COMPOSITION RULES ===');

    // Order: format BEFORE audience BEFORE task.
    const idxFormat = out.indexOf('=== FORMAT PROFILE ===');
    const idxAudience = out.indexOf('=== AUDIENCE PROFILE ===');
    const idxTask = out.indexOf('=== TASK INSTRUCTIONS ===');
    expect(idxFormat).toBeLessThan(idxAudience);
    expect(idxAudience).toBeLessThan(idxTask);
  });

  it('format block includes beat names + runtime range', () => {
    const out = buildSystemPrompt({
      formatProfile,
      audienceProfile: stubAudience,
      taskInstructions: TASK,
    });
    for (const beat of formatProfile.beats) {
      expect(out).toContain(beat.name);
    }
    expect(out).toContain(`${formatProfile.runtimeRange[0]}-${formatProfile.runtimeRange[1]}s`);
  });

  it('audience block includes hook patterns + CTA placement', () => {
    const out = buildSystemPrompt({
      formatProfile,
      audienceProfile: stubAudience,
      taskInstructions: TASK,
    });
    expect(out).toContain('start with the failure');
    expect(out).toContain('final 15 seconds');
    expect(out).toContain('<audience_profile>');
    expect(out).toContain('</audience_profile>');
  });
});

describe('buildSystemPrompt — invariant guards', () => {
  const formatProfile = getFormatProfile('claude_code_build_along');

  it('rejects empty task instructions', () => {
    expect(() =>
      buildSystemPrompt({
        v1CompositionRules: COVER_LETTER_RULES,
        taskInstructions: '',
      }),
    ).toThrow(PromptCompositionError);
    expect(() =>
      buildSystemPrompt({
        v1CompositionRules: COVER_LETTER_RULES,
        taskInstructions: '   ',
      }),
    ).toThrow(PromptCompositionError);
  });

  it('rejects mixing v1 rules with format profile', () => {
    expect(() =>
      buildSystemPrompt({
        v1CompositionRules: COVER_LETTER_RULES,
        formatProfile,
        taskInstructions: TASK,
      }),
    ).toThrow(PromptCompositionError);
  });

  it('rejects format profile without audience profile', () => {
    expect(() =>
      buildSystemPrompt({
        formatProfile,
        taskInstructions: TASK,
      }),
    ).toThrow(PromptCompositionError);
  });

  it('rejects audience profile without format profile', () => {
    expect(() =>
      buildSystemPrompt({
        audienceProfile: stubAudience,
        taskInstructions: TASK,
      }),
    ).toThrow(PromptCompositionError);
  });

  it('rejects all-empty option set', () => {
    expect(() => buildSystemPrompt({ taskInstructions: TASK })).toThrow(
      PromptCompositionError,
    );
  });
});
