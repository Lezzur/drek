import type { FC } from 'hono/jsx';
import { Layout, type LayoutProps } from './layout.js';
import type { Plan, PlanStatus, PlanType } from '../db/schemas.js';

export interface DashboardProps {
  plans: Plan[];
  /** Active filters (passed via query string, echoed in form). */
  filter: { type?: PlanType; status?: PlanStatus };
  /** ISO timestamp of the last successful poll, for the header banner. */
  lastPollAt: string | null;
  /** config.autoRunMaxAgeDays — listings older than this are stale. */
  freshWindowDays: number;
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

const TYPE_LABELS: Record<PlanType, string> = {
  cover_letter: 'Cover letter',
  youtube_lite: 'YouTube (lite)',
  youtube_advanced: 'YouTube (advanced)',
};

/** Plans created before this instant are stale. Shared with the
 *  dismiss-stale route so the button and the grouping agree exactly. */
export function staleCutoff(freshWindowDays: number, now = new Date()): Date {
  return new Date(now.getTime() - freshWindowDays * 24 * 60 * 60 * 1000);
}

function formatDate(d: Date): string {
  return d.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** "4m ago" / "2h ago" / "19d ago" — listings decay in days; full
 *  timestamps hid that. */
function relativeAge(d: Date, now = new Date()): string {
  const mins = Math.max(0, Math.floor((now.getTime() - d.getTime()) / 60_000));
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

const FilterBar: FC<{ filter: DashboardProps['filter'] }> = ({ filter }) => {
  return (
    <div class="card" style="margin-bottom:16px;">
      <h3 class="section-label">Filter</h3>
      <form method="get" action="/" class="row" style="flex-wrap: wrap;">
        <label class="row" style="gap:6px;">
          <span class="muted">Type</span>
          <select name="type">
            <option value="" selected={!filter.type}>All</option>
            <option value="cover_letter" selected={filter.type === 'cover_letter'}>Cover letter</option>
            <option value="youtube_lite" selected={filter.type === 'youtube_lite'}>YouTube (lite)</option>
            <option value="youtube_advanced" selected={filter.type === 'youtube_advanced'}>YouTube (advanced)</option>
          </select>
        </label>
        <label class="row" style="gap:6px;">
          <span class="muted">Status</span>
          <select name="status">
            <option value="" selected={!filter.status}>All</option>
            {(Object.keys(STATUS_LABELS) as PlanStatus[]).map((s) => (
              <option value={s} selected={filter.status === s}>{STATUS_LABELS[s]}</option>
            ))}
          </select>
        </label>
        <button class="btn small secondary" type="submit">Filter</button>
        {(filter.type || filter.status) ? (
          <a class="btn small linkish" href="/">Clear</a>
        ) : null}
      </form>
    </div>
  );
};

/** One badge that reflects what matters most right now: an active or
 *  failed background run trumps the content status. */
const PlanBadge: FC<{ plan: Plan }> = ({ plan }) => {
  if (plan.pipelineState === 'running') return <span class="badge pipeline-running">Generating…</span>;
  if (plan.pipelineState === 'queued') return <span class="badge pipeline-queued">Queued</span>;
  if (plan.pipelineState === 'failed') return <span class="badge pipeline-failed">Pipeline failed</span>;
  return <span class={`badge ${plan.status}`}>{STATUS_LABELS[plan.status]}</span>;
};

const RowActions: FC<{ plan: Plan }> = ({ plan }) => {
  const ready = plan.status === 'scenes_generated' || plan.status === 'finalized';
  if (ready) {
    return (
      <a class="btn small" href={`/plans/${plan.id}/export`}>Shoot instructions</a>
    );
  }
  if (plan.pipelineState === 'failed') {
    return (
      <button
        class="btn small secondary"
        type="button"
        hx-post={`/plans/${plan.id}/queue-row`}
        hx-disabled-elt="this"
      >
        Retry
      </button>
    );
  }
  if (plan.status === 'awaiting_review' && plan.pipelineState === 'idle') {
    return (
      <div class="row" style="gap:6px; justify-content:flex-end;">
        <button
          class="btn small secondary"
          type="button"
          hx-post={`/plans/${plan.id}/queue-row`}
          hx-disabled-elt="this"
        >
          Generate
        </button>
        <button
          class="btn small linkish"
          type="button"
          hx-post={`/plans/${plan.id}/dismiss`}
          hx-target="closest tr"
          hx-swap="outerHTML"
          hx-confirm="Dismiss this listing? It will not be planned for video."
        >
          Dismiss
        </button>
      </div>
    );
  }
  return null;
};

const PlansTable: FC<{ plans: Plan[]; showError?: boolean }> = ({ plans, showError }) => {
  return (
    <div class="card" style="padding:0; overflow:hidden; border-radius:12px;">
      <table class="plans">
        <thead>
          <tr>
            <th style="width:40%">Title</th>
            <th>Type</th>
            <th>Status</th>
            <th>Age</th>
            <th style="width:190px;"></th>
          </tr>
        </thead>
        <tbody>
          {plans.map((p) => (
            <tr>
              <td>
                <a href={`/plans/${p.id}`} style="color:var(--link); font-weight:500;">{p.title}</a>
                {showError && p.pipelineError ? (
                  <div class="muted" style="font-size:12px; color:var(--danger); margin-top:3px;">{p.pipelineError.slice(0, 160)}</div>
                ) : null}
              </td>
              <td><span class="muted">{TYPE_LABELS[p.type]}</span></td>
              <td><PlanBadge plan={p} /></td>
              <td><span class="muted" title={formatDate(p.createdAt)}>{relativeAge(p.createdAt)}</span></td>
              <td style="text-align:right;"><RowActions plan={p} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

const Section: FC<{ label: string; hint?: string; children: unknown }> = ({ label, hint, children }) => (
  <div style="margin-bottom:24px;">
    <div class="row" style="margin-bottom:8px; align-items:baseline;">
      <h2 style="margin:0;">{label}</h2>
      {hint ? <span class="muted" style="font-size:13px;">{hint}</span> : null}
    </div>
    {children}
  </div>
);

/**
 * The triage view. A month of usage data showed the old flat table failed
 * its job: 61 visually identical "Awaiting review" rows buried the one
 * thing Rick opens DREK for — a finished script he can record from. The
 * default view now leads with ready scripts and pushes dead listings into
 * a collapsed Stale section with a one-click bulk dismiss.
 */
const TriageView: FC<{ plans: Plan[]; freshWindowDays: number }> = ({ plans, freshWindowDays }) => {
  const cutoff = staleCutoff(freshWindowDays);

  const ready = plans.filter((p) => p.status === 'scenes_generated' || p.status === 'finalized');
  const inPipeline = plans.filter((p) => p.pipelineState === 'queued' || p.pipelineState === 'running');
  const failed = plans.filter((p) => p.pipelineState === 'failed');
  const inProgress = plans.filter(
    (p) =>
      p.pipelineState === 'idle' &&
      !['awaiting_review', 'dismissed', 'scenes_generated', 'finalized', 'exported'].includes(p.status),
  );
  const inbox = plans.filter(
    (p) => p.status === 'awaiting_review' && p.pipelineState === 'idle' && p.createdAt.getTime() >= cutoff.getTime(),
  );
  const stale = plans.filter(
    (p) => p.status === 'awaiting_review' && p.pipelineState === 'idle' && p.createdAt.getTime() < cutoff.getTime(),
  );

  const nothingActive =
    ready.length === 0 && inPipeline.length === 0 && failed.length === 0 && inProgress.length === 0 && inbox.length === 0;

  return (
    <div>
      {/* Self-refresh while the background worker is busy, so scripts
          appear without Rick touching anything. */}
      {inPipeline.length > 0 ? (
        <div
          id="pipeline-watch"
          hx-get="/"
          hx-trigger="every 8s"
          hx-target="body"
          hx-swap="outerHTML"
        ></div>
      ) : null}

      {ready.length > 0 ? (
        <Section label="Ready to record" hint="scripts written — open the shoot instructions and hit record">
          <PlansTable plans={ready} />
        </Section>
      ) : null}

      {inPipeline.length > 0 ? (
        <Section label="Generating" hint="the background pipeline is writing these now — no action needed">
          <PlansTable plans={inPipeline} />
        </Section>
      ) : null}

      {failed.length > 0 ? (
        <Section label="Needs attention" hint="the pipeline hit an error — retry or open for details">
          <PlansTable plans={failed} showError />
        </Section>
      ) : null}

      {inProgress.length > 0 ? (
        <Section label="In progress" hint="partially advanced — open to continue">
          <PlansTable plans={inProgress} />
        </Section>
      ) : null}

      {inbox.length > 0 ? (
        <Section label="Inbox" hint={`fresh listings (under ${freshWindowDays}d) not yet generated`}>
          <PlansTable plans={inbox} />
        </Section>
      ) : null}

      {nothingActive ? (
        <div class="empty lg" style="margin-bottom:24px;">
          Nothing needs you right now. New listings are polled every 30 minutes and
          scripts generate automatically — they'll show up here ready to record.
        </div>
      ) : null}

      {stale.length > 0 ? (
        <details style="margin-bottom:24px;">
          <summary style="cursor:pointer; color:var(--ink-3); font-size:14px; padding:10px 4px;">
            {stale.length} stale listing{stale.length === 1 ? '' : 's'} (older than {freshWindowDays}d — likely dead)
          </summary>
          <div class="row" style="margin:10px 0;">
            <button
              class="btn small secondary"
              type="button"
              hx-post="/plans/dismiss-stale"
              hx-disabled-elt="this"
              hx-confirm={`Dismiss all ${stale.length} stale listings? They stay reachable via the Dismissed filter.`}
            >
              Dismiss all stale
            </button>
          </div>
          <PlansTable plans={stale} />
        </details>
      ) : null}
    </div>
  );
};

export const DashboardPage: FC<DashboardProps> = ({
  plans,
  filter,
  lastPollAt,
  freshWindowDays,
  flash,
}) => {
  const filtered = Boolean(filter.type || filter.status);
  return (
    <Layout title="Dashboard" flash={flash}>
      <div class="row" style="margin-bottom:8px;">
        <h1 style="margin:0;">Video plans</h1>
        <span class="spacer" />
        <button
          class="btn accent"
          type="button"
          hx-post="/poll"
          hx-target="#poll-result"
          hx-indicator="#poll-indicator"
        >
          Check now
        </button>
        <span id="poll-indicator" class="muted htmx-indicator" style="font-size:13px;">Polling…</span>
        <a class="btn secondary" href="/plans/new/cover-letter">New cover letter</a>
        <a class="btn secondary" href="/plans/new/youtube">New YouTube</a>
        <a class="btn secondary" href="/plans/new/youtube-advanced">New Advanced</a>
      </div>
      <p class="muted" style="margin: 6px 0 16px;">Last poll: {lastPollAt ? formatDate(new Date(lastPollAt)) : 'never'}</p>
      <div id="poll-result" style="margin-bottom:12px;"></div>
      <FilterBar filter={filter} />
      {filtered ? (
        plans.length === 0 ? (
          <div class="empty">
            No plans match the current filter. Hit <strong>Check now</strong> above to poll Neurocore,
            or create a new plan with the buttons up top.
          </div>
        ) : (
          <PlansTable plans={plans} />
        )
      ) : (
        <TriageView plans={plans} freshWindowDays={freshWindowDays} />
      )}
    </Layout>
  );
};

/**
 * HTMX partial — used as the response to POST /poll. Returns just a flash-
 * style banner the dashboard slots into #poll-result. The dashboard reload
 * for the actual plan list refresh happens via hx-trigger on the partial.
 */
export const PollResult: FC<{
  createdPlans: number;
  queuedPipelines: number;
  skipped: number;
  failed: number;
  disabled: boolean;
}> = ({ createdPlans, queuedPipelines, skipped, failed, disabled }) => {
  if (disabled) {
    return (
      <div
        class="flash warn"
        hx-get="/"
        hx-trigger="load delay:1s"
        hx-target="body"
        hx-swap="outerHTML"
      >
        Polling is disabled. Toggle it on in the config to ingest new listings.
      </div>
    );
  }
  const type = failed > 0 ? 'err' : 'ok';
  const parts: string[] = [];
  if (createdPlans > 0) parts.push(`${createdPlans} new plan${createdPlans === 1 ? '' : 's'}`);
  if (queuedPipelines > 0) parts.push(`${queuedPipelines} queued for script generation`);
  if (skipped > 0) parts.push(`${skipped} already had plans`);
  if (failed > 0) parts.push(`${failed} failed`);
  const text = parts.length > 0 ? parts.join(', ') + '.' : 'No new listings.';
  return (
    <div
      class={`flash ${type}`}
      hx-get="/"
      hx-trigger="load delay:1s"
      hx-target="body"
      hx-swap="outerHTML"
    >
      {text}
    </div>
  );
};
