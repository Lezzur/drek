/**
 * LLMProvider — uniform interface DREK uses for every LLM call.
 *
 * Implementations spawn a local CLI (Claude or Codex) and pipe the prompt
 * over stdin to dodge Windows' 8191-char command-line limit. The contract
 * is intentionally narrow: take a prompt, return text, throw a typed error
 * on any failure. Higher layers (planning engine) handle parsing the
 * structured output the prompts ask for.
 */
export interface LLMProvider {
  readonly name: 'claude' | 'codex';
  generate(prompt: string, opts?: { timeoutMs?: number }): Promise<string>;
}

export type LLMProviderErrorCode =
  | 'TIMEOUT'           // subprocess didn't exit within the timeout
  | 'NON_ZERO_EXIT'     // exited with a non-zero status
  | 'SPAWN_FAILED'      // OS-level spawn error (ENOENT, EACCES, etc.)
  | 'OVERFLOW'          // stdout exceeded the size cap
  | 'CIRCUIT_BREAKER'   // too many recent failures — fast-failing
  | 'INVALID_PROMPT';   // prompt failed length / type validation

export class LLMProviderError extends Error {
  public readonly code: LLMProviderErrorCode;
  public readonly providerName: string;
  constructor(providerName: string, code: LLMProviderErrorCode, message: string) {
    super(message);
    this.name = 'LLMProviderError';
    this.code = code;
    this.providerName = providerName;
  }
}
