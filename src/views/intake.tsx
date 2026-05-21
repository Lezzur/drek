import type { FC } from 'hono/jsx';
import { Layout, type LayoutProps } from './layout.js';
import type { PipelineBrief, BriefStage, BriefScore } from '../db/schemas.js';

export { BriefStage };

export interface IntakeListPageProps {
  briefs: PipelineBrief[];
  currentStage?: BriefStage;
  /** candidate + vetted count for the pipeline depth warning. */
  queueDepth: number;
  /** M33: count of build-plan edits Rick has made since DREK started
   *  tracking. Surfaced in the header so progress toward the M34
   *  pattern-analysis trigger is always visible. */
  buildPlanEditCount?: number;
  flash?: LayoutProps['flash'];
}

const M34_TRIGGER_THRESHOLD = 15;

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

const STALE_DAYS = 7;

/**
 * A brief is "queued" (stale) when its last touch was over STALE_DAYS days
 * ago AND it's still in a queue stage. This is a UI nudge ("you might have
 * forgotten about this"), not a learning signal — Neurocore is not told
 * anything about staleness. Briefs in `published` or `retired` are never
 * marked stale because the queue stages are the only states Rick cares
 * about progressing.
 */
function isStale(brief: PipelineBrief, now: Date = new Date()): boolean {
  if (brief.stage === 'published' || brief.stage === 'retired') return false;
  const ageMs = now.getTime() - brief.updatedAt.getTime();
  return ageMs >= STALE_DAYS * 24 * 60 * 60 * 1000;
}

function relativeAge(d: Date, now: Date = new Date()): string {
  const ageMs = now.getTime() - d.getTime();
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
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

const COL_GRID =
  'grid-template-columns: 32px 1fr 80px 110px auto; gap:12px; align-items:center;';

const BriefRow: FC<{ brief: PipelineBrief }> = ({ brief }) => {
  const stale = isStale(brief);
  return (
    <div
      class="card brief-row"
      style={`padding:12px 16px; margin-bottom:8px; display:grid; ${COL_GRID}; ${stale ? 'background:var(--surface-2, var(--surface));' : ''}`}
      data-brief-id={brief.id}
    >
      <input
        type="checkbox"
        name="briefIds"
        value={brief.id}
        class="brief-select"
        style="width:18px; height:18px; cursor:pointer;"
      />

      <div style="min-width:0;">
        <a
          href={`/intake/${brief.id}`}
          style="font-size:15px; font-weight:600; color:var(--ink); text-decoration:none;"
        >
          {brief.title}
        </a>
        <div class="muted" style="font-size:12px; margin-top:2px; display:flex; gap:6px; align-items:center; flex-wrap:wrap;">
          {brief.company ? <span>{brief.company} ·</span> : null}
          <span title={formatDate(brief.updatedAt)}>{relativeAge(brief.updatedAt)}</span>
          {stale ? (
            <span
              style="font-size:10px; padding:2px 6px; border-radius:4px; background:var(--amber-fg); color:var(--amber-bg, #1a1100); text-transform:uppercase; letter-spacing:0.04em; font-weight:600;"
              title={`Last touched ${formatDate(brief.updatedAt)} — over ${STALE_DAYS} days ago`}
            >
              Queued
            </span>
          ) : null}
        </div>
      </div>

      <div style="text-align:center;">
        {brief.score ? (
          <ScoreBadge score={brief.score} />
        ) : (
          <span class="muted" style="font-size:12px; font-style:italic;">—</span>
        )}
      </div>

      <div style="text-align:center;">
        <span class={`badge ${brief.stage}`} style="font-size:11px;">
          {STAGE_LABELS[brief.stage]}
        </span>
      </div>

      <div class="row" style="gap:6px; justify-content:flex-end; flex-shrink:0;">
        {!brief.score ? (
          <button
            class="btn small secondary"
            type="button"
            hx-post={`/intake/${brief.id}/score`}
            hx-target="body"
            hx-swap="outerHTML"
            hx-confirm="Run LLM scoring on this brief? This takes 15-30 seconds."
          >
            Score
          </button>
        ) : null}
        {brief.stage === 'vetted' && brief.score && !brief.promotedPlanId ? (
          <a class="btn small accent" href={`/intake/${brief.id}`}>
            Promote
          </a>
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
  );
};

const BriefListHeader: FC = () => {
  return (
    <div
      style={`display:grid; ${COL_GRID} padding:8px 16px; margin-bottom:6px; font-size:11px; font-weight:600; color:var(--ink-3); text-transform:uppercase; letter-spacing:0.05em;`}
    >
      <div style="text-align:center;">
        <input
          type="checkbox"
          id="brief-select-all"
          style="width:18px; height:18px; cursor:pointer;"
        />
      </div>
      <div>Brief</div>
      <div style="text-align:center;">Score</div>
      <div style="text-align:center;">Status</div>
      <div style="text-align:right;">Actions</div>
    </div>
  );
};

/**
 * Bulk-action bar shown when ≥1 brief is selected. Hidden by default; the
 * inline script below shows/hides it based on checkbox state.
 */
const BulkActionBar: FC = () => {
  return (
    <div
      id="bulk-action-bar"
      style="display:none; position:sticky; top:0; z-index:10; background:var(--surface-raised); border:1px solid var(--border-strong); border-radius:8px; padding:10px 14px; margin-bottom:12px; align-items:center; gap:12px;"
    >
      <span style="font-weight:600;">
        <span id="bulk-selected-count">0</span> selected
      </span>
      <span class="spacer" />
      <button
        type="button"
        class="btn small secondary"
        data-bulk-action="retire"
      >
        Retire selected
      </button>
      <button
        type="button"
        class="btn small"
        style="background:var(--danger); color:#fff; border-color:var(--danger);"
        data-bulk-action="delete"
      >
        Delete selected
      </button>
    </div>
  );
};

const BULK_SCRIPT = `
(function () {
  var bar = document.getElementById('bulk-action-bar');
  var counter = document.getElementById('bulk-selected-count');
  var selectAll = document.getElementById('brief-select-all');
  if (!bar || !counter) return;

  function selectedIds() {
    var boxes = document.querySelectorAll('.brief-select:checked');
    return Array.prototype.map.call(boxes, function (b) { return b.value; });
  }
  function refresh() {
    var ids = selectedIds();
    counter.textContent = ids.length;
    bar.style.display = ids.length > 0 ? 'flex' : 'none';
  }

  document.querySelectorAll('.brief-select').forEach(function (cb) {
    cb.addEventListener('change', refresh);
  });
  if (selectAll) {
    selectAll.addEventListener('change', function () {
      document.querySelectorAll('.brief-select').forEach(function (cb) {
        cb.checked = selectAll.checked;
      });
      refresh();
    });
  }

  bar.addEventListener('click', function (ev) {
    var btn = ev.target;
    if (!btn || !btn.dataset || !btn.dataset.bulkAction) return;
    var action = btn.dataset.bulkAction;
    var ids = selectedIds();
    if (ids.length === 0) return;

    var confirmMsg = action === 'delete'
      ? 'Delete ' + ids.length + ' brief(s)? This is permanent — the records are removed from Firestore.'
      : 'Retire ' + ids.length + ' brief(s)? They will move out of the active queue.';
    if (!confirm(confirmMsg)) return;

    btn.disabled = true;
    var body = new FormData();
    body.set('action', action);
    ids.forEach(function (id) { body.append('briefIds', id); });
    fetch('/intake/bulk-action', { method: 'POST', body: body, headers: { 'hx-request': 'true' } })
      .then(function (r) {
        if (r.ok || r.status === 302) {
          window.location.href = '/intake';
        } else {
          return r.json().then(function (j) {
            alert('Bulk action failed: ' + (j.error && j.error.message ? j.error.message : 'unknown error'));
            btn.disabled = false;
          });
        }
      })
      .catch(function (err) {
        alert('Bulk action failed: ' + err.message);
        btn.disabled = false;
      });
  });

  refresh();
})();
`;

export const IntakeListPage: FC<IntakeListPageProps> = ({
  briefs,
  currentStage,
  queueDepth,
  buildPlanEditCount = 0,
  flash,
}) => {
  const m34Triggered = buildPlanEditCount >= M34_TRIGGER_THRESHOLD;
  return (
    <Layout title="Intake pipeline" flash={flash}>
      <div class="row" style="margin-bottom:8px;">
        <h1 style="margin:0;">Intake pipeline</h1>
        <span class="spacer" />
        {!m34Triggered ? (
          <span
            class="muted"
            style="font-size:12px; padding:4px 10px; background:var(--surface); border:1px solid var(--border); border-radius:6px;"
            title="Edits accumulated toward the M34 pattern-analysis trigger. At 15 edits we review the corpus to teach Neurocore Rick's substitution + granularity preferences."
          >
            Build-plan edits: {buildPlanEditCount}/{M34_TRIGGER_THRESHOLD}
          </span>
        ) : null}
        <a class="btn secondary" href="/intake/new">Add brief</a>
        <a class="btn accent" href="/intake/batch/new">Add batch</a>
      </div>
      <p class="muted" style="margin: 6px 0 16px;">
        Source and vet briefs before promoting them to youtube_advanced plans.
      </p>

      {m34Triggered ? (
        <div
          class="flash warn"
          style="margin-bottom:16px; display:flex; gap:12px; align-items:flex-start;"
        >
          <span style="font-size:20px;">🚨</span>
          <div style="flex:1; line-height:1.5;">
            <strong>{buildPlanEditCount} build-plan edits reached — time to review the corpus.</strong>
            <div style="margin-top:4px; font-size:13px; color:var(--ink-2);">
              You've crossed the M34 trigger threshold ({M34_TRIGGER_THRESHOLD}+ edits).
              Pull the <code>build_plan.edited</code> signals from Neurocore and
              look for substitution patterns (e.g., tools you keep swapping) +
              step-granularity drift. See the email{' '}
              <em>"Tony — M34 trigger reminder"</em> for the full procedure.
            </div>
          </div>
        </div>
      ) : null}

      {queueDepth < 3 ? (
        <div class="flash warn" style="margin-bottom:16px;">
          Pipeline thin — source more briefs. Only {queueDepth} brief{queueDepth === 1 ? '' : 's'} in candidate/vetted.
        </div>
      ) : null}

      <StagePills currentStage={currentStage} />

      <BulkActionBar />

      {briefs.length === 0 ? (
        <div class="empty">
          No briefs yet.{' '}
          <a href="/intake/new">Add a brief</a> to start building your pipeline.
        </div>
      ) : (
        <>
          <BriefListHeader />
          {briefs.map((b) => <BriefRow brief={b} />)}
        </>
      )}
      <script dangerouslySetInnerHTML={{ __html: BULK_SCRIPT }} />
    </Layout>
  );
};
