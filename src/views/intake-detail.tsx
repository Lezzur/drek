import type { FC } from 'hono/jsx';
import { Layout, type LayoutProps } from './layout.js';
import type { PipelineBrief, BriefStage, BriefScore } from '../db/schemas.js';
import type { FormatProfile } from '../engine/format-profiles/index.js';
import type { AudienceProfile } from '../neurocore/audience-profiles.js';
import { isTransformable } from '../engine/transform-brief.js';

export interface BriefDetailPageProps {
  brief: PipelineBrief;
  formatProfiles: FormatProfile[];
  audienceProfiles: AudienceProfile[];
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

const ScorePanel: FC<{ brief: PipelineBrief }> = ({ brief }) => {
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
          <button
            class="btn small accent"
            type="button"
            hx-post={`/intake/${brief.id}/transform`}
            hx-target="body"
            hx-swap="outerHTML"
            hx-confirm="Transform this brief into a build plan? The LLM will derive goal + toolchain + build steps + shots. ~60-120s."
          >
            Transform → build plan
          </button>
          <span class="muted htmx-indicator" style="margin-left:10px; font-size:13px;">Transforming… (~60-120s)</span>
        </div>
      ) : null}

      <script dangerouslySetInnerHTML={{ __html: manualEditScript }} />
    </div>
  );
};

const TransformPanel: FC<{ brief: PipelineBrief }> = ({ brief }) => {
  const plan = brief.transformedBuildPlan;
  const stack = brief.pinnedTechStack;
  if (!plan || !stack) return null;

  const totalMinutes = plan.buildSteps.reduce((sum, s) => sum + s.estimatedMinutes, 0);
  // Serialize the initial state so the edit-mode script can hydrate from
  // it. Safe: this is JSON, embedded server-side, no user input round-trip.
  const initialJson = JSON.stringify({
    goal: plan.goal,
    finalProduct: plan.finalProduct,
    toolchain: plan.toolchain,
    buildSteps: plan.buildSteps,
    shotHints: plan.shotHints,
    pinnedTechStack: stack,
  });

  return (
    <div class="card" style="margin-bottom:16px;" id={`build-plan-${brief.id}`}>
      <div class="row" style="margin-bottom:12px; align-items:center;">
        <h3 class="section-label" style="margin:0;">Build plan</h3>
        <span class="spacer" />
        <span class="muted" style="font-size:12px;" id={`bp-total-${brief.id}`}>~{totalMinutes} min total</span>
      </div>

      {/* VIEW MODE */}
      <div id={`bp-view-${brief.id}`}>
        <div style="margin-bottom:14px;">
          <div class="field-label" style="margin-bottom:4px;">Goal</div>
          <div style="font-size:14px; color:var(--ink); line-height:1.6;">{plan.goal}</div>
        </div>

        <div style="margin-bottom:14px;">
          <div class="field-label" style="margin-bottom:4px;">Final product (10-second wow shot)</div>
          <div style="font-size:14px; color:var(--ink); line-height:1.6;">{plan.finalProduct}</div>
        </div>

        <div style="margin-bottom:14px;">
          <div class="field-label" style="margin-bottom:6px;">Pinned tech stack</div>
          <div style="font-size:14px; color:var(--ink); line-height:1.5;">
            <div>
              <strong>Primary:</strong>{' '}
              <code style="font-size:13px;">{stack.primary}</code>
            </div>
            {stack.supporting.length > 0 ? (
              <div style="margin-top:4px;">
                <strong>Supporting:</strong>{' '}
                {stack.supporting.map((id, i) => (
                  <span>
                    <code style="font-size:13px;">{id}</code>
                    {i < stack.supporting.length - 1 ? ', ' : ''}
                  </span>
                ))}
              </div>
            ) : null}
            <div style="margin-top:8px; color:var(--ink-2); font-size:13px; line-height:1.6;">
              {stack.rationale}
            </div>
          </div>
        </div>

        <div style="margin-bottom:14px;">
          <div class="field-label" style="margin-bottom:6px;">Toolchain</div>
          <div style="display:flex; flex-direction:column; gap:6px;">
            {plan.toolchain.map((t) => (
              <div style="display:flex; gap:10px; align-items:baseline; font-size:13px;">
                <span style={`font-weight:600; color:${t.source === 'given' ? 'var(--ink)' : 'var(--ink-2)'}; min-width:90px;`}>{t.name}</span>
                <span style="color:var(--ink-3); font-size:11px; text-transform:uppercase; letter-spacing:0.04em;">{t.source}</span>
                <span style="color:var(--ink-2); flex:1;">{t.role}</span>
              </div>
            ))}
          </div>
        </div>

        <div style="margin-bottom:14px;">
          <div class="field-label" style="margin-bottom:6px;">Build steps</div>
          <ol style="margin:0; padding-left:22px; display:flex; flex-direction:column; gap:8px;">
            {plan.buildSteps.map((s) => (
              <li style="font-size:14px; color:var(--ink); line-height:1.5;">
                <div style="display:flex; gap:8px; align-items:baseline;">
                  <strong style="flex:1;">{s.title}</strong>
                  <span class="muted" style="font-size:12px; font-variant-numeric:tabular-nums;">{s.estimatedMinutes} min</span>
                </div>
                <div style="color:var(--ink-2); font-size:13px; line-height:1.5; margin-top:2px;">{s.description}</div>
              </li>
            ))}
          </ol>
        </div>

        <div style="margin-bottom:14px;">
          <div class="field-label" style="margin-bottom:6px;">Shot hints</div>
          <ul style="margin:0; padding-left:22px; display:flex; flex-direction:column; gap:4px;">
            {plan.shotHints.map((h) => (
              <li style="font-size:13px; color:var(--ink-2); line-height:1.5;">{h}</li>
            ))}
          </ul>
        </div>
      </div>

      {/* EDIT MODE — populated + wired by the script below. Hidden by default. */}
      <div id={`bp-edit-${brief.id}`} style="display:none;">
        <div style="margin-bottom:14px;">
          <div class="field-label" style="margin-bottom:4px;">Goal</div>
          <textarea
            id={`bp-edit-goal-${brief.id}`}
            rows={3}
            style="width:100%; font-family:inherit; font-size:14px;"
          />
        </div>
        <div style="margin-bottom:14px;">
          <div class="field-label" style="margin-bottom:4px;">Final product</div>
          <textarea
            id={`bp-edit-final-${brief.id}`}
            rows={3}
            style="width:100%; font-family:inherit; font-size:14px;"
          />
        </div>
        <div style="margin-bottom:14px;">
          <div class="field-label" style="margin-bottom:6px;">Pinned tech stack</div>
          <label style="display:block; margin-bottom:6px; font-size:12px; color:var(--ink-2);">
            Primary
            <input
              type="text"
              id={`bp-edit-stack-primary-${brief.id}`}
              style="width:100%; font-family:inherit; font-size:13px;"
            />
          </label>
          <label style="display:block; margin-bottom:6px; font-size:12px; color:var(--ink-2);">
            Supporting (comma-separated)
            <input
              type="text"
              id={`bp-edit-stack-supporting-${brief.id}`}
              style="width:100%; font-family:inherit; font-size:13px;"
            />
          </label>
          <label style="display:block; font-size:12px; color:var(--ink-2);">
            Rationale
            <textarea
              id={`bp-edit-stack-rationale-${brief.id}`}
              rows={2}
              style="width:100%; font-family:inherit; font-size:13px;"
            />
          </label>
        </div>
        <div style="margin-bottom:14px;">
          <div class="field-label" style="margin-bottom:6px;">Toolchain</div>
          <div id={`bp-edit-toolchain-${brief.id}`} style="display:flex; flex-direction:column; gap:6px;" />
          <button
            type="button"
            class="btn small secondary"
            style="margin-top:6px;"
            data-bp-add-tool={brief.id}
          >
            + Add tool
          </button>
        </div>
        <div style="margin-bottom:14px;">
          <div class="field-label" style="margin-bottom:6px;">Build steps</div>
          <div id={`bp-edit-steps-${brief.id}`} style="display:flex; flex-direction:column; gap:10px;" />
          <button
            type="button"
            class="btn small secondary"
            style="margin-top:6px;"
            data-bp-add-step={brief.id}
          >
            + Add step
          </button>
        </div>
        <div style="margin-bottom:14px;">
          <div class="field-label" style="margin-bottom:6px;">Shot hints</div>
          <div id={`bp-edit-shots-${brief.id}`} style="display:flex; flex-direction:column; gap:6px;" />
          <button
            type="button"
            class="btn small secondary"
            style="margin-top:6px;"
            data-bp-add-shot={brief.id}
          >
            + Add shot
          </button>
        </div>
        <div id={`bp-edit-error-${brief.id}`} class="flash warn" style="display:none; margin-bottom:8px; font-size:13px;" />
      </div>

      <div class="row" style="margin-top:14px; gap:8px;">
        <button
          type="button"
          class="btn small accent"
          data-bp-edit-toggle={brief.id}
          id={`bp-edit-toggle-${brief.id}`}
        >
          Edit plan
        </button>
        <button
          type="button"
          class="btn small accent"
          style="display:none;"
          data-bp-save={brief.id}
          id={`bp-save-${brief.id}`}
        >
          Save
        </button>
        <button
          type="button"
          class="btn small secondary"
          style="display:none;"
          data-bp-cancel={brief.id}
          id={`bp-cancel-${brief.id}`}
        >
          Cancel
        </button>
        <span class="spacer" />
        <button
          class="btn small secondary"
          type="button"
          hx-post={`/intake/${brief.id}/transform`}
          hx-target="body"
          hx-swap="outerHTML"
          hx-confirm="Re-transform this brief? The current build plan and tech-stack pick will be overwritten."
        >
          Re-transform
        </button>
        <span class="muted htmx-indicator" style="font-size:13px;">Transforming… (~60-120s)</span>
      </div>
      <script
        dangerouslySetInnerHTML={{
          __html: buildPlanEditScript(brief.id, initialJson),
        }}
      />
    </div>
  );
};

/**
 * Inline edit-mode controller for one build plan card. Hydrates the form
 * from `initial`, handles add/remove rows, validates locally (matches the
 * server-side Zod schema bounds so users get instant feedback), and
 * POSTs JSON to /intake/:id/build-plan. On success reloads the page so
 * the view-mode rendering reflects the new server state.
 *
 * Plain DOM API — no framework. Each panel is independently scoped via
 * the briefId, so multiple panels on the same page (rare but possible)
 * don't collide.
 */
function buildPlanEditScript(briefId: string, initial: string): string {
  return `
(function() {
  var initial = ${initial};
  var state = JSON.parse(JSON.stringify(initial));

  var id = ${JSON.stringify(briefId)};
  var $ = function(suffix) { return document.getElementById('bp-' + suffix + '-' + id); };
  var view = $('view'), edit = $('edit'), toggle = $('edit-toggle'), save = $('save'), cancel = $('cancel');
  var errBox = $('edit-error');
  if (!view || !edit || !toggle) return;

  function setError(msg) {
    if (!errBox) return;
    if (msg) { errBox.textContent = msg; errBox.style.display = 'block'; }
    else { errBox.textContent = ''; errBox.style.display = 'none'; }
  }

  function enterEdit() {
    state = JSON.parse(JSON.stringify(initial));
    hydrate();
    view.style.display = 'none';
    edit.style.display = 'block';
    toggle.style.display = 'none';
    save.style.display = '';
    cancel.style.display = '';
    setError(null);
  }
  function exitEdit() {
    view.style.display = '';
    edit.style.display = 'none';
    toggle.style.display = '';
    save.style.display = 'none';
    cancel.style.display = 'none';
    setError(null);
  }

  function hydrate() {
    $('edit-goal').value = state.goal;
    $('edit-final').value = state.finalProduct;
    $('edit-stack-primary').value = state.pinnedTechStack.primary;
    $('edit-stack-supporting').value = state.pinnedTechStack.supporting.join(', ');
    $('edit-stack-rationale').value = state.pinnedTechStack.rationale;
    renderToolchain();
    renderSteps();
    renderShots();
  }

  function renderToolchain() {
    var container = $('edit-toolchain');
    container.innerHTML = '';
    state.toolchain.forEach(function(t, i) {
      var row = document.createElement('div');
      row.style.cssText = 'display:flex; gap:6px; align-items:center;';
      row.innerHTML =
        '<input type="text" placeholder="Tool name" style="flex:1; font-family:inherit; font-size:13px;" data-tc-name="' + i + '" />' +
        '<input type="text" placeholder="Role" style="flex:2; font-family:inherit; font-size:13px;" data-tc-role="' + i + '" />' +
        '<select style="font-family:inherit; font-size:13px;" data-tc-source="' + i + '">' +
          '<option value="given">given</option><option value="assumed">assumed</option></select>' +
        '<button type="button" class="btn small secondary" data-tc-remove="' + i + '">−</button>';
      container.appendChild(row);
      row.querySelector('[data-tc-name]').value = t.name;
      row.querySelector('[data-tc-role]').value = t.role;
      row.querySelector('[data-tc-source]').value = t.source;
    });
  }

  function renderSteps() {
    var container = $('edit-steps');
    container.innerHTML = '';
    state.buildSteps.forEach(function(s, i) {
      var row = document.createElement('div');
      row.style.cssText = 'display:flex; flex-direction:column; gap:4px; padding:8px; border:1px solid var(--border-soft); border-radius:6px;';
      row.innerHTML =
        '<div style="display:flex; gap:6px; align-items:center;">' +
          '<input type="text" placeholder="Step title" style="flex:1; font-family:inherit; font-size:13px;" data-step-title="' + i + '" />' +
          '<input type="number" min="1" max="240" placeholder="min" style="width:70px; font-family:inherit; font-size:13px;" data-step-minutes="' + i + '" />' +
          '<button type="button" class="btn small secondary" data-step-remove="' + i + '">−</button>' +
        '</div>' +
        '<textarea rows="2" placeholder="What gets built in this step" style="font-family:inherit; font-size:13px; width:100%;" data-step-desc="' + i + '"></textarea>';
      container.appendChild(row);
      row.querySelector('[data-step-title]').value = s.title;
      row.querySelector('[data-step-minutes]').value = String(s.estimatedMinutes);
      row.querySelector('[data-step-desc]').value = s.description;
    });
  }

  function renderShots() {
    var container = $('edit-shots');
    container.innerHTML = '';
    state.shotHints.forEach(function(h, i) {
      var row = document.createElement('div');
      row.style.cssText = 'display:flex; gap:6px; align-items:center;';
      row.innerHTML =
        '<input type="text" style="flex:1; font-family:inherit; font-size:13px;" data-shot="' + i + '" />' +
        '<button type="button" class="btn small secondary" data-shot-remove="' + i + '">−</button>';
      container.appendChild(row);
      row.querySelector('[data-shot]').value = h;
    });
  }

  function collect() {
    // Pull state back out of the live form into the in-memory model.
    state.goal = $('edit-goal').value.trim();
    state.finalProduct = $('edit-final').value.trim();
    state.pinnedTechStack.primary = $('edit-stack-primary').value.trim();
    state.pinnedTechStack.supporting = $('edit-stack-supporting').value
      .split(',').map(function(s) { return s.trim(); }).filter(Boolean);
    state.pinnedTechStack.rationale = $('edit-stack-rationale').value.trim();
    state.toolchain = Array.prototype.map.call(
      $('edit-toolchain').children,
      function(row) {
        return {
          name: row.querySelector('[data-tc-name]').value.trim(),
          role: row.querySelector('[data-tc-role]').value.trim(),
          source: row.querySelector('[data-tc-source]').value,
        };
      },
    );
    state.buildSteps = Array.prototype.map.call(
      $('edit-steps').children,
      function(row) {
        return {
          title: row.querySelector('[data-step-title]').value.trim(),
          description: row.querySelector('[data-step-desc]').value.trim(),
          estimatedMinutes: parseInt(row.querySelector('[data-step-minutes]').value, 10) || 0,
        };
      },
    );
    state.shotHints = Array.prototype.map.call(
      $('edit-shots').children,
      function(row) { return row.querySelector('[data-shot]').value.trim(); },
    ).filter(Boolean);
  }

  function validate(s) {
    if (s.goal.length < 20) return 'Goal must be at least 20 characters';
    if (s.finalProduct.length < 20) return 'Final product must be at least 20 characters';
    if (!s.pinnedTechStack.primary) return 'Pinned tech stack primary is required';
    if (s.pinnedTechStack.rationale.length < 1) return 'Pinned tech stack rationale is required';
    if (s.toolchain.length < 1 || s.toolchain.length > 8) return 'Toolchain must have 1-8 entries';
    for (var i = 0; i < s.toolchain.length; i++) {
      var t = s.toolchain[i];
      if (!t.name || !t.role) return 'Toolchain row ' + (i + 1) + ' is incomplete';
    }
    if (s.buildSteps.length < 3 || s.buildSteps.length > 12) return 'Build steps must have 3-12 entries';
    for (var j = 0; j < s.buildSteps.length; j++) {
      var bs = s.buildSteps[j];
      if (!bs.title || !bs.description) return 'Build step ' + (j + 1) + ' is incomplete';
      if (bs.estimatedMinutes < 1 || bs.estimatedMinutes > 240) return 'Build step ' + (j + 1) + ' minutes must be 1-240';
    }
    if (s.shotHints.length < 3 || s.shotHints.length > 12) return 'Shot hints must have 3-12 entries';
    return null;
  }

  // Event delegation — single listener handles all add/remove + toggle/save/cancel.
  document.addEventListener('click', function(e) {
    var t = e.target;
    if (!t || !t.getAttribute) return;
    if (t.getAttribute('data-bp-edit-toggle') === id) { enterEdit(); return; }
    if (t.getAttribute('data-bp-cancel') === id) { exitEdit(); return; }
    if (t.getAttribute('data-bp-add-tool') === id) {
      collect();
      state.toolchain.push({ name: '', role: '', source: 'assumed' });
      renderToolchain(); return;
    }
    if (t.getAttribute('data-bp-add-step') === id) {
      collect();
      state.buildSteps.push({ title: '', description: '', estimatedMinutes: 30 });
      renderSteps(); return;
    }
    if (t.getAttribute('data-bp-add-shot') === id) {
      collect();
      state.shotHints.push('');
      renderShots(); return;
    }
    var rem;
    if ((rem = t.getAttribute('data-tc-remove')) !== null) {
      collect();
      state.toolchain.splice(parseInt(rem, 10), 1);
      renderToolchain(); return;
    }
    if ((rem = t.getAttribute('data-step-remove')) !== null) {
      collect();
      state.buildSteps.splice(parseInt(rem, 10), 1);
      renderSteps(); return;
    }
    if ((rem = t.getAttribute('data-shot-remove')) !== null) {
      collect();
      state.shotHints.splice(parseInt(rem, 10), 1);
      renderShots(); return;
    }
    if (t.getAttribute('data-bp-save') === id) {
      collect();
      var err = validate(state);
      if (err) { setError(err); return; }
      setError(null);
      save.disabled = true;
      save.textContent = 'Saving…';
      fetch('/intake/' + id + '/build-plan', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(state),
      }).then(function(r) {
        if (r.ok) {
          window.location.href = '/intake/' + id + '?flash=plan-edited';
          return;
        }
        return r.json().then(function(b) {
          setError((b && b.error && b.error.message) || ('HTTP ' + r.status));
          save.disabled = false;
          save.textContent = 'Save';
        });
      }).catch(function(e) {
        setError(e.message || 'network error');
        save.disabled = false;
        save.textContent = 'Save';
      });
    }
  });
})();
`;
}

const PromoteForm: FC<{
  brief: PipelineBrief;
  formatProfiles: FormatProfile[];
  audienceProfiles: AudienceProfile[];
}> = ({ brief, formatProfiles, audienceProfiles }) => {
  if (brief.promotedPlanId) {
    return (
      <div class="card" style="margin-bottom:16px;">
        <h3 class="section-label">Promote to plan</h3>
        <div class="flash ok" style="margin-bottom:0;">
          Already promoted.{' '}
          <a href={`/plans/${brief.promotedPlanId}`}>Open plan &rarr;</a>
        </div>
      </div>
    );
  }

  const disabled = !brief.score;

  return (
    <div class="card" style="margin-bottom:16px;">
      <h3 class="section-label">Promote to plan</h3>
      {disabled ? (
        <div class="flash warn" style="margin-bottom:12px;">
          Brief must be scored before promoting.
        </div>
      ) : null}
      <form method="post" action={`/intake/${brief.id}/promote`}>
        <label style="display:block; margin-bottom:12px;">
          <div class="field-label" style="margin-bottom:4px;">Format profile</div>
          <select name="formatProfileId" required style="width:100%;">
            {formatProfiles.map((fp) => (
              <option value={fp.id}>{fp.displayName}</option>
            ))}
          </select>
        </label>
        <label style="display:block; margin-bottom:12px;">
          <div class="field-label" style="margin-bottom:4px;">Audience profile</div>
          <select name="audienceProfileId" required style="width:100%;">
            {audienceProfiles.length === 0 ? (
              <option value="" disabled>No audience profiles available</option>
            ) : (
              audienceProfiles.map((ap) => (
                <option value={ap.id}>{ap.name}</option>
              ))
            )}
          </select>
        </label>
        <label style="display:block; margin-bottom:12px;">
          <div class="field-label" style="margin-bottom:4px;">Target runtime (seconds, optional)</div>
          <input
            type="number"
            name="targetRuntimeSeconds"
            min={30}
            max={3600}
            placeholder="Uses format default if omitted"
            style="width:180px;"
          />
        </label>
        <button
          class="btn accent"
          type="submit"
          disabled={disabled}
        >
          Promote to plan
        </button>
      </form>
    </div>
  );
};

export const BriefDetailPage: FC<BriefDetailPageProps> = ({
  brief,
  formatProfiles,
  audienceProfiles,
  flash,
}) => {
  return (
    <Layout title={brief.title} flash={flash}>
      <div class="row" style="margin-bottom:16px;">
        <div>
          <h1 style="margin:0;">{brief.title}</h1>
          <div class="muted" style="margin-top:4px; font-size:14px;">
            {brief.company ? <span>{brief.company} · </span> : null}
            <span class={`badge ${brief.stage}`} style="vertical-align:middle;">
              {STAGE_LABELS[brief.stage]}
            </span>
            {brief.sourceUrl ? (
              <span> · <a href={brief.sourceUrl} target="_blank" rel="noopener noreferrer">{brief.sourceUrl}</a></span>
            ) : null}
          </div>
        </div>
        <span class="spacer" />
        <a class="btn secondary" href="/intake">Back to pipeline</a>
      </div>

      <div style="display:grid; grid-template-columns:1fr 340px; gap:20px; align-items:flex-start;">
        <div>
          <details style="margin-bottom:16px;">
            <summary style="cursor:pointer; font-size:14px; color:var(--ink-3); padding:12px 16px; background:var(--surface); border:1px solid var(--border); border-radius:8px; list-style:none; display:flex; align-items:center; gap:8px;">
              <span style="font-size:12px; font-weight:600; letter-spacing:0.06em; text-transform:uppercase;">Brief text</span>
              <span class="spacer" />
              <span style="font-size:12px;">{brief.rawText.length.toLocaleString()} chars ▾</span>
            </summary>
            <div style="border:1px solid var(--border); border-top:none; border-radius:0 0 8px 8px; padding:16px; background:var(--surface);">
              <pre style="white-space:pre-wrap; font-family:inherit; font-size:13px; color:var(--ink-2); line-height:1.6; margin:0; overflow-wrap:break-word;">{brief.rawText}</pre>
            </div>
          </details>

          <div class="card" style="margin-bottom:16px;">
            <h3 class="section-label">Stage transition</h3>
            <form method="post" action={`/intake/${brief.id}/stage`} class="row" style="gap:8px; flex-wrap:wrap;">
              <select name="stage" style="font-size:14px;">
                {(['candidate', 'vetted', 'selected', 'in_production', 'published', 'retired'] as const).map((s) => (
                  <option value={s} selected={brief.stage === s}>{STAGE_LABELS[s]}</option>
                ))}
              </select>
              <button class="btn small" type="submit">Transition</button>
            </form>
          </div>
        </div>

        <div>
          <ScorePanel brief={brief} />
          <TransformPanel brief={brief} />
          <PromoteForm
            brief={brief}
            formatProfiles={formatProfiles}
            audienceProfiles={audienceProfiles}
          />
        </div>
      </div>
    </Layout>
  );
};
