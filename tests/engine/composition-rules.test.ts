import { describe, it, expect } from 'vitest';
import {
  COVER_LETTER_RULES,
  YOUTUBE_RULES,
  getCompositionRules,
  compositionRulesToPrompt,
  runtimeToWordCount,
  runtimeToSceneRange,
  wordBudgetPerScene,
  estimateSceneSeconds,
} from '../../src/engine/composition-rules.js';

describe('getCompositionRules', () => {
  it('returns COVER_LETTER_RULES for cover_letter mode', () => {
    expect(getCompositionRules('cover_letter')).toBe(COVER_LETTER_RULES);
    expect(getCompositionRules('cover_letter').mode).toBe('cover_letter');
  });
  it('returns YOUTUBE_RULES for youtube mode', () => {
    expect(getCompositionRules('youtube')).toBe(YOUTUBE_RULES);
    expect(getCompositionRules('youtube').mode).toBe('youtube');
  });
});

describe('compositionRulesToPrompt', () => {
  it('renders mode, audience, tone, pacing, structure, rules, anti-patterns', () => {
    const text = compositionRulesToPrompt(COVER_LETTER_RULES);
    expect(text).toContain('MODE: cover_letter');
    expect(text).toContain('AUDIENCE:');
    expect(text).toContain('TONE:');
    expect(text).toContain('PACING:');
    expect(text).toContain('STRUCTURE:');
    expect(text).toContain('RULES:');
    expect(text).toContain('ANTI-PATTERNS — DO NOT DO THESE:');
    // First rule from the constant should appear as a bullet.
    expect(text).toContain(`- ${COVER_LETTER_RULES.rules[0]}`);
  });
});

describe('runtimeToWordCount', () => {
  it('uses 150 wpm by default', () => {
    expect(runtimeToWordCount(60)).toBe(150);
    expect(runtimeToWordCount(120)).toBe(300);
    expect(runtimeToWordCount(600)).toBe(1500);
  });
  it('rounds to nearest integer', () => {
    expect(runtimeToWordCount(40)).toBe(100); // 40*150/60 = 100
    expect(runtimeToWordCount(31)).toBe(78); // 31*2.5 = 77.5 → 78
  });
  it('honors a custom wpm', () => {
    expect(runtimeToWordCount(60, 180)).toBe(180);
  });
});

describe('runtimeToSceneRange', () => {
  it('returns the default range at the default runtime', () => {
    expect(runtimeToSceneRange(120, COVER_LETTER_RULES)).toEqual([3, 5]);
    expect(runtimeToSceneRange(600, YOUTUBE_RULES)).toEqual([8, 12]);
  });
  it('scales scene count down for shorter runtimes', () => {
    const [min, max] = runtimeToSceneRange(60, COVER_LETTER_RULES); // half default
    expect(min).toBeGreaterThanOrEqual(1);
    expect(max).toBeLessThan(5);
    expect(max).toBeGreaterThan(min);
  });
  it('scales scene count up for longer runtimes', () => {
    const [min, max] = runtimeToSceneRange(240, COVER_LETTER_RULES); // 2x default
    expect(min).toBeGreaterThan(3);
    expect(max).toBeGreaterThan(5);
  });
  it('always returns max > min', () => {
    for (const sec of [30, 60, 90, 120, 240, 600, 900, 1800]) {
      const [a, b] = runtimeToSceneRange(sec, COVER_LETTER_RULES);
      expect(b).toBeGreaterThan(a);
    }
  });
});

describe('wordBudgetPerScene', () => {
  it('divides total words by scene count, rounded', () => {
    expect(wordBudgetPerScene(300, 5)).toBe(60);
    expect(wordBudgetPerScene(1500, 10)).toBe(150);
  });
  it('returns totalWords when sceneCount is zero (avoid divide by zero)', () => {
    expect(wordBudgetPerScene(300, 0)).toBe(300);
  });
});

describe('estimateSceneSeconds', () => {
  it('converts script word count to seconds at 150 wpm', () => {
    const fifteenWords = 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen';
    expect(estimateSceneSeconds(fifteenWords)).toBe(6); // 15 words / 2.5 = 6s
  });
  it('returns 0 for empty input', () => {
    expect(estimateSceneSeconds('')).toBe(0);
    expect(estimateSceneSeconds('   ')).toBe(0);
  });
});
