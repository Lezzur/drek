import { Hono } from 'hono';
import { z } from 'zod';
import { getLLMSettings, saveLLMSettings } from '../db/llm-settings.js';
import { getCatalog } from '../models/catalog.js';
import { SettingsPage } from '../views/settings.js';

const app = new Hono();

app.get('/settings', async (c) => {
  const [settings, catalog] = await Promise.all([getLLMSettings(), getCatalog()]);
  return c.html(<SettingsPage settings={settings} catalog={catalog} />);
});

const settingsFormSchema = z.object({
  provider: z.enum(['claude', 'codex']),
  claudeModel: z.string().min(1, 'Claude model is required'),
  codexModel: z.string().min(1, 'Codex model is required'),
  // M36: production-realism critic toggle. Form HTML checkbox arrives as
  // 'on' when checked and absent when unchecked, so we coerce a string
  // → boolean here and default to enabled when the field isn't posted at
  // all (existing forms without the checkbox).
  useCritique: z
    .union([z.literal('on'), z.literal('off'), z.boolean(), z.undefined()])
    .transform((v) => v === undefined || v === 'on' || v === true)
    .default(true),
});

app.post('/settings', async (c) => {
  const form = await c.req.formData();
  const raw = Object.fromEntries(form) as Record<string, string>;
  const parsed = settingsFormSchema.safeParse(raw);

  const [catalog] = await Promise.all([getCatalog()]);

  if (!parsed.success) {
    const settings = await getLLMSettings();
    return c.html(
      <SettingsPage
        settings={settings}
        catalog={catalog}
        flash={{ type: 'err', message: parsed.error.errors[0]?.message ?? 'Invalid input' }}
      />,
      400,
    );
  }

  await saveLLMSettings(parsed.data);

  return c.html(
    <SettingsPage
      settings={parsed.data}
      catalog={catalog}
      flash={{ type: 'ok', message: `Saved. Active provider: ${parsed.data.provider}, model: ${parsed.data.provider === 'claude' ? parsed.data.claudeModel : parsed.data.codexModel}` }}
    />,
  );
});

export default app;
