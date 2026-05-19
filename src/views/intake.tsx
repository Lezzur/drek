import type { FC } from 'hono/jsx';
import { Layout, type LayoutProps } from './layout.js';
import type { PipelineBrief, BriefStage, BriefScore } from '../db/schemas.js';

export { BriefStage };

export interface IntakeListPageProps {
  briefs: PipelineBrief[];
  currentStage?: BriefStage;
  /** candidate + vetted count for the pipeline depth warning. */
  queueDepth: number;
  flash?: LayoutProps['flash'];
}

const STAGE_LABELS: Record<BriefStage, string> = {
  candidate: 'Candidate',
  vetted: 'Vetted',
  selected: 'Selected',
  in_production: 'In production',
  published: 'Published',
  retired: 'Retired',
};

const BRIEF_STAGES: BriefStage[] = [
  'candidate',
  'vetted',
  'selected',
  'in_production',
  'published',
  'retired',
];

function formatDate(d: Date): string {
  return d.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function scoreColor(aggregate: number): string {
  if (aggregate >= 4) return 'var(--green-fg)';
  if (aggregate >= 3) return 'var(--amber-fg)';
  return 'var(--danger)';
}

const ScoreBadge: FC<{ score: BriefScore }> = ({ score }) => {
  const color = scoreColor(score.aggregate);
  return (
    <span
      style={`display:inline-flex;align-items:center;gap:4px;padding:3px 8px;border-radius:999px;font-size:12px;font-weight:600;background:var(--surface-raised);color:${color};`}
    >
      {score.aggregate.toFixed(1)}
    </span>
  );
};

const StagePills: FC<{ currentStage?: BriefStage }> = ({ currentStage }) => {
  return (
    <div class="row" style="flex-wrap:wrap; gap:6px; margin-bottom:16px;">
      <a
        href="/intake"
        class="btn small"
        style={!currentStage ? 'background:var(--ink);color:var(--bg);' : 'background:var(--surface);color:var(--ink);border-color:var(--border-strong);'}
      >
        All
      </a>
      {BRIEF_STAGES.map((stage) => (
        <a
          href={`/intake?stage=${stage}`}
          class="btn small"
          style={currentStage === stage
            ? 'background:var(--ink);color:var(--bg);'
            : 'background:var(--surface);color:var(--ink);border-color:var(--border-strong);'}
        >
          {STAGE_LABELS[stage]}
        </a>
      ))}
    </div>
  );
};

const BriefRow: FC<{ brief: PipelineBrief }> = ({ brief }) => {
  return (
    <div class="card" style="padding:16px 20px; margin-bottom:10px;">
      <div class="row" style="gap:12px; align-items:flex-start;">
        <div style="flex:1; min-width:0;">
          <div class="row" style="gap:8px; align-items:center; flex-wrap:wrap;">
            <a href={`/intake/${brief.id}`} style="font-size:15px; font-weight:600; color:var(--ink);">
              {brief.title}
            </a>
            {brief.score ? <ScoreBadge score={brief.score} /> : null}
            <span class={`badge ${brief.stage}`}>{STAGE_LABELS[brief.stage]}</span>
          </div>
          <div class="muted" style="font-size:13px; margin-top:4px;">
            {brief.company ? <span>{brief.company} · </span> : null}
            Updated {formatDate(brief.updatedAt)}
          </div>
        </div>
        <div class="row" style="gap:6px; flex-shrink:0;">
          {!brief.score ? (
            <button
              class="btn small secondary"
              type="button"
              hx-post={`/intake/${brief.id}/score`}
              hx-target="body"
              hx-swap="outerHTML"
              hx-confirm="Run LLM scoring on this brief? This takes 15-30 seconds."
            >
              Score with LLM
            </button>
          ) : null}
          {brief.stage === 'vetted' && brief.score && !brief.promotedPlanId ? (
            <a class="btn small accent" href={`/intake/${brief.id}`}>Promote</a>
          ) : null}
          {brief.stage !== 'retired' ? (
            <button
              class="btn small secondary"
              type="button"
              hx-post={`/intake/${brief.id}/stage`}
              hx-vals='{"stage":"retired"}'
              hx-target="body"
              hx-swap="outerHTML"
              hx-confirm="Retire this brief? It will no longer appear in the active queue."
            >
              Retire
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
};

export const IntakeListPage: FC<IntakeListPageProps> = ({
  briefs,
  currentStage,
  queueDepth,
  flash,
}) => {
  return (
    <Layout title="Intake pipeline" flash={flash}>
      <div class="row" style="margin-bottom:8px;">
        <h1 style="margin:0;">Intake pipeline</h1>
        <span class="spacer" />
        <a class="btn secondary" href="/intake/new">Add brief</a>
        <a class="btn accent" href="/intake/batch/new">Add batch</a>
      </div>
      <p class="muted" style="margin: 6px 0 16px;">
        Source and vet briefs before promoting them to youtube_advanced plans.
      </p>

      {queueDepth < 3 ? (
        <div class="flash warn" style="margin-bottom:16px;">
          Pipeline thin — source more briefs. Only {queueDepth} brief{queueDepth === 1 ? '' : 's'} in candidate/vetted.
        </div>
      ) : null}

      <StagePills currentStage={currentStage} />

      {briefs.length === 0 ? (
        <div class="empty">
          No briefs yet.{' '}
          <a href="/intake/new">Add a brief</a> to start building your pipeline.
        </div>
      ) : (
        briefs.map((b) => <BriefRow brief={b} />)
      )}
    </Layout>
  );
};
