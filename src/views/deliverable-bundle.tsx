import type { FC } from 'hono/jsx';
import { Layout, type LayoutProps } from './layout.js';
import type {
  Plan,
  Deliverable,
  DeliverableKind,
  DeliverableStatus,
  TitleConcept,
  ThumbnailConcept,
} from '../db/schemas.js';

export interface DeliverableSummary {
  deliverable: Deliverable;
  selectedTitle: TitleConcept | null;
  selectedThumbnail: ThumbnailConcept | null;
  hasPublishMetadata: boolean;
}

export interface DeliverableBundleViewProps {
  plan: Plan;
  summaries: DeliverableSummary[];
  exportFlash?: {
    successCount: number;
    failures: Array<{ deliverableId: string; reason: string }>;
  } | null;
  flash?: LayoutProps['flash'];
}

const KIND_LABELS: Record<DeliverableKind, string> = {
  long_form: 'Long-form',
  short_clip: 'Short',
  lead_magnet: 'Lead magnet',
};

const STATUS_LABELS: Record<DeliverableStatus, string> = {
  draft: 'Draft',
  scripts_ready: 'Scripts ready',
  metadata_ready: 'Metadata ready',
  exported: 'Exported',
  published: 'Published',
};

const STATUS_COLOR: Record<DeliverableStatus, string> = {
  draft: 'var(--ink-3)',
  scripts_ready: 'var(--amber-fg)',
  metadata_ready: 'var(--accent)',
  exported: 'var(--link)',
  published: 'var(--green-fg)',
};

const DeliverableCard: FC<{
  plan: Plan;
  summary: DeliverableSummary;
  prominent?: boolean;
}> = ({ plan, summary, prominent }) => {
  const { deliverable, selectedTitle, selectedThumbnail, hasPublishMetadata } = summary;
  const titleText = selectedTitle?.titleText ?? deliverable.title;
  const thumbText = selectedThumbnail?.conceptSummary ?? null;

  return (
    <div
      id={`deliverable-${deliverable.id}`}
      style={`background:var(--surface); border:1px solid var(--border-soft); border-radius:10px; padding:18px; display:flex; flex-direction:column; gap:10px; ${prominent ? 'grid-column: 1 / -1;' : ''}`}
    >
      <div class="row" style="justify-content:space-between; align-items:flex-start; gap:8px;">
        <div style="display:flex; gap:6px; flex-wrap:wrap;">
          <span class="tag">{KIND_LABELS[deliverable.kind]}</span>
          <span
            class="tag"
            style={`background:transparent; border:1px solid ${STATUS_COLOR[deliverable.status]}; color:${STATUS_COLOR[deliverable.status]};`}
          >
            {STATUS_LABELS[deliverable.status]}
          </span>
        </div>
        <span class="muted" style="font-size:12px;">
          {deliverable.audienceProfileId}
        </span>
      </div>

      <div style="font-size:16px; font-weight:600; line-height:1.35;">{titleText}</div>

      {thumbText ? (
        <div style="font-size:13px; color:var(--ink-3); font-style:italic;">
          Thumbnail: {thumbText}
        </div>
      ) : null}

      {deliverable.youtubeUrl ? (
        <div style="font-size:13px;">
          <a
            href={deliverable.youtubeUrl}
            target="_blank"
            rel="noopener noreferrer"
            style="color:var(--link); word-break:break-all;"
          >
            {deliverable.youtubeUrl}
          </a>
        </div>
      ) : null}

      <div class="row" style="gap:6px; flex-wrap:wrap; margin-top:6px;">
        <a class="btn secondary" href={`/plans/${plan.id}/deliverables/${deliverable.id}`}>
          Open
        </a>
        {hasPublishMetadata ? (
          <a class="btn secondary" href={`/deliverables/${deliverable.id}/publish`}>
            Publishing
          </a>
        ) : (
          <a class="btn secondary" href={`/deliverables/${deliverable.id}/publish`}>
            Set up publishing
          </a>
        )}
        {deliverable.kind === 'long_form' ? (
          <a class="btn secondary" href={`/plans/${plan.id}/footage`}>
            Footage
          </a>
        ) : null}
      </div>
    </div>
  );
};

const ExportAllBlock: FC<{
  plan: Plan;
  summaries: DeliverableSummary[];
  exportFlash: DeliverableBundleViewProps['exportFlash'];
}> = ({ plan, summaries, exportFlash }) => {
  if (summaries.length === 0) return null;
  return (
    <div class="card" style="margin-bottom:16px;">
      <div class="row" style="gap:12px; align-items:center; flex-wrap:wrap;">
        <button
          class="btn accent"
          type="button"
          hx-post={`/plans/${plan.id}/deliverables/export-all`}
          hx-target="body"
          hx-swap="outerHTML"
          hx-disabled-elt="this"
          hx-indicator="#export-all-indicator"
        >
          Export all to workspace
        </button>
        <span class="muted" style="font-size:12px;">
          Writes shoot-instructions.html, shoot-instructions.txt,
          publish-bundle.txt, metadata.json into exports/&#123;deliverableId&#125;/ for every
          deliverable that has publishing metadata.
        </span>
      </div>
      {exportFlash ? (
        <div style="margin-top:10px; font-size:13px;">
          <strong>Exported {exportFlash.successCount} deliverable(s).</strong>
          {exportFlash.failures.length > 0 ? (
            <ul style="margin-top:6px;">
              {exportFlash.failures.map((f) => (
                <li style="color:var(--danger);">
                  {f.deliverableId}: {f.reason}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      <div
        id="export-all-indicator"
        class="pipeline-indicator"
        style="margin-top:10px;"
      >
        Writing files — this is usually instant…
      </div>
    </div>
  );
};

export const DeliverableBundleView: FC<DeliverableBundleViewProps> = ({
  plan,
  summaries,
  exportFlash,
  flash,
}) => {
  const longForm = summaries.find((s) => s.deliverable.kind === 'long_form');
  const shorts = summaries.filter((s) => s.deliverable.kind === 'short_clip');
  const others = summaries.filter(
    (s) => s.deliverable.kind !== 'long_form' && s.deliverable.kind !== 'short_clip',
  );

  return (
    <Layout title={`Deliverables · ${plan.title}`} flash={flash}>
      <div style="margin-bottom:16px;">
        <a href={`/plans/${plan.id}`} class="muted" style="font-size:14px;">
          ← Back to plan
        </a>
      </div>
      <div class="card" style="margin-bottom:16px;">
        <h1 style="margin:0 0 6px;font-size:22px;">Deliverables · {plan.title}</h1>
        <div class="muted" style="font-size:14px;">
          Every artifact derived from this plan — long-form, Shorts, future
          lead magnets. Each tile links to its title/thumbnail/publishing
          workshops.
        </div>
      </div>

      <ExportAllBlock plan={plan} summaries={summaries} exportFlash={exportFlash ?? null} />

      {summaries.length === 0 ? (
        <div
          style="text-align:center; padding:48px 24px; background:var(--surface); border:1px dashed var(--border-strong); border-radius:10px;"
        >
          <div style="font-size:16px; color:var(--ink-3); margin-bottom:8px;">
            No deliverables yet
          </div>
          <div style="font-size:14px; color:var(--ink-4);">
            youtube_advanced plans get a long-form deliverable automatically.
            Approved Short candidates become short_clip deliverables — go to
            the <a href={`/plans/${plan.id}/shorts`}>Shorts workshop</a> to
            generate them.
          </div>
        </div>
      ) : (
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px;">
          {longForm ? (
            <DeliverableCard plan={plan} summary={longForm} prominent={true} />
          ) : null}
          {shorts.map((s) => (
            <DeliverableCard plan={plan} summary={s} />
          ))}
          {others.map((s) => (
            <DeliverableCard plan={plan} summary={s} />
          ))}
        </div>
      )}
    </Layout>
  );
};
