import { getEnv } from '../env.js';
import { getLLMSettings } from '../db/llm-settings.js';
import { runCli } from './cli-runner.js';
import type { LLMProvider } from './types.js';

export class ClaudeCLIProvider implements LLMProvider {
  readonly name = 'claude' as const;

  async generate(prompt: string, opts?: { timeoutMs?: number }): Promise<string> {
    const env = getEnv();
    const { claudeModel } = await getLLMSettings();
    return runCli(
      {
        providerName: 'claude',
        bin: env.CLAUDE_BIN,
        args: ['-p', '--model', claudeModel],
        logMeta: { model: claudeModel },
      },
      prompt,
      opts?.timeoutMs ?? env.LLM_TIMEOUT_MS,
    );
  }
}
