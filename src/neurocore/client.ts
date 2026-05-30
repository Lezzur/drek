import { getEnv } from '../env.js';
import { NeurocoreError } from './errors.js';
import { getSharedClient } from './_shared.js';
import type {
  ApprovedScriptSignal,
  BuildPlanEditedSignal,
  ContentCatalogCreatePayload,
  ContentCatalogListEntry,
  ContentCatalogResponse,
  CritiqueFindingEmittedSignal,
  CritiqueFindingOverriddenSignal,
  CritiqueUnavailableSignal,
  MemoryContextResponse,
  NeurocoreModelConfigResponse,
  PendingListing,
  PlanMode,
  PublishedScriptSignal,
  ReferenceHallucinationSignal,
  RevisedAfterCritiqueSignal,
  ScoreOverriddenSignal,
  UserEditedSignal,
} from './types.js';

const APP_ID = 'drek';
const IDEMPOTENCY_HEADER = 'Idempotency-Key';
const PENDING_VIDEO_PATH = '/v1/signals/pending-video';
const MODEL_CONFIG_PATH = '/v1/model-config';

/**
 * NeurocoreClient — DREK's domain-specific Neurocore facade.
 *
 * **Phase 2b migration:** this class is now a facade over
 * `@lezzur/neurocore-client`. The shared client owns HTTP transport,
 * auth, retry, abort-on-timeout, and idempotency-key injection. This
 * class preserves DREK's domain-specific method surface so the 57
 * call sites across DREK don't have to change yet.
 *
 * The public method signatures and return shapes are unchanged. Where
 * the shared client throws a `NeurocoreError` with its own code set,
 * this facade translates to DREK's `NeurocoreError` so existing
 * `catch (err) { if (err.code === '...') }` patterns keep matching.
 *
 * Every method now delegates to the shared client. (Previously `getModelConfig`
 * fell back to raw fetch because `/v1/model-config` wasn't on the v1.0 surface
 * yet — fixed by Lezzur/neurocore#10 which added `nc.getModelConfig()`.)
 *
 * Phase 2c migrates polling/service.ts to nc.createPollingLoop().
 * Phase 2d would delete this facade entirely and update call sites to import
 * the shared client directly — punted as low-value given the facade does
 * legitimate domain translation (error code mapping, payload validation,
 * idempotency-key formats).
 */
export class NeurocoreClient {
  private readonly baseUrl: string;
  private readonly token: string | null;
  private readonly timeoutMs: number;

  constructor(opts?: {
    baseUrl?: string;
    token?: string | null;
    timeoutMs?: number;
    retryBackoffMs?: number;
  }) {
    const env = getEnv();
    this.baseUrl = (opts?.baseUrl ?? env.NEUROCORE_URL).replace(/\/$/, '');
    this.token = opts && 'token' in opts ? opts.token ?? null : env.NEUROCORE_TOKEN ?? null;
    this.timeoutMs = opts?.timeoutMs ?? env.NEUROCORE_TIMEOUT_MS;
    // retryBackoffMs is accepted for backward-compat but ignored — shared
    // client owns retry policy now.
  }

  // ─── Read methods ─────────────────────────────────────────────────

  async getProjectContext(params: {
    planMode: PlanMode;
    contactId?: string;
    jobContextHint?: string;
    tokenBudget?: number;
  }): Promise<MemoryContextResponse> {
    const taskType =
      params.planMode === 'cover_letter' ? 'videoPlanCoverLetter' : 'videoPlanYoutube';
    return this.composeContext(taskType, params);
  }

  async getVoiceProfile(params: {
    planMode: PlanMode;
    contactId?: string;
    jobContextHint?: string;
    tokenBudget?: number;
  }): Promise<MemoryContextResponse> {
    const taskType =
      params.planMode === 'cover_letter' ? 'scriptCoverLetter' : 'scriptYoutube';
    return this.composeContext(taskType, params);
  }

  private async composeContext(
    taskType: string,
    params: { contactId?: string; jobContextHint?: string; tokenBudget?: number },
  ): Promise<MemoryContextResponse> {
    const nc = await getSharedClient();
    const body: Record<string, unknown> = {
      taskType,
      scope: {
        userId: 'rick',
        appId: APP_ID,
        ...(params.contactId ? { contactId: params.contactId } : {}),
      },
    };
    if (params.jobContextHint !== undefined) body.jobContextHint = params.jobContextHint;
    if (params.tokenBudget !== undefined) body.tokenBudget = params.tokenBudget;
    try {
      const composed = await nc.composeContext(body);
      // Shared client's ComposedContext is open-shape; DREK's response type
      // is strict. Cast through unknown — the wire data has the same fields,
      // shared client just doesn't pin them.
      return composed as unknown as MemoryContextResponse;
    } catch (err) {
      throw translate(err, '/v1/memory/context');
    }
  }

  async pollPendingSignals(): Promise<PendingListing[]> {
    const nc = await getSharedClient();
    try {
      const listings = await nc.pollPendingListings();
      // Shared client returns PendingListing[] from its own types; the field
      // shape matches DREK's PendingListing type since both mirror the
      // server's `listings` collection. Cast at the boundary.
      return listings as unknown as PendingListing[];
    } catch (err) {
      throw translate(err, PENDING_VIDEO_PATH);
    }
  }

  async ackSignal(memoryId: string): Promise<void> {
    if (!memoryId) {
      throw new NeurocoreError('BAD_REQUEST', PENDING_VIDEO_PATH, 'memoryId is required');
    }
    const nc = await getSharedClient();
    try {
      await nc.ackPendingListing(memoryId);
    } catch (err) {
      throw translate(err, `${PENDING_VIDEO_PATH}/${memoryId}/ack`);
    }
  }

  // ─── Signal-emit methods (fire-and-forget) ────────────────────────

  async sendApprovedScript(payload: ApprovedScriptSignal): Promise<void> {
    await this.emit('script.approved', payload, `drek-script-approved-${payload.planId}`);
  }

  async sendBuildPlanEdited(payload: BuildPlanEditedSignal): Promise<void> {
    await this.emit(
      'build_plan.edited',
      payload,
      `drek-build-plan-edited-${payload.briefId}-${payload.editedAt}`,
    );
  }

  async sendScoreOverridden(payload: ScoreOverriddenSignal): Promise<void> {
    await this.emit(
      'score.overridden',
      payload,
      `drek-score-overridden-${payload.briefId}-${payload.overriddenAt}`,
    );
  }

  async sendPublishedScript(payload: PublishedScriptSignal): Promise<void> {
    await this.emit('script.published', payload, `drek-script-published-${payload.deliverableId}`);
  }

  async sendCritiqueFindingEmitted(payload: CritiqueFindingEmittedSignal): Promise<void> {
    await this.emit(
      'plan.critique_finding_emitted',
      payload,
      `drek-finding-emitted-${payload.findingId}`,
    );
  }

  async sendCritiqueFindingOverridden(payload: CritiqueFindingOverriddenSignal): Promise<void> {
    await this.emit(
      'plan.critique_finding_overridden',
      payload,
      `drek-finding-overridden-${payload.findingId}-${payload.overriddenAt}`,
    );
  }

  async sendRevisedAfterCritique(payload: RevisedAfterCritiqueSignal): Promise<void> {
    const now = new Date().toISOString();
    await this.emit(
      'plan.revised_after_critique',
      payload,
      `drek-revised-${payload.briefId}-${now}`,
    );
  }

  async sendCritiqueUnavailable(payload: CritiqueUnavailableSignal): Promise<void> {
    const now = new Date().toISOString();
    await this.emit(
      'plan.critique_unavailable',
      payload,
      `drek-critique-unavailable-${payload.briefId}-${now}`,
    );
  }

  async sendUserEdited(payload: UserEditedSignal): Promise<void> {
    await this.emit(
      'plan.user_edited',
      payload,
      `drek-user-edited-${payload.briefId}-${payload.fieldPath}-${payload.editedAt}`,
    );
  }

  /**
   * Reference-hallucination signal. Accepts an optional `briefId` for
   * idempotency-key scoping; the wire payload strips it out so the server
   * only sees the canonical signal shape.
   */
  async sendReferenceHallucination(
    payload: ReferenceHallucinationSignal & { briefId?: string },
  ): Promise<void> {
    const now = new Date().toISOString();
    const briefScope = payload.briefId ?? 'unscoped';
    const wirePayload: Record<string, unknown> = {
      spoke: payload.spoke,
      operation: payload.operation,
      hallucinatedId: payload.hallucinatedId,
      expectedSetSize: payload.expectedSetSize,
    };
    if (payload.modelId !== undefined) wirePayload.modelId = payload.modelId;
    await this.emit(
      'llm.reference_hallucination_emitted',
      wirePayload,
      `drek-hallucination-${briefScope}-${payload.operation}-${payload.hallucinatedId}-${now}`,
    );
  }

  /** Single shared signal-emit codepath — preserves DREK's per-method
   *  idempotency-key formats while routing through the shared client. */
  private async emit(
    type: string,
    payload: object,
    idempotencyKey: string,
  ): Promise<void> {
    const nc = await getSharedClient();
    try {
      await nc.emitSignal({
        type,
        payload: payload as Record<string, unknown>,
        idempotencyKey,
      });
    } catch (err) {
      throw translate(err, '/v1/memory/signals');
    }
  }

  // ─── Entity write methods ─────────────────────────────────────────

  async createContentCatalog(
    payload: ContentCatalogCreatePayload,
  ): Promise<ContentCatalogResponse> {
    // Note: DREK's write-queue is the durability layer for content-catalog,
    // so we use direct `writeEntity` here, not `writeEntityQueued`. The
    // shared client's queue would double-queue otherwise.
    const nc = await getSharedClient();
    const body = payload as unknown as Record<string, unknown>;
    try {
      await nc.writeEntity('contentCatalog', 'create', body);
    } catch (err) {
      throw translate(err, '/v1/content-catalog');
    }
    // Shared client's writeEntity returns void; callers of this method use
    // the call to confirm success. The original returned the server body
    // (mostly unused by callers). We return a minimal shape that matches
    // the type — only `id` is consumed downstream in practice.
    return { profile: { id: payload.deliverableId } } as unknown as ContentCatalogResponse;
  }

  async listContentCatalog(opts?: {
    primaryTechStackId?: string;
    audienceProfileId?: string;
    limit?: number;
  }): Promise<{ profiles: ContentCatalogListEntry[] }> {
    const nc = await getSharedClient();
    // DREK's existing contract defaulted to sourceApp='drek'; shared client
    // dropped that default per v2.1 §13. Preserve DREK's filter explicitly.
    const filter: Record<string, string | number> = { sourceApp: APP_ID };
    if (opts?.primaryTechStackId) filter.primaryTechStackId = opts.primaryTechStackId;
    if (opts?.audienceProfileId) filter.audienceProfileId = opts.audienceProfileId;
    if (opts?.limit) filter.limit = opts.limit;
    let entries: unknown[];
    try {
      entries = await nc.contentCatalog.list(filter);
    } catch (err) {
      throw translate(err, '/v1/content-catalog');
    }
    return { profiles: entries as ContentCatalogListEntry[] };
  }

  async createStackPerformance(payload: {
    id: string;
    techStackProfileId: string;
    videoCount: number;
    avgViews: number;
    avgWatchTimeSeconds: number;
    avgCtr: number;
    totalRevenueUsd: number | null;
    lastVideoPublishedAt: string | null;
  }): Promise<{ entry: unknown }> {
    const nc = await getSharedClient();
    const body = payload as unknown as Record<string, unknown>;
    try {
      await nc.writeEntity('stackPerformance', 'create', body);
    } catch (err) {
      throw translate(err, '/v1/stack-performance');
    }
    return { entry: { id: payload.id } };
  }

  async getModelConfig(): Promise<NeurocoreModelConfigResponse> {
    const nc = await getSharedClient();
    try {
      // Shared client returns ModelConfigResponse which is structurally
      // identical to NeurocoreModelConfigResponse (same wire shape from
      // the same endpoint). Cast through unknown to satisfy the strict
      // type pin DREK has on its own type.
      return (await nc.getModelConfig()) as unknown as NeurocoreModelConfigResponse;
    } catch (err) {
      throw translate(err, MODEL_CONFIG_PATH);
    }
  }
}

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * Translate a shared-client error into DREK's NeurocoreError shape.
 * Preserves the existing `catch (err) { if (err.code === '...') }`
 * patterns scattered across DREK's call sites.
 */
function translate(err: unknown, endpoint: string): NeurocoreError {
  if (err instanceof NeurocoreError) return err;
  if (err && typeof err === 'object') {
    const e = err as { code?: string; message?: string; status?: number };
    const message = e.message ?? 'shared client error';
    const status = typeof e.status === 'number' ? e.status : null;
    const drekCode = sharedToDrekCode(e.code, status);
    return new NeurocoreError(drekCode, endpoint, message, status);
  }
  return new NeurocoreError('UNREACHABLE', endpoint, String(err));
}

function sharedToDrekCode(sharedCode: string | undefined, status: number | null): NeurocoreErrorCode {
  switch (sharedCode) {
    case 'NETWORK': return 'UNREACHABLE';
    case 'TIMEOUT': return 'TIMEOUT';
    case 'UNAUTHORIZED': return 'UNAUTHENTICATED';
    case 'FORBIDDEN': return 'FORBIDDEN';
    case 'NOT_FOUND': return 'NOT_FOUND';
    case 'CONFLICT': return 'INVALID_STATE';
    case 'VALIDATION': return 'BAD_REQUEST';
    case 'INTERNAL':
      // Shared client's INTERNAL covers 429 (rate-limited, retryable) + 5xx.
      if (status === 429) return 'RATE_LIMITED';
      return 'SERVER_ERROR';
    case 'NOT_CONFIGURED': return 'NOT_CONFIGURED';
    case 'DISABLED': return 'NOT_CONFIGURED';
    default:
      if (status && status >= 500) return 'SERVER_ERROR';
      if (status === 429) return 'RATE_LIMITED';
      return 'UNREACHABLE';
  }
}

// Need the type import alongside the runtime classes — re-import here so
// switch-case typing works without circular imports back into errors.ts.
import type { NeurocoreErrorCode } from './errors.js';

// ─── Singleton + test reset ─────────────────────────────────────────

let cachedClient: NeurocoreClient | null = null;

export function getNeurocoreClient(): NeurocoreClient {
  if (!cachedClient) cachedClient = new NeurocoreClient();
  return cachedClient;
}

export function _resetNeurocoreClientForTests(): void {
  cachedClient = null;
}

// IDEMPOTENCY_HEADER is no longer used internally (shared client owns the
// header) but exported for backward-compat with any test that asserts on it.
export { IDEMPOTENCY_HEADER };
