import type { FC } from 'hono/jsx';
import { Layout, type LayoutProps } from './layout.js';
import type { LLMSettings } from '../db/llm-settings.js';
import type { ModelCatalog } from '../models/types.js';

export interface SettingsPageProps {
  settings: LLMSettings;
  catalog: ModelCatalog;
  flash?: LayoutProps['flash'];
}

const ProviderCard: FC<{ settings: LLMSettings; catalog: ModelCatalog }> = ({
  settings,
  catalog,
}) => {
  const anthropicModels = catalog.anthropic.items.map((m) => m.id);
  const openaiModels = catalog.openai.items.map((m) => m.id);

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
          {anthropicModels.length > 0 ? (
            <select name="claudeModel" style="width:100%;">
              {anthropicModels.map((id) => (
                <option value={id} selected={settings.claudeModel === id}>{id}</option>
              ))}
              {!anthropicModels.includes(settings.claudeModel) ? (
                <option value={settings.claudeModel} selected>{settings.claudeModel} (current)</option>
              ) : null}
            </select>
          ) : (
            <>
              <input
                type="text"
                name="claudeModel"
                value={settings.claudeModel}
                style="width:100%;"
                placeholder="e.g. claude-sonnet-4-5"
              />
              <div class="muted" style="font-size:12px; margin-top:4px;">
                {catalog.anthropic.error
                  ? `Catalog unavailable: ${catalog.anthropic.error}. Set ANTHROPIC_API_KEY to populate the list.`
                  : 'Set ANTHROPIC_API_KEY to populate the model list.'}
              </div>
            </>
          )}
        </label>

        <label>
          <div class="field-label" style="margin-bottom:6px;">Codex model</div>
          {openaiModels.length > 0 ? (
            <select name="codexModel" style="width:100%;">
              {openaiModels.map((id) => (
                <option value={id} selected={settings.codexModel === id}>{id}</option>
              ))}
              {!openaiModels.includes(settings.codexModel) ? (
                <option value={settings.codexModel} selected>{settings.codexModel} (current)</option>
              ) : null}
            </select>
          ) : (
            <>
              <input
                type="text"
                name="codexModel"
                value={settings.codexModel}
                style="width:100%;"
                placeholder="e.g. codex-mini-latest"
              />
              <div class="muted" style="font-size:12px; margin-top:4px;">
                {catalog.openai.error
                  ? `Catalog unavailable: ${catalog.openai.error}. Set OPENAI_API_KEY to populate the list.`
                  : 'Set OPENAI_API_KEY to populate the model list.'}
              </div>
            </>
          )}
        </label>
      </div>

      <div class="row" style="gap:8px;">
        <button class="btn" type="submit">Save settings</button>
      </div>
    </form>
  );
};

const CatalogStatus: FC<{ catalog: ModelCatalog }> = ({ catalog }) => {
  const { anthropic, openai } = catalog;
  return (
    <div class="card">
      <h3 class="section-label" style="margin-bottom:12px;">Model catalog</h3>
      <p class="muted" style="font-size:13px; margin-bottom:12px;">
        The catalog is refreshed every 24h from the provider APIs. Set
        ANTHROPIC_API_KEY and/or OPENAI_API_KEY in the service .env to enable
        automatic refresh. Without them, models are pinned to what's typed above.
      </p>
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
        <div style="background:var(--surface-raised); border-radius:7px; padding:12px;">
          <div class="field-label" style="margin-bottom:6px;">Anthropic</div>
          {anthropic.fetched ? (
            <span style="color:var(--green-fg); font-size:13px;">{anthropic.items.length} models · refreshed {anthropic.refreshedAt ? new Date(anthropic.refreshedAt).toLocaleString() : '—'}</span>
          ) : (
            <span style="color:var(--ink-3); font-size:13px;">{anthropic.error ?? 'Not fetched'}</span>
          )}
        </div>
        <div style="background:var(--surface-raised); border-radius:7px; padding:12px;">
          <div class="field-label" style="margin-bottom:6px;">OpenAI</div>
          {openai.fetched ? (
            <span style="color:var(--green-fg); font-size:13px;">{openai.items.length} models · refreshed {openai.refreshedAt ? new Date(openai.refreshedAt).toLocaleString() : '—'}</span>
          ) : (
            <span style="color:var(--ink-3); font-size:13px;">{openai.error ?? 'Not fetched'}</span>
          )}
        </div>
      </div>
    </div>
  );
};

export const SettingsPage: FC<SettingsPageProps> = ({ settings, catalog, flash }) => {
  return (
    <Layout title="Settings" flash={flash}>
      <div style="margin-bottom:20px;">
        <a href="/" class="muted" style="font-size:13px; color:var(--ink-3); text-decoration:none; display:inline-block; margin-bottom:8px;">← Dashboard</a>
        <h1 style="margin:0;">Settings</h1>
      </div>
      <ProviderCard settings={settings} catalog={catalog} />
      <CatalogStatus catalog={catalog} />
    </Layout>
  );
};
