import { spawn, type ChildProcess } from 'node:child_process';
import { logger } from '../logger.js';
import { LLMProviderError } from './types.js';

/**
 * Hardened subprocess wrapper shared by ClaudeCLIProvider and CodexCLIProvider.
 *
 * Mirrors the pattern Neurocore and Prospect Intelligence both use for their
 * Claude CLI calls — known-stable on Windows where most of the sharp edges
 * live (8191-char command line limit, .cmd shim routing, ghost children when
 * SIGTERM is ignored).
 *
 * What it does for free:
 *   - prompt over stdin (never on the command line)
 *   - .cmd / .bat shim detection → routed via cmd.exe /c
 *   - windowsHide so subprocesses don't pop console windows
 *   - stdout cap (1 MB) and stderr cap (8 KB) with overflow detection
 *   - SIGTERM → 2s grace → SIGKILL
 *   - retry once on transient failure
 *   - circuit breaker: 3 failures in 60s opens a 60s break
 *   - stderr sanitization (scrub API-key-shaped tokens and absolute paths)
 */

export interface CliConfig {
  /** Provider name used in error messages and logs. */
  providerName: 'claude' | 'codex';
  /** Path or name of the CLI binary. */
  bin: string;
  /** Args passed to the CLI (e.g. `-p --model X`). Prompt is NOT in here. */
  args: string[];
  /** Optional extra metadata logged on every invocation. */
  logMeta?: Record<string, unknown>;
}

const STDOUT_CAP_BYTES = 1024 * 1024;
const STDERR_CAP_BYTES = 8 * 1024;
const STDERR_LOG_MAX = 500;
const MIN_PROMPT_LEN = 1;
const MAX_PROMPT_LEN = 200_000;
const SIGTERM_GRACE_MS = 2_000;
const MAX_ATTEMPTS = 2;
// Short pause before a retry so a transiently overloaded CLI host isn't hit
// twice back-to-back (which would also trip the circuit breaker faster).
const RETRY_BACKOFF_MS = 750;

const FAILURE_WINDOW_MS = 60_000;
const FAILURE_THRESHOLD = 3;
const BREAK_DURATION_MS = 60_000;

// Per-provider circuit-breaker state. Keyed by providerName so that a flaky
// Claude install doesn't fast-fail Codex calls (and vice versa).
const breakerState = new Map<string, { failures: number[]; breakUntil: number }>();

function getBreaker(name: string) {
  let s = breakerState.get(name);
  if (!s) {
    s = { failures: [], breakUntil: 0 };
    breakerState.set(name, s);
  }
  return s;
}

function recordFailure(name: string): void {
  const s = getBreaker(name);
  const now = Date.now();
  while (s.failures.length > 0 && s.failures[0]! < now - FAILURE_WINDOW_MS) {
    s.failures.shift();
  }
  s.failures.push(now);
  if (s.failures.length >= FAILURE_THRESHOLD) {
    s.breakUntil = now + BREAK_DURATION_MS;
  }
}

function recordSuccess(name: string): void {
  const s = getBreaker(name);
  s.failures.length = 0;
  s.breakUntil = 0;
}

function circuitOpen(name: string): boolean {
  return Date.now() < getBreaker(name).breakUntil;
}

/** Test-only: clear the circuit breaker between tests. */
export function _resetBreakerForTests(): void {
  breakerState.clear();
}

const activeChildren = new Set<ChildProcess>();

function isCmdShim(bin: string): boolean {
  const lower = bin.toLowerCase();
  return lower.endsWith('.cmd') || lower.endsWith('.bat');
}

function sanitizeStderr(raw: string): string {
  let out = raw;
  // Scrub anything that looks like an API key / refresh token.
  out = out.replace(/[A-Za-z0-9_\-]{24,}/g, '[REDACTED]');
  out = out.replace(/[A-Za-z]:[\\/][^\s'"<>]*/g, '[PATH]');
  out = out.replace(/(^|[\s'"(<])\/[^\s'"<>:]+/g, '$1[PATH]');
  out = out.replace(/\s+/g, ' ').trim();
  if (out.length > STDERR_LOG_MAX) {
    out = '...' + out.slice(out.length - (STDERR_LOG_MAX - 3));
  }
  return out;
}

interface Outcome {
  stdout: string;
  exitCode: number;
  stderrTail: string;
  timedOut: boolean;
  overflowed: boolean;
  spawnFailed: boolean;
  durationMs: number;
}

function spawnOnce(config: CliConfig, prompt: string, timeoutMs: number): Promise<Outcome> {
  return new Promise<Outcome>((resolve) => {
    const startedAt = Date.now();
    let timedOut = false;
    let overflowed = false;
    let spawnFailed = false;
    let killTimer: NodeJS.Timeout | null = null;
    const stdoutChunks: Buffer[] = [];
    let stdoutLen = 0;
    const stderrChunks: Buffer[] = [];
    let stderrLen = 0;
    let settled = false;

    const [spawnBin, baseArgs]: [string, string[]] = isCmdShim(config.bin)
      ? ['cmd.exe', ['/c', config.bin]]
      : [config.bin, []];

    const child = spawn(spawnBin, [...baseArgs, ...config.args], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
    activeChildren.add(child);

    child.stdin?.end(prompt, 'utf8');

    const armKill = () => {
      try {
        child.kill('SIGTERM');
      } catch {
        // already exited
      }
      if (killTimer === null) {
        killTimer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            // already exited
          }
        }, SIGTERM_GRACE_MS);
        if (typeof killTimer.unref === 'function') killTimer.unref();
      }
    };

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      armKill();
    }, timeoutMs);
    if (typeof timeoutTimer.unref === 'function') timeoutTimer.unref();

    child.stdout?.on('data', (chunk: Buffer) => {
      if (overflowed) return;
      if (stdoutLen + chunk.length > STDOUT_CAP_BYTES) {
        overflowed = true;
        stdoutChunks.length = 0;
        stdoutLen = 0;
        armKill();
        return;
      }
      stdoutChunks.push(chunk);
      stdoutLen += chunk.length;
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderrLen >= STDERR_CAP_BYTES) return;
      const remaining = STDERR_CAP_BYTES - stderrLen;
      if (chunk.length > remaining) {
        stderrChunks.push(chunk.subarray(0, remaining));
        stderrLen = STDERR_CAP_BYTES;
      } else {
        stderrChunks.push(chunk);
        stderrLen += chunk.length;
      }
    });

    const settle = (outcome: Outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      activeChildren.delete(child);
      resolve(outcome);
    };

    child.on('error', (err: NodeJS.ErrnoException) => {
      spawnFailed = true;
      settle({
        stdout: '',
        exitCode: -1,
        stderrTail: sanitizeStderr(err.message || 'spawn error'),
        timedOut,
        overflowed,
        spawnFailed,
        durationMs: Date.now() - startedAt,
      });
    });

    child.on('close', (code) => {
      const stdout = overflowed ? '' : Buffer.concat(stdoutChunks).toString('utf8');
      const stderrTail = sanitizeStderr(Buffer.concat(stderrChunks).toString('utf8'));
      const exitCode = code === null ? -1 : code;
      settle({
        stdout,
        exitCode,
        stderrTail,
        timedOut,
        overflowed,
        spawnFailed,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

/**
 * Run a CLI with `prompt` on stdin, returning captured stdout. Retries once
 * on transient failure. Throws `LLMProviderError` on terminal failure or
 * when the circuit breaker is open.
 */
export async function runCli(
  config: CliConfig,
  prompt: string,
  timeoutMs: number,
): Promise<string> {
  if (typeof prompt !== 'string') {
    throw new LLMProviderError(config.providerName, 'INVALID_PROMPT', 'prompt must be a string');
  }
  if (prompt.length < MIN_PROMPT_LEN || prompt.length > MAX_PROMPT_LEN) {
    throw new LLMProviderError(
      config.providerName,
      'INVALID_PROMPT',
      `prompt length ${prompt.length} out of range [${MIN_PROMPT_LEN}, ${MAX_PROMPT_LEN}]`,
    );
  }
  if (circuitOpen(config.providerName)) {
    throw new LLMProviderError(
      config.providerName,
      'CIRCUIT_BREAKER',
      `${config.providerName} CLI circuit-broken after rapid failures`,
    );
  }

  let lastDetail = '';
  let lastCode: 'TIMEOUT' | 'NON_ZERO_EXIT' | 'SPAWN_FAILED' | 'OVERFLOW' = 'NON_ZERO_EXIT';

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (circuitOpen(config.providerName)) {
      throw new LLMProviderError(
        config.providerName,
        'CIRCUIT_BREAKER',
        `${config.providerName} CLI circuit-broken after rapid failures`,
      );
    }
    const outcome = await spawnOnce(config, prompt, timeoutMs);
    logger.info(
      {
        provider: config.providerName,
        durationMs: outcome.durationMs,
        exitCode: outcome.exitCode,
        attempt,
        timedOut: outcome.timedOut,
        ...config.logMeta,
      },
      'llm cli invocation',
    );
    if (
      !outcome.timedOut &&
      !outcome.overflowed &&
      !outcome.spawnFailed &&
      outcome.exitCode === 0
    ) {
      recordSuccess(config.providerName);
      return outcome.stdout;
    }
    if (outcome.overflowed) {
      lastDetail = `stdout exceeded ${STDOUT_CAP_BYTES / 1024 / 1024}MB cap`;
      lastCode = 'OVERFLOW';
    } else if (outcome.timedOut) {
      lastDetail = `timeout after ${timeoutMs}ms`;
      lastCode = 'TIMEOUT';
    } else if (outcome.spawnFailed) {
      lastDetail = outcome.stderrTail || 'spawn failed';
      lastCode = 'SPAWN_FAILED';
    } else {
      lastDetail = outcome.stderrTail || `exit ${outcome.exitCode}`;
      lastCode = 'NON_ZERO_EXIT';
    }
    recordFailure(config.providerName);
    // Back off before the next attempt (not after the final one).
    if (attempt < MAX_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS));
    }
  }

  throw new LLMProviderError(
    config.providerName,
    lastCode,
    `${config.providerName} CLI failed: ${lastDetail}`,
  );
}

/** Send SIGTERM (or another signal) to every CLI subprocess we still have a
 *  handle on. Useful on graceful shutdown. */
export function killAllInflight(signal: NodeJS.Signals = 'SIGTERM'): void {
  for (const child of activeChildren) {
    try {
      child.kill(signal);
    } catch {
      // best-effort
    }
  }
}
