import { logger } from '../logger.js';
import { fetchAnthropicModels } from './anthropic.js';
import { fetchOpenAIModels } from './openai.js';
import { readCatalog, writeCatalog } from './store.js';
import type { ModelCatalog } from './types.js';

/**
 * Refresh the model catalog. Fetches both providers in parallel, writes a
 * single Firestore doc, returns the result. Either provider may have
 * fetched=false (missing key, fetch failure) without invalidating the
 * other — we always write a complete snapshot.
 *
 * Designed to be cron-driven (see startScheduler in src/index.ts) but also
 * safe to invoke directly, e.g. from an admin endpoint later.
 */
export async function refreshModelCatalog(): Promise<ModelCatalog> {
  const t0 = Date.now();
  const [anthropic, openai] = await Promise.all([
    fetchAnthropicModels(),
    fetchOpenAIModels(),
  ]);
  const catalog: ModelCatalog = { anthropic, openai };

  try {
    await writeCatalog(catalog);
  } catch (err) {
    // Firestore down — log and return the freshly fetched data anyway so the
    // caller (admin endpoint or test) can see what we got.
    logger.warn({ err: (err as Error).message }, 'model catalog write failed');
  }

  logger.info(
    {
      durationMs: Date.now() - t0,
      anthropic: {
        fetched: anthropic.fetched,
        count: anthropic.items.length,
        error: anthropic.error,
      },
      openai: {
        fetched: openai.fetched,
        count: openai.items.length,
        error: openai.error,
      },
    },
    'model catalog refresh complete',
  );
  return catalog;
}

/** Read-only access to the cached catalog. Surfaced as a function so the
 *  route handler doesn't have to know about Firestore. */
export async function getCatalog(): Promise<ModelCatalog> {
  return readCatalog();
}
