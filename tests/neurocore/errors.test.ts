import { describe, it, expect } from 'vitest';
import { NeurocoreError, isRetryable } from '../../src/neurocore/errors.js';

describe('NeurocoreError', () => {
  it('carries code, endpoint, status, and message', () => {
    const err = new NeurocoreError('TIMEOUT', '/v1/memory/context', 'slow', null);
    expect(err.code).toBe('TIMEOUT');
    expect(err.endpoint).toBe('/v1/memory/context');
    expect(err.status).toBeNull();
    expect(err.message).toBe('slow');
    expect(err.name).toBe('NeurocoreError');
    expect(err).toBeInstanceOf(Error);
  });

  it('carries the HTTP status when provided', () => {
    const err = new NeurocoreError('NOT_FOUND', '/x', '404', 404);
    expect(err.status).toBe(404);
  });
});

describe('isRetryable', () => {
  it.each([
    ['UNREACHABLE', true],
    ['TIMEOUT', true],
    ['SERVER_ERROR', true],
    ['RATE_LIMITED', true],
    ['UNAUTHENTICATED', false],
    ['FORBIDDEN', false],
    ['BAD_REQUEST', false],
    ['NOT_FOUND', false],
    ['INVALID_STATE', false],
    ['DEGRADED', false],
    ['INVALID_RESPONSE', false],
    ['NOT_CONFIGURED', false],
  ] as const)('%s -> %s', (code, expected) => {
    const err = new NeurocoreError(code, '/x', 'msg');
    expect(isRetryable(err)).toBe(expected);
  });
});
