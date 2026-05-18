import type { FC } from 'hono/jsx';
import { Layout, type LayoutProps } from './layout.js';
import { SceneList } from './scene-card.js';
import type { Plan, Scene, PlanStatus } from '../db/schemas.js';
import { listFormatProfiles } from '../engine/format-profiles/index.js';

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

// Statuses at or after hooks_generated (to show "Hook workshop →" link)
const HOOKS_GENERATED_OR_LATER: PlanStatus[] = [
  'hooks_generated',
  'hook_selected',
  'shot_list_generated',
  'titles_generated',
  'title_selected',
  'thumbnails_generated',
  'thumbnail_selected',
  'shorts_extracted',
  'finalized',
  'exported',
  'metadata_generated',
];

// Statuses at or after shot_list_generated (to show regenerate-shot-list affordance)
const SHOT_LIST_GENERATED_OR_LATER: PlanStatus[] = [
  'shot_list_generated',
  'titles_generated',
  'title_selected',
  'thumbnails_generated',
  'thumbnail_selected',
  'shorts_extracted',
  'finalized',
  'exported',
  'metadata_generated',
];

const TITLES_GENERATED_OR_LATER: PlanStatus[] = [
  'titles_generated',
  'title_selected',
  'thumbnails_generated',
  'thumbnail_selected',
  'shorts_extracted',
  'finalized',
  'exported',
  'metadata_generated',
];

const THUMBNAILS_GENERATED_OR_LATER: PlanStatus[] = [
  'thumbnails_generated',
  'thumbnail_selected',
  'shorts_extracted',
  'finalized',
  'exported',
  'metadata_generated',
];

const METADATA_GENERATED_OR_LATER: PlanStatus[] = [
  'metadata_generated',
];

const ActionStrip: FC<{ plan: Plan }> = ({ plan }) => {
  const canRunPipeline = plan.status !== 'dismissed';
  const canFinalize = plan.status === 'scenes_generated';
  const rerun = ['requirements_reviewed', 'projects_matched', 'scenes_generated', 'finalized', 'exported'].includes(plan.status);

  const showGenerateHooks =
    plan.type === 'youtube_advanced' && plan.status === 'scenes_generated';
  const showHookWorkshopLink =
    plan.type === 'youtube_advanced' && HOOKS_GENERATED_OR_LATER.includes(plan.status);
  const showGenerateShotList =
    plan.type === 'youtube_advanced' && plan.status === 'hook_selected';
  const showRegenerateShotList =
    plan.type === 'youtube_advanced' &&
    SHOT_LIST_GENERATED_OR_LATER.includes(plan.status);
  const showGenerateTitles =
    plan.type === 'youtube_advanced' && plan.status === 'shot_list_generated';
  const showTitleWorkshopLink =
    plan.type === 'youtube_advanced' &&
    TITLES_GENERATED_OR_LATER.includes(plan.status);
  const showGenerateThumbnails =
    plan.type === 'youtube_advanced' && plan.status === 'title_selected';
  const showThumbnailWorkshopLink =
    plan.type === 'youtube_advanced' &&
    THUMBNAILS_GENERATED_OR_LATER.includes(plan.status);
  const showGenerateMetadata =
    plan.type === 'youtube_advanced' && plan.status === 'finalized';
  const showPublishLink =
    plan.type === 'youtube_advanced' &&
    METADATA_GENERATED_OR_LATER.includes(plan.status);

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
        {showGenerateHooks ? (
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
        ) : null}
        {showHookWorkshopLink ? (
          <a
            class="btn secondary"
            href={`/plans/${plan.id}/workshop/hooks`}
          >
            Hook workshop →
          </a>
        ) : null}
        {showGenerateShotList ? (
          <button
            class="btn accent"
            type="button"
            hx-post={`/plans/${plan.id}/generate-shot-list`}
            hx-target="body"
            hx-swap="outerHTML"
            hx-disabled-elt="this"
            hx-indicator="#shot-list-indicator"
          >
            Generate shot list
          </button>
        ) : null}
        {showRegenerateShotList ? (
          <button
            class="btn secondary"
            type="button"
            hx-post={`/plans/${plan.id}/generate-shot-list`}
            hx-target="body"
            hx-swap="outerHTML"
            hx-disabled-elt="this"
            hx-confirm="Regenerate the shot list? Existing per-scene shot data will be replaced."
            hx-indicator="#shot-list-indicator"
          >
            Regenerate shot list
          </button>
        ) : null}
        {showGenerateTitles ? (
          <button
            class="btn accent"
            type="button"
            hx-post={`/plans/${plan.id}/generate-titles`}
            hx-target="body"
            hx-swap="outerHTML"
            hx-disabled-elt="this"
          >
            Generate titles
          </button>
        ) : null}
        {showTitleWorkshopLink ? (
          <a class="btn secondary" href={`/plans/${plan.id}/workshop/titles`}>
            Title workshop →
          </a>
        ) : null}
        {showGenerateThumbnails ? (
          <button
            class="btn accent"
            type="button"
            hx-post={`/plans/${plan.id}/generate-thumbnails`}
            hx-target="body"
            hx-swap="outerHTML"
            hx-disabled-elt="this"
          >
            Generate thumbnails
          </button>
        ) : null}
        {showThumbnailWorkshopLink ? (
          <a class="btn secondary" href={`/plans/${plan.id}/workshop/thumbnails`}>
            Thumbnail workshop →
          </a>
        ) : null}
        {showGenerateMetadata ? (
          <button
            class="btn accent"
            type="button"
            hx-post={`/plans/${plan.id}/generate-publish-metadata`}
            hx-target="body"
            hx-swap="outerHTML"
            hx-disabled-elt="this"
          >
            Generate metadata
          </button>
        ) : null}
        {showPublishLink ? (
          <a class="btn secondary" href={`/plans/${plan.id}/publish`}>
            Publishing →
          </a>
        ) : null}
        {showPublishLink ? (
          <a class="btn secondary" href={`/plans/${plan.id}/shorts`}>
            Shorts workshop →
          </a>
        ) : null}
        {plan.type === 'youtube_advanced' ? (
          <a class="btn secondary" href={`/plans/${plan.id}/footage`}>
            Footage →
          </a>
        ) : null}
        {plan.type === 'youtube_advanced' ? (
          <a class="btn secondary" href={`/plans/${plan.id}/deliverables`}>
            Deliverables →
          </a>
        ) : null}
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

/**
 * Format profile selector — only shown for youtube_advanced plans.
 * Editable when plan is not exported or published. Fires
 * hx-post="/plans/:id/change-format" on change.
 */
const FormatProfileSelector: FC<{ plan: Plan }> = ({ plan }) => {
  if (plan.type !== 'youtube_advanced') return null;

  const profiles = listFormatProfiles();
  const isLocked = plan.status === 'exported' || (plan.status as string) === 'published';
  const hasScenes = !['awaiting_review', 'dismissed', 'requirements_reviewed', 'projects_matched'].includes(plan.status);

  if (isLocked) {
    const lockedProfile = profiles.find((p) => p.id === plan.formatProfileId);
    return (
      <div class="card" style="margin-bottom:16px;">
        <h3 class="section-label">Format profile</h3>
        <div class="row" style="gap:10px; align-items:center;">
          <select disabled style="flex:1; opacity:0.6; cursor:not-allowed;">
            <option>{lockedProfile?.displayName ?? plan.formatProfileId ?? 'Unknown'}</option>
          </select>
          <span class="muted" style="font-size:12px; white-space:nowrap;" title="Format locked after publish — create a new plan instead">
            Locked after publish
          </span>
        </div>
      </div>
    );
  }

  const confirmMsg = hasScenes
    ? 'Changing format wipes all scenes, scripts, hooks, titles, thumbnails, and Shorts for this plan. Recording sessions are preserved. Continue?'
    : undefined;

  return (
    <div class="card" style="margin-bottom:16px;">
      <h3 class="section-label">Format profile</h3>
      <select
        name="formatProfileId"
        hx-post={`/plans/${plan.id}/change-format`}
        hx-target="body"
        hx-swap="outerHTML"
        hx-include="this"
        hx-vals={`{"formatProfileId": "{{this.value}}"}`}
        hx-trigger="change"
        hx-confirm={confirmMsg}
        style="width:100%;"
      >
        {profiles.map((p) => (
          <option
            value={p.id}
            selected={plan.formatProfileId === p.id}
          >
            {p.displayName}
          </option>
        ))}
      </select>
      {hasScenes ? (
        <div class="muted" style="font-size:12px; margin-top:6px;">
          Changing format will wipe scenes, scripts, hooks, titles, and Shorts. Recording sessions are preserved.
        </div>
      ) : null}
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
      <FormatProfileSelector plan={plan} />
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
