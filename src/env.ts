import { config } from 'dotenv';
import { z } from 'zod';

config();

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3003),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  // Firestore credentials. Firebase Admin SDK auto-detects
  // GOOGLE_APPLICATION_CREDENTIALS, but we also read it ourselves so we can
  // fail fast with a clear message when the file is missing in production.
  GOOGLE_APPLICATION_CREDENTIALS: z.string().optional(),

  GCP_PROJECT_ID: z.string().min(1, 'GCP_PROJECT_ID is required'),

  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Pure, side-effect-free env parser. Throws on invalid input. Accepts a
 * source object so tests can pass synthetic envs without polluting
 * process.env or fighting module-load order.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const errors = parsed.error.flatten().fieldErrors;
    throw new Error(`Invalid environment: ${JSON.stringify(errors, null, 2)}`);
  }
  if (!parsed.data.GOOGLE_APPLICATION_CREDENTIALS && parsed.data.NODE_ENV !== 'test') {
    throw new Error(
      'GOOGLE_APPLICATION_CREDENTIALS must point to the DREK Firestore service-account JSON',
    );
  }
  return parsed.data;
}

/**
 * Memoized env loader. First call validates process.env; subsequent calls
 * return the cached result. This is lazy so importing env.ts in a test file
 * doesn't immediately blow up over a missing GCP_PROJECT_ID — only the code
 * paths that actually need env trigger validation.
 */
let cached: Env | null = null;
export function getEnv(): Env {
  if (!cached) cached = loadEnv();
  return cached;
}

/** Test-only: reset the memoized env so a test can swap it in. */
export function _resetEnvForTests(): void {
  cached = null;
}
