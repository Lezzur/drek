import { getEnv } from '../env.js';
import { runCli } from './cli-runner.js';
import type { LLMProvider } from './types.js';

/**
 * Routes prompts through the local `claude` CLI in non-interactive mode:
 *   <CLAUDE_BIN> -p --model <CLAUDE_MODEL> < prompt-on-stdin
 *
 * Same invocation Neurocore and Prospect Intelligence use, so a working
 * Claude install for either of those works here unchanged.
 */
export class ClaudeCLIProvider implements LLMProvider {
  readonly name = 'claude' as const;

  async generate(prompt: string, opts?: { timeoutMs?: number }): Promise<string> {
    const env = getEnv();
    return runCli(
      {
        providerName: 'claude',
        bin: env.CLAUDE_BIN,
        args: ['-p', '--model', env.CLAUDE_MODEL],
        logMeta: { model: env.CLAUDE_MODEL },
      },
      prompt,
      opts?.timeoutMs ?? env.LLM_TIMEOUT_MS,
    );
  }
}
