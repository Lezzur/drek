import type { FC } from 'hono/jsx';
import { Layout, type LayoutProps } from './layout.js';
import type {
  PipelineBrief,
  BriefStage,
  CritiqueFinding,
} from '../db/schemas.js';
import type { FormatProfile } from '../engine/format-profiles/index.js';
import type { AudienceProfile } from '../neurocore/audience-profiles.js';
import { ScorePanel } from './intake-detail-score.js';
import { TransformPanel } from './intake-detail-build-plan.js';
import { FindingsPanel } from './intake-detail-findings.js';

export interface BriefDetailPageProps {
  brief: PipelineBrief;
  formatProfiles: FormatProfile[];
  audienceProfiles: AudienceProfile[];
  /** M36: persisted critique findings for this brief. Empty when critique
   *  didn't run or the plan passed every criterion. */
  findings?: CritiqueFinding[];
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

const PromoteForm: FC<{
  brief: PipelineBrief;
  formatProfiles: FormatProfile[];
  audienceProfiles: AudienceProfile[];
}> = ({ brief, formatProfiles, audienceProfiles }) => {
  if (brief.promotedPlanId) {
    return (
      <div class="card" style="margin-bottom:16px;">
        <h3 class="section-label">Send to pipeline</h3>
        <div class="flash ok" style="margin-bottom:0;">
          Already sent to pipeline.{' '}
          <a href={`/plans/${brief.promotedPlanId}`}>Open plan &rarr;</a>
        </div>
      </div>
    );
  }

  const disabled = !brief.score;

  return (
    <div class="card" style="margin-bottom:16px;">
      <h3 class="section-label">Send to pipeline</h3>
      {disabled ? (
        <div class="flash warn" style="margin-bottom:12px;">
          Brief must be scored before sending to the pipeline.
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
          Send to pipeline
        </button>
      </form>
    </div>
  );
};

export const BriefDetailPage: FC<BriefDetailPageProps> = ({
  brief,
  formatProfiles,
  audienceProfiles,
  findings = [],
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
          {/* Build plan lives in the main column, above the brief text -- Rick
              wants it as the primary thing he sees once a transform completes,
              not tucked into the 340px sidebar. TransformPanel returns null
              when the brief has no transformedBuildPlan yet, so this slot is
              empty pre-transform and the brief-text panel becomes the top
              element. */}
          <TransformPanel brief={brief} />

          {/* M36: production-realism findings panel. Sits directly below
              the build plan card so the user sees the plan + the critic's
              receipt of what was checked together. Returns null when there
              are no findings (panel disappears for plans that passed). */}
          <FindingsPanel briefId={brief.id} findings={findings} />

          {/* Open by default per Rick — he reads the brief text on every visit
              so collapsing it just hid information he always wanted. The
              <details> element still lets him collapse manually if he wants to. */}
          <details class="brief-text-panel" open style="margin-bottom:16px;">
            <summary style="cursor:pointer; font-size:14px; color:var(--ink-3); padding:12px 16px; background:var(--surface); border:1px solid var(--border); border-radius:8px; list-style:none; display:flex; align-items:center; gap:8px;">
              <span style="font-size:12px; font-weight:600; letter-spacing:0.06em; text-transform:uppercase;">Brief text</span>
              <span class="spacer" />
              <span class="brief-text-toggle" style="font-size:12px;">{brief.rawText.length.toLocaleString()} chars</span>
            </summary>
            <div style="border:1px solid var(--border); border-top:none; border-radius:0 0 8px 8px; padding:16px; background:var(--surface);">
              <pre style="white-space:pre-wrap; font-family:inherit; font-size:13px; color:var(--ink-2); line-height:1.6; margin:0; overflow-wrap:break-word;">{brief.rawText}</pre>
            </div>
          </details>
          <style dangerouslySetInnerHTML={{ __html: `
            .brief-text-panel .brief-text-toggle::after { content: ' ▾'; }
            .brief-text-panel[open] .brief-text-toggle::after { content: ' ▴'; }
          ` }} />

          {/* Stage is driven by the natural flow (created → sent to pipeline),
              never hand-set. The only explicit decision is retiring a brief
              you don't want — and restoring one if you change your mind. */}
          {brief.stage === 'retired' ? (
            <div class="card" style="margin-bottom:16px;">
              <div class="flash" style="margin-bottom:12px;">This brief is retired.</div>
              <form method="post" action={`/intake/${brief.id}/stage`}>
                <input type="hidden" name="stage" value="candidate" />
                <button class="btn small secondary" type="submit">Restore brief</button>
              </form>
            </div>
          ) : (
            <div class="card" style="margin-bottom:16px;">
              <form
                method="post"
                action={`/intake/${brief.id}/stage`}
                onsubmit="return confirm('Retire this brief? It will be hidden from the active queue. You can restore it later.');"
              >
                <input type="hidden" name="stage" value="retired" />
                <button class="btn small secondary" type="submit">Retire brief</button>
              </form>
            </div>
          )}
        </div>

        <div>
          {/* Promote ("Send to pipeline") sits at the top of the sidebar — it's
              the primary action on a vetted brief and shouldn't be buried below
              the score panel. */}
          <PromoteForm
            brief={brief}
            formatProfiles={formatProfiles}
            audienceProfiles={audienceProfiles}
          />
          <ScorePanel brief={brief} />
        </div>
      </div>
    </Layout>
  );
};
