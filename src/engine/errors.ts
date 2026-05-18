/**
 * Typed errors for the planning engine (the four LLM-driven steps that turn
 * a listing into a video plan). Higher layers (route handlers, UI) route on
 * `code` to decide whether to retry, dismiss, or surface a specific
 * actionable message to Rick.
 */

export type PlanningEngineErrorCode =
  // ---- Input / state errors --------------------------------------------
  | 'PLAN_NOT_FOUND'                // planId didn't resolve to a doc
  | 'WRONG_PLAN_TYPE'               // step doesn't apply to this plan.type
  | 'WRONG_PLAN_STATUS'             // plan.status isn't in an allowed-entry state
  | 'DISALLOWED_TRANSITION'         // target status not reachable from current
  | 'NO_LISTING_TEXT'               // requirement detection needs sourceListingText
  | 'NO_REQUIREMENTS'               // project matching needs a confirmed requirement set
  | 'NO_PROJECT_MATCHES'            // scene/script generation needs matched projects
  // ---- v2 pre-condition errors -----------------------------------------
  | 'NO_PIPELINE_BRIEF'             // youtube_advanced detect-requirements needs pipelineBriefId
  | 'NO_FORMAT_PROFILE'             // youtube_advanced steps need a formatProfileId on the plan
  | 'NO_LONG_FORM_DELIVERABLE'      // youtube_advanced steps need the long_form Deliverable
  | 'CANNOT_CHANGE_AFTER_PUBLISH'   // change-format rejected: plan already exported/published
  | 'UNKNOWN_FORMAT_PROFILE'        // change-format rejected: unknown formatProfileId
  | 'HOOK_NOT_FOUND'                // hookId doesn't exist under this plan
  // ---- LLM-level failures ---------------------------------------------
  | 'LLM_FAILED'               // underlying CLI subprocess failure (timeout, exit, etc.)
  | 'INVALID_OUTPUT'           // LLM output didn't parse / didn't match schema
                               // after the retry budget was exhausted
  // ---- Persistence ----------------------------------------------------
  | 'PERSIST_FAILED';          // Firestore write failed

export class PlanningEngineError extends Error {
  public readonly code: PlanningEngineErrorCode;
  public readonly step: string;
  public readonly planId: string | null;
  /** Optional structured detail (e.g., zod issues, llm error code). */
  public readonly detail: unknown;
  constructor(
    step: string,
    code: PlanningEngineErrorCode,
    message: string,
    opts?: { planId?: string | null; detail?: unknown },
  ) {
    super(message);
    this.name = 'PlanningEngineError';
    this.code = code;
    this.step = step;
    this.planId = opts?.planId ?? null;
    this.detail = opts?.detail;
  }
}
