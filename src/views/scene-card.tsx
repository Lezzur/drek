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
          class="btn small secondary"
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
          class="btn small secondary"
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
