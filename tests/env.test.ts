import { describe, it, expect } from 'vitest';
import { loadEnv } from '../src/env.js';

describe('loadEnv', () => {
  it('accepts a minimal valid environment', () => {
    const env = loadEnv({
      GCP_PROJECT_ID: 'drek-test',
      GOOGLE_APPLICATION_CREDENTIALS: './gcp-key.json',
      NODE_ENV: 'production',
    } as NodeJS.ProcessEnv);
    expect(env.GCP_PROJECT_ID).toBe('drek-test');
    expect(env.PORT).toBe(3003);
    expect(env.LOG_LEVEL).toBe('info');
  });

  it('rejects missing GCP_PROJECT_ID', () => {
    expect(() =>
      loadEnv({
        GOOGLE_APPLICATION_CREDENTIALS: './gcp-key.json',
      } as NodeJS.ProcessEnv),
    ).toThrow(/GCP_PROJECT_ID/);
  });

  it('requires credentials outside of test env', () => {
    expect(() =>
      loadEnv({
        GCP_PROJECT_ID: 'drek-test',
        NODE_ENV: 'production',
      } as NodeJS.ProcessEnv),
    ).toThrow(/GOOGLE_APPLICATION_CREDENTIALS/);
  });

  it('skips the credentials check when NODE_ENV is test', () => {
    const env = loadEnv({
      GCP_PROJECT_ID: 'drek-test',
      NODE_ENV: 'test',
    } as NodeJS.ProcessEnv);
    expect(env.NODE_ENV).toBe('test');
  });

  it('coerces PORT from string', () => {
    const env = loadEnv({
      GCP_PROJECT_ID: 'drek-test',
      NODE_ENV: 'test',
      PORT: '4000',
    } as NodeJS.ProcessEnv);
    expect(env.PORT).toBe(4000);
  });

  it('rejects an invalid LOG_LEVEL', () => {
    expect(() =>
      loadEnv({
        GCP_PROJECT_ID: 'drek-test',
        NODE_ENV: 'test',
        LOG_LEVEL: 'verbose',
      } as NodeJS.ProcessEnv),
    ).toThrow(/Invalid environment/);
  });
});
