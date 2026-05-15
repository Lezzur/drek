/**
 * Model catalog types — what gets cached in Firestore and surfaced via
 * GET /v1/models. Provider-tagged so the dashboard can show the right list
 * based on the active LLM_PROVIDER.
 */

export type ModelProvider = 'anthropic' | 'openai';

export interface ModelEntry {
  id: string;                 // canonical id passed to the CLI
  provider: ModelProvider;
  displayName: string | null; // human-readable name when the API gives one
  createdAt: string | null;   // ISO 8601 when the API gives one
}

export interface ProviderCatalog {
  /** True when the last refresh successfully fetched. False when the API key
   *  was missing, the call failed, or the response was unparseable. */
  fetched: boolean;
  /** Null on success; short message on failure (no secrets ever). */
  error: string | null;
  items: ModelEntry[];
  refreshedAt: string;        // ISO 8601 of when this provider was last attempted
}

export interface ModelCatalog {
  anthropic: ProviderCatalog;
  openai: ProviderCatalog;
}

/** Sentinel returned when nothing has been cached yet. */
export const EMPTY_CATALOG: ModelCatalog = {
  anthropic: { fetched: false, error: null, items: [], refreshedAt: '' },
  openai: { fetched: false, error: null, items: [], refreshedAt: '' },
};
