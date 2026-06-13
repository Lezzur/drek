import { Hono } from 'hono';
import { z } from 'zod';
import { getLLMSettings, saveLLMSettings } from '../db/llm-settings.js';
import { readPollingConfig, patchPollingConfig } from '../db/config.js';
import { getCatalog } from '../models/catalog.js';
import { SettingsPage } from '../views/settings.js';

const app = new Hono();

app.get('/settings', async (c) => {
  const [settings, catalog, polling] = await Promise.all([
    getLLMSettings(),
    getCatalog(),
    readPollingConfig(),
  ]);
  return c.html(<SettingsPage settings={settings} catalog={catalog} polling={polling} />);
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

  const [catalog, polling] = await Promise.all([getCatalog(), readPollingConfig()]);

  if (!parsed.success) {
    const settings = await getLLMSettings();
    return c.html(
      <SettingsPage
        settings={settings}
        catalog={catalog}
        polling={polling}
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
      polling={polling}
      flash={{ type: 'ok', message: `Saved. Active provider: ${parsed.data.provider}, model: ${parsed.data.provider === 'claude' ? parsed.data.claudeModel : parsed.data.codexModel}` }}
    />,
  );
});

const automationFormSchema = z.object({
  // Checkbox: 'on' when checked, absent when not.
  autoRunPipeline: z
    .union([z.literal('on'), z.undefined()])
    .transform((v) => v === 'on'),
  autoRunMaxAgeDays: z.coerce.number().int().min(1).max(30),
});

app.post('/settings/automation', async (c) => {
  const form = await c.req.formData();
  const raw = Object.fromEntries(form) as Record<string, string>;
  const parsed = automationFormSchema.safeParse(raw);

  const [settings, catalog] = await Promise.all([getLLMSettings(), getCatalog()]);

  if (!parsed.success) {
    const polling = await readPollingConfig();
    return c.html(
      <SettingsPage
        settings={settings}
        catalog={catalog}
        polling={polling}
        flash={{ type: 'err', message: parsed.error.errors[0]?.message ?? 'Invalid automation input' }}
      />,
      400,
    );
  }

  const polling = await patchPollingConfig({
    autoRunPipeline: parsed.data.autoRunPipeline,
    autoRunMaxAgeDays: parsed.data.autoRunMaxAgeDays,
  });

  return c.html(
    <SettingsPage
      settings={settings}
      catalog={catalog}
      polling={polling}
      flash={{
        type: 'ok',
        message: `Automation saved. Auto-generate: ${polling.autoRunPipeline ? 'on' : 'off'}, fresh window: ${polling.autoRunMaxAgeDays}d.`,
      }}
    />,
  );
});

export default app;
