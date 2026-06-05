/**
 * Per-plan in-process serialization lock.
 *
 * The pipeline steps read a plan's status, decide a transition, then write —
 * a read-modify-write that is NOT atomic across concurrent requests (the fake
 * Firestore used in tests doesn't support runTransaction, and production reads
 * happen outside any transaction). Two overlapping requests on the same plan
 * (a double-clicked "Run pipeline", an HTMX retry, cron + manual) can both pass
 * the transition check and both write, producing duplicate scenes or a clobbered
 * status.
 *
 * `withPlanLock` serializes work per planId within this process: calls for the
 * same plan run one-at-a-time in arrival order; calls for different plans run
 * concurrently. This is a single-process app, so an in-memory lock is sufficient.
 */

const tails = new Map<string, Promise<unknown>>();

export function withPlanLock<T>(planId: string, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(planId) ?? Promise.resolve();
  // Run fn after prev settles, whether it resolved or rejected — one request's
  // failure must not wedge the next.
  const run = prev.then(fn, fn);
  // Store a rejection-swallowed handle as the new tail so the next caller waits
  // without triggering an unhandled-rejection warning on the stored promise.
  const stored = run.catch(() => undefined);
  tails.set(planId, stored);
  // Drop the entry once idle so the map doesn't retain one promise per plan id
  // for the life of the process.
  void stored.then(() => {
    if (tails.get(planId) === stored) tails.delete(planId);
  });
  return run;
}

/** Test seam: clear all locks. */
export function _resetPlanLocksForTests(): void {
  tails.clear();
}
