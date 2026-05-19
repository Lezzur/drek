import type { FC } from 'hono/jsx';
import { Layout, type LayoutProps } from './layout.js';
import type { PipelineBrief, BriefStage } from '../db/schemas.js';

// ---------------------------------------------------------------------------
// New batch form — multi-row, dynamic add/remove
// ---------------------------------------------------------------------------

interface BriefRowValues {
  title?: string;
  sourceUrl?: string;
  company?: string;
  rawText?: string;
}

export interface NewBatchBriefFormProps {
  /** Echo back form values + per-row errors on validation failure. */
  values?: BriefRowValues[];
  error?: string | null;
  flash?: LayoutProps['flash'];
}

const DEFAULT_ROWS = 3;
const MAX_ROWS = 25;

export const NewBatchBriefForm: FC<NewBatchBriefFormProps> = ({
  values,
  error,
  flash,
}) => {
  // Always start with at least DEFAULT_ROWS rows so the form feels usable
  // even when echoing back validation errors.
  const rows: BriefRowValues[] =
    values && values.length > 0
      ? values
      : Array.from({ length: DEFAULT_ROWS }, () => ({} as BriefRowValues));

  const batchScript = `
(function () {
  var container = document.getElementById('brief-rows');
  var addBtn = document.getElementById('add-row-btn');
  var rowCount = ${rows.length};
  var MAX_ROWS = ${MAX_ROWS};

  function makeRow(index) {
    var idx = index;
    var div = document.createElement('div');
    div.className = 'brief-row card';
    div.dataset.rowIndex = idx;
    div.style.cssText = 'margin-bottom:14px; padding:18px; position:relative;';
    div.innerHTML = ''
      + '<div class="row" style="justify-content:space-between; align-items:center; margin-bottom:12px;">'
      + '  <strong style="color:var(--ink-2);">Brief #' + (idx + 1) + '</strong>'
      + '  <button type="button" class="remove-row-btn" style="background:transparent; border:1px solid var(--border-soft); color:var(--ink-3); padding:4px 10px; border-radius:4px; cursor:pointer; font-size:12px;">remove</button>'
      + '</div>'
      + '<label style="display:block; margin-bottom:10px;">'
      + '  <div class="field-label" style="margin-bottom:4px;">Title *</div>'
      + '  <input type="text" name="briefs[' + idx + '][title]" required maxlength="200" placeholder="e.g. Build a lead-routing automation" style="width:100%;" />'
      + '</label>'
      + '<label style="display:block; margin-bottom:10px;">'
      + '  <div class="field-label" style="margin-bottom:4px;">Source URL (optional)</div>'
      + '  <input type="url" name="briefs[' + idx + '][sourceUrl]" placeholder="https://www.upwork.com/jobs/..." style="width:100%;" />'
      + '</label>'
      + '<label style="display:block; margin-bottom:10px;">'
      + '  <div class="field-label" style="margin-bottom:4px;">Company (optional)</div>'
      + '  <input type="text" name="briefs[' + idx + '][company]" placeholder="Acme Corp" style="width:100%;" />'
      + '</label>'
      + '<label style="display:block;">'
      + '  <div class="field-label" style="margin-bottom:4px;">Brief text *</div>'
      + '  <textarea name="briefs[' + idx + '][rawText]" rows="6" required maxlength="50000" placeholder="Paste the full job brief here." style="width:100%;"></textarea>'
      + '</label>';
    return div;
  }

  function renumber() {
    var allRows = container.querySelectorAll('.brief-row');
    allRows.forEach(function (row, i) {
      row.dataset.rowIndex = i;
      var heading = row.querySelector('strong');
      if (heading) heading.textContent = 'Brief #' + (i + 1);
      var inputs = row.querySelectorAll('input, textarea');
      inputs.forEach(function (input) {
        var name = input.name || '';
        var newName = name.replace(/^briefs\\[\\d+\\]/, 'briefs[' + i + ']');
        input.name = newName;
      });
    });
    rowCount = allRows.length;
    addBtn.disabled = rowCount >= MAX_ROWS;
  }

  if (addBtn) {
    addBtn.addEventListener('click', function () {
      if (rowCount >= MAX_ROWS) return;
      var row = makeRow(rowCount);
      container.appendChild(row);
      renumber();
    });
  }

  container.addEventListener('click', function (ev) {
    var target = ev.target;
    if (!target || !target.classList || !target.classList.contains('remove-row-btn')) return;
    var row = target.closest('.brief-row');
    if (!row) return;
    var remainingRows = container.querySelectorAll('.brief-row').length;
    if (remainingRows <= 1) {
      alert('At least one brief is required.');
      return;
    }
    row.remove();
    renumber();
  });

  renumber();
})();
`;

  return (
    <Layout
      title="Add briefs (batch)"
      flash={error ? { type: 'err', message: error } : (flash ?? null)}
    >
      <div style="margin-bottom:16px;">
        <a href="/intake" class="muted" style="font-size:13px;">
          ← Intake pipeline
        </a>
      </div>
      <h2>Add briefs (batch)</h2>
      <p class="muted" style="margin-top:-8px; margin-bottom:20px;">
        Paste up to {MAX_ROWS} briefs at once. All briefs persist immediately;
        scoring runs in parallel (~30-45s for 10 briefs). Click any row in
        the resulting view to drill into the score breakdown.
      </p>
      <form method="post" action="/intake/batch">
        <div id="brief-rows">
          {rows.map((v, i) => (
            <div
              class="brief-row card"
              data-row-index={i}
              style="margin-bottom:14px; padding:18px; position:relative;"
            >
              <div
                class="row"
                style="justify-content:space-between; align-items:center; margin-bottom:12px;"
              >
                <strong style="color:var(--ink-2);">Brief #{i + 1}</strong>
                <button
                  type="button"
                  class="remove-row-btn"
                  style="background:transparent; border:1px solid var(--border-soft); color:var(--ink-3); padding:4px 10px; border-radius:4px; cursor:pointer; font-size:12px;"
                >
                  remove
                </button>
              </div>
              <label style="display:block; margin-bottom:10px;">
                <div class="field-label" style="margin-bottom:4px;">Title *</div>
                <input
                  type="text"
                  name={`briefs[${i}][title]`}
                  value={v.title ?? ''}
                  required
                  maxlength={200}
                  placeholder="e.g. Build a lead-routing automation"
                  style="width:100%;"
                />
              </label>
              <label style="display:block; margin-bottom:10px;">
                <div class="field-label" style="margin-bottom:4px;">Source URL (optional)</div>
                <input
                  type="url"
                  name={`briefs[${i}][sourceUrl]`}
                  value={v.sourceUrl ?? ''}
                  placeholder="https://www.upwork.com/jobs/..."
                  style="width:100%;"
                />
              </label>
              <label style="display:block; margin-bottom:10px;">
                <div class="field-label" style="margin-bottom:4px;">Company (optional)</div>
                <input
                  type="text"
                  name={`briefs[${i}][company]`}
                  value={v.company ?? ''}
                  placeholder="Acme Corp"
                  style="width:100%;"
                />
              </label>
              <label style="display:block;">
                <div class="field-label" style="margin-bottom:4px;">Brief text *</div>
                <textarea
                  name={`briefs[${i}][rawText]`}
                  rows={6}
                  required
                  maxlength={50000}
                  placeholder="Paste the full job brief here."
                  style="width:100%;"
                >{v.rawText ?? ''}</textarea>
              </label>
            </div>
          ))}
        </div>

        <div class="row" style="gap:8px; margin-bottom:16px;">
          <button
            type="button"
            id="add-row-btn"
            class="btn secondary"
          >
            + Add another brief
          </button>
          <span class="muted" style="font-size:12px; align-self:center;">
            up to {MAX_ROWS} per batch
          </span>
        </div>

        <div class="row" style="gap:8px;">
          <button class="btn accent" type="submit">Score all</button>
          <a class="btn secondary" href="/intake">Cancel</a>
        </div>
      </form>
      <script dangerouslySetInnerHTML={{ __html: batchScript }} />
    </Layout>
  );
};

// ---------------------------------------------------------------------------
// Batch overview — HTMX-polled live row list
// ---------------------------------------------------------------------------

export interface BatchOverviewPageProps {
  batchId: string;
  briefs: PipelineBrief[];
  flash?: LayoutProps['flash'];
}

const STAGE_LABELS: Record<BriefStage, string> = {
  candidate: 'Scored',
  vetted: 'Vetted',
  selected: 'Selected',
  in_production: 'In production',
  published: 'Published',
  retired: 'Retired',
};

const BatchRow: FC<{ brief: PipelineBrief }> = ({ brief }) => {
  const isScoring = brief.score === null;
  const score = brief.score;

  const aggregateColor = !score
    ? 'var(--ink-3)'
    : score.aggregate >= 4
    ? 'var(--green-fg)'
    : score.aggregate >= 3
    ? 'var(--amber-fg)'
    : 'var(--danger)';

  return (
    <div
      style="border-top:1px solid var(--border-soft); padding:14px 0; display:grid; grid-template-columns:1fr 110px 80px; gap:12px; align-items:center;"
    >
      <div style="min-width:0;">
        <a
          href={`/intake/${brief.id}`}
          style="text-decoration:none; color:var(--ink); font-weight:600;"
        >
          {brief.title}
        </a>
        {brief.company ? (
          <span class="muted" style="font-size:13px; margin-left:6px;">
            · {brief.company}
          </span>
        ) : null}
        {!isScoring && score ? (
          <div class="muted" style="font-size:12px; margin-top:4px;">
            VO {score.visualOutcome} · SP {score.storyPotential} · SF {score.scopeFit} · AM {score.audienceMatch}
          </div>
        ) : null}
      </div>
      <div style="text-align:center;">
        {isScoring ? (
          <span class="muted" style="font-size:12px; font-style:italic;">
            scoring…
          </span>
        ) : (
          <span
            style={`font-size:22px; font-weight:700; font-variant-numeric:tabular-nums; color:${aggregateColor};`}
          >
            {score!.aggregate.toFixed(1)}
          </span>
        )}
      </div>
      <div style="text-align:right;">
        <span class="tag" style="text-transform:none; font-size:11px;">
          {STAGE_LABELS[brief.stage]}
        </span>
      </div>
    </div>
  );
};

export const BatchOverviewPage: FC<BatchOverviewPageProps> = ({
  batchId,
  briefs,
  flash,
}) => {
  const scoringCount = briefs.filter((b) => b.score === null).length;
  const isStillScoring = scoringCount > 0;

  // HTMX polls the same URL while scoring is in progress. Once everyone is
  // scored, the data-hx-trigger attribute is omitted (no more polling).
  const pollAttrs = isStillScoring
    ? {
        'hx-get': `/intake/batch/${batchId}`,
        'hx-trigger': 'every 2s',
        'hx-target': 'body',
        'hx-swap': 'outerHTML',
      }
    : {};

  return (
    <Layout title={`Batch · ${batchId.slice(0, 12)}…`} flash={flash}>
      <div style="margin-bottom:16px;">
        <a href="/intake" class="muted" style="font-size:13px;">
          ← Intake pipeline
        </a>
      </div>
      <div class="card" style="margin-bottom:16px;" {...pollAttrs}>
        <div class="row" style="justify-content:space-between; align-items:flex-start; gap:12px;">
          <div>
            <h2 style="margin:0 0 4px;">Batch · {briefs.length} brief{briefs.length === 1 ? '' : 's'}</h2>
            <div class="muted" style="font-size:13px; font-family:ui-monospace,monospace;">
              {batchId}
            </div>
          </div>
          <div style="text-align:right;">
            {isStillScoring ? (
              <span style="color:var(--amber-fg); font-size:13px;">
                Scoring {scoringCount} / {briefs.length}…
              </span>
            ) : (
              <span style="color:var(--green-fg); font-size:13px;">
                ✓ All scored
              </span>
            )}
          </div>
        </div>
        {briefs.length === 0 ? (
          <div class="muted" style="margin-top:12px;">No briefs in this batch.</div>
        ) : (
          <div style="margin-top:10px;">
            {briefs.map((b) => (
              <BatchRow brief={b} />
            ))}
          </div>
        )}
      </div>
      <div class="row" style="gap:8px;">
        <a class="btn secondary" href="/intake/batch/new">+ New batch</a>
        <a class="btn secondary" href="/intake">Pipeline view</a>
      </div>
    </Layout>
  );
};
