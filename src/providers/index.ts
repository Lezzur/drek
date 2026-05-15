import { getEnv } from '../env.js';
import { ClaudeCLIProvider } from './claude-cli.js';
import { CodexCLIProvider } from './codex-cli.js';
import type { LLMProvider } from './types.js';

export { LLMProviderError } from './types.js';
export type { LLMProvider, LLMProviderErrorCode } from './types.js';
export { killAllInflight } from './cli-runner.js';

/**
 * Memoized provider factory. The active provider is decided once per process
 * from LLM_PROVIDER, then cached — switching providers requires a restart.
 * This matches the discovery brief D-14: "Provider selection is
 * application-wide (not per-request)."
 */
let cached: LLMProvider | null = null;

export function getLLMProvider(): LLMProvider {
  if (cached) return cached;
  const env = getEnv();
  switch (env.LLM_PROVIDER) {
    case 'claude':
      cached = new ClaudeCLIProvider();
      break;
    case 'codex':
      cached = new CodexCLIProvider();
      break;
    default:
      // The zod schema rejects anything else, so this is defensive — but the
      // exhaustiveness check catches future enum additions that forget to
      // wire up a case here.
      const _exhaustive: never = env.LLM_PROVIDER;
      throw new Error(`Unsupported LLM_PROVIDER: ${String(_exhaustive)}`);
  }
  return cached;
}

/** Test-only: reset the memoized provider so a new LLM_PROVIDER takes effect. */
export function _resetProviderForTests(): void {
  cached = null;
}
