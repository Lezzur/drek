import type { FC } from 'hono/jsx';
import { Layout, type LayoutProps } from './layout.js';
import type {
  Plan,
  HookDraft,
  TitleConcept,
  ThumbnailConcept,
  Deliverable,
} from '../db/schemas.js';

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

// =========================================================================
// Title Workshop (M20)
// =========================================================================

export interface TitleWorkshopViewProps {
  plan: Plan;
  deliverable: Deliverable;
  concepts: TitleConcept[];
  flash?: LayoutProps['flash'];
}

const TitleCard: FC<{ deliverable: Deliverable; concept: TitleConcept }> = ({
  deliverable,
  concept,
}) => {
  const cardClass = `concept-card${concept.selected ? ' selected' : ''}`;
  return (
    <div
      class={cardClass}
      hx-post={`/deliverables/${deliverable.id}/select-title`}
      hx-vals={JSON.stringify({ conceptId: concept.id })}
      hx-target="body"
      hx-swap="outerHTML"
      hx-disabled-elt="this"
      style={`cursor:${concept.selected ? 'default' : 'pointer'}; padding:16px; background:var(--surface); border:2px solid ${concept.selected ? 'var(--accent)' : 'var(--border-soft)'}; border-radius:8px; display:flex; flex-direction:column; gap:8px;`}
    >
      <div class="row" style="justify-content:space-between; align-items:flex-start; gap:8px;">
        <span class="tag" style="text-transform:none;">{concept.archetype}</span>
        <span style="font-size:12px; color:var(--ink-3); font-variant-numeric:tabular-nums;">
          CTR: <strong style="color:var(--accent);">{concept.predictedClickability}</strong>/10
        </span>
      </div>
      <div style="font-size:16px; font-weight:600; line-height:1.35;">{concept.titleText}</div>
      <div style="font-size:13px; color:var(--ink-3); font-style:italic;">{concept.reasoning}</div>
      {concept.keywordsSurfaced.length > 0 ? (
        <div style="display:flex; gap:4px; flex-wrap:wrap; margin-top:4px;">
          {concept.keywordsSurfaced.map((k) => (
            <span class="feature-chip" style="font-size:11px;">{k}</span>
          ))}
        </div>
      ) : null}
      {concept.selected ? (
        <div style="margin-top:6px; font-size:13px; color:var(--accent); font-weight:600;">✓ selected</div>
      ) : null}
    </div>
  );
};

export const TitleWorkshopView: FC<TitleWorkshopViewProps> = ({
  plan,
  deliverable,
  concepts,
  flash,
}) => {
  const sortedConcepts = [...concepts].sort(
    (a, b) => b.predictedClickability - a.predictedClickability,
  );
  return (
    <Layout title={`Titles · ${plan.title}`} flash={flash}>
      <div style="margin-bottom:16px;">
        <a href={`/plans/${plan.id}`} class="muted" style="font-size:14px;">
          ← Back to plan
        </a>
      </div>
      <div class="card" style="margin-bottom:16px;">
        <h1 style="margin:0 0 6px;font-size:22px;">Titles · {plan.title}</h1>
        <div style="font-size:14px; color:var(--ink-3); margin-bottom:12px;">
          Deliverable: <strong>{deliverable.title}</strong> ({deliverable.kind})
        </div>
        <div class="row" style="gap:8px; flex-wrap:wrap;">
          <button
            class="btn secondary"
            type="button"
            hx-post={`/deliverables/${deliverable.id}/generate-titles`}
            hx-target="body"
            hx-swap="outerHTML"
            hx-confirm="Discard current variants and generate a new set?"
            hx-disabled-elt="this"
          >
            Regenerate titles
          </button>
        </div>
      </div>

      {sortedConcepts.length === 0 ? (
        <div style="text-align:center; padding:48px 24px; background:var(--surface); border:1px dashed var(--border-strong); border-radius:10px;">
          <div style="font-size:16px; color:var(--ink-3); margin-bottom:16px;">
            Generate titles first
          </div>
          <button
            class="btn accent"
            type="button"
            hx-post={`/deliverables/${deliverable.id}/generate-titles`}
            hx-target="body"
            hx-swap="outerHTML"
            hx-disabled-elt="this"
          >
            Generate titles
          </button>
        </div>
      ) : (
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px;">
          {sortedConcepts.map((c) => (
            <TitleCard deliverable={deliverable} concept={c} />
          ))}
        </div>
      )}
    </Layout>
  );
};

// =========================================================================
// Thumbnail Workshop (M20)
// =========================================================================

export interface ThumbnailWorkshopViewProps {
  plan: Plan;
  deliverable: Deliverable;
  concepts: ThumbnailConcept[];
  selectedTitleText: string | null;
  flash?: LayoutProps['flash'];
}

const ThumbnailCard: FC<{ deliverable: Deliverable; concept: ThumbnailConcept }> = ({
  deliverable,
  concept,
}) => {
  const cardClass = `concept-card${concept.selected ? ' selected' : ''}`;
  const swatch = (hex: string) => (
    <span style={`display:inline-block; width:16px; height:16px; background:${hex}; border:1px solid var(--border-soft); border-radius:3px; vertical-align:middle; margin-right:4px;`} />
  );
  return (
    <div
      class={cardClass}
      hx-post={`/deliverables/${deliverable.id}/select-thumbnail`}
      hx-vals={JSON.stringify({ conceptId: concept.id })}
      hx-target="body"
      hx-swap="outerHTML"
      hx-disabled-elt="this"
      style={`cursor:${concept.selected ? 'default' : 'pointer'}; padding:16px; background:var(--surface); border:2px solid ${concept.selected ? 'var(--accent)' : 'var(--border-soft)'}; border-radius:8px; display:flex; flex-direction:column; gap:8px;`}
    >
      <div style="display:flex; align-items:center; justify-content:space-between;">
        <div>
          {concept.colorPalette.map((hex) => swatch(hex))}
        </div>
        {concept.expression ? (
          <span class="tag" style="text-transform:none;">{concept.expression}</span>
        ) : null}
      </div>
      <div style="font-size:18px; font-weight:700; line-height:1.2;">{concept.textHook}</div>
      <div style="font-size:13px; color:var(--ink-2);">{concept.composition}</div>
      <div style="font-size:13px; color:var(--ink-3); font-style:italic;">{concept.conceptSummary}</div>
      {concept.assetsRequired.length > 0 ? (
        <div style="margin-top:4px;">
          <div class="field-label">Assets needed</div>
          <ul style="margin:4px 0 0; padding-left:20px; font-size:12px; color:var(--ink-3);">
            {concept.assetsRequired.map((a) => <li>{a}</li>)}
          </ul>
        </div>
      ) : null}
      {concept.selected ? (
        <div style="margin-top:6px; font-size:13px; color:var(--accent); font-weight:600;">✓ selected</div>
      ) : null}
    </div>
  );
};

export const ThumbnailWorkshopView: FC<ThumbnailWorkshopViewProps> = ({
  plan,
  deliverable,
  concepts,
  selectedTitleText,
  flash,
}) => {
  return (
    <Layout title={`Thumbnails · ${plan.title}`} flash={flash}>
      <div style="margin-bottom:16px;">
        <a href={`/plans/${plan.id}`} class="muted" style="font-size:14px;">
          ← Back to plan
        </a>
      </div>
      <div class="card" style="margin-bottom:16px;">
        <h1 style="margin:0 0 6px;font-size:22px;">Thumbnails · {plan.title}</h1>
        <div style="font-size:14px; color:var(--ink-3); margin-bottom:6px;">
          Deliverable: <strong>{deliverable.title}</strong> ({deliverable.kind})
        </div>
        {selectedTitleText ? (
          <div style="font-size:14px; color:var(--ink-2); margin-bottom:12px;">
            For title: <em>{selectedTitleText}</em>
          </div>
        ) : (
          <div style="font-size:13px; color:var(--danger); margin-bottom:12px;">
            ⚠ No title selected yet — concepts will be generic until you pick one.
          </div>
        )}
        <div class="row" style="gap:8px; flex-wrap:wrap;">
          <button
            class="btn secondary"
            type="button"
            hx-post={`/deliverables/${deliverable.id}/generate-thumbnails`}
            hx-target="body"
            hx-swap="outerHTML"
            hx-confirm="Discard current concepts and generate a new set?"
            hx-disabled-elt="this"
          >
            Regenerate thumbnails
          </button>
        </div>
        <div style="margin-top:8px; font-size:13px; color:var(--ink-3);">
          Concepts are text-only briefs. Use your favorite tool (Figma, Photoshop, Canva, AI image gen) to produce the actual thumbnail from the selected concept.
        </div>
      </div>

      {concepts.length === 0 ? (
        <div style="text-align:center; padding:48px 24px; background:var(--surface); border:1px dashed var(--border-strong); border-radius:10px;">
          <div style="font-size:16px; color:var(--ink-3); margin-bottom:16px;">
            Generate thumbnail concepts first
          </div>
          <button
            class="btn accent"
            type="button"
            hx-post={`/deliverables/${deliverable.id}/generate-thumbnails`}
            hx-target="body"
            hx-swap="outerHTML"
            hx-disabled-elt="this"
          >
            Generate thumbnails
          </button>
        </div>
      ) : (
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px;">
          {concepts.map((c) => (
            <ThumbnailCard deliverable={deliverable} concept={c} />
          ))}
        </div>
      )}
    </Layout>
  );
};
