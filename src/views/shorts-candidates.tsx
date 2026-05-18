import type { FC } from 'hono/jsx';
import { Layout, type LayoutProps } from './layout.js';
import type { Plan } from '../db/schemas.js';
import type { ShortCandidate } from '../engine/extract-shorts.js';

export interface ShortsCandidateViewProps {
  plan: Plan;
  candidates: ShortCandidate[];
  /** Map of scene id → scene title for resolving sourceSceneIds in cards. */
  sceneTitlesById: Record<string, string>;
  flash?: LayoutProps['flash'];
}

const BeatScoreBar: FC<{ score: number }> = ({ score }) => {
  const clamped = Math.max(1, Math.min(10, score));
  const pct = clamped * 10;
  const color =
    clamped >= 8 ? 'var(--green-fg)' : clamped >= 5 ? 'var(--amber-fg)' : 'var(--danger)';
  return (
    <div style="display:flex; align-items:center; gap:8px;">
      <span
        style="font-size:11px; color:var(--ink-3); text-transform:uppercase; letter-spacing:0.05em;"
      >
        beat score
      </span>
      <div style="flex:1; height:8px; background:var(--surface-raised); border-radius:4px; overflow:hidden; max-width:120px;">
        <div style={`width:${pct}%; height:100%; background:${color};`} />
      </div>
      <span style="font-variant-numeric:tabular-nums; font-size:13px; font-weight:600;">
        {clamped}/10
      </span>
    </div>
  );
};

const CandidateCard: FC<{
  plan: Plan;
  candidate: ShortCandidate;
  sceneTitlesById: Record<string, string>;
}> = ({ plan, candidate, sceneTitlesById }) => {
  const sourceTitles = candidate.sourceSceneIds
    .map((id) => sceneTitlesById[id] ?? id)
    .join(' · ');
  const wordCount = candidate.reworkedScript.trim().split(/\s+/).filter(Boolean).length;
  const estSeconds = Math.round((wordCount / 150) * 60);

  return (
    <div
      id={`candidate-${candidate.id}`}
      style="background:var(--surface); border:1px solid var(--border-soft); border-radius:10px; padding:18px; display:flex; flex-direction:column; gap:12px;"
    >
      <BeatScoreBar score={candidate.beatImportanceScore} />

      <div style="font-size:12px; color:var(--ink-3);">
        <strong>From:</strong> {sourceTitles}
      </div>

      <div style="font-size:16px; font-weight:600; line-height:1.4;">
        {candidate.hookText}
      </div>

      <form
        hx-post={`/plans/${plan.id}/approve-short`}
        hx-target="body"
        hx-swap="outerHTML"
        hx-disabled-elt="find button"
        style="display:flex; flex-direction:column; gap:8px;"
      >
        <input type="hidden" name="candidateId" value={candidate.id} />
        <label style="font-size:12px; color:var(--ink-3);">
          Reworked script · {wordCount} words · ~{estSeconds}s
        </label>
        <textarea
          name="reworkedScriptOverride"
          rows={8}
          style="font-family:ui-monospace,monospace; font-size:13px; line-height:1.5; resize:vertical; width:100%;"
        >{candidate.reworkedScript}</textarea>

        <div style="font-size:13px; color:var(--ink-2); font-style:italic; padding:8px 10px; background:var(--surface-raised); border-radius:6px;">
          <strong>Vertical reframing:</strong> {candidate.verticalReframingNotes}
        </div>

        <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px; font-size:12px; color:var(--ink-3);">
          <div>
            <strong>Title hint:</strong> {candidate.suggestedTitleHint}
          </div>
          <div>
            <strong>Thumb hint:</strong> {candidate.suggestedThumbnailHint}
          </div>
        </div>

        <div class="row" style="gap:8px; margin-top:6px;">
          <button class="btn accent" type="submit">
            Approve → create Short
          </button>
          <button
            class="btn secondary"
            type="button"
            hx-post={`/plans/${plan.id}/dismiss-short`}
            hx-vals={JSON.stringify({ candidateId: candidate.id })}
            hx-target="body"
            hx-swap="outerHTML"
            hx-confirm="Dismiss this candidate? Re-extract to bring it back."
          >
            Dismiss
          </button>
        </div>
      </form>
    </div>
  );
};

const ExtractCta: FC<{ plan: Plan; hasCandidates: boolean }> = ({
  plan,
  hasCandidates,
}) => {
  return (
    <div class="card" style="margin-bottom:16px;">
      <div class="row" style="gap:12px; flex-wrap:wrap; align-items:center;">
        <button
          class="btn accent"
          type="button"
          hx-post={`/plans/${plan.id}/extract-shorts`}
          hx-target="body"
          hx-swap="outerHTML"
          hx-disabled-elt="this"
          hx-indicator="#shorts-indicator"
          hx-confirm={
            hasCandidates
              ? 'Re-extract will discard the current candidate set. Continue?'
              : undefined
          }
        >
          {hasCandidates ? 'Re-extract candidates' : 'Extract Shorts candidates'}
        </button>
        <span class="muted" style="font-size:12px;">
          ~60-90 seconds. Produces 3-5 reworked Short scripts from the long-form.
        </span>
      </div>
      <div id="shorts-indicator" class="pipeline-indicator" style="margin-top:10px;">
        Calling LLM — Shorts extraction usually takes 60-90 seconds…
      </div>
    </div>
  );
};

export const ShortsCandidateView: FC<ShortsCandidateViewProps> = ({
  plan,
  candidates,
  sceneTitlesById,
  flash,
}) => {
  return (
    <Layout title={`Shorts · ${plan.title}`} flash={flash}>
      <div style="margin-bottom:16px;">
        <a href={`/plans/${plan.id}`} class="muted" style="font-size:14px;">
          ← Back to plan
        </a>
      </div>
      <div class="card" style="margin-bottom:16px;">
        <h1 style="margin:0 0 6px;font-size:22px;">Shorts · {plan.title}</h1>
        <div class="muted" style="font-size:14px;">
          Review extracted Short candidates. Approve to create a short_clip
          Deliverable bound to the business_owner_shorts audience — each
          approved Short gets its own title + thumbnail + publishing metadata
          flow.
        </div>
      </div>

      <ExtractCta plan={plan} hasCandidates={candidates.length > 0} />

      {candidates.length === 0 ? (
        <div
          style="text-align:center; padding:48px 24px; background:var(--surface); border:1px dashed var(--border-strong); border-radius:10px;"
        >
          <div style="font-size:16px; color:var(--ink-3); margin-bottom:8px;">
            No Shorts candidates yet
          </div>
          <div style="font-size:14px; color:var(--ink-4);">
            Click <strong>Extract Shorts candidates</strong> above to generate them.
          </div>
        </div>
      ) : (
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px;">
          {candidates.map((c) => (
            <CandidateCard
              plan={plan}
              candidate={c}
              sceneTitlesById={sceneTitlesById}
            />
          ))}
        </div>
      )}
    </Layout>
  );
};
