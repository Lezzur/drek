import pino from 'pino';
import { getEnv } from './env.js';

// Structured JSON to stdout. pm2 captures stdout; for local dev, pipe the
// process through `pino-pretty` if you want colorized output:
//   npm run dev | npx pino-pretty
//
// Lazy: created on first access so importing this module doesn't force env
// validation. The first access is from server.ts at request time.
let cached: pino.Logger | null = null;
export function getLogger(): pino.Logger {
  if (!cached) {
    cached = pino({
      level: getEnv().LOG_LEVEL,
      base: { service: 'drek' },
      // Defense-in-depth: no call site logs a secret today, but redact common
      // credential paths so a future `logger.info({ err })` that happens to
      // capture headers/env can't leak tokens.
      redact: {
        paths: [
          'token',
          'authorization',
          '*.token',
          '*.authorization',
          '*.refresh_token',
          '*.access_token',
          '*.client_secret',
          '*.apiKey',
          '*.NEUROCORE_TOKEN',
          'headers.authorization',
        ],
        censor: '[REDACTED]',
      },
    });
  }
  return cached;
}

// Thin proxy for ergonomic `logger.info(...)` style usage. Defers actual
// construction until the first method call.
type AnyFn = (...args: unknown[]) => unknown;
export const logger: pino.Logger = new Proxy({} as pino.Logger, {
  get(_target, prop) {
    const inner = getLogger();
    const value = (inner as unknown as Record<string | symbol, unknown>)[prop];
    return typeof value === 'function' ? (value as AnyFn).bind(inner) : value;
  },
});
