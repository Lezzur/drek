import type { FC } from 'hono/jsx';
import { Layout, type LayoutProps } from './layout.js';
import type { Plan, PlanStatus, PlanType } from '../db/schemas.js';

export interface DashboardProps {
  plans: Plan[];
  /** Active filters (passed via query string, echoed in form). */
  filter: { type?: PlanType; status?: PlanStatus };
  /** ISO timestamp of the last successful poll, for the header banner. */
  lastPollAt: string | null;
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

function formatDate(d: Date): string {
  return d.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
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

const PlansTable: FC<{ plans: Plan[] }> = ({ plans }) => {
  if (plans.length === 0) {
    return (
      <div class="empty">
        No plans match the current filter. Hit <strong>Check now</strong> above to poll Neurocore,
        or create a new plan with the buttons up top.
      </div>
    );
  }
  return (
    <div class="card" style="padding:0; overflow:hidden; border-radius:10px;">
      <table class="plans">
        <thead>
          <tr>
            <th style="width:34%">Title</th>
            <th>Type</th>
            <th>Status</th>
            <th class="col-runtime">Runtime</th>
            <th>Updated</th>
            <th style="width:120px;"></th>
          </tr>
        </thead>
        <tbody>
          {plans.map((p) => (
            <tr>
              <td>
                <a href={`/plans/${p.id}`} style="color:var(--link); font-weight:500;">{p.title}</a>
              </td>
              <td><span class="muted">{p.type === 'cover_letter' ? 'Cover letter' : 'YouTube'}</span></td>
              <td><span class={`badge ${p.status}`}>{STATUS_LABELS[p.status]}</span></td>
              <td class="col-runtime"><span class="muted">{p.targetRuntimeSeconds}s</span></td>
              <td><span class="muted">{formatDate(p.updatedAt)}</span></td>
              <td>
                {p.status === 'awaiting_review' ? (
                  <button
                    class="btn small linkish"
                    type="button"
                    hx-post={`/plans/${p.id}/dismiss`}
                    hx-target="closest tr"
                    hx-swap="outerHTML"
                    hx-confirm="Dismiss this listing? It will not be planned for video."
                  >
                    Dismiss
                  </button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

export const DashboardPage: FC<DashboardProps> = ({
  plans,
  filter,
  lastPollAt,
  flash,
}) => {
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
      </div>
      <p class="muted" style="margin: 6px 0 16px;">Last poll: {lastPollAt ? formatDate(new Date(lastPollAt)) : 'never'}</p>
      <div id="poll-result" style="margin-bottom:12px;"></div>
      <FilterBar filter={filter} />
      <PlansTable plans={plans} />
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
  skipped: number;
  failed: number;
  disabled: boolean;
}> = ({ createdPlans, skipped, failed, disabled }) => {
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
