import { getEnv } from '../env.js';
import { getLLMSettings } from '../db/llm-settings.js';
import { runCli } from './cli-runner.js';
import type { LLMProvider } from './types.js';

/**
 * Routes prompts through the local OpenAI `codex` CLI in non-interactive mode.
 *
 * Default invocation: codex --model <model> -q < prompt-on-stdin
 * The -q (quiet/non-interactive) flag and model come from LLM settings.
 * Override CODEX_BIN in .env if your codex binary is not on PATH.
 */
export class CodexCLIProvider implements LLMProvider {
  readonly name = 'codex' as const;

  async generate(prompt: string, opts?: { timeoutMs?: number }): Promise<string> {
    const env = getEnv();
    const { codexModel } = await getLLMSettings();
    return runCli(
      {
        providerName: 'codex',
        bin: env.CODEX_BIN,
        args: ['--model', codexModel, '-q'],
        logMeta: { model: codexModel },
      },
      prompt,
      opts?.timeoutMs ?? env.LLM_TIMEOUT_MS,
    );
  }
}
