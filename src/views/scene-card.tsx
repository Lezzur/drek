import type { FC } from 'hono/jsx';
import type { Scene } from '../db/schemas.js';
import { SCENE_INTERFACE_TYPES, SHOT_ITEM_SOURCES } from '../db/schemas.js';

/**
 * Scene card — the unit of the M8 plan-detail UI. Rendered as a full card on
 * page load and as an HTMX partial response when reordered / edited / added.
 *
 * Editable fields: title, description, framingNotes, script, pacingNotes,
 * transitionNote, projectRef. Click-to-edit pattern: each editable region is
 * a clickable element that swaps in a textarea (inline-edit form). On blur
 * the form auto-submits via hx-trigger=blur and the response replaces the
 * whole card with the updated render.
 */

export interface SceneCardProps {
  planId: string;
  scene: Scene;
  /** Whether this card is currently in edit mode for a particular field.
   *  When set, the editor takes over for that field; everything else stays
   *  readable. */
  editField?: keyof Scene | null;
  isFirst: boolean;
  isLast: boolean;
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

const EditorTextarea: FC<{
  planId: string;
  scene: Scene;
  field: keyof Scene;
  rows?: number;
}> = ({ planId, scene, field, rows = 3 }) => {
  return (
    <form
      class="inline"
      hx-patch={`/plans/${planId}/scenes/${scene.id}`}
      hx-target={`#scene-${scene.id}`}
      hx-swap="outerHTML"
      hx-trigger="submit, blur from:textarea delay:200ms"
    >
      <input type="hidden" name="field" value={field as string} />
      <textarea
        name="value"
        rows={rows}
        autofocus
      >{asString(scene[field])}</textarea>
      <div class="muted" style="font-size:12px; margin-top:4px;">
        Auto-saves on blur — press Esc to cancel.
      </div>
    </form>
  );
};

const FIELD_LABELS: Partial<Record<keyof Scene, string>> = {
  title: 'Title',
  framingNotes: 'Framing',
  description: 'Description',
  script: 'Script (spoken)',
  pacingNotes: 'Pacing notes',
  transitionNote: 'Transition to next',
};

const FIELD_ROWS: Partial<Record<keyof Scene, number>> = {
  title: 1,
  framingNotes: 2,
  description: 3,
  script: 10,
  pacingNotes: 2,
  transitionNote: 2,
};

const ClickableField: FC<{
  planId: string;
  scene: Scene;
  field: keyof Scene;
  label: string;
  rows?: number;
  inEdit: boolean;
  valueClass?: string;
}> = ({ planId, scene, field, label, rows, inEdit, valueClass }) => {
  const value = asString(scene[field]);
  if (inEdit) {
    return (
      <div class="field-block">
        <div class="field-label">{label}</div>
        <EditorTextarea planId={planId} scene={scene} field={field} rows={rows} />
      </div>
    );
  }
  return (
    <div
      class="field-block"
      hx-get={`/plans/${planId}/scenes/${scene.id}/edit?field=${field as string}`}
      hx-target={`#scene-${scene.id}`}
      hx-swap="outerHTML"
    >
      <div class="field-label">{label}</div>
      <div class={`field-value${valueClass ? ` ${valueClass}` : ''}`}>
        {value || <span class="field-empty">(empty — click to add)</span>}
      </div>
    </div>
  );
};

export const SceneCard: FC<SceneCardProps> = ({
  planId,
  scene,
  editField,
  isFirst,
  isLast,
}) => {
  return (
    <div id={`scene-${scene.id}`} class="scene-card">
      <div class="scene-col-left">
        <div class="scene-num">#{scene.order}</div>
        <button
          class="btn scene-move secondary"
          type="button"
          disabled={isFirst}
          hx-post={`/plans/${planId}/scenes/${scene.id}/move-up`}
          hx-target="#scene-list"
          hx-swap="outerHTML"
          title="Move up"
        >
          ▲
        </button>
        <button
          class="btn scene-move secondary"
          type="button"
          disabled={isLast}
          hx-post={`/plans/${planId}/scenes/${scene.id}/move-down`}
          hx-target="#scene-list"
          hx-swap="outerHTML"
          title="Move down"
        >
          ▼
        </button>
        <div class="scene-dur">{scene.estimatedDurationSeconds}s</div>
      </div>

      <div>
        <ClickableField
          planId={planId}
          scene={scene}
          field="title"
          label={FIELD_LABELS.title!}
          rows={FIELD_ROWS.title}
          inEdit={editField === 'title'}
          valueClass="title-value"
        />
        <ClickableField
          planId={planId}
          scene={scene}
          field="framingNotes"
          label={FIELD_LABELS.framingNotes!}
          rows={FIELD_ROWS.framingNotes}
          inEdit={editField === 'framingNotes'}
        />
        <ClickableField
          planId={planId}
          scene={scene}
          field="description"
          label={FIELD_LABELS.description!}
          rows={FIELD_ROWS.description}
          inEdit={editField === 'description'}
        />
        <ClickableField
          planId={planId}
          scene={scene}
          field="script"
          label={FIELD_LABELS.script!}
          rows={FIELD_ROWS.script}
          inEdit={editField === 'script'}
          valueClass="script-value"
        />
        <ClickableField
          planId={planId}
          scene={scene}
          field="pacingNotes"
          label={FIELD_LABELS.pacingNotes!}
          rows={FIELD_ROWS.pacingNotes}
          inEdit={editField === 'pacingNotes'}
        />
        <ClickableField
          planId={planId}
          scene={scene}
          field="transitionNote"
          label={FIELD_LABELS.transitionNote!}
          rows={FIELD_ROWS.transitionNote}
          inEdit={editField === 'transitionNote'}
        />
        {scene.projectRef ? (
          <div class="scene-project-ref">project: <code>{scene.projectRef}</code></div>
        ) : null}
        <ShotListBlock planId={planId} scene={scene} />
      </div>

      <div style="padding-top:2px;">
        <button
          class="btn-delete-scene"
          type="button"
          hx-delete={`/plans/${planId}/scenes/${scene.id}`}
          hx-target="#scene-list"
          hx-swap="outerHTML"
          hx-confirm="Delete this scene? Remaining scenes will renumber."
        >
          ✕
        </button>
      </div>
    </div>
  );
};

/**
 * Shot list section for v2 scenes. Exported so the shot-edit route endpoints
 * can return it as an HTMX partial. Renders only when the scene has at least
 * one shot-list field populated.
 *
 * primaryShot and brollItems are editable inline. shotListItems, cutPoints,
 * and onScreenTextOverlays are read-only (auto-generated, rarely hand-edited).
 */
export const ShotListBlock: FC<{ planId: string; scene: Scene }> = ({ planId, scene }) => {
  const hasShotData =
    scene.primaryShot !== null ||
    scene.brollItems.length > 0 ||
    scene.shotListItems.length > 0 ||
    scene.onScreenTextOverlays.length > 0 ||
    scene.cutPoints.length > 0;

  if (!hasShotData) return null;

  const shotUrl = (suffix: string) => `/plans/${planId}/scenes/${scene.id}/shots${suffix}`;
  const blockId = `shot-block-${scene.id}`;
  const target = `#${blockId}`;

  return (
    <details class="shot-list-block" open id={blockId}>
      <summary
        style="cursor:pointer;font-weight:600;font-size:13px;color:var(--ink-2);margin-top:12px;padding-top:8px;border-top:1px dashed var(--border-soft);"
      >
        Shot list
        {scene.beatTag ? <span class="muted"> · beat: {scene.beatTag}</span> : null}
      </summary>
      <div style="margin-top:10px;display:flex;flex-direction:column;gap:10px;">

        {/* Primary shot — editable type + description */}
        {scene.primaryShot ? (
          <div>
            <div class="field-label" style="margin-bottom:4px;">Primary shot</div>
            <form
              hx-patch={shotUrl('/primary')}
              hx-target={target}
              hx-swap="outerHTML"
              hx-trigger="change from:select, blur from:input delay:300ms"
              style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;"
            >
              <select name="type" style="font-size:12px;padding:2px 4px;border-radius:4px;background:var(--surface-raised);color:var(--ink-2);border:1px solid var(--border);">
                {SCENE_INTERFACE_TYPES.map((t) => (
                  <option value={t} selected={t === scene.primaryShot!.type}>{t}</option>
                ))}
              </select>
              <input
                type="text"
                name="description"
                value={scene.primaryShot.description}
                style="flex:1;font-size:13px;min-width:200px;background:transparent;border:none;border-bottom:1px dashed var(--border);color:var(--ink-2);padding:2px 0;"
              />
            </form>
          </div>
        ) : null}

        {/* B-roll — editable descriptions, add/remove */}
        <div>
          <div class="field-label" style="margin-bottom:4px;">
            B-roll{scene.brollItems.length > 0 ? ` · ${scene.brollItems.length}` : ''}
          </div>
          {scene.brollItems.length > 0 ? (
            <ul style="margin:0 0 8px;padding-left:0;list-style:none;display:flex;flex-direction:column;gap:4px;">
              {scene.brollItems.map((b, i) => (
                <li key={i} style="display:flex;gap:6px;align-items:center;font-size:13px;">
                  <span class="tag" style="flex-shrink:0;">{b.type}</span>
                  <form
                    hx-patch={shotUrl(`/broll/${i}`)}
                    hx-target={target}
                    hx-swap="outerHTML"
                    hx-trigger="blur from:input delay:300ms"
                    style="flex:1;display:flex;"
                  >
                    <input
                      type="text"
                      name="description"
                      value={b.description}
                      style="flex:1;font-size:13px;background:transparent;border:none;border-bottom:1px dashed var(--border);color:var(--ink-2);padding:2px 0;"
                    />
                  </form>
                  <span class="muted" style="font-size:12px;flex-shrink:0;">{b.durationSeconds}s</span>
                  <button
                    type="button"
                    hx-delete={shotUrl(`/broll/${i}`)}
                    hx-target={target}
                    hx-swap="outerHTML"
                    style="background:none;border:none;color:var(--ink-4);cursor:pointer;padding:0 2px;font-size:13px;line-height:1;"
                    title="Remove b-roll item"
                  >✕</button>
                </li>
              ))}
            </ul>
          ) : null}
          {/* Add b-roll form */}
          <form
            hx-post={shotUrl('/broll')}
            hx-target={target}
            hx-swap="outerHTML"
            style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:4px;"
          >
            <select name="type" style="font-size:12px;padding:2px 4px;border-radius:4px;background:var(--surface-raised);color:var(--ink-2);border:1px solid var(--border);">
              {SCENE_INTERFACE_TYPES.map((t) => <option value={t}>{t}</option>)}
            </select>
            <input
              type="text"
              name="description"
              required
              placeholder="B-roll description"
              style="flex:1;font-size:13px;min-width:160px;"
            />
            <input
              type="number"
              name="durationSeconds"
              value={10}
              min={1}
              max={600}
              style="width:54px;font-size:13px;"
            />
            <span class="muted" style="font-size:12px;">s</span>
            <select name="source" style="font-size:12px;padding:2px 4px;border-radius:4px;background:var(--surface-raised);color:var(--ink-2);border:1px solid var(--border);">
              {SHOT_ITEM_SOURCES.map((s) => <option value={s}>{s.replace(/_/g, ' ')}</option>)}
            </select>
            <button type="submit" class="btn small" style="font-size:12px;padding:3px 8px;">＋ Add</button>
          </form>
        </div>

        {/* Shot list items — read-only */}
        {scene.shotListItems.length > 0 ? (
          <div>
            <div class="field-label">Shot list items · {scene.shotListItems.length}</div>
            <ul style="margin:4px 0 0;padding-left:20px;font-size:13px;color:var(--ink-2);">
              {scene.shotListItems.map((s, i) => (
                <li key={i}>
                  <span class="tag" style="margin-right:6px;">{s.type}</span>
                  {s.description}
                  <span class="muted" style="font-size:12px;"> · {s.durationSeconds}s</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {/* On-screen text — read-only */}
        {scene.onScreenTextOverlays.length > 0 ? (
          <div>
            <div class="field-label">On-screen text · {scene.onScreenTextOverlays.length}</div>
            <ul style="margin:4px 0 0;padding-left:20px;font-size:13px;color:var(--ink-2);">
              {scene.onScreenTextOverlays.map((o, i) => (
                <li key={i}>
                  <strong>{o.textContent}</strong>
                  <span class="muted" style="font-size:12px;"> · {o.styleHint} · {o.timingHint}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {/* Cut points — read-only */}
        {scene.cutPoints.length > 0 ? (
          <div>
            <div class="field-label">Cut points · {scene.cutPoints.length}</div>
            <ul style="margin:4px 0 0;padding-left:20px;font-size:13px;color:var(--ink-2);">
              {scene.cutPoints.map((cp, i) => (
                <li key={i}>
                  Line {cp.scriptLineNumber}: {cp.reason}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </details>
  );
};

/** A list of scene cards — wrapped in an id so HTMX reorder/add/delete
 *  swaps the whole list cleanly. */
export const SceneList: FC<{ planId: string; scenes: Scene[] }> = ({
  planId,
  scenes,
}) => {
  if (scenes.length === 0) {
    return (
      <div id="scene-list">
        <div class="empty">
          No scenes yet. Run <strong>Generate plan</strong> above to have DREK draft scenes from
          your matched projects, or add scenes manually with the button below.
        </div>
        <div style="margin-top:12px;">
          <button
            class="btn-add-scene"
            type="button"
            hx-post={`/plans/${planId}/scenes`}
            hx-target="#scene-list"
            hx-swap="outerHTML"
          >
            + Add blank scene
          </button>
        </div>
      </div>
    );
  }

  return (
    <div id="scene-list">
      {scenes.map((s, i) => (
        <SceneCard
          planId={planId}
          scene={s}
          isFirst={i === 0}
          isLast={i === scenes.length - 1}
        />
      ))}
      <div style="margin-top:12px;">
        <button
          class="btn-add-scene"
          type="button"
          hx-post={`/plans/${planId}/scenes`}
          hx-target="#scene-list"
          hx-swap="outerHTML"
        >
          + Add blank scene
        </button>
      </div>
    </div>
  );
};
