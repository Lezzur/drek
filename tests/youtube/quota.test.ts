import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() },
}));

import {
  setQuotaCap,
  consume,
  consumeRaw,
  snapshot,
  _resetQuotaForTests,
} from '../../src/youtube/quota.js';
import { YouTubeError } from '../../src/youtube/errors.js';

beforeEach(() => {
  _resetQuotaForTests(10_000);
});

describe('quota — basic accounting', () => {
  it('starts at zero consumed, full cap remaining', () => {
    const s = snapshot();
    expect(s.consumed).toBe(0);
    expect(s.cap).toBe(10_000);
    expect(s.remaining).toBe(10_000);
    expect(s.utilization).toBe(0);
    expect(s.warnFiredAt).toBe(null);
  });

  it('consume() adds to the counter', () => {
    consume(5, '/videos');
    consume(1, '/channels');
    expect(snapshot().consumed).toBe(6);
    expect(snapshot().remaining).toBe(9_994);
  });

  it('snapshot.utilization tracks fraction consumed', () => {
    consumeRaw(2_500);
    expect(snapshot().utilization).toBeCloseTo(0.25, 2);
  });
});

describe('quota — warn + hard-limit thresholds', () => {
  it('does not fire warn under 80%', () => {
    consume(7_999, '/videos');
    expect(snapshot().warnFiredAt).toBe(null);
  });

  it('fires warn once at 80%+ (sticky)', () => {
    consume(8_000, '/videos');
    expect(snapshot().warnFiredAt).not.toBe(null);
    const firstFireAt = snapshot().warnFiredAt;
    consume(1, '/videos');
    expect(snapshot().warnFiredAt).toBe(firstFireAt); // stays sticky
  });

  it('throws QUOTA_EXCEEDED when a call would push past 95%', () => {
    consumeRaw(9_400);
    // Next call charges 200 units → would reach 9_600, past 95% (9_500).
    try {
      consume(200, '/reports');
      expect.fail('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(YouTubeError);
      expect((err as YouTubeError).code).toBe('QUOTA_EXCEEDED');
    }
    // Counter did NOT increment — the call was refused before charging.
    expect(snapshot().consumed).toBe(9_400);
  });

  it('allows calls that land exactly on 95%', () => {
    consumeRaw(9_400);
    consume(100, '/reports'); // 9_500 = exactly 95%
    expect(snapshot().consumed).toBe(9_500);
  });

  it('consumeRaw bypasses the 95% guard', () => {
    consumeRaw(9_999);
    expect(() => consumeRaw(10)).not.toThrow();
    expect(snapshot().consumed).toBe(10_009);
  });
});

describe('quota — cap configuration', () => {
  it('setQuotaCap replaces the cap', () => {
    setQuotaCap(2_000);
    expect(snapshot().cap).toBe(2_000);
    consume(1_500, '/videos');
    expect(snapshot().remaining).toBe(500);
  });

  it('treats non-positive cap as default', () => {
    setQuotaCap(0);
    expect(snapshot().cap).toBe(10_000);
    setQuotaCap(-50);
    expect(snapshot().cap).toBe(10_000);
  });
});

describe('quota — UTC day rollover', () => {
  it('resets counter when the UTC day changes', () => {
    consume(100, '/videos');
    expect(snapshot().consumed).toBe(100);

    // Simulate the day rolling by mocking Date.toISOString. We use
    // vi.setSystemTime so the next consume() call sees a new day.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-21T00:00:00.000Z'));
    // First call AFTER the roll triggers the reset path; the counter
    // becomes 0 + new units.
    consume(5, '/videos');
    expect(snapshot().consumed).toBe(5);
    vi.useRealTimers();
  });
});
