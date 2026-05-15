import { getDb } from '../db/firestore.js';
import { logger } from '../logger.js';
import { EMPTY_CATALOG, type ModelCatalog } from './types.js';

const COLLECTION = 'config';
const DOC = 'model_catalog';

/**
 * Read the cached model catalog from Firestore. Returns EMPTY_CATALOG when
 * the doc doesn't exist yet (first boot before the cron has run) or when
 * Firestore itself is unreachable — DREK should keep serving with whatever
 * env-pinned model the user has configured.
 */
export async function readCatalog(): Promise<ModelCatalog> {
  try {
    const snap = await getDb().collection(COLLECTION).doc(DOC).get();
    if (!snap.exists) return EMPTY_CATALOG;
    const data = snap.data() as Partial<ModelCatalog> | undefined;
    if (!data) return EMPTY_CATALOG;
    return {
      anthropic: data.anthropic ?? EMPTY_CATALOG.anthropic,
      openai: data.openai ?? EMPTY_CATALOG.openai,
    };
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'model catalog read failed');
    return EMPTY_CATALOG;
  }
}

/** Overwrite the cached catalog. Whole-doc replace because the catalog is
 *  always written as a complete snapshot, never patched per-provider. */
export async function writeCatalog(catalog: ModelCatalog): Promise<void> {
  await getDb().collection(COLLECTION).doc(DOC).set(catalog);
}
