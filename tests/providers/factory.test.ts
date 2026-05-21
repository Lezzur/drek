import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * The factory used to read LLM_PROVIDER straight off env and memoize globally.
 * It now reads from src/db/llm-settings.js (which has its own 30s cache) and
 * memoizes per-provider-name, so both providers can coexist in the Map.
 *
 * These tests stub out llm-settings to control what the factory sees.
 */

const fakeSettings = {
  provider: 'claude' as 'claude' | 'codex',
  claudeModel: 'claude-sonnet-4-5',
  codexModel: 'gpt-5-codex',
};

vi.mock('../../src/db/llm-settings.js', () => ({
  getLLMSettings: vi.fn(async () => ({ ...fakeSettings })),
  _resetLLMSettingsCacheForTests: vi.fn(),
}));

import {
  getLLMProvider,
  _resetProviderForTests,
} from '../../src/providers/index.js';

describe('getLLMProvider', () => {
  beforeEach(() => {
    _resetProviderForTests();
    fakeSettings.provider = 'claude';
  });

  it('returns a ClaudeCLIProvider when settings.provider=claude', async () => {
    fakeSettings.provider = 'claude';
    const p = await getLLMProvider();
    expect(p.name).toBe('claude');
  });

  it('returns a CodexCLIProvider when settings.provider=codex', async () => {
    fakeSettings.provider = 'codex';
    const p = await getLLMProvider();
    expect(p.name).toBe('codex');
  });

  it('memoizes — the same instance comes back across calls with the same provider', async () => {
    fakeSettings.provider = 'claude';
    const a = await getLLMProvider();
    const b = await getLLMProvider();
    expect(a).toBe(b);
  });

  it('memoizes per-provider-name — switching settings hands back the other cached instance', async () => {
    fakeSettings.provider = 'claude';
    const first = await getLLMProvider();
    fakeSettings.provider = 'codex';
    const second = await getLLMProvider();
    // Different instances — the Map keys by provider name now, so both
    // providers coexist instead of one winning the cache forever.
    expect(second.name).toBe('codex');
    expect(second).not.toBe(first);
    // Switching back returns the original Claude instance.
    fakeSettings.provider = 'claude';
    const third = await getLLMProvider();
    expect(third).toBe(first);
  });

  it('_resetProviderForTests clears both instances; next call rebuilds fresh', async () => {
    fakeSettings.provider = 'claude';
    const original = await getLLMProvider();
    _resetProviderForTests();
    const rebuilt = await getLLMProvider();
    expect(rebuilt.name).toBe('claude');
    expect(rebuilt).not.toBe(original);
  });
});
