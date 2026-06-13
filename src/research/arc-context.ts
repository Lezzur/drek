import { logger } from '../logger.js';
import { getNeurocoreClient } from '../neurocore/index.js';

/**
 * Builds a "PREVIOUS EPISODES" text block from Neurocore's ContentCatalog.
 * Soft-fails (returns empty string) when the catalog is unreachable —
 * research still runs, just without arc context.
 */
export async function buildArcContext(limit = 20): Promise<string> {
  try {
    const client = getNeurocoreClient();
    const { profiles } = await client.listContentCatalog({ limit });

    if (profiles.length === 0) return '';

    const lines = profiles.map((p) => {
      const date = p.publishedAt
        ? new Date(p.publishedAt).toISOString().split('T')[0]
        : 'unpublished';
      const stack = p.primaryTechStackId ? ` (${p.primaryTechStackId})` : '';
      return `- ${p.title}${stack} — ${date}`;
    });

    return `PREVIOUS EPISODES\n${lines.join('\n')}`;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'arc-context: ContentCatalog unavailable, skipping');
    return '';
  }
}
