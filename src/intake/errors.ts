/**
 * Typed errors for the intake module (pipeline brief sourcing + promote
 * flow). Route handlers route on `code` to translate to HTTP responses
 * and user-visible flash messages.
 */

export type IntakeErrorCode =
  | 'BRIEF_NOT_FOUND'
  | 'BRIEF_ALREADY_PROMOTED'
  | 'BRIEF_MISSING_SCORE'         // promote requires scoring per Rick's day-one rule
  | 'INVALID_STAGE_TRANSITION'
  | 'UNKNOWN_FORMAT_PROFILE'
  | 'UNKNOWN_AUDIENCE_PROFILE'
  | 'LLM_FAILED'
  | 'INVALID_OUTPUT'              // LLM scoring output didn't parse after retry
  | 'PERSIST_FAILED';

export class IntakeError extends Error {
  public readonly code: IntakeErrorCode;
  public readonly briefId: string | null;
  public readonly detail: unknown;
  constructor(
    code: IntakeErrorCode,
    message: string,
    opts?: { briefId?: string | null; detail?: unknown },
  ) {
    super(message);
    this.name = 'IntakeError';
    this.code = code;
    this.briefId = opts?.briefId ?? null;
    this.detail = opts?.detail;
  }
}
