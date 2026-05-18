import type { FC } from 'hono/jsx';
import { Layout, type LayoutProps } from './layout.js';
import { SceneList } from './scene-card.js';
import type { Plan, Scene, PlanStatus } from '../db/schemas.js';

export interface PlanDetailProps {
  plan: Plan;
  scenes: Scene[];
  flash?: LayoutProps['flash'];
}

const STATUS_LABELS: Record<PlanStatus, string> = {
  // v1
  awaiting_review: 'Awaiting review',
  dismissed: 'Dismissed',
  requirements_reviewed: 'Requirements reviewed',
  projects_matched: 'Projects matched',
  scenes_generated: 'Scenes generated',
  finalized: 'Finalized',
  exported: 'Exported',
  // v2 (youtube_advanced)
  hooks_generated: 'Hooks generated',
  hook_selected: 'Hook selected',
  shot_list_generated: 'Shot list generated',
  titles_generated: 'Titles generated',
  title_selected: 'Title selected',
  thumbnails_generated: 'Thumbnails generated',
  thumbnail_selected: 'Thumbnail selected',
  shorts_extracted: 'Shorts extracted',
  metadata_generated: 'Metadata generated',
};

/**
 * Runtime bar — visualizes estimated vs target runtime. Green when within
 * 15% of target, yellow if 15-30% off, red beyond 30%. Per PRD §4.9.
 */
const RuntimeBar: FC<{ targetSeconds: number; estimatedSeconds: number }> = ({
  targetSeconds,
  estimatedSeconds,
}) => {
  const ratio = targetSeconds > 0 ? estimatedSeconds / targetSeconds : 0;
  const deviation = Math.abs(ratio - 1);
  const color = deviation <= 0.15 ? 'var(--green-fg)' : deviation <= 0.3 ? 'var(--amber-fg)' : 'var(--danger)';
  const pct = Math.min(150, Math.round(ratio * 100));
  const label = deviation > 0.15
    ? ` (${Math.round(deviation * 100)}% off target)`
    : '';
  return (
    <div class="card" style="margin-bottom:16px;">
      <h3 class="section-label">Runtime estimate</h3>
      <div class="row" style="justify-content:space-between;">
        <span class="muted" style="font-size:13px;">Estimated</span>
        <span style={`font-weight:600; color:${color}; font-variant-numeric:tabular-nums;`}>
          {estimatedSeconds}s / {targetSeconds}s{label}
        </span>
      </div>
      <div class="runtime-bar-track" style="margin-top:8px;">
        <div class="runtime-bar-fill" style={`width:${pct}%; background:${color};`}></div>
      </div>
    </div>
  );
};

const ActionStrip: FC<{ plan: Plan }> = ({ plan }) => {
  const canRunPipeline = plan.status !== 'dismissed';
  const canFinalize = plan.status === 'scenes_generated';
  const rerun = ['requirements_reviewed', 'projects_matched', 'scenes_generated', 'finalized', 'exported'].includes(plan.status);

  return (
    <div class="card" style="margin-bottom:16px;">
      <h3 class="section-label">Pipeline</h3>
      <div class="row" style="gap:12px; flex-wrap:wrap;">
        <button
          class="btn"
          type="button"
          disabled={!canRunPipeline}
          hx-post={`/plans/${plan.id}/run`}
          hx-target="body"
          hx-swap="outerHTML"
          hx-indicator="#run-indicator"
          hx-disabled-elt="this"
          hx-confirm={rerun ? 'Re-run pipeline? Existing scenes and scripts will be replaced.' : undefined}
        >
          Run pipeline
        </button>
        <span class="spacer" />
        <button
          class="btn"
          type="button"
          disabled={!canFinalize}
          hx-post={`/plans/${plan.id}/finalize`}
          hx-target="body"
          hx-swap="outerHTML"
          hx-confirm="Finalize this plan? Approved scripts will be sent to Neurocore as spoken-voice training data."
        >
          Finalize
        </button>
        <a
          class={`btn ${plan.status === 'finalized' || plan.status === 'exported' ? '' : 'secondary'}`}
          href={`/plans/${plan.id}/export`}
        >
          Export shoot instructions
        </a>
      </div>
      <div id="run-indicator" class="pipeline-indicator">
        Running pipeline — this usually takes a minute or two…
      </div>
    </div>
  );
};

const RequirementsBlock: FC<{ plan: Plan }> = ({ plan }) => {
  if (plan.type !== 'cover_letter') return null;
  if (plan.requirements.length === 0) {
    return (
      <div class="card">
        <h3 class="section-label">Requirements · not analyzed yet</h3>
        <div class="muted">
          Click <strong>Run pipeline</strong> above to extract them from the listing.
        </div>
      </div>
    );
  }
  return (
    <div class="card">
      <h3 class="section-label">Requirements · {plan.requirements.length} extracted</h3>
      {plan.requirements.map((r) => (
        <div style="display:grid; grid-template-columns:92px 1fr 160px; gap:14px 16px; padding:12px 0; border-top:1px solid var(--border-soft);">
          <span class={`tag ${r.priority === 'must_show' ? 'must' : 'nice'}`}>
            {r.priority === 'must_show' ? 'Must' : 'Nice'}
          </span>
          <div>
            <strong>{r.skill}</strong>
            <div style="color:var(--ink-3);font-size:13px;margin-top:2px;">{r.evidence}</div>
          </div>
          <div style="text-align:right;color:var(--ink-3);font-size:12px;">{r.category}</div>
        </div>
      ))}
    </div>
  );
};

const MatchedProjectsBlock: FC<{ plan: Plan }> = ({ plan }) => {
  if (plan.matchedProjects.length === 0) {
    return (
      <div class="card">
        <h3 class="section-label">Matched projects · none yet</h3>
        <div class="muted">
          Click <strong>Run pipeline</strong> above.
        </div>
      </div>
    );
  }
  return (
    <div class="card">
      <h3 class="section-label">Matched projects · {plan.matchedProjects.length} selected</h3>
      {plan.matchedProjects.map((m, i) => (
        <div class="row" style="border-top:1px solid var(--border-soft); padding:14px 0; align-items:flex-start; gap:12px;">
          <span style="color:var(--ink-3);font-size:14px;font-variant-numeric:tabular-nums;min-width:28px;">{i + 1}.</span>
          <div style="flex:1;">
            <div style="font-weight:600;">
              {m.projectName}<span class="muted"> /{m.projectSlug}</span>
            </div>
            {m.matchedFeatures.length > 0 ? (
              <div style="margin-top:4px; display:flex; gap:4px; flex-wrap:wrap;">
                {m.matchedFeatures.map((f) => (
                  <span class="feature-chip">{f}</span>
                ))}
              </div>
            ) : null}
            {m.suggestedDemoSequence ? (
              <div style="font-size:13px;color:var(--ink-2);margin-top:4px;font-style:italic;">{m.suggestedDemoSequence}</div>
            ) : null}
          </div>
          <span style="color:var(--link);font-weight:700;font-variant-numeric:tabular-nums;font-size:14px;white-space:nowrap;">
            {m.relevanceScore.toFixed(2)}<span class="muted" style="font-weight:400; font-size:12px;"> rel</span>
          </span>
        </div>
      ))}
    </div>
  );
};

const ListingContext: FC<{ plan: Plan }> = ({ plan }) => {
  if (plan.type !== 'cover_letter') return null;
  if (!plan.sourceListingText) return null;
  return (
    <div class="card">
      <details>
        <summary style="cursor:pointer;font-weight:600;font-size:14px;color:var(--ink-2);">Source listing text</summary>
        <pre style="white-space:pre-wrap;word-break:break-word;margin:12px 0 0;font-family:inherit;font-size:14px;color:var(--ink-3);max-height:300px;overflow-y:auto;">
          {plan.sourceListingText}
        </pre>
      </details>
    </div>
  );
};

const PlanHeader: FC<{ plan: Plan }> = ({ plan }) => {
  return (
    <div style="margin-bottom: 20px;">
      <a href="/" class="muted" style="font-size:13px; color:var(--ink-3); text-decoration:none; display:inline-block; margin-bottom:8px;">← Dashboard</a>
      <div class="row" style="gap:12px; align-items:flex-start;">
        <h1 style="margin:0; flex:1;">{plan.title}</h1>
        <span class={`badge ${plan.status}`}>{STATUS_LABELS[plan.status]}</span>
      </div>
      <div class="row" style="gap:10px; margin-top:6px; color:var(--ink-3); font-size:14px;">
        <span>{plan.type === 'cover_letter' ? 'Cover letter' : 'YouTube'}</span>
        <span style="width:3px;height:3px;border-radius:50%;background:#c5c5c5;flex-shrink:0;"></span>
        <span>Target {plan.targetRuntimeSeconds}s</span>
      </div>
    </div>
  );
};

export const PlanDetailPage: FC<PlanDetailProps> = ({ plan, scenes, flash }) => {
  return (
    <Layout title={plan.title} flash={flash}>
      <PlanHeader plan={plan} />
      <ActionStrip plan={plan} />
      <RuntimeBar targetSeconds={plan.targetRuntimeSeconds} estimatedSeconds={plan.estimatedRuntimeSeconds} />
      {plan.userConstraints ? (
        <div class="card">
          <h3 class="section-label">Instructions</h3>
          <div style="font-size:14.5px;color:var(--ink-2);white-space:pre-wrap;">{plan.userConstraints}</div>
        </div>
      ) : null}
      <ListingContext plan={plan} />
      <RequirementsBlock plan={plan} />
      <MatchedProjectsBlock plan={plan} />
      <h2 style="margin: 24px 0 12px;">Scenes ({scenes.length})</h2>
      <SceneList planId={plan.id} scenes={scenes} />
    </Layout>
  );
};

export { RuntimeBar };
