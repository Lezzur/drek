import type { FC } from 'hono/jsx';
import { Layout, type LayoutProps } from './layout.js';
import type { Plan, HookDraft } from '../db/schemas.js';

export interface HookWorkshopViewProps {
  plan: Plan;
  hooks: HookDraft[];
  flash?: LayoutProps['flash'];
}

const ARCHETYPE_LABELS: Record<string, string> = {
  pattern_interrupt: 'Pattern interrupt',
  bold_claim: 'Bold claim',
  retention_question: 'Retention question',
  story_cold_open: 'Story cold open',
  demo_first: 'Demo first',
};

const HookCard: FC<{ plan: Plan; hook: HookDraft }> = ({ plan, hook }) => {
  const isSelected = hook.selected;
  const borderStyle = isSelected
    ? '2px solid var(--green-fg)'
    : '1px solid var(--border)';
  const bgStyle = isSelected ? 'var(--green-bg)' : 'var(--surface)';

  return (
    <div
      style={`background:${bgStyle}; border:${borderStyle}; border-radius:10px; padding:20px; position:relative; cursor:${isSelected ? 'default' : 'pointer'};`}
      {...(!isSelected
        ? {
            'hx-post': `/plans/${plan.id}/select-hook`,
            'hx-vals': JSON.stringify({ hookId: hook.id }),
            'hx-target': 'body',
            'hx-swap': 'outerHTML',
            'hx-disabled-elt': 'this',
          }
        : {})}
    >
      <div style="display:flex; align-items:center; gap:8px; margin-bottom:12px;">
        <span
          style="display:inline-block; padding:2px 8px; border-radius:4px; font-size:11px; font-weight:600; letter-spacing:0.05em; text-transform:uppercase; background:var(--surface-raised); color:var(--ink-2);"
        >
          {ARCHETYPE_LABELS[hook.archetype] ?? hook.archetype}
        </span>
        {isSelected ? (
          <span
            style="display:inline-flex; align-items:center; gap:4px; padding:2px 8px; border-radius:4px; font-size:11px; font-weight:600; background:var(--green-fg); color:#0e1f14;"
          >
            ✓ selected
          </span>
        ) : null}
      </div>

      <div
        style="font-size:16px; line-height:1.65; color:var(--ink); margin-bottom:14px; font-weight:400;"
      >
        {hook.scriptText}
      </div>

      <div
        style="font-size:13px; color:var(--ink-3); line-height:1.5; font-style:italic;"
      >
        {hook.predictedRetention}
      </div>
    </div>
  );
};

export const HookWorkshopView: FC<HookWorkshopViewProps> = ({ plan, hooks, flash }) => {
  return (
    <Layout title={`Hooks · ${plan.title}`} flash={flash}>
      <div style="margin-bottom:20px;">
        <a
          href={`/plans/${plan.id}`}
          style="font-size:13px; color:var(--ink-3); text-decoration:none; display:inline-block; margin-bottom:12px;"
        >
          ← Back to plan
        </a>
        <div style="display:flex; align-items:center; gap:12px;">
          <h1 style="margin:0; flex:1;">Hooks · {plan.title}</h1>
          <button
            class="btn secondary"
            type="button"
            hx-post={`/plans/${plan.id}/generate-hooks`}
            hx-target="body"
            hx-swap="outerHTML"
            hx-confirm="Discard current variants and generate a new set?"
            hx-disabled-elt="this"
          >
            Regenerate hooks
          </button>
        </div>
        <div style="margin-top:6px; font-size:14px; color:var(--ink-3);">
          Click a card to select it as your episode hook. The selected hook will be used verbatim as scene 1's script when you generate scripts.
        </div>
      </div>

      {hooks.length === 0 ? (
        <div
          style="text-align:center; padding:48px 24px; background:var(--surface); border:1px dashed var(--border-strong); border-radius:10px;"
        >
          <div style="font-size:16px; color:var(--ink-3); margin-bottom:16px;">
            Generate hooks first
          </div>
          <div style="font-size:14px; color:var(--ink-4); margin-bottom:20px;">
            Run hook generation to produce 3-4 hook variants for this episode.
          </div>
          <button
            class="btn accent"
            type="button"
            hx-post={`/plans/${plan.id}/generate-hooks`}
            hx-target="body"
            hx-swap="outerHTML"
            hx-disabled-elt="this"
          >
            Generate hooks
          </button>
        </div>
      ) : (
        <div
          style="display:grid; grid-template-columns:1fr 1fr; gap:16px;"
        >
          {hooks.map((hook) => (
            <HookCard plan={plan} hook={hook} />
          ))}
        </div>
      )}
    </Layout>
  );
};
