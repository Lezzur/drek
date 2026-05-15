import { getEnv } from '../env.js';
import { logger } from '../logger.js';
import type { ModelEntry, ProviderCatalog } from './types.js';

const ENDPOINT = 'https://api.anthropic.com/v1/models';
const FETCH_TIMEOUT_MS = 10_000;

interface AnthropicListResponse {
  data?: Array<{
    id?: string;
    display_name?: string | null;
    created_at?: string | null;
    type?: string;
  }>;
}

/**
 * Fetch the active Claude model catalog. Skips silently when ANTHROPIC_API_KEY
 * is unset — the cron handles that. Filters out non-model rows defensively.
 */
export async function fetchAnthropicModels(): Promise<ProviderCatalog> {
  const env = getEnv();
  const refreshedAt = new Date().toISOString();
  if (!env.ANTHROPIC_API_KEY) {
    return {
      fetched: false,
      error: 'ANTHROPIC_API_KEY unset',
      items: [],
      refreshedAt,
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  if (typeof timer.unref === 'function') timer.unref();

  try {
    const res = await fetch(ENDPOINT, {
      method: 'GET',
      headers: {
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        Accept: 'application/json',
      },
      signal: controller.signal,
    });

    if (!res.ok) {
      const detail = (await safeText(res)).slice(0, 200);
      logger.warn(
        { status: res.status, detail },
        'anthropic /v1/models non-2xx',
      );
      return {
        fetched: false,
        error: `HTTP ${res.status}`,
        items: [],
        refreshedAt,
      };
    }

    const body = (await res.json()) as AnthropicListResponse;
    const data = Array.isArray(body.data) ? body.data : [];
    const items: ModelEntry[] = data
      .filter((m): m is { id: string } & typeof m =>
        typeof m?.id === 'string' && m.id.length > 0,
      )
      .map((m) => ({
        id: m.id,
        provider: 'anthropic' as const,
        displayName: typeof m.display_name === 'string' ? m.display_name : null,
        createdAt: typeof m.created_at === 'string' ? m.created_at : null,
      }));
    return { fetched: true, error: null, items, refreshedAt };
  } catch (err) {
    const name = (err as Error & { name?: string }).name ?? 'Error';
    const msg = name === 'AbortError' ? `timeout after ${FETCH_TIMEOUT_MS}ms` : (err as Error).message;
    logger.warn({ err: msg }, 'anthropic /v1/models fetch failed');
    return { fetched: false, error: msg, items: [], refreshedAt };
  } finally {
    clearTimeout(timer);
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
