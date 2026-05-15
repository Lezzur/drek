import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';

// Fake ChildProcess we can drive from each test. Mirrors the surface the
// runner touches: stdin.end, stdout/stderr emitters, kill(), 'close'/'error'.
class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = { end: vi.fn() };
  kill = vi.fn();
  emitData(chunk: string): void {
    this.stdout.emit('data', Buffer.from(chunk));
  }
  emitStderr(chunk: string): void {
    this.stderr.emit('data', Buffer.from(chunk));
  }
  emitClose(code: number): void {
    this.emit('close', code);
  }
  emitError(err: Error): void {
    this.emit('error', err);
  }
}

// Every call to spawn() creates a fresh FakeChild and records it. Tests reach
// in via `spawnedChildren[N]` to drive the Nth spawned process. We also
// install per-spawn handlers via `onSpawn` so a test can react synchronously
// to a spawn (e.g., auto-fail every attempt for the circuit-breaker test).
const spawnedChildren: FakeChild[] = [];
const spawnCalls: Array<{ bin: string; args: string[] }> = [];
let onSpawn: ((child: FakeChild, index: number) => void) | null = null;

vi.mock('node:child_process', () => ({
  spawn: vi.fn((bin: string, args: string[]) => {
    spawnCalls.push({ bin, args });
    const child = new FakeChild();
    const index = spawnedChildren.length;
    spawnedChildren.push(child);
    if (onSpawn) {
      const handler = onSpawn;
      // Defer so the runner can install its listeners before we emit.
      setImmediate(() => handler(child, index));
    }
    return child;
  }),
}));

// Silent logger so tests don't spam stdout.
vi.mock('../../src/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  },
}));

import { runCli, _resetBreakerForTests } from '../../src/providers/cli-runner.js';

beforeEach(() => {
  spawnedChildren.length = 0;
  spawnCalls.length = 0;
  onSpawn = null;
  _resetBreakerForTests();
});

/** Wait for the next FakeChild to appear (microtask race against runCli). */
async function nextSpawn(after: number): Promise<FakeChild> {
  while (spawnedChildren.length <= after) {
    await new Promise((r) => setImmediate(r));
  }
  return spawnedChildren[after]!;
}

describe('runCli — input validation', () => {
  it('rejects a non-string prompt with INVALID_PROMPT', async () => {
    await expect(
      runCli({ providerName: 'claude', bin: 'claude', args: [] }, 123 as unknown as string, 1000),
    ).rejects.toMatchObject({ code: 'INVALID_PROMPT', providerName: 'claude' });
  });

  it('rejects an empty prompt', async () => {
    await expect(
      runCli({ providerName: 'claude', bin: 'claude', args: [] }, '', 1000),
    ).rejects.toMatchObject({ code: 'INVALID_PROMPT' });
  });
});

describe('runCli — happy path', () => {
  it('returns the captured stdout on exit 0 and pipes prompt to stdin', async () => {
    const p = runCli(
      { providerName: 'claude', bin: 'claude', args: ['-p', '--model', 'X'] },
      'hi',
      5000,
    );
    const child = await nextSpawn(0);
    child.emitData('{"voice":"ok"}');
    child.emitClose(0);
    await expect(p).resolves.toBe('{"voice":"ok"}');
    expect(child.stdin.end).toHaveBeenCalledWith('hi', 'utf8');
    expect(spawnCalls[0]?.args).toEqual(['-p', '--model', 'X']);
  });
});

describe('runCli — failure paths', () => {
  it('retries once on non-zero exit then throws NON_ZERO_EXIT', async () => {
    onSpawn = (child) => {
      child.emitStderr('boom');
      child.emitClose(1);
    };
    await expect(
      runCli({ providerName: 'codex', bin: 'codex', args: ['exec'] }, 'hi', 5000),
    ).rejects.toMatchObject({ code: 'NON_ZERO_EXIT', providerName: 'codex' });
    expect(spawnCalls).toHaveLength(2);
  });

  it('throws SPAWN_FAILED on a spawn error from the OS', async () => {
    onSpawn = (child) => {
      child.emitError(Object.assign(new Error('ENOENT claude'), { code: 'ENOENT' }));
    };
    await expect(
      runCli({ providerName: 'claude', bin: 'claude', args: [] }, 'hi', 5000),
    ).rejects.toMatchObject({ code: 'SPAWN_FAILED', providerName: 'claude' });
  });
});

describe('runCli — .cmd shim routing', () => {
  it('routes a .cmd shim through cmd.exe /c', async () => {
    const p = runCli(
      { providerName: 'claude', bin: 'C:\\bin\\claude.cmd', args: ['-p'] },
      'hi',
      5000,
    );
    const child = await nextSpawn(0);
    child.emitData('ok');
    child.emitClose(0);
    await p;
    expect(spawnCalls[0]?.bin).toBe('cmd.exe');
    expect(spawnCalls[0]?.args).toEqual(['/c', 'C:\\bin\\claude.cmd', '-p']);
  });

  it('routes a plain binary directly (no cmd.exe wrapper)', async () => {
    const p = runCli(
      { providerName: 'claude', bin: 'claude', args: ['-p'] },
      'hi',
      5000,
    );
    const child = await nextSpawn(0);
    child.emitData('ok');
    child.emitClose(0);
    await p;
    expect(spawnCalls[0]?.bin).toBe('claude');
    expect(spawnCalls[0]?.args).toEqual(['-p']);
  });
});

describe('runCli — circuit breaker', () => {
  it('opens after 3 failed runCli calls, then fast-fails further attempts', async () => {
    // Auto-fail every spawn: emit a non-zero exit. Each runCli call retries
    // once, so each call triggers 2 failed spawns. After 3 such call-level
    // failures the per-provider breaker should be open.
    onSpawn = (child) => child.emitClose(1);
    const config = { providerName: 'claude' as const, bin: 'claude', args: [] };

    for (let call = 0; call < 3; call++) {
      await expect(runCli(config, 'hi', 5000)).rejects.toMatchObject({
        providerName: 'claude',
      });
    }
    // Next call should fast-fail before spawning anything.
    const spawnsBefore = spawnCalls.length;
    await expect(runCli(config, 'hi', 5000)).rejects.toMatchObject({
      code: 'CIRCUIT_BREAKER',
    });
    expect(spawnCalls.length).toBe(spawnsBefore);
  });

  it('breaks per provider — a flaky claude does not fast-fail codex', async () => {
    onSpawn = (child, idx) => {
      // Fail all claude calls, succeed all codex calls.
      const spawnedBin = spawnCalls[idx]?.bin;
      if (spawnedBin === 'claude') {
        child.emitClose(1);
      } else if (spawnedBin === 'codex') {
        child.emitData('codex ok');
        child.emitClose(0);
      }
    };
    const claudeCfg = { providerName: 'claude' as const, bin: 'claude', args: [] };
    const codexCfg = { providerName: 'codex' as const, bin: 'codex', args: [] };

    for (let i = 0; i < 3; i++) {
      await expect(runCli(claudeCfg, 'hi', 5000)).rejects.toBeDefined();
    }
    // Claude breaker should now be open; codex should still work.
    await expect(runCli(claudeCfg, 'hi', 5000)).rejects.toMatchObject({
      code: 'CIRCUIT_BREAKER',
    });
    await expect(runCli(codexCfg, 'hi', 5000)).resolves.toBe('codex ok');
  });
});
