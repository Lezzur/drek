/**
 * Critique findings store (M36 Phase 2.5).
 *
 * Top-level Firestore collection `critique_findings`. One document per
 * finding emitted by the production-realism critic. Findings outlive the
 * single critique run that produced them so users can review/override
 * later; that's why they're a separate collection rather than embedded
 * inside the brief document.
 *
 * Query patterns supported:
 *   - per-brief list (newest first) for the detail view → composite index
 *     critique_findings(briefId ASC, createdAt DESC)
 *   - per-brief unresolved count for the list-view badge → same index
 *     filters by status === 'unresolved' in-memory; the page sizes are
 *     small enough that we don't need a status-keyed composite yet
 *   - cross-brief "unresolved high-severity" sweep for ops dashboards →
 *     composite index critique_findings(status ASC, severity ASC, createdAt DESC)
 */

import type { Firestore } from 'firebase-admin/firestore';
import { getDb } from './firestore.js';
import { makeId } from './ids.js';
import {
  critiqueFindingSchema,
  type CritiqueFinding,
  type CritiqueFindingCreate,
  type CritiqueFindingStatus,
  type CritiqueSeverity,
} from './schemas.js';

const COLLECTION = 'critique_findings';

function tsToDate(v: unknown): Date {
  if (v instanceof Date) return v;
  const maybe = v as { toDate?: () => Date };
  return typeof maybe?.toDate === 'function' ? maybe.toDate() : new Date(0);
}

function tsToDateOrNull(v: unknown): Date | null {
  if (v === null || v === undefined) return null;
  return tsToDate(v);
}

function docToFinding(id: string, data: Record<string, unknown>): CritiqueFinding {
  return critiqueFindingSchema.parse({
    id,
    briefId: data.briefId,
    criterionId: data.criterionId,
    severity: data.severity,
    confidence: data.confidence,
    issue: data.issue,
    suggestedFix: data.suggestedFix,
    stepRef: (data.stepRef as string | null) ?? null,
    status: data.status,
    overrideReason: (data.overrideReason as string | null) ?? null,
    overrideAt: tsToDateOrNull(data.overrideAt),
    resolvedAt: tsToDateOrNull(data.resolvedAt),
    criteriaVersion: data.criteriaVersion,
    modelUsed: data.modelUsed,
    createdAt: tsToDate(data.createdAt),
  });
}

/**
 * Persist a batch of findings produced by one critique run. Atomic batch
 * write so a partial failure leaves nothing in the database.
 *
 * Initial status is `unresolved` for every finding; the revisor pass
 * (Phase 2.6 integration) updates the ones it actually applied via
 * `markAppliedByRevisor`.
 */
export async function persistFindings(
  inputs: CritiqueFindingCreate[],
  db: Firestore = getDb(),
): Promise<CritiqueFinding[]> {
  if (inputs.length === 0) return [];

  const now = new Date();
  const batch = db.batch();
  const created: CritiqueFinding[] = [];

  for (const input of inputs) {
    const id = makeId('finding');
    const ref = db.collection(COLLECTION).doc(id);
    const doc = {
      briefId: input.briefId,
      criterionId: input.criterionId,
      severity: input.severity,
      confidence: input.confidence,
      issue: input.issue,
      suggestedFix: input.suggestedFix,
      stepRef: input.stepRef ?? null,
      status: 'unresolved' as CritiqueFindingStatus,
      overrideReason: null,
      overrideAt: null,
      resolvedAt: null,
      criteriaVersion: input.criteriaVersion,
      modelUsed: input.modelUsed,
      createdAt: now,
    };
    // set() not create() — ids are fresh UUIDs so collision is essentially
    // impossible, and set keeps the fake-firestore test harness simpler.
    batch.set(ref, doc);
    created.push({ id, ...doc });
  }

  await batch.commit();
  return created;
}

// FIRESTORE-INDEX: critique_findings(briefId:ASC, createdAt:DESC)
/**
 * List every finding for a brief, newest first. Powers the findings panel
 * on the intake detail view.
 */
export async function listFindingsByBriefId(
  briefId: string,
  db: Firestore = getDb(),
): Promise<CritiqueFinding[]> {
  if (!briefId) return [];
  const snap = await db
    .collection(COLLECTION)
    .where('briefId', '==', briefId)
    .orderBy('createdAt', 'desc')
    .get();
  return snap.docs.map((d) => docToFinding(d.id, d.data() as Record<string, unknown>));
}

/**
 * Count unresolved findings for a brief. Used by the intake list-view
 * badge to show "3 findings" without loading the full detail page.
 *
 * Uses the same composite index as listFindingsByBriefId — Firestore can
 * serve count() off the indexed query without re-scanning documents.
 */
// FIRESTORE-INDEX: critique_findings(briefId:ASC, createdAt:DESC)
export async function countUnresolvedFindings(
  briefId: string,
  db: Firestore = getDb(),
): Promise<number> {
  if (!briefId) return 0;
  // Status filter applied in-memory: the doc-counts per brief are small
  // (<= ~10 typical) and avoiding a status-keyed composite saves an index.
  const snap = await db
    .collection(COLLECTION)
    .where('briefId', '==', briefId)
    .orderBy('createdAt', 'desc')
    .get();
  let count = 0;
  for (const d of snap.docs) {
    if ((d.data() as { status?: CritiqueFindingStatus }).status === 'unresolved') count += 1;
  }
  return count;
}

/**
 * User explicitly rejects a finding (the critic was wrong here). Records
 * the reason for the calibration loop (DEFERRED.md #1) so we can detect
 * criteria that get overridden consistently.
 */
export async function overrideFinding(
  findingId: string,
  reason: string | null,
  db: Firestore = getDb(),
): Promise<CritiqueFinding | null> {
  const ref = db.collection(COLLECTION).doc(findingId);
  const snap = await ref.get();
  if (!snap.exists) return null;
  const now = new Date();
  await ref.update({
    status: 'overridden' as CritiqueFindingStatus,
    overrideReason: reason,
    overrideAt: now,
  });
  const updated = await ref.get();
  return docToFinding(findingId, updated.data() as Record<string, unknown>);
}

/**
 * User addressed the finding manually (separate from the revisor pass).
 * No reason required — the act of marking it resolved is the signal.
 */
export async function markResolvedByUser(
  findingId: string,
  db: Firestore = getDb(),
): Promise<CritiqueFinding | null> {
  const ref = db.collection(COLLECTION).doc(findingId);
  const snap = await ref.get();
  if (!snap.exists) return null;
  await ref.update({
    status: 'resolved_by_user' as CritiqueFindingStatus,
    resolvedAt: new Date(),
  });
  const updated = await ref.get();
  return docToFinding(findingId, updated.data() as Record<string, unknown>);
}

/**
 * Mark a finding as applied by the revisor. Called by transform-brief.ts
 * (Phase 2.6 integration) after the revisor pass succeeds.
 *
 * Accepts an array of ids so the revisor can mark all its applied findings
 * in one atomic batch — keeps the brief detail view consistent.
 */
export async function markAppliedByRevisor(
  findingIds: string[],
  db: Firestore = getDb(),
): Promise<void> {
  if (findingIds.length === 0) return;
  const batch = db.batch();
  const now = new Date();
  for (const id of findingIds) {
    const ref = db.collection(COLLECTION).doc(id);
    batch.update(ref, {
      status: 'applied_by_revisor' as CritiqueFindingStatus,
      resolvedAt: now,
    });
  }
  await batch.commit();
}

/**
 * Delete every finding tied to a brief. Used when a brief is re-transformed
 * — old findings are obsolete because they target an obsolete draft.
 *
 * Note: this is a destructive read-then-delete loop. Acceptable because
 * per-brief finding counts are small (<= ~10 typical, ~50 max). If we ever
 * see briefs accumulating hundreds of findings, switch to a recursive
 * batched delete.
 */
export async function deleteFindingsByBriefId(
  briefId: string,
  db: Firestore = getDb(),
): Promise<{ deleted: number }> {
  if (!briefId) return { deleted: 0 };
  const snap = await db.collection(COLLECTION).where('briefId', '==', briefId).get();
  if (snap.empty) return { deleted: 0 };
  const batch = db.batch();
  for (const d of snap.docs) batch.delete(d.ref);
  await batch.commit();
  return { deleted: snap.docs.length };
}

// FIRESTORE-INDEX: critique_findings(status:ASC, severity:ASC, createdAt:DESC)
/**
 * List-view badge query: returns a map of `briefId → unresolved count` for
 * every brief that currently has at least one unresolved finding. Uses
 * the leftmost prefix of the (status, severity, createdAt) composite
 * index so no new index is required.
 *
 * Bounded at 500 — far above what a healthy operator backlog ever reaches.
 * If we hit the cap, the list view will under-report counts, which is a
 * better failure mode than hanging the page.
 */
export async function countUnresolvedFindingsByBriefIds(
  db: Firestore = getDb(),
): Promise<Map<string, number>> {
  const snap = await db
    .collection(COLLECTION)
    .where('status', '==', 'unresolved')
    .orderBy('createdAt', 'desc')
    .limit(500)
    .get();
  const counts = new Map<string, number>();
  for (const d of snap.docs) {
    const briefId = (d.data() as { briefId?: string }).briefId;
    if (briefId) counts.set(briefId, (counts.get(briefId) ?? 0) + 1);
  }
  return counts;
}

// FIRESTORE-INDEX: critique_findings(status:ASC, severity:ASC, createdAt:DESC)
/**
 * Cross-brief query for the future ops dashboard: list unresolved findings
 * at a given severity, newest first. Bounded by `limit` so large
 * unresolved backlogs don't fan out into a huge result set.
 */
export async function listUnresolvedBySeverity(
  severity: CritiqueSeverity,
  limit: number,
  db: Firestore = getDb(),
): Promise<CritiqueFinding[]> {
  const snap = await db
    .collection(COLLECTION)
    .where('status', '==', 'unresolved')
    .where('severity', '==', severity)
    .orderBy('createdAt', 'desc')
    .limit(Math.max(1, Math.min(limit, 500)))
    .get();
  return snap.docs.map((d) => docToFinding(d.id, d.data() as Record<string, unknown>));
}
