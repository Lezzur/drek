/**
 * YouTubeError — typed errors for the YouTube client. Mirrors the
 * NeurocoreError shape so callers can switch on `code` without learning a
 * second taxonomy.
 *
 * Codes per TECH-SPEC-drek-v2.1-content-substrate-2026-05-19.md §4 Piece 5.
 */

export type YouTubeErrorCode =
  | 'NOT_CONFIGURED'   // env vars missing — client can't even attempt
  | 'AUTH_FAILED'      // refresh token rejected, bad client id/secret
  | 'QUOTA_EXCEEDED'   // local counter at the cap OR upstream 403 with quotaExceeded
  | 'NOT_FOUND'        // 404 — video/channel doesn't exist
  | 'EMPTY_CHANNEL'    // 403 from analytics on a channel with no data
  | 'FORBIDDEN'        // other 403 — usually scope or permission
  | 'UNREACHABLE'      // fetch failed before getting a response
  | 'TIMEOUT'          // request exceeded YOUTUBE_TIMEOUT_MS
  | 'INVALID_RESPONSE' // response body wasn't valid JSON or shape mismatch
  | 'SERVER_ERROR';    // 5xx

export class YouTubeError extends Error {
  public readonly code: YouTubeErrorCode;
  public readonly endpoint: string;
  public readonly status: number | null;
  public readonly detail?: unknown;
  constructor(
    code: YouTubeErrorCode,
    endpoint: string,
    message: string,
    opts?: { status?: number | null; detail?: unknown },
  ) {
    super(message);
    this.name = 'YouTubeError';
    this.code = code;
    this.endpoint = endpoint;
    this.status = opts?.status ?? null;
    if (opts?.detail !== undefined) this.detail = opts.detail;
  }
}

/** Retry policy: same as Neurocore — server errors + network blips retry
 *  once. Quota/auth/4xx are terminal. */
export function isRetryable(err: YouTubeError): boolean {
  return (
    err.code === 'UNREACHABLE' ||
    err.code === 'TIMEOUT' ||
    err.code === 'SERVER_ERROR'
  );
}
