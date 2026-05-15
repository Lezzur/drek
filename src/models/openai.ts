import { getEnv } from '../env.js';
import { logger } from '../logger.js';
import type { ModelEntry, ProviderCatalog } from './types.js';

const ENDPOINT = 'https://api.openai.com/v1/models';
const FETCH_TIMEOUT_MS = 10_000;

interface OpenAIListResponse {
  data?: Array<{
    id?: string;
    object?: string;
    created?: number;
    owned_by?: string;
  }>;
}

/**
 * OpenAI's /v1/models returns the entire account-visible catalog including
 * embeddings, image, TTS, and legacy completion models. Filter to the ones
 * usable by Codex CLI / chat — anything else is noise in the dashboard
 * dropdown.
 *
 * Excludes (always): embeddings, dall-e, whisper, tts, moderation, legacy
 * davinci/babbage/ada/curie text models, search/edit endpoints.
 * Includes: codex-prefixed, gpt-*, o1-*, o3-*, chatgpt-*.
 */
function isCodingModel(id: string): boolean {
  const lower = id.toLowerCase();
  if (
    lower.includes('embedding') ||
    lower.includes('dall-e') ||
    lower.includes('whisper') ||
    lower.startsWith('tts-') ||
    lower.includes('moderation') ||
    lower.startsWith('text-davinci') ||
    lower.startsWith('davinci-') ||
    lower.startsWith('babbage-') ||
    lower.startsWith('ada-') ||
    lower.startsWith('curie-') ||
    lower.includes('-edit-') ||
    lower.includes('search-')
  ) {
    return false;
  }
  return (
    lower.startsWith('codex') ||
    lower.includes('-codex') ||
    lower.startsWith('gpt-') ||
    lower.startsWith('o1') ||
    lower.startsWith('o3') ||
    lower.startsWith('chatgpt-')
  );
}

export async function fetchOpenAIModels(): Promise<ProviderCatalog> {
  const env = getEnv();
  const refreshedAt = new Date().toISOString();
  if (!env.OPENAI_API_KEY) {
    return {
      fetched: false,
      error: 'OPENAI_API_KEY unset',
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
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });

    if (!res.ok) {
      const detail = (await safeText(res)).slice(0, 200);
      logger.warn({ status: res.status, detail }, 'openai /v1/models non-2xx');
      return {
        fetched: false,
        error: `HTTP ${res.status}`,
        items: [],
        refreshedAt,
      };
    }

    const body = (await res.json()) as OpenAIListResponse;
    const data = Array.isArray(body.data) ? body.data : [];
    const items: ModelEntry[] = data
      .filter((m): m is { id: string } & typeof m =>
        typeof m?.id === 'string' && m.id.length > 0 && isCodingModel(m.id),
      )
      .map((m) => ({
        id: m.id,
        provider: 'openai' as const,
        // OpenAI doesn't return display_name; surface owner so the UI shows
        // something useful.
        displayName: m.owned_by ?? null,
        createdAt: typeof m.created === 'number'
          ? new Date(m.created * 1000).toISOString()
          : null,
      }));
    return { fetched: true, error: null, items, refreshedAt };
  } catch (err) {
    const name = (err as Error & { name?: string }).name ?? 'Error';
    const msg = name === 'AbortError' ? `timeout after ${FETCH_TIMEOUT_MS}ms` : (err as Error).message;
    logger.warn({ err: msg }, 'openai /v1/models fetch failed');
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

// Exposed for unit tests so we can verify the filter without a real fetch.
export const _internal = { isCodingModel };
