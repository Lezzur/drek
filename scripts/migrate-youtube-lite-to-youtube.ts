/**
 * Rollback companion to scripts/migrate-youtube-to-youtube-lite.ts.
 *
 * Reverts `type: 'youtube_lite'` plan documents back to `type: 'youtube'`.
 *
 * Idempotent. Only touches the `type` field. Use ONLY if you're rolling
 * the v2 deploy back to v1; after running this the v1 enum (which only
 * knows 'cover_letter' | 'youtube') will accept the docs again.
 *
 * Usage:
 *   npx tsx scripts/migrate-youtube-lite-to-youtube.ts             # dry run
 *   npx tsx scripts/migrate-youtube-lite-to-youtube.ts --execute   # actually writes
 */

import type { Firestore } from 'firebase-admin/firestore';
import { pathToFileURL } from 'node:url';
import { getDb } from '../src/db/firestore.js';
import { getEnv } from '../src/env.js';
import { logger } from '../src/logger.js';

const FROM_TYPE = 'youtube_lite';
const TO_TYPE = 'youtube';
const COLLECTION = 'plans';
const BATCH_SIZE = 400;

export interface RollbackResult {
  matched: number;
  updated: number;
  errors: string[];
}

export async function migrateYoutubeLiteToYoutube(
  opts: { execute?: boolean; db?: Firestore } = {},
): Promise<RollbackResult> {
  const db = opts.db ?? getDb();
  const snapshot = await db.collection(COLLECTION).where('type', '==', FROM_TYPE).get();
  const matched = snapshot.size;
  const errors: string[] = [];

  if (!opts.execute) {
    return { matched, updated: 0, errors };
  }

  let updated = 0;
  for (let i = 0; i < snapshot.docs.length; i += BATCH_SIZE) {
    const chunk = snapshot.docs.slice(i, i + BATCH_SIZE);
    const batch = db.batch();
    for (const doc of chunk) {
      batch.update(doc.ref, { type: TO_TYPE });
    }
    try {
      await batch.commit();
      updated += chunk.length;
    } catch (err) {
      const msg = `batch ${i / BATCH_SIZE} failed: ${(err as Error).message}`;
      errors.push(msg);
      logger.error(
        { failedDocIds: chunk.map((d) => d.id), error: msg },
        'rollback batch failed',
      );
      break;
    }
  }

  return { matched, updated, errors };
}

async function main(): Promise<void> {
  const execute = process.argv.includes('--execute');
  const env = getEnv();
  if (!env.GOOGLE_APPLICATION_CREDENTIALS) {
    logger.error('GOOGLE_APPLICATION_CREDENTIALS must be set');
    process.exit(1);
  }

  logger.info(
    {
      projectId: env.GCP_PROJECT_ID,
      from: FROM_TYPE,
      to: TO_TYPE,
      execute,
    },
    execute ? 'rollback: youtube_lite → youtube' : 'dry run — pass --execute to write',
  );

  try {
    const result = await migrateYoutubeLiteToYoutube({ execute });
    logger.info(result, 'rollback result');
    if (result.errors.length > 0) process.exit(1);
  } catch (err) {
    logger.error({ err }, 'rollback failed');
    process.exit(1);
  }
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (entry === import.meta.url) {
  await main();
}
