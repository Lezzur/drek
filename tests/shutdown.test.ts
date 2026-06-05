import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() },
}));

import { createShutdownHandler } from '../src/shutdown.js';

describe('createShutdownHandler', () => {
  let killInflight: ReturnType<typeof vi.fn>;
  let exit: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    killInflight = vi.fn();
    exit = vi.fn();
  });

  it('kills in-flight LLM children with SIGKILL, closes the server, then exits 0', () => {
    let closeCb: (() => void) | undefined;
    const server = { close: vi.fn((cb?: () => void) => { closeCb = cb; }) };

    const shutdown = createShutdownHandler({ server, killInflight, exit });
    shutdown('SIGTERM');

    // In-flight children are force-killed before we stop accepting connections.
    expect(killInflight).toHaveBeenCalledWith('SIGKILL');
    expect(server.close).toHaveBeenCalledTimes(1);
    // Exit only happens once the server reports it closed.
    expect(exit).not.toHaveBeenCalled();
    closeCb!();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('is idempotent — a second signal forces exit(1) without re-killing or re-closing', () => {
    const server = { close: vi.fn() };
    const shutdown = createShutdownHandler({ server, killInflight, exit });

    shutdown('SIGTERM');
    expect(killInflight).toHaveBeenCalledTimes(1);
    expect(server.close).toHaveBeenCalledTimes(1);

    shutdown('SIGINT'); // second signal while already shutting down
    expect(exit).toHaveBeenCalledWith(1);
    // No second kill / close.
    expect(killInflight).toHaveBeenCalledTimes(1);
    expect(server.close).toHaveBeenCalledTimes(1);
  });

  it('force-exits 1 if server.close hangs past the timeout', () => {
    vi.useFakeTimers();
    try {
      const server = { close: vi.fn() }; // never invokes its callback
      const shutdown = createShutdownHandler({ server, killInflight, exit, timeoutMs: 5_000 });

      shutdown('SIGTERM');
      expect(exit).not.toHaveBeenCalled();
      vi.advanceTimersByTime(5_000);
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
