import path from 'node:path';
import { getEnv } from '../env.js';

/**
 * Path utilities for the per-plan workspace folder layout.
 *
 * Security model: every path operation goes through resolve() + within-root
 * verification. Slugs are pre-validated against a strict regex BEFORE they
 * touch path.join — defense in depth.
 *
 * The 7 allowed subdirs per tech-spec §4.2 Component I:
 *   brief/, briefs/, scripts/, shotlist/, recordings/, assets/, exports/
 */

export const ALLOWED_SUBDIRS = [
  'brief',
  'briefs',
  'scripts',
  'shotlist',
  'recordings',
  'assets',
  'exports',
] as const;
export type WorkspaceSubdir = (typeof ALLOWED_SUBDIRS)[number];

const ALLOWED_SUBDIRS_SET = new Set<string>(ALLOWED_SUBDIRS);

// Slug: lowercase alphanumerics + hyphens. Optional file extension suffix.
// No leading hyphen, no leading dot, no path separators.
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z]+)?$/;

// Windows reserved device names (case-insensitive). We refuse to use these
// as slugs even on non-Windows hosts — DREK runs on Rick's Windows box.
const WINDOWS_RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  'com0', 'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt0', 'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

// Hard ceiling on slug length so resolved paths stay well under Windows'
// 260-char MAX_PATH (Node 20 supports long paths natively, but Rick's
// editor and Explorer don't always).
const SLUG_MAX_LEN = 80;

export class InvalidSlugError extends Error {
  public readonly slug: string;
  constructor(slug: string, reason: string) {
    super(`Invalid slug "${slug}": ${reason}`);
    this.name = 'InvalidSlugError';
    this.slug = slug;
  }
}

export class PathTraversalError extends Error {
  public readonly attemptedPath: string;
  constructor(attemptedPath: string, root: string) {
    super(`Path traversal blocked: "${attemptedPath}" escapes root "${root}"`);
    this.name = 'PathTraversalError';
    this.attemptedPath = attemptedPath;
  }
}

export class WorkspaceNotConfiguredError extends Error {
  constructor() {
    super('WORKSPACE_ROOT env var is not set — workspace operations unavailable');
    this.name = 'WorkspaceNotConfiguredError';
  }
}

export class UnknownSubdirError extends Error {
  public readonly subdir: string;
  constructor(subdir: string) {
    super(`Unknown workspace subdir "${subdir}" — must be one of ${ALLOWED_SUBDIRS.join(', ')}`);
    this.name = 'UnknownSubdirError';
    this.subdir = subdir;
  }
}

/**
 * Validate a slug. Throws InvalidSlugError if it fails any check.
 *
 * Reject reasons:
 *   - empty
 *   - longer than SLUG_MAX_LEN
 *   - contains path separators (/, \) or parent traversal (..)
 *   - starts with hyphen, underscore, dot
 *   - matches a Windows reserved device name (case-insensitive, basename)
 *   - doesn't match the strict SLUG_RE
 */
export function validateSlug(slug: string): void {
  if (typeof slug !== 'string' || slug.length === 0) {
    throw new InvalidSlugError(String(slug), 'empty');
  }
  if (slug.length > SLUG_MAX_LEN) {
    throw new InvalidSlugError(slug, `length ${slug.length} > ${SLUG_MAX_LEN}`);
  }
  if (slug.includes('/') || slug.includes('\\')) {
    throw new InvalidSlugError(slug, 'contains path separator');
  }
  if (slug.includes('..')) {
    throw new InvalidSlugError(slug, 'contains parent traversal (..)');
  }
  if (slug.startsWith('-') || slug.startsWith('_') || slug.startsWith('.')) {
    throw new InvalidSlugError(slug, 'starts with -, _, or .');
  }
  // Strip extension before checking reserved names.
  const basename = slug.replace(/\.[a-z]+$/, '').toLowerCase();
  if (WINDOWS_RESERVED.has(basename)) {
    throw new InvalidSlugError(slug, 'reserved Windows device name');
  }
  if (!SLUG_RE.test(slug)) {
    throw new InvalidSlugError(slug, 'does not match required pattern');
  }
}

/**
 * Deterministic slug from a Plan-like object. Lowercases the title,
 * replaces non-alphanumerics with hyphens, collapses runs of hyphens,
 * trims length. Always returns a slug that passes validateSlug.
 */
export function planSlug(plan: { id: string; title: string }): string {
  const base = plan.title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')   // strip accents
    .replace(/[^a-z0-9]+/g, '-')        // non-alphanumerics → hyphens
    .replace(/^-+|-+$/g, '')            // trim leading/trailing hyphens
    .replace(/-+/g, '-');               // collapse runs of hyphens

  // Empty after normalization (e.g. title was all symbols) — fall back to
  // a constant so we don't produce '' which validateSlug would reject.
  const safe = base.length > 0 ? base : 'untitled';
  const truncated = safe.slice(0, SLUG_MAX_LEN);
  validateSlug(truncated); // sanity check — should never throw for our own output
  return truncated;
}

/**
 * Read WORKSPACE_ROOT from env. Throws WorkspaceNotConfiguredError when
 * unset so callers can degrade rather than crash on startup.
 */
function getWorkspaceRoot(): string {
  const root = getEnv().WORKSPACE_ROOT;
  if (!root) throw new WorkspaceNotConfiguredError();
  return path.resolve(root);
}

/**
 * Resolve `${WORKSPACE_ROOT}/${planId}-${slug}` to an absolute path,
 * verifying it stays under the root.
 */
export function resolvePlanWorkspacePath(planId: string, slug: string): string {
  validateSlug(slug);
  // Plan id is generated server-side (makeId), known to be alphanumeric +
  // underscore. Defensive validate anyway:
  if (!/^[a-zA-Z0-9_]+$/.test(planId)) {
    throw new InvalidSlugError(planId, 'planId must be alphanumeric + underscore');
  }
  const root = getWorkspaceRoot();
  const folder = `${planId}-${slug}`;
  const candidate = path.resolve(root, folder);
  ensureWithinRoot(candidate, root);
  return candidate;
}

/**
 * Resolve a subdir (and optional filename) under a plan's workspace path.
 * Verifies subdir is in ALLOWED_SUBDIRS and the resulting path stays under
 * the workspace path.
 */
export function resolveSubdirPath(
  workspacePath: string,
  subdir: string,
  filename?: string,
): string {
  if (!ALLOWED_SUBDIRS_SET.has(subdir)) {
    throw new UnknownSubdirError(subdir);
  }
  const root = getWorkspaceRoot();
  // Double-check the caller didn't hand us a forged workspacePath.
  ensureWithinRoot(path.resolve(workspacePath), root);

  let candidate = path.resolve(workspacePath, subdir);
  ensureWithinRoot(candidate, workspacePath);

  if (filename !== undefined) {
    validateSlug(filename);
    candidate = path.resolve(workspacePath, subdir, filename);
    ensureWithinRoot(candidate, workspacePath);
  }
  return candidate;
}

function ensureWithinRoot(candidate: string, root: string): void {
  const rel = path.relative(root, candidate);
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
    throw new PathTraversalError(candidate, root);
  }
}

// Re-export for test imports.
export const _internals = { SLUG_MAX_LEN, WINDOWS_RESERVED, SLUG_RE };
