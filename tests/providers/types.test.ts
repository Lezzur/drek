import { describe, it, expect } from 'vitest';
import { LLMProviderError } from '../../src/providers/types.js';

describe('LLMProviderError', () => {
  it('carries the provider name, code, and message', () => {
    const err = new LLMProviderError('claude', 'TIMEOUT', 'too slow');
    expect(err.providerName).toBe('claude');
    expect(err.code).toBe('TIMEOUT');
    expect(err.message).toBe('too slow');
    expect(err.name).toBe('LLMProviderError');
  });

  it('is an Error subclass (so generic try/catch handlers catch it)', () => {
    const err = new LLMProviderError('codex', 'SPAWN_FAILED', 'no codex on PATH');
    expect(err).toBeInstanceOf(Error);
  });
});
