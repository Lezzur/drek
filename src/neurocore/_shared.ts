/**
 * Shared @lezzur/neurocore-client singleton, configured for DREK.
 *
 * One client instance per process — every facade in this directory pulls
 * from `getSharedClient()`. The first call lazily instantiates with
 * DREK's env vars. Tests can reset via `_resetSharedClientForTests()`.
 *
 * Migration plan (Phase 2):
 *   - Phase 2a (this PR): audience-profiles, tech-stacks, stack-performance,
 *     write-queue migrated to facades that delegate here. client.ts and
 *     polling/service.ts untouched in this PR.
 *   - Phase 2b: client.ts NeurocoreClient class delegates to shared client
 *     for low-level calls (getProjectContext / getVoiceProfile / etc).
 *   - Phase 2c: polling/service.ts uses nc.createPollingLoop().
 *   - Phase 2d: src/neurocore/ deleted; call sites import @lezzur/neurocore-client
 *     directly.
 */

import { createNeurocoreClient, type NeurocoreClient } from '@lezzur/neurocore-client';
import path from 'node:path';
import { getEnv } from '../env.js';

let cached: NeurocoreClient | null = null;

export async function getSharedClient(): Promise<NeurocoreClient> {
  if (cached !== null) return cached;
  const env = getEnv();
  if (!env.NEUROCORE_TOKEN) {
    // Mirror DREK's existing "lazy token" pattern — let tests instantiate
    // without a token, surface NOT_CONFIGURED on first real call.
    throw new Error(
      'NEUROCORE_TOKEN is not set; refusing to instantiate shared client. ' +
        'Set the env var before any Neurocore call.',
    );
  }
  // Queue paths colocated with DREK's process working directory so the
  // existing DREK write-queue + shared write-queue can coexist during
  // the migration window without colliding on filesystem paths.
  const queueRoot = process.cwd();
  cached = await createNeurocoreClient({
    baseUrl: env.NEUROCORE_URL,
    token: env.NEUROCORE_TOKEN,
    appId: 'drek',
    userId: 'rick',
    queue: {
      persistencePath: path.join(queueRoot, '.neurocore-shared-queue.jsonl'),
      deadLetterPath: path.join(queueRoot, '.neurocore-shared-queue-dead.jsonl'),
    },
    http: {
      timeoutMs: env.NEUROCORE_TIMEOUT_MS,
    },
  });
  return cached;
}

/** Test helper. Disposes the singleton so the next call rebuilds it. */
export function _resetSharedClientForTests(): void {
  cached = null;
}
