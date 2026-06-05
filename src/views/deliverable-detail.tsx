import type { FC } from 'hono/jsx';
import { Layout, BackLink, type LayoutProps } from './layout.js';
import type {
  Plan,
  Deliverable,
  Scene,
  CustomShortScript,
} from '../db/schemas.js';

export interface DeliverableDetailViewProps {
  plan: Plan;
  deliverable: Deliverable;
  /** For long_form: parent plan's scenes. For short_clip: the long-form scenes
   *  referenced by scriptOverrideSceneIds (filtered). */
  relatedScenes: Scene[];
  /** For short_clip: the reworked scripts. Null for long_form. */
  customScripts: CustomShortScript[] | null;
  flash?: LayoutProps['flash'];
}

const ActionLinks: FC<{ plan: Plan; deliverable: Deliverable }> = ({
  plan,
  deliverable,
}) => {
  return (
    <div class="card" style="margin-bottom:16px;">
      <h3 class="section-label">Workshops</h3>
      <div class="row" style="gap:8px; flex-wrap:wrap;">
        {deliverable.kind === 'long_form' ? (
          <>
            <a class="btn secondary" href={`/plans/${plan.id}/workshop/hooks`}>
              Hooks
            </a>
            <a
              class="btn secondary"
              href={`/plans/${plan.id}/workshop/titles?deliverableId=${deliverable.id}`}
            >
              Titles
            </a>
            <a
              class="btn secondary"
              href={`/plans/${plan.id}/workshop/thumbnails?deliverableId=${deliverable.id}`}
            >
              Thumbnails
            </a>
          </>
        ) : (
          <>
            <a
              class="btn secondary"
              href={`/plans/${plan.id}/workshop/titles?deliverableId=${deliverable.id}`}
            >
              Titles
            </a>
            <a
              class="btn secondary"
              href={`/plans/${plan.id}/workshop/thumbnails?deliverableId=${deliverable.id}`}
            >
              Thumbnails
            </a>
          </>
        )}
        <a class="btn secondary" href={`/deliverables/${deliverable.id}/publish`}>
          Publishing
        </a>
        {deliverable.kind === 'long_form' ? (
          <a class="btn secondary" href={`/plans/${plan.id}/footage`}>
            Footage
          </a>
        ) : null}
      </div>
    </div>
  );
};

const ScenesBlock: FC<{ scenes: Scene[] }> = ({ scenes }) => {
  if (scenes.length === 0) {
    return (
      <div class="card">
        <h3 class="section-label">Scenes</h3>
        <div class="muted">No scenes linked to this deliverable yet.</div>
      </div>
    );
  }
  return (
    <div class="card">
      <h3 class="section-label">Scenes · {scenes.length}</h3>
      <div style="display:flex; flex-direction:column; gap:12px;">
        {scenes.map((s) => (
          <div style="border-top:1px solid var(--border-soft); padding-top:10px;">
            <div class="row" style="gap:8px;">
              <strong>#{s.order}</strong>
              <span>{s.title}</span>
              {s.beatTag ? (
                <span class="muted" style="font-size:12px;">· {s.beatTag}</span>
              ) : null}
              <span class="spacer" />
              <span class="muted" style="font-size:12px;">
                ~{s.estimatedDurationSeconds}s
              </span>
            </div>
            {s.script ? (
              <pre
                style="white-space:pre-wrap; word-break:break-word; font-family:inherit; font-size:13px; color:var(--ink-2); margin-top:6px;"
              >
                {s.script}
              </pre>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
};

const CustomScriptBlock: FC<{
  scripts: CustomShortScript[];
}> = ({ scripts }) => {
  return (
    <div class="card">
      <h3 class="section-label">Reworked Short script</h3>
      {scripts.map((cs, i) => (
        <div
          style={`${i > 0 ? 'margin-top:14px; padding-top:14px; border-top:1px solid var(--border-soft);' : ''}`}
        >
          {cs.sourceSceneId ? (
            <div class="muted" style="font-size:12px; margin-bottom:6px;">
              Source scene: {cs.sourceSceneId}
            </div>
          ) : null}
          <pre
            style="white-space:pre-wrap; word-break:break-word; font-family:inherit; font-size:14px; line-height:1.55;"
          >
            {cs.script}
          </pre>
        </div>
      ))}
    </div>
  );
};

export const DeliverableDetailView: FC<DeliverableDetailViewProps> = ({
  plan,
  deliverable,
  relatedScenes,
  customScripts,
  flash,
}) => {
  return (
    <Layout title={`${deliverable.title} · ${plan.title}`} flash={flash}>
      <div style="margin-bottom:16px;">
        <BackLink href={`/plans/${plan.id}/deliverables`} label="Back to deliverables" />
      </div>
      <div class="card" style="margin-bottom:16px;">
        <h1 style="margin:0 0 6px;font-size:22px;">{deliverable.title}</h1>
        <div class="row" style="gap:8px; flex-wrap:wrap; margin-top:4px;">
          <span class="tag">{deliverable.kind}</span>
          <span class="tag">{deliverable.status}</span>
          <span class="muted" style="font-size:12px;">
            audience: {deliverable.audienceProfileId}
          </span>
        </div>
      </div>

      <ActionLinks plan={plan} deliverable={deliverable} />

      {deliverable.kind === 'short_clip' && customScripts && customScripts.length > 0 ? (
        <CustomScriptBlock scripts={customScripts} />
      ) : null}

      <ScenesBlock scenes={relatedScenes} />
    </Layout>
  );
};
