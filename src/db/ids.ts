import { randomUUID } from 'node:crypto';

/** Prefix-tagged id so the namespace is obvious in logs and Firestore.
 *  Example: makeId('plan') → 'plan_8b8e3c50a4e9...'. */
export function makeId(prefix: 'plan' | 'scene' | 'listing'): string {
  return `${prefix}_${randomUUID().replace(/-/g, '')}`;
}
