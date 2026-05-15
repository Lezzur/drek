import { describe, it, expect } from 'vitest';
import { _internal } from '../../src/models/openai.js';

const { isCodingModel } = _internal;

describe('OpenAI model filter', () => {
  it.each([
    'gpt-5-codex',
    'gpt-5',
    'gpt-4.5-turbo',
    'gpt-4o',
    'o1-preview',
    'o1-mini',
    'o3-mini',
    'chatgpt-4o-latest',
    'codex-mini-latest',
  ])('includes coding/chat model %s', (id) => {
    expect(isCodingModel(id)).toBe(true);
  });

  it.each([
    'text-embedding-3-small',
    'text-embedding-ada-002',
    'dall-e-3',
    'whisper-1',
    'tts-1-hd',
    'text-moderation-stable',
    'text-davinci-003',
    'davinci-002',
    'babbage-002',
    'curie-001',
    'ada-001',
    'text-search-davinci-doc-001',
    'gpt-3.5-turbo-edit-001',
  ])('excludes non-coding model %s', (id) => {
    expect(isCodingModel(id)).toBe(false);
  });
});
