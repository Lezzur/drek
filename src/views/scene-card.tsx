import type { FC } from 'hono/jsx';
import type { Scene } from '../db/schemas.js';

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

const editableSimpleFields: Array<keyof Scene> = [
  'title',
  'description',
  'framingNotes',
  'script',
  'pacingNotes',
  'transitionNote',
];

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

const ClickableField: FC<{
  planId: string;
  scene: Scene;
  field: keyof Scene;
  label: string;
  display?: string;
  rows?: number;
  inEdit: boolean;
}> = ({ planId, scene, field, label, display, rows, inEdit }) => {
  const value = display ?? asString(scene[field]);
  if (inEdit) {
    return (
      <div style="margin-bottom:10px;">
        <div class="muted" style="font-size:12px; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:4px;">{label}</div>
        <EditorTextarea planId={planId} scene={scene} field={field} rows={rows} />
      </div>
    );
  }
  return (
    <div
      style="margin-bottom:10px; cursor:pointer;"
      hx-get={`/plans/${planId}/scenes/${scene.id}/edit?field=${field as string}`}
      hx-target={`#scene-${scene.id}`}
      hx-swap="outerHTML"
    >
      <div class="muted" style="font-size:12px; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:4px;">
        {label}
      </div>
      <div style="white-space:pre-wrap;">{value || <span class="muted">(empty — click to add)</span>}</div>
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
    <div id={`scene-${scene.id}`} class="card" style="display:flex; gap:16px;">
      <div style="display:flex; flex-direction:column; align-items:center; gap:6px; min-width:48px;">
        <div style="font-weight:600; font-size:18px;">#{scene.order}</div>
        <button
          class="btn small linkish"
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
          class="btn small linkish"
          type="button"
          disabled={isLast}
          hx-post={`/plans/${planId}/scenes/${scene.id}/move-down`}
          hx-target="#scene-list"
          hx-swap="outerHTML"
          title="Move down"
        >
          ▼
        </button>
        <div class="muted" style="font-size:12px;">{scene.estimatedDurationSeconds}s</div>
      </div>

      <div style="flex:1;">
        <ClickableField
          planId={planId}
          scene={scene}
          field="title"
          label="Title"
          rows={1}
          inEdit={editField === 'title'}
        />
        <ClickableField
          planId={planId}
          scene={scene}
          field="framingNotes"
          label="Framing"
          rows={2}
          inEdit={editField === 'framingNotes'}
        />
        <ClickableField
          planId={planId}
          scene={scene}
          field="description"
          label="Description"
          rows={3}
          inEdit={editField === 'description'}
        />
        <ClickableField
          planId={planId}
          scene={scene}
          field="script"
          label="Script (spoken)"
          rows={6}
          inEdit={editField === 'script'}
        />
        <ClickableField
          planId={planId}
          scene={scene}
          field="pacingNotes"
          label="Pacing notes"
          rows={2}
          inEdit={editField === 'pacingNotes'}
        />
        <ClickableField
          planId={planId}
          scene={scene}
          field="transitionNote"
          label="Transition to next"
          rows={2}
          inEdit={editField === 'transitionNote'}
        />
        {scene.projectRef ? (
          <div class="muted" style="font-size:13px;">Featuring project: <strong>{scene.projectRef}</strong></div>
        ) : null}
      </div>

      <div>
        <button
          class="btn small danger"
          type="button"
          hx-delete={`/plans/${planId}/scenes/${scene.id}`}
          hx-target="#scene-list"
          hx-swap="outerHTML"
          hx-confirm="Delete this scene? Remaining scenes will renumber."
          title="Delete scene"
        >
          ✕
        </button>
      </div>
    </div>
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
            class="btn secondary"
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

  // Use a non-self-closing parent so we can wrap, but use SceneCard directly
  // via list to keep JSX readable.
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
          class="btn secondary"
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
