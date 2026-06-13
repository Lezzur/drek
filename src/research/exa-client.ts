import { logger } from '../logger.js';

const EXA_API_BASE = 'https://api.exa.ai';
const DEFAULT_TIMEOUT_MS = 30_000;

export class ResearchUnavailableError extends Error {
  constructor(reason: string) {
    super(`Research unavailable: ${reason}`);
    this.name = 'ResearchUnavailableError';
  }
}

export interface ExaSearchResult {
  url: string;
  title: string;
  text: string;
  publishedDate?: string;
}

export async function exaSearch(
  query: string,
  opts: { numResults?: number; type?: 'neural' | 'keyword' } = {},
): Promise<ExaSearchResult[]> {
  const apiKey = process.env.EXA_API_KEY;
  if (!apiKey) {
    throw new ResearchUnavailableError('EXA_API_KEY is not set');
  }

  const timeoutMs = Number(process.env.EXA_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${EXA_API_BASE}/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
      },
      body: JSON.stringify({
        query,
        numResults: opts.numResults ?? 10,
        type: opts.type ?? 'neural',
        contents: { text: { maxCharacters: 2000 } },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new ResearchUnavailableError(
        `Exa API returned ${response.status}: ${body.slice(0, 200)}`,
      );
    }

    const data = (await response.json()) as { results?: unknown[] };
    const results = Array.isArray(data.results) ? data.results : [];

    return results
      .filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null)
      .map((r) => ({
        url: String(r.url ?? ''),
        title: String(r.title ?? ''),
        text: String(r.text ?? ''),
        publishedDate: r.publishedDate ? String(r.publishedDate) : undefined,
      }))
      .filter((r) => r.url && r.title);
  } catch (err) {
    if (err instanceof ResearchUnavailableError) throw err;
    const msg = (err as Error).message ?? String(err);
    if (msg.includes('abort') || msg.includes('signal')) {
      throw new ResearchUnavailableError(`Exa search timed out after ${timeoutMs}ms`);
    }
    logger.warn({ err: msg, query }, 'exa search failed');
    throw new ResearchUnavailableError(msg);
  } finally {
    clearTimeout(timer);
  }
}
