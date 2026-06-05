import type { FC } from 'hono/jsx';
import type {
  CritiqueFinding,
  CritiqueSeverity,
  CritiqueConfidence,
} from '../db/schemas.js';

/* ─── M36: Findings panel ─────────────────────────────────────────── */

const SEVERITY_STYLES: Record<CritiqueSeverity, { bg: string; fg: string; label: string }> = {
  high:   { bg: 'rgba(220, 38, 38, 0.08)',  fg: 'var(--danger)',   label: 'High' },
  medium: { bg: 'rgba(217, 119, 6, 0.08)',  fg: 'var(--amber-fg)', label: 'Medium' },
  low:    { bg: 'rgba(100, 116, 139, 0.08)', fg: 'var(--ink-3)',    label: 'Low' },
};

const CONFIDENCE_LABEL: Record<CritiqueConfidence, string> = {
  high: 'High confidence',
  medium: 'Medium confidence',
  low: 'Low confidence',
};

const STATUS_LABEL: Record<CritiqueFinding['status'], string> = {
  unresolved: 'Unresolved',
  applied_by_revisor: 'Applied by revisor',
  overridden: 'Overridden',
  resolved_by_user: 'Resolved',
};

const STATUS_FG: Record<CritiqueFinding['status'], string> = {
  unresolved: 'var(--amber-fg)',
  applied_by_revisor: 'var(--green-fg)',
  overridden: 'var(--ink-3)',
  resolved_by_user: 'var(--green-fg)',
};

function formatCriterionName(id: string): string {
  // Display name without coupling the view to the criteria catalog import
  // (which would pull engine code into the view tree). Catalog id is
  // snake_case → "Scope honesty" via title-case mapping.
  return id
    .split('_')
    .map((part, i) => (i === 0 ? part[0]!.toUpperCase() + part.slice(1) : part))
    .join(' ');
}

const FindingCard: FC<{ briefId: string; finding: CritiqueFinding }> = ({ briefId, finding }) => {
  const sev = SEVERITY_STYLES[finding.severity];
  const isActionable = finding.status === 'unresolved';
  return (
    <div
      style={`
        border: 1px solid var(--border);
        border-left: 3px solid ${sev.fg};
        border-radius: 6px;
        padding: 12px 14px;
        margin-bottom: 8px;
        background: var(--surface);
      `}
    >
      <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:6px;">
        <span style="font-weight:600; font-size:13px;">{formatCriterionName(finding.criterionId)}</span>
        <span
          style={`
            font-size: 11px;
            font-weight: 600;
            padding: 2px 8px;
            border-radius: 10px;
            background: ${sev.bg};
            color: ${sev.fg};
            text-transform: uppercase;
            letter-spacing: 0.04em;
          `}
        >
          {sev.label}
        </span>
        <span style="font-size:11px; color:var(--ink-3);">{CONFIDENCE_LABEL[finding.confidence]}</span>
        <span class="spacer" />
        <span style={`font-size: 11px; color: ${STATUS_FG[finding.status]}; font-weight: 600;`}>
          {STATUS_LABEL[finding.status]}
        </span>
      </div>

      {finding.stepRef ? (
        <div style="font-size:11px; color:var(--ink-3); margin-bottom:6px;">
          <span style="font-weight:600;">{finding.stepRef}</span>
        </div>
      ) : null}

      <div style="font-size:13px; color:var(--ink-1); margin-bottom:8px; line-height:1.5;">
        <strong style="font-weight:600;">Issue:</strong> {finding.issue}
      </div>
      <div style="font-size:13px; color:var(--ink-2); margin-bottom:8px; line-height:1.5;">
        <strong style="font-weight:600; color:var(--ink-1);">Suggested fix:</strong> {finding.suggestedFix}
      </div>

      {finding.status === 'overridden' && finding.overrideReason ? (
        <div style="font-size:12px; color:var(--ink-3); font-style:italic; margin-bottom:6px; padding:6px 10px; background:var(--bg-subtle); border-radius:4px;">
          Override reason: {finding.overrideReason}
        </div>
      ) : null}

      {isActionable ? (
        <div style="display:flex; gap:8px; margin-top:8px;">
          <form
            method="post"
            action={`/intake/${briefId}/findings/${finding.id}/override`}
            style="display:flex; gap:6px; align-items:center; margin:0; flex-wrap:wrap;"
          >
            <input
              type="text"
              name="reason"
              placeholder="Why is the critic wrong? (optional)"
              maxlength={2000}
              style="font-size:12px; padding:4px 8px; border:1px solid var(--border); border-radius:4px; min-width:240px;"
            />
            <button class="btn small secondary" type="submit">Override</button>
          </form>
          <form
            method="post"
            action={`/intake/${briefId}/findings/${finding.id}/resolve`}
            style="margin:0;"
          >
            <button class="btn small" type="submit">Mark resolved</button>
          </form>
        </div>
      ) : null}
    </div>
  );
};

export const FindingsPanel: FC<{ briefId: string; findings: CritiqueFinding[] }> = ({ briefId, findings }) => {
  if (findings.length === 0) return null;

  const unresolvedCount = findings.filter((f) => f.status === 'unresolved').length;
  const appliedCount = findings.filter((f) => f.status === 'applied_by_revisor').length;
  const overriddenCount = findings.filter((f) => f.status === 'overridden').length;
  const resolvedCount = findings.filter((f) => f.status === 'resolved_by_user').length;

  return (
    <div class="card" style="margin-bottom:16px;">
      <div style="display:flex; align-items:center; gap:8px; margin-bottom:12px;">
        <h2 style="margin:0; font-size:16px;">Production-realism findings</h2>
        <span class="spacer" />
        <span style="font-size:12px; color:var(--ink-3);">
          {findings.length} total
          {unresolvedCount > 0 ? ` · ${unresolvedCount} unresolved` : ''}
          {appliedCount > 0 ? ` · ${appliedCount} applied by revisor` : ''}
          {overriddenCount > 0 ? ` · ${overriddenCount} overridden` : ''}
          {resolvedCount > 0 ? ` · ${resolvedCount} resolved` : ''}
        </span>
      </div>

      <div style="font-size:12px; color:var(--ink-3); margin-bottom:12px; line-height:1.5;">
        The critic reviewed this build plan against {findings.length === 1 ? 'one' : 'several'} production-realism criteria.
        Findings marked <em>applied by revisor</em> have already been incorporated into the plan above.
        For unresolved findings, you can either fix them yourself (then mark resolved) or override if you think the critic was wrong.
      </div>

      {findings.map((f) => (
        <FindingCard briefId={briefId} finding={f} />
      ))}
    </div>
  );
};
