import type { FC } from 'hono/jsx';
import { Layout, type LayoutProps } from './layout.js';
import type { PipelineBrief, BriefStage, BriefScore } from '../db/schemas.js';
import { transformableReason } from '../engine/transform-brief.js';

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
  /** M35: count of manual score overrides. Same review-threshold pattern
   *  as buildPlanEditCount — banner fires at >= 15 so Tony reviews the
   *  score.overridden corpus for scorer bias. */
  scoreOverrideCount?: number;
  /** M36: per-brief unresolved critique finding counts. Briefs not in
   *  the map (or with count 0) render no badge. */
  findingBadges?: Record<string, number>;
  flash?: LayoutProps['flash'];
}

const M34_TRIGGER_THRESHOLD = 15;
const SCORE_REVIEW_THRESHOLD = 15;

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

/**
 * M35: dedicated "Transformable" column on the intake list. Renders a
 * plain "yes" / "no" with an em-dash for unscored briefs. On hover, the
 * "no" cell spells out which axes failed the gate.
 */
const AXIS_LABEL: Record<'scopeFit' | 'audienceMatch', string> = {
  scopeFit: 'scope',
  audienceMatch: 'audience',
};
const TransformableCell: FC<{ score: BriefScore | null }> = ({ score }) => {
  if (!score) {
    return <span class="muted" style="font-size:13px; font-style:italic;">—</span>;
  }
  const { ok, failedAxes } = transformableReason(score);
  if (ok) {
    return (
      <span
        title="Passes transformer gate (scopeFit >= 2.0 AND audienceMatch >= 3.0)"
        style="font-size:13px; font-weight:600; color:var(--green-fg);"
      >
        yes
      </span>
    );
  }
  const labels = failedAxes.map((a) => AXIS_LABEL[a]).join(', ');
  return (
    <span
      title={`Blocked by transformer gate: ${labels}. Requires scopeFit >= 2.0 AND audienceMatch >= 3.0. Edit the score if the LLM rated it wrong.`}
      style="font-size:13px; font-weight:600; color:var(--ink-3);"
    >
      no
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
  'grid-template-columns: 32px 1fr 80px 110px 110px auto; gap:12px; align-items:center;';

const FindingsBadge: FC<{ count: number; briefId: string }> = ({ count, briefId }) => {
  if (count <= 0) return null;
  return (
    <a
      href={`/intake/${briefId}#findings`}
      title={`${count} unresolved production-realism finding${count === 1 ? '' : 's'}`}
      style="
        display: inline-flex;
        align-items: center;
        gap: 4px;
        font-size: 11px;
        font-weight: 600;
        padding: 2px 8px;
        border-radius: 10px;
        background: rgba(217, 119, 6, 0.12);
        color: var(--amber-fg);
        text-decoration: none;
        text-transform: uppercase;
        letter-spacing: 0.04em;
      "
    >
      ⚠ {count} {count === 1 ? 'finding' : 'findings'}
    </a>
  );
};

const BriefRow: FC<{ brief: PipelineBrief; findingsCount?: number }> = ({ brief, findingsCount = 0 }) => {
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
              Stale
            </span>
          ) : null}
          {findingsCount > 0 ? <FindingsBadge count={findingsCount} briefId={brief.id} /> : null}
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
        <TransformableCell score={brief.score} />
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
        {brief.score && !brief.promotedPlanId && brief.stage !== 'retired' ? (
          <a class="btn small accent" href={`/intake/${brief.id}`}>
            Send to pipeline
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
      {/* First column is the per-row checkbox in BriefRow; header leaves
          it intentionally empty (no select-all — per Rick 2026-05-22). */}
      <div />
      <div>Brief</div>
      <div style="text-align:center;">Score</div>
      <div style="text-align:center;">Transformable</div>
      <div style="text-align:center;">Status</div>
      <div style="text-align:right;">Actions</div>
    </div>
  );
};

/**
 * Bulk-action bar. Reserves vertical space whether or not anything is
 * selected — visibility toggles via opacity + pointer-events so the
 * page below doesn't shift when the first checkbox flips on. The
 * inline script also handles shift-click range selection between two
 * .brief-select checkboxes.
 */
const BulkActionBar: FC = () => {
  return (
    <div
      id="bulk-action-bar"
      style="display:flex; visibility:hidden; opacity:0; transition:opacity 0.12s ease-in-out; position:sticky; top:0; z-index:10; background:var(--surface-raised); border:1px solid var(--border-strong); border-radius:8px; padding:10px 14px; margin-bottom:12px; align-items:center; gap:12px;"
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
  if (!bar || !counter) return;

  function allBoxes() {
    return Array.prototype.slice.call(document.querySelectorAll('.brief-select'));
  }
  function selectedIds() {
    return allBoxes().filter(function (b) { return b.checked; }).map(function (b) { return b.value; });
  }
  function refresh() {
    var ids = selectedIds();
    counter.textContent = ids.length;
    // Toggle via visibility + opacity (NOT display) so the bar's space
    // is always reserved — clicking the first checkbox doesn't shift
    // the list down.
    if (ids.length > 0) {
      bar.style.visibility = 'visible';
      bar.style.opacity = '1';
      bar.style.pointerEvents = 'auto';
    } else {
      bar.style.visibility = 'hidden';
      bar.style.opacity = '0';
      bar.style.pointerEvents = 'none';
    }
  }

  // Shift-click range select: remember the last checkbox that the user
  // clicked. On the next click WITH shift held, toggle every box between
  // the anchor and the new click to match the new click's target state.
  var lastChecked = null;
  allBoxes().forEach(function (cb) {
    cb.addEventListener('click', function (ev) {
      var boxes = allBoxes();
      if (ev.shiftKey && lastChecked && lastChecked !== cb) {
        var start = boxes.indexOf(lastChecked);
        var end = boxes.indexOf(cb);
        if (start > -1 && end > -1) {
          var lo = Math.min(start, end), hi = Math.max(start, end);
          var target = cb.checked; // match the box the user just clicked
          for (var i = lo; i <= hi; i++) boxes[i].checked = target;
        }
      }
      lastChecked = cb;
      refresh();
    });
  });

  bar.addEventListener('click', function (ev) {
    var btn = ev.target;
    if (!btn || !btn.dataset || !btn.dataset.bulkAction) return;
    var action = btn.dataset.bulkAction;
    var ids = selectedIds();
    if (ids.length === 0) return;

    var confirmMsg = action === 'delete'
      ? 'Delete ' + ids.length + ' brief(s)? This is permanent — the records are removed from Firestore.'
      : 'Retire ' + ids.length + ' brief(s)? They will move out of the active queue.';

    function showError(msg) {
      var main = document.querySelector('main');
      if (!main) { alert(msg); return; }
      var d = document.createElement('div');
      d.className = 'flash err';
      d.textContent = 'Bulk action failed: ' + msg;
      main.insertBefore(d, main.firstChild);
      window.scrollTo(0, 0);
    }

    function run() {
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
              showError(j.error && j.error.message ? j.error.message : 'unknown error');
              btn.disabled = false;
            });
          }
        })
        .catch(function (err) {
          showError(err.message);
          btn.disabled = false;
        });
    }

    // Route through the shared styled modal (falls back to native confirm()).
    (window.drekConfirm || function (m, cb) { if (window.confirm(m)) cb(); })(confirmMsg, run);
  });

  refresh();
})();
`;

export const IntakeListPage: FC<IntakeListPageProps> = ({
  briefs,
  currentStage,
  queueDepth,
  buildPlanEditCount = 0,
  scoreOverrideCount = 0,
  findingBadges = {},
  flash,
}) => {
  const m34Triggered = buildPlanEditCount >= M34_TRIGGER_THRESHOLD;
  const scoreReviewTriggered = scoreOverrideCount >= SCORE_REVIEW_THRESHOLD;
  return (
    <Layout title="Intake pipeline" flash={flash}>
      <div class="row" style="margin-bottom:8px;">
        <h1 style="margin:0;">Intake pipeline</h1>
        <span class="spacer" />
        {!m34Triggered ? (
          <span
            class="muted"
            style="font-size:12px; padding:4px 10px; background:var(--surface); border:1px solid var(--border); border-radius:6px;"
            title="Build-plan edits logged since tracking started. At 15, review the accumulated edits to learn your tool-substitution and step-granularity preferences."
          >
            Build-plan edits: {buildPlanEditCount}/{M34_TRIGGER_THRESHOLD}
          </span>
        ) : null}
        {!scoreReviewTriggered ? (
          <span
            class="muted"
            style="font-size:12px; padding:4px 10px; background:var(--surface); border:1px solid var(--border); border-radius:6px;"
            title="Manual score overrides logged. At 15, review them to detect scorer bias (e.g. scope-fit consistently underrated for a given stack)."
          >
            Score overrides: {scoreOverrideCount}/{SCORE_REVIEW_THRESHOLD}
          </span>
        ) : null}
        <a class="btn secondary" href="/intake/new">Add brief</a>
        <a class="btn accent" href="/intake/batch/new">Add batch</a>
      </div>
      <p class="muted" style="margin: 6px 0 16px;">
        Source and vet briefs before promoting them to YouTube plans.
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
              You've passed {M34_TRIGGER_THRESHOLD}+ build-plan edits. Review the
              saved edit history and look for substitution patterns (tools you
              keep swapping) and step-granularity drift, then use them to tune
              the build-plan generator.
            </div>
          </div>
        </div>
      ) : null}

      {scoreReviewTriggered ? (
        <div
          class="flash warn"
          style="margin-bottom:16px; display:flex; gap:12px; align-items:flex-start;"
        >
          <span style="font-size:20px;">🎯</span>
          <div style="flex:1; line-height:1.5;">
            <strong>{scoreOverrideCount} score overrides reached — time to review scorer bias.</strong>
            <div style="margin-top:4px; font-size:13px; color:var(--ink-2);">
              You've passed {SCORE_REVIEW_THRESHOLD}+ score overrides. Review the
              saved override history and look for systematic patterns — which axis
              gets corrected most often, and what kind of briefs trigger the
              override. Use the findings to re-tune the scoring prompt.
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
          {briefs.map((b) => (
            <BriefRow brief={b} findingsCount={findingBadges[b.id] ?? 0} />
          ))}
        </>
      )}
      <script dangerouslySetInnerHTML={{ __html: BULK_SCRIPT }} />
    </Layout>
  );
};
