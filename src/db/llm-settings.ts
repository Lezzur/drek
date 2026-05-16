import { z } from 'zod';
import { getDb } from './firestore.js';
import { getEnv } from '../env.js';
import { logger } from '../logger.js';

const COLLECTION = 'config';
const DOC = 'llm_settings';

export const llmSettingsSchema = z.object({
  provider: z.enum(['claude', 'codex']),
  claudeModel: z.string().min(1),
  codexModel: z.string().min(1),
});
export type LLMSettings = z.infer<typeof llmSettingsSchema>;

function envDefaults(): LLMSettings {
  const env = getEnv();
  return {
    provider: env.LLM_PROVIDER,
    claudeModel: env.CLAUDE_MODEL,
    codexModel: env.CODEX_MODEL,
  };
}

// 30-second in-memory TTL — settings changes apply within one pipeline call.
let _cache: { settings: LLMSettings; expiresAt: number } | null = null;

export async function getLLMSettings(): Promise<LLMSettings> {
  if (_cache && Date.now() < _cache.expiresAt) return _cache.settings;
  try {
    const snap = await getDb().collection(COLLECTION).doc(DOC).get();
    if (!snap.exists) {
      const defaults = envDefaults();
      _cache = { settings: defaults, expiresAt: Date.now() + 30_000 };
      return defaults;
    }
    const data = snap.data() ?? {};
    const parsed = llmSettingsSchema.safeParse(data);
    const settings = parsed.success ? parsed.data : envDefaults();
    _cache = { settings, expiresAt: Date.now() + 30_000 };
    return settings;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'llm settings read failed, using env defaults');
    return envDefaults();
  }
}

export async function saveLLMSettings(settings: LLMSettings): Promise<void> {
  await getDb().collection(COLLECTION).doc(DOC).set(settings);
  _cache = { settings, expiresAt: Date.now() + 30_000 };
}

export function _resetLLMSettingsCacheForTests(): void {
  _cache = null;
}
