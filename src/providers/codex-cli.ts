import { getEnv } from '../env.js';
import { runCli } from './cli-runner.js';
import type { LLMProvider } from './types.js';

/**
 * Routes prompts through the local OpenAI `codex` CLI in non-interactive mode:
 *   <CODEX_BIN> exec --model <CODEX_MODEL> < prompt-on-stdin
 *
 * The `exec` subcommand is Codex's non-interactive prompt runner. If your
 * installed Codex CLI version exposes a different subcommand or flag name,
 * override `CODEX_BIN`/`CODEX_MODEL` in `.env` and (if needed) extend this
 * file to take args from env too. Default model is a placeholder — set
 * CODEX_MODEL to whatever your install accepts.
 */
export class CodexCLIProvider implements LLMProvider {
  readonly name = 'codex' as const;

  async generate(prompt: string, opts?: { timeoutMs?: number }): Promise<string> {
    const env = getEnv();
    return runCli(
      {
        providerName: 'codex',
        bin: env.CODEX_BIN,
        args: ['exec', '--model', env.CODEX_MODEL],
        logMeta: { model: env.CODEX_MODEL },
      },
      prompt,
      opts?.timeoutMs ?? env.LLM_TIMEOUT_MS,
    );
  }
}
