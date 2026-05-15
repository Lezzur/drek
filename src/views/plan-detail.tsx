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
  awaiting_review: 'Awaiting review',
  dismissed: 'Dismissed',
  requirements_reviewed: 'Requirements reviewed',
  projects_matched: 'Projects matched',
  scenes_generated: 'Scenes generated',
  finalized: 'Finalized',
  exported: 'Exported',
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
  const color = deviation <= 0.15 ? '#1c7a32' : deviation <= 0.3 ? '#a06b00' : '#a01b1b';
  const pct = Math.min(150, Math.round(ratio * 100));
  return (
    <div style="margin: 12px 0;">
      <div class="row" style="justify-content:space-between; font-size:13px; margin-bottom:4px;">
        <span class="muted">Estimated runtime</span>
        <span style={`color:${color}; font-weight:600;`}>
          {estimatedSeconds}s / {targetSeconds}s
          {deviation > 0.15
            ? ` (${deviation > 0 ? '±' : ''}${Math.round(deviation * 100)}% off target)`
            : ''}
        </span>
      </div>
      <div style="height:8px; background:#eee; border-radius:4px; overflow:hidden;">
        <div style={`height:100%; width:${pct}%; background:${color};`}></div>
      </div>
    </div>
  );
};

/**
 * Step status block — shows the engine pipeline state (M4 → M5 → M6) and
 * surfaces the "next action" button corresponding to the current plan.status.
 * Disabled / advisory buttons render as muted text.
 */
const ActionStrip: FC<{ plan: Plan }> = ({ plan }) => {
  const isCoverLetter = plan.type === 'cover_letter';
  const canAnalyze =
    isCoverLetter &&
    ['awaiting_review', 'requirements_reviewed', 'projects_matched'].includes(plan.status);
  const canMatch =
    (plan.requirements.length > 0 || !isCoverLetter) &&
    ['requirements_reviewed', 'projects_matched'].includes(plan.status);
  const canGenerate =
    plan.matchedProjects.length > 0 &&
    ['projects_matched', 'scenes_generated'].includes(plan.status);
  const canFinalize = plan.status === 'scenes_generated';
  return (
    <div class="card" style="margin-bottom:16px;">
      <div class="row" style="gap:12px; flex-wrap:wrap;">
        {isCoverLetter ? (
          <button
            class="btn"
            type="button"
            disabled={!canAnalyze}
            hx-post={`/plans/${plan.id}/analyze`}
            hx-target="body"
            hx-swap="outerHTML"
            hx-indicator="#analyze-indicator"
          >
            1. Analyze requirements
          </button>
        ) : null}
        <button
          class="btn"
          type="button"
          disabled={!canMatch}
          hx-post={`/plans/${plan.id}/match`}
          hx-target="body"
          hx-swap="outerHTML"
          hx-indicator="#match-indicator"
        >
          {isCoverLetter ? '2.' : '1.'} Match projects
        </button>
        <button
          class="btn"
          type="button"
          disabled={!canGenerate}
          hx-post={`/plans/${plan.id}/generate`}
          hx-target="body"
          hx-swap="outerHTML"
          hx-indicator="#generate-indicator"
          hx-confirm={
            plan.status === 'scenes_generated'
              ? 'Re-generate scenes? Existing scene edits will be replaced.'
              : undefined
          }
        >
          {isCoverLetter ? '3.' : '2.'} Generate scenes + scripts
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
      <div class="muted" style="font-size:13px; margin-top:8px;">
        <span id="analyze-indicator" class="htmx-indicator">Analyzing…</span>
        <span id="match-indicator" class="htmx-indicator">Matching projects…</span>
        <span id="generate-indicator" class="htmx-indicator">Generating scenes + scripts (this can take a minute)…</span>
      </div>
    </div>
  );
};

const RequirementsBlock: FC<{ plan: Plan }> = ({ plan }) => {
  if (plan.type !== 'cover_letter') return null;
  if (plan.requirements.length === 0) {
    return (
      <div class="card">
        <h3 style="margin-top:0;">Requirements</h3>
        <div class="muted">
          Not analyzed yet. Click <strong>Analyze requirements</strong> above to extract them from the listing.
        </div>
      </div>
    );
  }
  return (
    <div class="card">
      <h3 style="margin-top:0;">Requirements ({plan.requirements.length})</h3>
      <ul style="margin:0; padding-left:20px;">
        {plan.requirements.map((r) => (
          <li style="margin-bottom:6px;">
            <span class={`badge ${r.priority === 'must_show' ? 'awaiting_review' : ''}`}>
              {r.priority === 'must_show' ? 'MUST' : 'NICE'}
            </span>{' '}
            <strong>{r.skill}</strong>{' '}
            <span class="muted">({r.category})</span>
            <div class="muted" style="font-size:13px; margin-top:2px;">{r.evidence}</div>
          </li>
        ))}
      </ul>
    </div>
  );
};

const MatchedProjectsBlock: FC<{ plan: Plan }> = ({ plan }) => {
  if (plan.matchedProjects.length === 0) {
    return (
      <div class="card">
        <h3 style="margin-top:0;">Matched projects</h3>
        <div class="muted">
          Not matched yet. Click <strong>Match projects</strong> above.
        </div>
      </div>
    );
  }
  return (
    <div class="card">
      <h3 style="margin-top:0;">Matched projects ({plan.matchedProjects.length})</h3>
      <ol style="margin:0; padding-left:20px;">
        {plan.matchedProjects.map((m) => (
          <li style="margin-bottom:10px;">
            <strong>{m.projectName}</strong>{' '}
            <span class="muted">({m.projectSlug}, relevance {m.relevanceScore.toFixed(2)})</span>
            <div style="margin-top:4px; font-size:14px;">
              {m.matchedFeatures.length > 0 ? (
                <span class="muted">Features: {m.matchedFeatures.join('; ')}</span>
              ) : null}
            </div>
            <div class="muted" style="font-size:13px; margin-top:2px;">
              {m.suggestedDemoSequence}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
};

const ListingContext: FC<{ plan: Plan }> = ({ plan }) => {
  if (plan.type !== 'cover_letter') return null;
  if (!plan.sourceListingText) return null;
  return (
    <details class="card" style="font-size:14px;">
      <summary style="cursor:pointer; font-weight:600;">Source listing text</summary>
      <pre style="white-space:pre-wrap; word-break:break-word; margin:10px 0 0 0; font-family:inherit;">
        {plan.sourceListingText}
      </pre>
    </details>
  );
};

const PlanHeader: FC<{ plan: Plan }> = ({ plan }) => {
  return (
    <div style="margin-bottom:12px;">
      <div class="row" style="gap:12px;">
        <h2 style="margin:0; flex:1;">{plan.title}</h2>
        <span class={`badge ${plan.status}`}>{STATUS_LABELS[plan.status]}</span>
      </div>
      <div class="muted" style="font-size:14px; margin-top:4px;">
        {plan.type === 'cover_letter' ? 'Cover letter' : 'YouTube'} ·{' '}
        target {plan.targetRuntimeSeconds}s ·{' '}
        <a href="/">Back to dashboard</a>
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
          <h3 style="margin-top:0;">Your constraints</h3>
          <div style="white-space:pre-wrap;">{plan.userConstraints}</div>
        </div>
      ) : null}
      <ListingContext plan={plan} />
      <RequirementsBlock plan={plan} />
      <MatchedProjectsBlock plan={plan} />
      <h3 style="margin-top:24px;">Scenes ({scenes.length})</h3>
      <SceneList planId={plan.id} scenes={scenes} />
    </Layout>
  );
};

export { RuntimeBar };
