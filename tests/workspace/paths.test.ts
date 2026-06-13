import { describe, it, expect, beforeEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';

const fakeEnv = {
  PORT: 3003,
  NODE_ENV: 'test' as const,
  GCP_PROJECT_ID: 'drek-test',
  LOG_LEVEL: 'silent' as const,
  LLM_PROVIDER: 'claude' as const,
  LLM_TIMEOUT_MS: 120_000,
  CLAUDE_BIN: 'claude',
  CLAUDE_MODEL: 'claude-sonnet-4-5',
  CODEX_BIN: 'codex',
  CODEX_MODEL: 'gpt-5-codex',
  NEUROCORE_URL: 'http://localhost:3100',
  NEUROCORE_TOKEN: 'test-token',
  NEUROCORE_TIMEOUT_MS: 50,
  WORKSPACE_ROOT: '/tmp/drek-workspace-test',
};

vi.mock('../../src/env.js', () => ({
  getEnv: () => fakeEnv,
  loadEnv: () => fakeEnv,
}));

import {
  validateSlug,
  planSlug,
  resolvePlanWorkspacePath,
  resolveSubdirPath,
  InvalidSlugError,
  PathTraversalError,
  WorkspaceNotConfiguredError,
  UnknownSubdirError,
  ALLOWED_SUBDIRS,
} from '../../src/workspace/paths.js';

beforeEach(() => {
  fakeEnv.WORKSPACE_ROOT = '/tmp/drek-workspace-test';
});

describe('validateSlug', () => {
  it.each(['rick-build', 'lead-pipeline', 'episode-1', 'foo.txt', 'a-b-c'])(
    'accepts %s',
    (slug) => {
      expect(() => validateSlug(slug)).not.toThrow();
    },
  );

  it.each([
    ['', 'empty'],
    ['UPPER', 'uppercase'],
    ['../escape', 'traversal'],
    ['has space', 'space'],
    ['/abs', 'leading slash'],
    ['back\\slash', 'backslash'],
    ['-leading', 'starts with hyphen'],
    ['_underscore', 'starts with underscore'],
    ['.dotfile', 'starts with dot'],
    ['con', 'reserved CON'],
    ['NUL', 'reserved NUL (case insensitive)'],
    ['com1.txt', 'reserved COM1 even with extension'],
    ['x'.repeat(81), 'over max length'],
  ])('rejects %s (%s)', (slug) => {
    expect(() => validateSlug(slug)).toThrow(InvalidSlugError);
  });
});

describe('planSlug', () => {
  it('lowercases + kebabs the title', () => {
    expect(planSlug({ id: 'plan_1', title: 'Build a Lead Pipeline' })).toBe(
      'build-a-lead-pipeline',
    );
  });

  it('strips symbols', () => {
    expect(planSlug({ id: 'plan_1', title: 'Build a $50k automation!!!' })).toBe(
      'build-a-50k-automation',
    );
  });

  it('falls back to "untitled" when title has no alphanumerics', () => {
    expect(planSlug({ id: 'plan_1', title: '???!!!' })).toBe('untitled');
  });

  it('truncates to max length', () => {
    const longTitle = 'a'.repeat(200);
    const s = planSlug({ id: 'plan_1', title: longTitle });
    expect(s.length).toBeLessThanOrEqual(80);
    expect(() => validateSlug(s)).not.toThrow();
  });

  it('output always passes validateSlug', () => {
    const titles = [
      'Normal Title',
      'with-hyphens-already',
      'UPPER CASE STUFF',
      '   leading spaces',
      'trailing spaces   ',
      'tabs\tand\tnewlines\n',
    ];
    for (const title of titles) {
      const s = planSlug({ id: 'plan_x', title });
      expect(() => validateSlug(s)).not.toThrow();
    }
  });
});

describe('resolvePlanWorkspacePath', () => {
  it('returns an absolute path under WORKSPACE_ROOT', () => {
    const p = resolvePlanWorkspacePath('plan_abc', 'my-episode');
    expect(path.isAbsolute(p)).toBe(true);
    expect(p).toContain('plan_abc-my-episode');
  });

  it('throws WorkspaceNotConfiguredError when WORKSPACE_ROOT is unset', () => {
    fakeEnv.WORKSPACE_ROOT = '';
    expect(() => resolvePlanWorkspacePath('plan_abc', 'ep')).toThrow(
      WorkspaceNotConfiguredError,
    );
    // Empty string in zod schema is also rejected — but we test the missing case
    fakeEnv.WORKSPACE_ROOT = undefined as unknown as string;
    expect(() => resolvePlanWorkspacePath('plan_abc', 'ep')).toThrow(
      WorkspaceNotConfiguredError,
    );
  });

  it('rejects traversal slugs', () => {
    expect(() => resolvePlanWorkspacePath('plan_abc', '../escape')).toThrow(
      InvalidSlugError,
    );
  });

  it('rejects invalid plan id', () => {
    expect(() => resolvePlanWorkspacePath('plan abc!', 'ep')).toThrow(InvalidSlugError);
  });
});

describe('resolveSubdirPath', () => {
  // resolve() so the expected values are drive-qualified on Windows the same
  // way the implementation's path.resolve output is.
  const workspace = path.resolve('/tmp/drek-workspace-test/plan_abc-ep');

  it.each(ALLOWED_SUBDIRS)('accepts %s', (sub) => {
    const p = resolveSubdirPath(workspace, sub);
    expect(p).toBe(path.join(workspace, sub));
  });

  it('rejects unknown subdirs', () => {
    expect(() => resolveSubdirPath(workspace, 'malware')).toThrow(UnknownSubdirError);
    expect(() => resolveSubdirPath(workspace, '../escape')).toThrow(UnknownSubdirError);
  });

  it('resolves a filename within an allowed subdir', () => {
    const p = resolveSubdirPath(workspace, 'scripts', 'episode-1.txt');
    expect(p).toBe(path.join(workspace, 'scripts', 'episode-1.txt'));
  });

  it('rejects a forged workspace path outside the root', () => {
    expect(() => resolveSubdirPath('/etc', 'scripts')).toThrow(PathTraversalError);
  });

  it('rejects a filename that fails slug validation', () => {
    expect(() => resolveSubdirPath(workspace, 'scripts', '../escape.txt')).toThrow(
      InvalidSlugError,
    );
    expect(() => resolveSubdirPath(workspace, 'scripts', 'CON.txt')).toThrow(
      InvalidSlugError,
    );
  });
});
