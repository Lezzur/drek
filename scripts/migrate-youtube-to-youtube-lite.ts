/**
 * One-time v2 migration: rename `type: 'youtube'` plan documents to
 * `type: 'youtube_lite'`.
 *
 * Idempotent: re-running is safe — the query won't match any documents
 * the second time. Only touches the `type` field; every other field on
 * each plan is preserved exactly.
 *
 * Usage:
 *   npx tsx scripts/migrate-youtube-to-youtube-lite.ts             # dry run
 *   npx tsx scripts/migrate-youtube-to-youtube-lite.ts --execute   # actually writes
 *
 * Deployment sequence (per TECH-SPEC-drek-v2-youtube-2026-05-18.md §11):
 *   1. nssm stop DREK
 *   2. git pull && npm install && npm run build
 *   3. npx tsx scripts/migrate-youtube-to-youtube-lite.ts --execute
 *   4. nssm start DREK
 *
 * Rollback companion: scripts/migrate-youtube-lite-to-youtube.ts.
 */

import type { Firestore } from 'firebase-admin/firestore';
import { pathToFileURL } from 'node:url';
import { getDb } from '../src/db/firestore.js';
import { getEnv } from '../src/env.js';
import { logger } from '../src/logger.js';

const FROM_TYPE = 'youtube';
const TO_TYPE = 'youtube_lite';
const COLLECTION = 'plans';
// Firestore batch limit is 500; leave headroom for safety.
const BATCH_SIZE = 400;

export interface MigrationResult {
  matched: number;
  updated: number;
  errors: string[];
}

export async function migrateYoutubeToYoutubeLite(
  opts: { execute?: boolean; db?: Firestore } = {},
): Promise<MigrationResult> {
  const db = opts.db ?? getDb();
  const snapshot = await db.collection(COLLECTION).where('type', '==', FROM_TYPE).get();
  const matched = snapshot.size;
  const errors: string[] = [];

  if (!opts.execute) {
    return { matched, updated: 0, errors };
  }

  let updated = 0;
  // Chunk into BATCH_SIZE-sized batches.
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
      // Log the document ids in this chunk so an operator can recover.
      logger.error(
        { failedDocIds: chunk.map((d) => d.id), error: msg },
        'migration batch failed',
      );
      // Stop on first failure — partial state is recoverable since the
      // query will only return remaining unmigrated docs on re-run.
      break;
    }
  }

  return { matched, updated, errors };
}

async function main(): Promise<void> {
  const execute = process.argv.includes('--execute');

  // Hard guard against accidental production runs without explicit config.
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
    execute ? 'migration: youtube → youtube_lite' : 'dry run — pass --execute to write',
  );

  try {
    const result = await migrateYoutubeToYoutubeLite({ execute });
    logger.info(result, 'migration result');
    if (result.errors.length > 0) {
      process.exit(1);
    }
    if (!execute) {
      logger.info(
        { matched: result.matched },
        `dry run complete — would update ${result.matched} plan(s)`,
      );
    } else {
      logger.info(
        { matched: result.matched, updated: result.updated },
        'migration complete',
      );
    }
  } catch (err) {
    logger.error({ err }, 'migration failed');
    process.exit(1);
  }
}

// Only run main when invoked directly (not when imported by tests).
const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (entry === import.meta.url) {
  await main();
}
