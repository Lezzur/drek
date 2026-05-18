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

  // --- LLM provider (M1) ----------------------------------------------------
  // Active provider. Selected once at startup, application-wide.
  LLM_PROVIDER: z.enum(['claude', 'codex']).default('claude'),

  // Wall-clock cap on a single subprocess call. The four-step pipeline runs
  // each step sequentially, so this is also the per-step timeout.
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),

  // Path/name of the Claude CLI binary. Defaults to `claude` (resolved via
  // PATH). On Windows, point at the .cmd shim — the wrapper detects .cmd/.bat
  // and routes via cmd.exe.
  CLAUDE_BIN: z.string().min(1).default('claude'),
  CLAUDE_MODEL: z.string().min(1).default('claude-sonnet-4-5'),

  // Path/name of the Codex CLI binary plus its model. Same .cmd-shim handling
  // as Claude. Default model is a placeholder — set CODEX_MODEL to whatever
  // your installed Codex CLI actually accepts.
  CODEX_BIN: z.string().min(1).default('codex'),
  CODEX_MODEL: z.string().min(1).default('gpt-5-codex'),

  // --- Neurocore client (M2) ------------------------------------------------
  // Base URL of the Neurocore HTTP service. Loopback by default since DREK is
  // co-located with Neurocore on Rick's Windows host.
  NEUROCORE_URL: z.string().url().default('http://localhost:3100'),

  // Bearer token issued for DREK by Neurocore's /v1/admin/tokens endpoint.
  // Required only when DREK actually talks to Neurocore — most unit tests
  // mock the client, so we keep this optional and let the client throw a
  // clear UNAUTHENTICATED error if it's missing at call time.
  NEUROCORE_TOKEN: z.string().min(1).optional(),

  // Wall-clock cap on a single Neurocore HTTP call. Single retry on top, so
  // worst-case wait is ~2× this + 2s backoff.
  NEUROCORE_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),

  // --- Model catalog (M1.5) -------------------------------------------------
  // Optional. If unset, the model-refresh cron skips that provider with a
  // logged warning — the catalog endpoint still returns whatever was last
  // cached, so DREK keeps working with the env-pinned CLAUDE_MODEL/CODEX_MODEL.
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),

  // How often the cron checks for new models. Default 24h; lower it if you
  // want faster pickup, raise it to spare the upstream rate limit.
  MODEL_REFRESH_INTERVAL_HOURS: z.coerce.number().int().positive().default(24),

  // --- Listing polling (M9) -------------------------------------------------
  // How often DREK asks Neurocore for new PI listings. Default 30 minutes
  // matches PRD §4.1. Manual "Check now" from the dashboard bypasses this.
  POLLING_INTERVAL_MS: z.coerce.number().int().positive().default(30 * 60 * 1000),

  // --- v2 Workspace module (M21) --------------------------------------------
  // Absolute path to the directory where per-plan folders are created. Each
  // youtube_advanced plan gets `${WORKSPACE_ROOT}/${planId}-${slug}/` on
  // creation. Optional in env so tests + non-Windows hosts can run without
  // configuring it — the workspace module surfaces a degraded health check
  // when unset rather than crashing on startup.
  WORKSPACE_ROOT: z.string().optional(),
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
