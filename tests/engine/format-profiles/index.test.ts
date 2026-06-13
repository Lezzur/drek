import { describe, it, expect } from 'vitest';
import {
  DEFAULT_FORMAT_PROFILE_ID,
  FORMAT_PROFILES,
  FormatProfileNotFoundError,
  getFormatProfile,
  listFormatProfiles,
} from '../../../src/engine/format-profiles/index.js';

describe('format profile registry', () => {
  it('exposes claude_code_build_along as the default', () => {
    expect(DEFAULT_FORMAT_PROFILE_ID).toBe('claude_code_build_along');
    expect(FORMAT_PROFILES[DEFAULT_FORMAT_PROFILE_ID]).toBeDefined();
  });

  it('getFormatProfile returns the registered profile by id', () => {
    const profile = getFormatProfile('claude_code_build_along');
    expect(profile.id).toBe('claude_code_build_along');
    expect(profile.displayName).toBe('Build-Along');
  });

  it('getFormatProfile throws FormatProfileNotFoundError on unknown id', () => {
    try {
      getFormatProfile('unknown_profile');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(FormatProfileNotFoundError);
      expect((err as FormatProfileNotFoundError).formatProfileId).toBe('unknown_profile');
      expect((err as Error).message).toContain('unknown_profile');
    }
  });

  it('listFormatProfiles returns all registered profiles', () => {
    const all = listFormatProfiles();
    expect(all.length).toBe(7);
    const ids = all.map((p) => p.id);
    expect(ids).toContain('claude_code_build_along');
    expect(ids).toContain('tutorial');
    expect(ids).toContain('case_study');
    expect(ids).toContain('comparison');
    expect(ids).toContain('essay_opinion');
    expect(ids).toContain('listicle');
    expect(ids).toContain('reaction_review');
  });

  it('registry is frozen — cannot accidentally mutate at runtime', () => {
    expect(Object.isFrozen(FORMAT_PROFILES)).toBe(true);
  });
});

describe('claude_code_build_along profile shape', () => {
  const profile = getFormatProfile('claude_code_build_along');

  it('declares 7 beats in the Gauntlet order', () => {
    const beatNames = profile.beats.map((b) => b.name);
    expect(beatNames).toEqual([
      'cold_open',
      'problem',
      'war_room',
      'build_reel',
      'breakdown',
      'demo',
      'outro',
    ]);
  });

  it('sums of beat target durations land inside runtimeRange', () => {
    const sum = profile.beats.reduce((acc, b) => acc + b.targetDurationSeconds, 0);
    const [min, max] = profile.runtimeRange;
    expect(sum).toBeGreaterThanOrEqual(min);
    expect(sum).toBeLessThanOrEqual(max);
  });

  it('every beat has a non-empty description and at least one shot convention', () => {
    for (const beat of profile.beats) {
      expect(beat.name).toMatch(/^[a-z][a-z_]*$/);
      expect(beat.targetDurationSeconds).toBeGreaterThan(0);
      expect(beat.description.length).toBeGreaterThan(0);
      expect(beat.shotConventions.length).toBeGreaterThan(0);
    }
  });

  it('sceneRange is sane', () => {
    const [min, max] = profile.sceneRange;
    expect(min).toBeGreaterThan(0);
    expect(max).toBeGreaterThanOrEqual(min);
  });

  it('pacingRules has positive wpm', () => {
    expect(profile.pacingRules.wordsPerMinute).toBeGreaterThan(0);
    expect(profile.pacingRules.sentenceLengthGuide.length).toBeGreaterThan(0);
  });

  it('declares at least 3 anti-patterns', () => {
    expect(profile.antiPatterns.length).toBeGreaterThanOrEqual(3);
  });

  it('ctaPolicy is non-empty', () => {
    expect(profile.ctaPolicy.length).toBeGreaterThan(0);
  });

  it('hookGuidelines includes guidance about the cold open', () => {
    expect(profile.hookGuidelines.toLowerCase()).toContain('cold open');
  });
});

describe('tutorial profile shape', () => {
  const profile = getFormatProfile('tutorial');

  it('declares the procedural 8-beat order', () => {
    const beatNames = profile.beats.map((b) => b.name);
    expect(beatNames).toEqual([
      'cold_open',
      'goal_and_prereqs',
      'architecture',
      'implementation_core',
      'implementation_hardening',
      'live_run',
      'extend_and_pitfalls',
      'outro',
    ]);
  });

  it('sum of beat target durations lands inside runtimeRange', () => {
    const sum = profile.beats.reduce((acc, b) => acc + b.targetDurationSeconds, 0);
    const [min, max] = profile.runtimeRange;
    expect(sum).toBeGreaterThanOrEqual(min);
    expect(sum).toBeLessThanOrEqual(max);
  });

  it('every beat has a non-empty description and at least one shot convention', () => {
    for (const beat of profile.beats) {
      expect(beat.name).toMatch(/^[a-z][a-z_]*$/);
      expect(beat.targetDurationSeconds).toBeGreaterThan(0);
      expect(beat.description.length).toBeGreaterThan(0);
      expect(beat.shotConventions.length).toBeGreaterThan(0);
    }
  });

  it('sceneRange is sane', () => {
    const [min, max] = profile.sceneRange;
    expect(min).toBeGreaterThan(0);
    expect(max).toBeGreaterThanOrEqual(min);
  });

  it('pacingRules has positive wpm', () => {
    expect(profile.pacingRules.wordsPerMinute).toBeGreaterThan(0);
    expect(profile.pacingRules.sentenceLengthGuide.length).toBeGreaterThan(0);
  });

  it('declares at least 3 anti-patterns', () => {
    expect(profile.antiPatterns.length).toBeGreaterThanOrEqual(3);
  });

  it('ctaPolicy is non-empty', () => {
    expect(profile.ctaPolicy.length).toBeGreaterThan(0);
  });

  it('hookGuidelines includes guidance about the cold open', () => {
    expect(profile.hookGuidelines.toLowerCase()).toContain('cold open');
  });

  it('hookGuidelines references only valid HOOK_ARCHETYPES values', () => {
    // The hook archetype enum (schemas.ts HOOK_ARCHETYPES) is what the
    // generator validates LLM output against. Recommended archetypes in
    // guidelines must be drawn from it so the model has valid options.
    const validArchetypes = [
      'pattern_interrupt',
      'bold_claim',
      'retention_question',
      'story_cold_open',
      'demo_first',
    ];
    const mentioned = validArchetypes.filter((a) => profile.hookGuidelines.includes(a));
    expect(mentioned.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Shared shape validator — runs the same structural checks for every profile.
// Add each new profile id to the list at the bottom of this block.
// ---------------------------------------------------------------------------

function sharedProfileShape(id: string) {
  describe(`${id} profile shape`, () => {
    const profile = getFormatProfile(id);

    it('id matches registry key', () => {
      expect(profile.id).toBe(id);
    });

    it('displayName is non-empty', () => {
      expect(profile.displayName.length).toBeGreaterThan(0);
    });

    it('sum of beat target durations lands inside runtimeRange', () => {
      const sum = profile.beats.reduce((acc, b) => acc + b.targetDurationSeconds, 0);
      const [min, max] = profile.runtimeRange;
      expect(sum).toBeGreaterThanOrEqual(min);
      expect(sum).toBeLessThanOrEqual(max);
    });

    it('every beat has a valid name, positive duration, non-empty description, and at least one shot convention', () => {
      for (const beat of profile.beats) {
        expect(beat.name).toMatch(/^[a-z][a-z_]*$/);
        expect(beat.targetDurationSeconds).toBeGreaterThan(0);
        expect(beat.description.length).toBeGreaterThan(0);
        expect(beat.shotConventions.length).toBeGreaterThan(0);
      }
    });

    it('first beat is cold_open', () => {
      expect(profile.beats[0]?.name).toBe('cold_open');
    });

    it('last beat is outro', () => {
      expect(profile.beats[profile.beats.length - 1]?.name).toBe('outro');
    });

    it('sceneRange is sane ([min, max] with min > 0)', () => {
      const [min, max] = profile.sceneRange;
      expect(min).toBeGreaterThan(0);
      expect(max).toBeGreaterThanOrEqual(min);
    });

    it('pacingRules has positive wpm and non-empty guide', () => {
      expect(profile.pacingRules.wordsPerMinute).toBeGreaterThan(0);
      expect(profile.pacingRules.sentenceLengthGuide.length).toBeGreaterThan(0);
    });

    it('declares at least 3 anti-patterns', () => {
      expect(profile.antiPatterns.length).toBeGreaterThanOrEqual(3);
    });

    it('ctaPolicy is non-empty', () => {
      expect(profile.ctaPolicy.length).toBeGreaterThan(0);
    });

    it('hookGuidelines mentions cold open', () => {
      expect(profile.hookGuidelines.toLowerCase()).toContain('cold open');
    });

    it('hookGuidelines references at least 2 valid HOOK_ARCHETYPES', () => {
      const validArchetypes = [
        'pattern_interrupt',
        'bold_claim',
        'retention_question',
        'story_cold_open',
        'demo_first',
      ];
      const mentioned = validArchetypes.filter((a) => profile.hookGuidelines.includes(a));
      expect(mentioned.length).toBeGreaterThanOrEqual(2);
    });
  });
}

sharedProfileShape('case_study');
sharedProfileShape('comparison');
sharedProfileShape('essay_opinion');
sharedProfileShape('listicle');
sharedProfileShape('reaction_review');
