import { getLLMSettings } from '../db/llm-settings.js';
import { ClaudeCLIProvider } from './claude-cli.js';
import { CodexCLIProvider } from './codex-cli.js';
import type { LLMProvider } from './types.js';

export { LLMProviderError } from './types.js';
export type { LLMProvider, LLMProviderErrorCode } from './types.js';
export { killAllInflight } from './cli-runner.js';

// One instance per provider name — switching via settings picks up the other
// instance on the next call without a restart.
const _instances = new Map<string, LLMProvider>();

export async function getLLMProvider(): Promise<LLMProvider> {
  const { provider } = await getLLMSettings();
  let instance = _instances.get(provider);
  if (!instance) {
    instance = provider === 'codex' ? new CodexCLIProvider() : new ClaudeCLIProvider();
    _instances.set(provider, instance);
  }
  return instance;
}

/** Test-only: clear cached instances so a new provider takes effect. */
export function _resetProviderForTests(): void {
  _instances.clear();
}
