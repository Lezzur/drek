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
    expect(profile.displayName).toBe('Claude Code Build-Along');
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
    expect(all.length).toBeGreaterThanOrEqual(1);
    expect(all.map((p) => p.id)).toContain('claude_code_build_along');
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
