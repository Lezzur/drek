import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the env module so we can flip LLM_PROVIDER per test without polluting
// process.env. The factory calls getEnv() lazily, so the mock is in place by
// the time it runs.
const fakeEnv = {
  PORT: 3003,
  NODE_ENV: 'test' as const,
  GCP_PROJECT_ID: 'drek-test',
  LOG_LEVEL: 'silent' as const,
  LLM_PROVIDER: 'claude' as 'claude' | 'codex',
  LLM_TIMEOUT_MS: 120_000,
  CLAUDE_BIN: 'claude',
  CLAUDE_MODEL: 'claude-sonnet-4-5',
  CODEX_BIN: 'codex',
  CODEX_MODEL: 'gpt-5-codex',
};

vi.mock('../../src/env.js', () => ({
  getEnv: () => fakeEnv,
  loadEnv: () => fakeEnv,
}));

import {
  getLLMProvider,
  _resetProviderForTests,
} from '../../src/providers/index.js';

describe('getLLMProvider', () => {
  beforeEach(() => {
    _resetProviderForTests();
  });

  it('returns a ClaudeCLIProvider when LLM_PROVIDER=claude', () => {
    fakeEnv.LLM_PROVIDER = 'claude';
    const p = getLLMProvider();
    expect(p.name).toBe('claude');
  });

  it('returns a CodexCLIProvider when LLM_PROVIDER=codex', () => {
    fakeEnv.LLM_PROVIDER = 'codex';
    const p = getLLMProvider();
    expect(p.name).toBe('codex');
  });

  it('memoizes — the same instance comes back across calls', () => {
    fakeEnv.LLM_PROVIDER = 'claude';
    const a = getLLMProvider();
    const b = getLLMProvider();
    expect(a).toBe(b);
  });

  it('switching LLM_PROVIDER after first call has no effect without reset', () => {
    fakeEnv.LLM_PROVIDER = 'claude';
    const first = getLLMProvider();
    fakeEnv.LLM_PROVIDER = 'codex';
    const second = getLLMProvider();
    expect(second.name).toBe('claude'); // still claude — cache won
    expect(second).toBe(first);
  });

  it('_resetProviderForTests clears the cache so a new provider can be selected', () => {
    fakeEnv.LLM_PROVIDER = 'claude';
    getLLMProvider();
    _resetProviderForTests();
    fakeEnv.LLM_PROVIDER = 'codex';
    const after = getLLMProvider();
    expect(after.name).toBe('codex');
  });
});
