import { promises as fs, lstatSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { logger } from '../logger.js';
import { getPlan, patchPlan } from '../db/plans.js';
import {
  ALLOWED_SUBDIRS,
  resolvePlanWorkspacePath,
  resolveSubdirPath,
  planSlug,
  WorkspaceNotConfiguredError,
  PathTraversalError,
} from './paths.js';
import type { Plan } from '../db/schemas.js';

/**
 * Filesystem operations for the per-plan workspace. Security-critical:
 *   - All paths validated via paths.ts (slug regex, within-root checks)
 *   - exportToWorkspace uses atomic write (write to temp + rename)
 *   - lstat-based symlink rejection before any write
 *   - Content cap 10MB defensive against accidental dumps
 */

const MAX_EXPORT_BYTES = 10 * 1024 * 1024;
const FILE_MODE = 0o644;
const DIR_MODE = 0o755;

export class WorkspaceCreateError extends Error {
  public readonly planId: string;
  constructor(planId: string, cause: Error) {
    super(`Failed to create workspace for plan ${planId}: ${cause.message}`);
    this.name = 'WorkspaceCreateError';
    this.planId = planId;
  }
}

export class WorkspaceExportError extends Error {
  public readonly planId: string;
  constructor(planId: string, cause: Error) {
    super(`Failed to export to workspace for plan ${planId}: ${cause.message}`);
    this.name = 'WorkspaceExportError';
    this.planId = planId;
  }
}

export interface CreatePlanWorkspaceResult {
  path: string;
}

/**
 * Create the 7-subdir folder structure for a plan. Returns the absolute
 * workspace path. Does NOT touch the plan document — caller patches
 * plan.workspacePath separately (typically via patchPlan from a wrapper
 * like createPlanWorkspaceForPlan below).
 */
export async function createPlanWorkspace(
  planId: string,
  slug: string,
): Promise<CreatePlanWorkspaceResult> {
  const workspacePath = resolvePlanWorkspacePath(planId, slug);
  try {
    await fs.mkdir(workspacePath, { recursive: true, mode: DIR_MODE });
    for (const sub of ALLOWED_SUBDIRS) {
      const subPath = path.join(workspacePath, sub);
      await fs.mkdir(subPath, { recursive: true, mode: DIR_MODE });
    }
    logger.info({ planId, workspacePath }, 'workspace folder created');
    return { path: workspacePath };
  } catch (err) {
    throw new WorkspaceCreateError(planId, err as Error);
  }
}

/**
 * Convenience: create the workspace for a plan AND patch plan.workspacePath
 * with the resolved absolute path. Used by intake.promote and the
 * new-plan form. If workspace creation fails, logs + leaves plan.workspacePath
 * null but DOES NOT throw — the plan + deliverable are already created and
 * usable without a folder. Rick gets a UI affordance to retry later.
 */
export async function createPlanWorkspaceForPlan(plan: Plan): Promise<string | null> {
  try {
    const slug = planSlug(plan);
    const result = await createPlanWorkspace(plan.id, slug);
    await patchPlan(plan.id, { workspacePath: result.path });
    return result.path;
  } catch (err) {
    if (err instanceof WorkspaceNotConfiguredError) {
      logger.warn(
        { planId: plan.id },
        'workspace not configured (WORKSPACE_ROOT unset); plan created without folder',
      );
    } else {
      logger.error(
        { planId: plan.id, err: (err as Error).message },
        'createPlanWorkspaceForPlan failed; plan keeps workspacePath=null',
      );
    }
    return null;
  }
}

/** Look up a plan's stored workspace path. */
export async function getPlanWorkspacePath(planId: string): Promise<string | null> {
  const plan = await getPlan(planId);
  return plan?.workspacePath ?? null;
}

/**
 * Atomic write: write to a temp file in the same directory then rename.
 * Rejects symlink targets via lstat. Caps content size at MAX_EXPORT_BYTES.
 *
 * `filename` is slug-validated (lowercase alphanumerics + hyphens with
 * optional .ext suffix).
 */
export async function exportToWorkspace(
  planId: string,
  subdir: string,
  filename: string,
  content: string | Buffer,
): Promise<string> {
  const plan = await getPlan(planId);
  if (!plan?.workspacePath) {
    throw new WorkspaceExportError(
      planId,
      new Error('plan has no workspacePath — create workspace first'),
    );
  }

  const buf = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;
  if (buf.byteLength > MAX_EXPORT_BYTES) {
    throw new WorkspaceExportError(
      planId,
      new Error(`content size ${buf.byteLength} > ${MAX_EXPORT_BYTES} byte cap`),
    );
  }

  const target = resolveSubdirPath(plan.workspacePath, subdir, filename);

  // Reject if a symlink already exists at this path.
  try {
    const st = lstatSync(target);
    if (st.isSymbolicLink()) {
      throw new WorkspaceExportError(
        planId,
        new Error(`refusing to write through symlink at ${target}`),
      );
    }
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    // ENOENT is fine — file doesn't exist yet. Anything else, re-throw.
    if (e.code !== 'ENOENT') {
      if (err instanceof WorkspaceExportError) throw err;
      // lstat failed for some other reason — let the write attempt below
      // surface the real cause.
    }
  }

  // Atomic write via temp + rename in the same directory.
  const dir = path.dirname(target);
  const tmpName = `.${path.basename(target)}.tmp-${randomBytes(8).toString('hex')}`;
  const tmpPath = path.join(dir, tmpName);

  try {
    await fs.writeFile(tmpPath, buf, { mode: FILE_MODE });
    await fs.rename(tmpPath, target);
    logger.info(
      { planId, target, bytes: buf.byteLength },
      'workspace export written',
    );
    return target;
  } catch (err) {
    // Best-effort cleanup of the temp file.
    try {
      await fs.unlink(tmpPath);
    } catch {
      // ignore — temp may not exist if writeFile itself failed
    }
    throw new WorkspaceExportError(planId, err as Error);
  }
}

export interface WorkspaceRootHealth {
  ok: boolean;
  reason?: string;
  path?: string;
}

/**
 * Health check: confirm WORKSPACE_ROOT is configured, exists, is a
 * directory, and is writable. Surfaced by /healthz so Rick can verify
 * the Windows drive is mounted before he starts a planning session.
 */
export async function validateWorkspaceRoot(): Promise<WorkspaceRootHealth> {
  let root: string;
  try {
    // Use a dummy slug to derive the resolved root without creating anything.
    const probePath = resolvePlanWorkspacePath('plan_probe', 'probe');
    root = path.dirname(probePath);
  } catch (err) {
    if (err instanceof WorkspaceNotConfiguredError) {
      return { ok: false, reason: 'WORKSPACE_ROOT env var not set' };
    }
    if (err instanceof PathTraversalError) {
      return { ok: false, reason: err.message };
    }
    return { ok: false, reason: (err as Error).message };
  }

  try {
    const st = await fs.stat(root);
    if (!st.isDirectory()) {
      return { ok: false, reason: `${root} is not a directory`, path: root };
    }
    // Probe writability with a temp file.
    const probe = path.join(root, `.drek-health-${randomBytes(4).toString('hex')}`);
    await fs.writeFile(probe, '');
    await fs.unlink(probe);
    return { ok: true, path: root };
  } catch (err) {
    return { ok: false, reason: (err as Error).message, path: root };
  }
}
