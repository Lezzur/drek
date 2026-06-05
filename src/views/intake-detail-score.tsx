import type { FC } from 'hono/jsx';
import type { PipelineBrief } from '../db/schemas.js';
import { isTransformable } from '../engine/transform-brief.js';

function scoreColor(aggregate: number): string {
  if (aggregate >= 4) return 'var(--green-fg)';
  if (aggregate >= 3) return 'var(--amber-fg)';
  return 'var(--danger)';
}

const ScoreRow: FC<{ label: string; value: number }> = ({ label, value }) => {
  const color = scoreColor(value);
  return (
    <div class="row" style="gap:12px; padding:6px 0; border-bottom:1px solid var(--border-soft);">
      <span style="flex:1; font-size:14px; color:var(--ink-2);">{label}</span>
      <span style={`font-size:14px; font-weight:600; color:${color}; min-width:24px; text-align:right;`}>
        {value}
      </span>
      <div style="width:80px; height:6px; background:var(--border-strong); border-radius:999px; overflow:hidden;">
        <div
          style={`height:100%; width:${(value / 5) * 100}%; background:${color}; border-radius:999px;`}
        />
      </div>
    </div>
  );
};

export const ScorePanel: FC<{ brief: PipelineBrief }> = ({ brief }) => {
  const score = brief.score;

  const manualEditScript = `
(function () {
  var toggle = document.getElementById('score-edit-toggle');
  var panel = document.getElementById('score-display');
  var form = document.getElementById('score-edit-form');
  if (!toggle || !panel || !form) return;
  toggle.addEventListener('click', function () {
    var editing = form.style.display !== 'none';
    form.style.display = editing ? 'none' : 'block';
    panel.style.display = editing ? 'block' : 'none';
    toggle.textContent = editing ? 'Edit scores manually' : 'Cancel edit';
  });
})();
`;

  if (!score) {
    return (
      <div class="card" style="margin-bottom:16px;">
        <h3 class="section-label">Score</h3>
        <div class="muted" style="font-size:14px;">Not scored yet.</div>
        <div style="margin-top:12px;">
          <button
            class="btn accent"
            type="button"
            hx-post={`/intake/${brief.id}/score`}
            hx-target="body"
            hx-swap="outerHTML"
            hx-indicator="#score-indicator"
            hx-disabled-elt="this"
          >
            Score with LLM
          </button>
          <span class="score-spinner htmx-indicator" id="score-indicator">Scoring…</span>
        </div>
      </div>
    );
  }

  const aggColor = scoreColor(score.aggregate);

  return (
    <div class="card" style="margin-bottom:16px;">
      <div class="row" style="margin-bottom:12px;">
        <h3 class="section-label" style="margin:0;">Score</h3>
        <span class="spacer" />
        <span
          style={`font-size:22px; font-weight:700; color:${aggColor}; font-variant-numeric:tabular-nums;`}
        >
          {score.aggregate.toFixed(1)}
        </span>
        <span class="muted" style="font-size:12px;">&nbsp;/ 5</span>
      </div>

      <div id="score-display">
        <ScoreRow label="Visual outcome" value={score.visualOutcome} />
        <ScoreRow label="Story potential" value={score.storyPotential} />
        <ScoreRow label="Scope fit" value={score.scopeFit} />
        <ScoreRow label="Audience match" value={score.audienceMatch} />

        {brief.scoringRationale ? (
          <div style="margin-top:12px; font-size:14px; color:var(--ink-2); line-height:1.6;">
            {brief.scoringRationale}
          </div>
        ) : null}
      </div>

      <div id="score-edit-form" style="display:none;">
        <form
          hx-patch={`/intake/${brief.id}`}
          hx-target="closest .card"
          hx-swap="outerHTML"
        >
          <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-bottom:12px;">
            {(['visualOutcome', 'storyPotential', 'scopeFit', 'audienceMatch'] as const).map((dim) => (
              <label style="display:block;">
                <div class="field-label" style="margin-bottom:4px;">
                  {dim === 'visualOutcome' ? 'Visual outcome' :
                   dim === 'storyPotential' ? 'Story potential' :
                   dim === 'scopeFit' ? 'Scope fit' : 'Audience match'}
                </div>
                <input
                  type="number"
                  name={dim}
                  value={score[dim]}
                  min={1}
                  max={5}
                  required
                  style="width:80px;"
                />
              </label>
            ))}
          </div>
          <label style="display:block; margin-bottom:12px;">
            <div class="field-label" style="margin-bottom:4px;">Rationale (optional)</div>
            <textarea name="scoringRationale" rows={3}>{brief.scoringRationale ?? ''}</textarea>
          </label>
          <label style="display:block; margin-bottom:12px;">
            <div class="field-label" style="margin-bottom:4px;">
              Why are you overriding? (optional — helps tune the scorer)
            </div>
            <input
              type="text"
              name="overrideReason"
              placeholder="e.g. 'scorer underrated scope — this is a 1-day build'"
              maxLength={800}
              style="width:100%;"
            />
            <div class="muted" style="font-size:12px; margin-top:4px;">
              Saved with the override so you can learn what the scorer consistently
              misses. Skip if there's no specific reason — the override is still
              recorded on the score delta alone.
            </div>
          </label>
          <button class="btn small" type="submit">Save scores</button>
        </form>
      </div>

      <div class="row" style="margin-top:12px; gap:8px;">
        <button
          id="score-edit-toggle"
          class="btn small secondary"
          type="button"
        >
          Edit scores manually
        </button>
        <button
          class="btn small secondary"
          type="button"
          hx-post={`/intake/${brief.id}/score`}
          hx-target="body"
          hx-swap="outerHTML"
          hx-indicator="#rescore-indicator"
          hx-disabled-elt="this"
        >
          Re-score
        </button>
        <span class="score-spinner htmx-indicator" id="rescore-indicator">Scoring…</span>
      </div>

      {isTransformable(score) && !brief.transformedBuildPlan ? (
        <div
          style="margin-top:14px; padding-top:12px; border-top:1px solid var(--border-soft);"
        >
          <div style="font-size:13px; color:var(--ink-2); line-height:1.5; margin-bottom:8px;">
            Strong technical fit ({score.scopeFit}/{score.audienceMatch}) —
            extract the build plan: goal, toolchain, step-by-step instructions,
            and shot hints.
          </div>
          <div style="display:flex; flex-wrap:wrap; gap:16px; align-items:center;">
            <button
              class="btn small accent"
              type="button"
              hx-post={`/intake/${brief.id}/transform`}
              hx-target="body"
              hx-swap="outerHTML"
              hx-confirm="Draft a build plan from this brief? The LLM will derive goal + toolchain + build steps + shots. ~60-120s."
              hx-indicator={`#transform-indicator-${brief.id}`}
              hx-disabled-elt="this"
            >
              Draft build plan
            </button>
            <span
              class="score-spinner htmx-indicator"
              id={`transform-indicator-${brief.id}`}
              style="margin-left:0;"
            >
              Transforming…
            </span>
          </div>
        </div>
      ) : null}

      <script dangerouslySetInnerHTML={{ __html: manualEditScript }} />
    </div>
  );
};
