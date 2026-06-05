import { logger } from './logger.js';
import { killAllInflight } from './providers/index.js';

/** Minimal shape of the server we need to close — keeps this unit testable
 *  without pulling in the @hono/node-server types. */
export interface ClosableServer {
  close(callback?: () => void): void;
}

export interface ShutdownDeps {
  server: ClosableServer;
  /** Override the in-flight LLM child killer (injected in tests). */
  killInflight?: (signal: NodeJS.Signals) => void;
  /** Override process.exit (injected in tests). */
  exit?: (code: number) => void;
  /** Force-exit timeout in ms. */
  timeoutMs?: number;
}

/**
 * Build the graceful-shutdown handler. On a deploy/restart signal it kills any
 * in-flight LLM CLI children (otherwise they orphan — and on Windows the
 * cmd.exe shim leaks too), stops accepting connections, then exits. A second
 * signal or the timeout forces exit so a hung `server.close()` can't wedge the
 * shutdown.
 *
 * Extracted from index.ts (which has import-time side effects) so the logic is
 * unit-testable with injected fakes — Windows can't deliver SIGINT/SIGTERM to a
 * detached process from a script, so a signal-based integration test would be
 * unreliable. Under NSSM (console Ctrl-C → SIGINT) and on POSIX it fires for real.
 */
export function createShutdownHandler(deps: ShutdownDeps): (signal: NodeJS.Signals) => void {
  const killInflight = deps.killInflight ?? killAllInflight;
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const timeoutMs = deps.timeoutMs ?? 10_000;
  let shuttingDown = false;

  return function shutdown(signal: NodeJS.Signals): void {
    if (shuttingDown) {
      logger.warn({ signal }, 'second shutdown signal — forcing exit');
      exit(1);
      return;
    }
    shuttingDown = true;
    logger.info({ signal }, 'shutting down: killing in-flight LLM children');
    killInflight('SIGKILL');
    const forceTimer = setTimeout(() => {
      logger.warn('shutdown timed out — forcing exit');
      exit(1);
    }, timeoutMs);
    forceTimer.unref();
    deps.server.close(() => {
      logger.info('server closed cleanly');
      exit(0);
    });
  };
}
