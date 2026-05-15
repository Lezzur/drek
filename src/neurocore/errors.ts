/**
 * Typed errors for the Neurocore client. Code maps to a class of failure so
 * higher layers (planning engine, polling cron, UI) can decide whether to
 * retry, degrade, or surface a specific message.
 */

export type NeurocoreErrorCode =
  | 'UNREACHABLE'         // network failure, DNS, connection refused, etc.
  | 'TIMEOUT'             // request didn't complete within the timeout
  | 'UNAUTHENTICATED'     // 401 — token missing/invalid
  | 'FORBIDDEN'           // 403 — token doesn't grant the required scope
  | 'NOT_FOUND'           // 404 — resource doesn't exist
  | 'INVALID_STATE'       // 409 — e.g. acking a listing that isn't video-required
  | 'BAD_REQUEST'         // 400/422 — request body failed validation
  | 'RATE_LIMITED'        // 429 — too many requests
  | 'DEGRADED'            // 503 — Neurocore returned partial result with degraded=true
  | 'SERVER_ERROR'        // 5xx (not 503) — Neurocore-side problem
  | 'INVALID_RESPONSE'    // body wasn't JSON or didn't match expected shape
  | 'NOT_CONFIGURED';     // NEUROCORE_TOKEN unset at call time

export class NeurocoreError extends Error {
  public readonly code: NeurocoreErrorCode;
  public readonly status: number | null;
  public readonly endpoint: string;
  constructor(
    code: NeurocoreErrorCode,
    endpoint: string,
    message: string,
    status: number | null = null,
  ) {
    super(message);
    this.name = 'NeurocoreError';
    this.code = code;
    this.status = status;
    this.endpoint = endpoint;
  }
}

/** Heuristic: is this error worth a retry? Network blips and transient 5xx
 *  yes; auth failures and 4xx body errors no — they'll just fail again. */
export function isRetryable(err: NeurocoreError): boolean {
  return (
    err.code === 'UNREACHABLE' ||
    err.code === 'TIMEOUT' ||
    err.code === 'SERVER_ERROR' ||
    err.code === 'RATE_LIMITED'
  );
}
