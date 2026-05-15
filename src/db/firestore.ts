import { cert, getApps, initializeApp, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { getEnv } from '../env.js';
import { logger } from '../logger.js';

let app: App | null = null;
let db: Firestore | null = null;

/**
 * Lazily initialize Firebase Admin + Firestore. We delay init until first use
 * so tests can stub the module without a real service account on disk.
 *
 * In production, GOOGLE_APPLICATION_CREDENTIALS points at the service-account
 * JSON. We read it ourselves rather than relying on auto-detection so we can
 * fail fast with a clear error when the file is missing.
 */
export function getDb(): Firestore {
  if (db) return db;

  const env = getEnv();
  const existing = getApps();
  if (existing.length > 0) {
    app = existing[0] ?? null;
  } else {
    const keyPath = env.GOOGLE_APPLICATION_CREDENTIALS;
    if (!keyPath) {
      throw new Error(
        'GOOGLE_APPLICATION_CREDENTIALS is required to initialize Firestore',
      );
    }
    const absPath = path.resolve(keyPath);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(readFileSync(absPath, 'utf-8')) as Record<string, unknown>;
    } catch (err) {
      throw new Error(
        `Could not read service-account JSON at ${absPath}: ${(err as Error).message}`,
      );
    }
    app = initializeApp({
      credential: cert(parsed as Parameters<typeof cert>[0]),
      projectId: env.GCP_PROJECT_ID,
    });
    logger.info({ projectId: env.GCP_PROJECT_ID }, 'firebase admin initialized');
  }

  db = getFirestore(app!);
  return db;
}
