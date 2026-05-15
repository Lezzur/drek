import { describe, it, expect } from 'vitest';
import { extractJson, parseExtractedJson } from '../../src/engine/json-utils.js';

describe('extractJson', () => {
  it('passes through a clean JSON object unchanged', () => {
    expect(extractJson('{"a":1}')).toBe('{"a":1}');
  });

  it('passes through a clean JSON array unchanged', () => {
    expect(extractJson('[1,2,3]')).toBe('[1,2,3]');
  });

  it('trims surrounding whitespace', () => {
    expect(extractJson('   {"a":1}   ')).toBe('{"a":1}');
  });

  it('strips ```json fences', () => {
    expect(extractJson('```json\n[1,2]\n```')).toBe('[1,2]');
  });

  it('strips plain ``` fences', () => {
    expect(extractJson('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('handles uppercase ```JSON fences', () => {
    expect(extractJson('```JSON\n[1]\n```')).toBe('[1]');
  });

  it('strips leading prose and trailing whitespace', () => {
    const input = 'Here is the JSON you requested:\n\n[{"skill":"x"}]\n\nThanks!';
    expect(extractJson(input)).toBe('[{"skill":"x"}]');
  });

  it('prefers the first opening bracket (array vs object)', () => {
    // The array starts first, so it should be picked.
    const input = 'oops [1,2] then {"a":1}';
    expect(extractJson(input)).toContain('[1,2');
  });

  it('returns the raw string when there is no JSON', () => {
    expect(extractJson('no json here')).toBe('no json here');
  });
});

describe('parseExtractedJson', () => {
  it('parses JSON wrapped in fences', () => {
    expect(parseExtractedJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('throws on truly broken JSON', () => {
    expect(() => parseExtractedJson('{not json')).toThrow();
  });
});
