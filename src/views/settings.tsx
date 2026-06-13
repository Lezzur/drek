import type { FC } from 'hono/jsx';
import { Layout, type LayoutProps } from './layout.js';
import type { LLMSettings } from '../db/llm-settings.js';
import type { ModelCatalog } from '../models/types.js';
import type { PollingConfig } from '../db/schemas.js';

const ANTHROPIC_FALLBACK_MODELS = [
  'claude-opus-4-7',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
  'claude-opus-4-5',
  'claude-sonnet-4-5',
  'claude-haiku-4-5',
];

const OPENAI_FALLBACK_MODELS = [
  'codex-mini-latest',
  'o4-mini',
  'o3-mini',
  'gpt-4o',
  'gpt-4o-mini',
];

export interface SettingsPageProps {
  settings: LLMSettings;
  catalog: ModelCatalog;
  polling: PollingConfig;
  flash?: LayoutProps['flash'];
}

/** Auto-pipeline behavior — the switch that decides whether polled
 *  listings turn into ready scripts on their own. */
const AutomationCard: FC<{ polling: PollingConfig }> = ({ polling }) => {
  return (
    <form method="post" action="/settings/automation" class="card">
      <h3 class="section-label" style="margin-bottom:14px;">Automation</h3>
      <p class="muted" style="font-size:13px; margin-bottom:12px; line-height:1.5;">
        When on, every freshly polled cover-letter listing runs the full
        script pipeline in the background — the dashboard shows finished
        scripts instead of raw listings. Listings older than the fresh
        window are treated as dead: never auto-run, grouped under Stale.
      </p>
      <label class="row" style="gap:10px; align-items:center; cursor:pointer; padding:8px 0;">
        <input
          type="checkbox"
          name="autoRunPipeline"
          value="on"
          checked={polling.autoRunPipeline}
          style="width:18px; height:18px; cursor:pointer;"
        />
        <span style="font-weight:500;">Auto-generate scripts for new listings</span>
        <span class="muted" style="font-size:12px;">
          {polling.autoRunPipeline ? 'Currently on' : 'Currently off'} — ~3-4 LLM calls per listing.
        </span>
      </label>
      <label class="row" style="gap:10px; align-items:center; padding:8px 0;">
        <span style="font-weight:500;">Fresh window</span>
        <input
          type="number"
          name="autoRunMaxAgeDays"
          value={String(polling.autoRunMaxAgeDays)}
          min="1"
          max="30"
          style="width:80px;"
        />
        <span class="muted" style="font-size:12px;">days — older listings count as stale</span>
      </label>
      <div class="row" style="gap:8px; margin-top:8px;">
        <button class="btn" type="submit">Save automation</button>
      </div>
    </form>
  );
};

const ProviderCard: FC<{ settings: LLMSettings; catalog: ModelCatalog }> = ({
  settings,
  catalog,
}) => {
  const anthropicModels = catalog.anthropic.items.length > 0
    ? catalog.anthropic.items.map((m) => m.id)
    : ANTHROPIC_FALLBACK_MODELS;
  const openaiModels = catalog.openai.items.length > 0
    ? catalog.openai.items.map((m) => m.id)
    : OPENAI_FALLBACK_MODELS;
  const anthropicLive = catalog.anthropic.items.length > 0;
  const openaiLive = catalog.openai.items.length > 0;

  return (
    <form method="post" action="/settings" class="card">
      <h3 class="section-label" style="margin-bottom:18px;">LLM provider</h3>

      <label style="display:block; margin-bottom:18px;">
        <div class="field-label" style="margin-bottom:8px;">Active provider</div>
        <div class="row" style="gap:10px;">
          <label class="row" style="gap:6px; cursor:pointer;">
            <input type="radio" name="provider" value="claude" checked={settings.provider === 'claude'} />
            <span>Claude (Anthropic)</span>
          </label>
          <label class="row" style="gap:6px; cursor:pointer;">
            <input type="radio" name="provider" value="codex" checked={settings.provider === 'codex'} />
            <span>Codex (OpenAI)</span>
          </label>
        </div>
        <div class="muted" style="font-size:12px; margin-top:6px;">
          Switches immediately — no restart needed.
        </div>
      </label>

      <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-bottom:18px;">
        <label>
          <div class="field-label" style="margin-bottom:6px;">Claude model</div>
          <select name="claudeModel" style="width:100%;">
            {anthropicModels.map((id) => (
              <option value={id} selected={settings.claudeModel === id}>{id}</option>
            ))}
            {!anthropicModels.includes(settings.claudeModel) ? (
              <option value={settings.claudeModel} selected>{settings.claudeModel} (current)</option>
            ) : null}
          </select>
          {!anthropicLive && (
            <div class="muted" style="font-size:12px; margin-top:4px;">
              Set ANTHROPIC_API_KEY to load live models.
            </div>
          )}
        </label>

        <label>
          <div class="field-label" style="margin-bottom:6px;">Codex model</div>
          <select name="codexModel" style="width:100%;">
            {openaiModels.map((id) => (
              <option value={id} selected={settings.codexModel === id}>{id}</option>
            ))}
            {!openaiModels.includes(settings.codexModel) ? (
              <option value={settings.codexModel} selected>{settings.codexModel} (current)</option>
            ) : null}
          </select>
          {!openaiLive && (
            <div class="muted" style="font-size:12px; margin-top:4px;">
              Set OPENAI_API_KEY to load live models.
            </div>
          )}
        </label>
      </div>

      <hr style="border:none; border-top:1px solid var(--border); margin:18px 0;" />

      <h3 class="section-label" style="margin-bottom:14px;">Production-realism critic (M36)</h3>
      <p class="muted" style="font-size:13px; margin-bottom:12px; line-height:1.5;">
        When enabled, every transformed build plan is reviewed by a separate
        LLM pass against the v1 criteria catalog (scope honesty, timeline
        realism, dependency completeness, effort distribution, risk
        visibility). Findings appear on the brief detail view. You can
        override or mark them resolved.
      </p>
      <label class="row" style="gap:10px; align-items:center; cursor:pointer; padding:8px 0;">
        <input
          type="checkbox"
          name="useCritique"
          value="on"
          checked={settings.useCritique}
          style="width:18px; height:18px; cursor:pointer;"
        />
        <span style="font-weight:500;">
          Enable critic on every transform
        </span>
        <span class="muted" style="font-size:12px;">
          {settings.useCritique ? 'Currently on' : 'Currently off'} —
          adds ~2 LLM calls per transform (critique + revisor).
        </span>
      </label>

      <div class="row" style="gap:8px;">
        <button class="btn" type="submit">Save settings</button>
      </div>
    </form>
  );
};

const CatalogStatus: FC<{ catalog: ModelCatalog }> = ({ catalog }) => {
  const { anthropic, openai } = catalog;
  return (
    <div class="card" style="padding-top:12px; padding-bottom:12px;">
      <div class="row" style="align-items:center; gap:16px;">
        <span class="section-label" style="margin:0;">Model catalog</span>
        {([
          { label: 'Anthropic', p: anthropic },
          { label: 'OpenAI', p: openai },
        ] as const).map(({ label, p }) => (
          <span class="row" style="gap:6px; align-items:center; font-size:13px; color:var(--ink-2);">
            <span style={`width:8px; height:8px; border-radius:50%; background:${p.fetched ? 'var(--green-fg)' : 'var(--ink-3)'}; flex-shrink:0;`} />
            {label}
          </span>
        ))}
      </div>
    </div>
  );
};

export const SettingsPage: FC<SettingsPageProps> = ({ settings, catalog, polling, flash }) => {
  return (
    <Layout title="Settings" flash={flash}>
      <div style="margin-bottom:20px;">
        <a href="/" class="muted" style="font-size:13px; color:var(--ink-3); text-decoration:none; display:inline-block; margin-bottom:8px;">← Dashboard</a>
        <h1 style="margin:0;">Settings</h1>
      </div>
      <AutomationCard polling={polling} />
      <ProviderCard settings={settings} catalog={catalog} />
      <CatalogStatus catalog={catalog} />
    </Layout>
  );
};
