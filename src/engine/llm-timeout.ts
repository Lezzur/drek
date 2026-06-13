import { getEnv } from '../env.js';

/**
 * Per-step LLM timeout resolution: explicit caller override, else the
 * operator's LLM_TIMEOUT_MS.
 *
 * History: engine steps used to hardcode their own defaults (30s for
 * requirements, 60s for scene generation, 20s for thumbnails, …) which
 * silently overrode LLM_TIMEOUT_MS — env.ts documents that var as "the
 * per-step timeout" but most steps never consulted it. Scene generation
 * empirically needs 80-90s through the Claude CLI, so the v1 pipeline
 * timed out on its heaviest call every single run (2026-06-11 audit:
 * 1 plan with scenes out of 67). One env var now governs all steps.
 */
export function defaultLlmTimeoutMs(override?: number): number {
  return override ?? getEnv().LLM_TIMEOUT_MS;
}
