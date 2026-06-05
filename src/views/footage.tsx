import type { FC } from 'hono/jsx';
import { Layout, BackLink, type LayoutProps } from './layout.js';
import type {
  Plan,
  Scene,
  RecordingSession,
  RecordingSessionType,
} from '../db/schemas.js';
import { RECORDING_SESSION_TYPES } from '../db/schemas.js';
import type { SceneCoverage } from '../db/recording-sessions.js';

export interface FootageTabProps {
  plan: Plan;
  scenes: Scene[];
  sessions: RecordingSession[];
  coverage: Record<string, SceneCoverage>;
  flash?: LayoutProps['flash'];
}

const SESSION_TYPE_LABELS: Record<RecordingSessionType, string> = {
  build_session: 'Build session',
  demo_session: 'Demo session',
  reflection: 'Reflection',
  b_roll: 'B-roll',
  screen_capture: 'Screen capture',
};

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const remainingSecs = seconds % 60;
  if (mins < 60) return remainingSecs === 0 ? `${mins}m` : `${mins}m ${remainingSecs}s`;
  const hours = Math.floor(mins / 60);
  const remainingMins = mins % 60;
  return remainingMins === 0 ? `${hours}h` : `${hours}h ${remainingMins}m`;
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

const CoverageSummary: FC<{
  scenes: Scene[];
  coverage: Record<string, SceneCoverage>;
}> = ({ scenes, coverage }) => {
  const covered = scenes.filter((s) => coverage[s.id]?.covered).length;
  const total = scenes.length;
  const pct = total > 0 ? Math.round((covered / total) * 100) : 0;
  const color =
    pct === 100 ? 'var(--green-fg)' : pct >= 50 ? 'var(--amber-fg)' : 'var(--danger)';

  return (
    <div class="card" style="margin-bottom:16px;">
      <h3 class="section-label">Coverage · {covered} / {total} scenes</h3>
      {total === 0 ? (
        <div class="muted">No scenes yet — generate scenes before logging footage.</div>
      ) : (
        <>
          <div class="runtime-bar-track" style="margin-top:8px;">
            <div
              class="runtime-bar-fill"
              style={`width:${pct}%; background:${color};`}
            ></div>
          </div>
          <div style="margin-top:10px; display:flex; flex-direction:column; gap:6px;">
            {scenes.map((s) => {
              const cov = coverage[s.id];
              const isCovered = cov?.covered ?? false;
              return (
                <div
                  class="row"
                  style="justify-content:space-between; font-size:13px;"
                >
                  <span>
                    <strong>#{s.order}</strong>
                    <span style="margin-left:8px;">{s.title}</span>
                  </span>
                  <span style={`font-weight:600; color:${isCovered ? 'var(--green-fg)' : 'var(--ink-3)'};`}>
                    {isCovered ? `✓ ${cov!.sessionIds.length} session(s)` : 'uncovered'}
                  </span>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
};

const LogSessionForm: FC<{ plan: Plan; scenes: Scene[] }> = ({ plan, scenes }) => {
  const todayIso = new Date().toISOString().slice(0, 10);
  return (
    <div class="card" style="margin-bottom:16px;">
      <h3 class="section-label">Log a recording session</h3>
      <form
        method="post"
        action={`/plans/${plan.id}/recording-sessions`}
        style="display:flex; flex-direction:column; gap:10px;"
      >
        <div class="row" style="gap:12px; flex-wrap:wrap;">
          <label class="row" style="gap:6px;">
            <span class="muted">Date</span>
            <input type="date" name="dateRecorded" value={todayIso} required />
          </label>
          <label class="row" style="gap:6px;">
            <span class="muted">Type</span>
            <select name="sessionType" required>
              {Object.entries(SESSION_TYPE_LABELS).map(([v, label]) => (
                <option value={v}>{label}</option>
              ))}
            </select>
          </label>
          <label class="row" style="gap:6px;">
            <span class="muted">Duration (minutes)</span>
            <input
              type="number"
              name="durationMinutes"
              min="1"
              max="1440"
              step="1"
              required
              style="width:90px;"
            />
          </label>
        </div>
        <label style="display:flex; flex-direction:column; gap:4px;">
          <span class="muted">File path (workspace-relative or absolute)</span>
          <input
            type="text"
            name="filePath"
            placeholder="recordings/build-2026-05-18.mp4"
            required
            style="font-family:ui-monospace,monospace;"
          />
        </label>
        <fieldset style="border:1px solid var(--border-soft); padding:10px; border-radius:6px;">
          <legend class="muted" style="font-size:12px;">Scenes covered</legend>
          {scenes.length === 0 ? (
            <div class="muted">No scenes yet.</div>
          ) : (
            <div style="display:flex; flex-direction:column; gap:4px;">
              {scenes.map((s) => (
                <label class="row" style="gap:8px;">
                  <input type="checkbox" name="scenesCovered" value={s.id} />
                  <span><strong>#{s.order}</strong> {s.title}</span>
                </label>
              ))}
            </div>
          )}
        </fieldset>
        <label style="display:flex; flex-direction:column; gap:4px;">
          <span class="muted">Notes (optional)</span>
          <textarea name="notes" rows={2} style="resize:vertical;"></textarea>
        </label>
        <div class="row">
          <button class="btn accent" type="submit">Log session</button>
        </div>
      </form>
    </div>
  );
};

const SessionList: FC<{ sessions: RecordingSession[] }> = ({ sessions }) => {
  if (sessions.length === 0) {
    return (
      <div class="card">
        <div class="muted">No recording sessions logged yet.</div>
      </div>
    );
  }
  return (
    <div class="card">
      <h3 class="section-label">Logged sessions · {sessions.length}</h3>
      <div style="display:flex; flex-direction:column; gap:12px; margin-top:8px;">
        {sessions.map((s) => (
          <div
            id={`session-${s.id}`}
            style="border-top:1px solid var(--border-soft); padding-top:10px; display:flex; justify-content:space-between; align-items:flex-start; gap:12px;"
          >
            <div style="flex:1;">
              <div class="row" style="gap:8px; align-items:center;">
                <span class="tag">{SESSION_TYPE_LABELS[s.sessionType]}</span>
                <span style="font-size:13px;color:var(--ink-3);font-variant-numeric:tabular-nums;">
                  {formatDate(s.dateRecorded)} · {formatDuration(s.durationSeconds)} · {s.scenesCovered.length} scene(s)
                </span>
              </div>
              <div style="font-family:ui-monospace,monospace;font-size:13px;color:var(--ink-2);margin-top:4px;word-break:break-all;">
                {s.filePath}
              </div>
              {s.notes ? (
                <div style="font-size:13px;color:var(--ink-3);margin-top:4px;font-style:italic;">
                  {s.notes}
                </div>
              ) : null}
            </div>
            <button
              class="btn-delete-scene"
              type="button"
              hx-delete={`/recording-sessions/${s.id}`}
              hx-target={`#session-${s.id}`}
              hx-swap="outerHTML"
              hx-confirm="Delete this recording session log? Footage files on disk are NOT deleted."
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </div>
  );
};

export const FootageTab: FC<FootageTabProps> = ({ plan, scenes, sessions, coverage, flash }) => {
  return (
    <Layout title={`Footage · ${plan.title}`} flash={flash}>
      <div style="margin-bottom:16px;">
        <BackLink href={`/plans/${plan.id}`} label="Back to plan" />
      </div>
      <div class="card" style="margin-bottom:16px;">
        <h1 style="margin:0 0 6px;font-size:22px;">Footage · {plan.title}</h1>
        <div class="muted" style="font-size:14px;">
          Track recording sessions for this plan. Coverage shows which scenes have footage logged.
        </div>
      </div>

      <CoverageSummary scenes={scenes} coverage={coverage} />
      <LogSessionForm plan={plan} scenes={scenes} />
      <SessionList sessions={sessions} />
    </Layout>
  );
};

export const RECORDING_SESSION_TYPE_VALUES: readonly RecordingSessionType[] = RECORDING_SESSION_TYPES;
