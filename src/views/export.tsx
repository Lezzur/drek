import type { FC } from 'hono/jsx';
import type { Plan, Scene } from '../db/schemas.js';

/**
 * Shoot instructions — the document Rick has open in another window while
 * he's recording on Loom. Designed for reading on-camera-adjacent: larger
 * font, clear scene breaks, framing notes called out separately from
 * dialogue, runtime summary at the top so Rick can pace.
 *
 * Two formats:
 *   - HTML (this file): renders in a browser tab. "Print" button uses the
 *     browser's native print dialog; the @media print rules below strip
 *     the action bar so the printed page is just the document.
 *   - Plain text: see toPlainText() — identical structure rendered as
 *     monospace-friendly text for paste into Notion / docs.
 */

export interface ShootInstructionsProps {
  plan: Plan;
  scenes: Scene[];
  /** True when plan.updatedAt > plan.exportedAt — the document is stale
   *  relative to recent edits. We surface a banner so Rick re-exports
   *  before recording. */
  stale: boolean;
}

const STYLES = `
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  font-size: 18px;
  line-height: 1.6;
  color: #1a1a1a;
  background: #fafaf7;
}
main { max-width: 880px; margin: 0 auto; padding: 40px 32px; }
h1 { font-size: 36px; font-weight: 600; letter-spacing: -0.01em; margin-bottom: 8px; }
.bar {
  background: #1a1a1a;
  color: #fafaf7;
  padding: 12px 24px;
  display: flex;
  align-items: center;
  gap: 12px;
}
.bar a, .bar button {
  background: transparent;
  color: #fafaf7;
  border: 1px solid rgba(255,255,255,0.4);
  padding: 7px 14px;
  border-radius: 6px;
  font-size: 14px;
  cursor: pointer;
  text-decoration: none;
  font-family: inherit;
}
.bar a:hover, .bar button:hover { background: rgba(255,255,255,0.1); text-decoration: none; }
.bar .spacer { flex: 1; }
.meta {
  display: grid;
  grid-template-columns: 120px 1fr;
  gap: 6px 16px;
  font-size: 15px;
  color: #555;
  margin-bottom: 36px;
  padding: 16px 20px;
  background: #fff;
  border: 1px solid #e8e6e0;
  border-radius: 10px;
}
.meta-label { color: #9a9a9a; font-size: 13px; font-weight: 500; }
.scene {
  margin-bottom: 40px;
  page-break-inside: avoid;
}
.scene-head { display: flex; align-items: baseline; gap: 14px; margin-bottom: 16px; }
.scene-num { font-size: 48px; font-weight: 700; color: #1a5fb4; line-height: 1; font-variant-numeric: tabular-nums; }
.scene-title { font-size: 24px; font-weight: 600; flex: 1; }
.scene-dur { color: #6b6b6b; font-size: 14px; }
.framing {
  background: #f1f6fc;
  border-left: 4px solid #1a5fb4;
  padding: 12px 16px;
  border-radius: 0 6px 6px 0;
  font-size: 15px;
  color: #3a3a3a;
  margin-bottom: 20px;
}
.framing-label {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: #6b6b6b;
  display: block;
  margin-bottom: 6px;
}
.script {
  font-size: 19px;
  line-height: 1.7;
  white-space: pre-wrap;
  max-width: 65ch;
  color: #1a1a1a;
  margin-bottom: 16px;
}
.pacing {
  background: #fdf6e4;
  border-left: 4px solid #7a4d00;
  padding: 10px 14px;
  border-radius: 0 6px 6px 0;
  font-size: 14px;
  color: #7a4d00;
  margin-top: 14px;
}
.transition {
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px dashed #d4d2cc;
  font-size: 13px;
  color: #3a3a3a;
  font-style: italic;
}
.stale-banner {
  background: #fdf2dd;
  border: 1px solid #e8d4a0;
  color: #7a4d00;
  padding: 12px 16px;
  border-radius: 8px;
  margin-bottom: 20px;
}
.runtime-summary {
  background: #fff;
  border: 1px solid #e8e6e0;
  border-radius: 10px;
  padding: 20px 24px;
  margin-top: 40px;
  font-size: 16px;
}
.runtime-summary h3 { font-size: 11px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: #6b6b6b; margin-bottom: 12px; }
.runtime-list { list-style: none; margin-top: 8px; }
.runtime-list li { font-size: 14px; color: #6b6b6b; padding: 4px 0; font-variant-numeric: tabular-nums; }
.runtime-total { font-size: 17px; font-weight: 600; margin-bottom: 4px; }
@media print {
  .bar, .stale-banner { display: none !important; }
  body { background: #fff; font-size: 16px; }
  main { padding: 0; }
  .scene { page-break-inside: avoid; }
}
`;

export const ShootInstructionsPage: FC<ShootInstructionsProps> = ({
  plan,
  scenes,
  stale,
}) => {
  const totalEst = scenes.reduce((sum, s) => sum + s.estimatedDurationSeconds, 0);
  const audience =
    plan.type === 'cover_letter'
      ? 'Hiring manager — evaluative. They want proof you can do the work. No fluff.'
      : "Potential clients — business owners, founders. Lead with business outcomes, not technology.";

  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>Shoot instructions · {plan.title}</title>
        <style dangerouslySetInnerHTML={{ __html: STYLES }} />
      </head>
      <body>
        <div class="bar">
          <a href={`/plans/${plan.id}`}>← Back to plan</a>
          <span class="spacer" />
          <button type="button" onclick="window.print()">Print</button>
          <a href={`/plans/${plan.id}/export.txt`}>Plain text</a>
        </div>
        <main>
          {stale ? (
            <div class="stale-banner">
              ⚠ This document is older than the most recent edit to the plan. Re-export to
              get the latest scripts.
            </div>
          ) : null}
          <h1>{plan.title}</h1>
          <div class="meta">
            <span class="meta-label">Type</span>
            <span>{plan.type === 'cover_letter' ? 'Cover letter' : 'YouTube'}</span>
            <span class="meta-label">Runtime</span>
            <span>{totalEst}s estimated · target {plan.targetRuntimeSeconds}s</span>
            <span class="meta-label">Audience</span>
            <span>{audience}</span>
          </div>

          {scenes.map((s) => (
            <SceneInstructionBlock scene={s} />
          ))}

          <div class="runtime-summary">
            <h3>Runtime summary</h3>
            <div class="runtime-total">Total: {totalEst}s estimated · Target: {plan.targetRuntimeSeconds}s</div>
            <ul class="runtime-list">
              {scenes.map((s) => (
                <li>Scene {s.order} · {s.title} — {s.estimatedDurationSeconds}s</li>
              ))}
            </ul>
          </div>
        </main>
      </body>
    </html>
  );
};

const SceneInstructionBlock: FC<{ scene: Scene }> = ({ scene }) => {
  return (
    <div class="scene">
      <div class="scene-head">
        <div class="scene-num">#{scene.order}</div>
        <div class="scene-title">{scene.title}</div>
        <div class="scene-dur">~{scene.estimatedDurationSeconds}s</div>
      </div>
      <div class="framing">
        <span class="framing-label">Framing</span>
        {scene.framingNotes || '(no framing notes)'}
      </div>
      <div class="script">{scene.script || '(no script written yet)'}</div>
      {scene.pacingNotes ? (
        <div class="pacing">
          <strong>Pacing:</strong> {scene.pacingNotes}
        </div>
      ) : null}
      {scene.transitionNote ? (
        <div class="transition">→ {scene.transitionNote}</div>
      ) : null}
    </div>
  );
};

/**
 * Plain-text export. Same content as the HTML version, formatted for paste
 * into Notion / Google Docs / wherever Rick wants it.
 */
export function toPlainText(plan: Plan, scenes: Scene[]): string {
  const totalEst = scenes.reduce((sum, s) => sum + s.estimatedDurationSeconds, 0);
  const audience =
    plan.type === 'cover_letter'
      ? 'Hiring manager — evaluative. Wants proof. No fluff.'
      : 'Potential clients — business owners, founders. Lead with outcomes, not technology.';
  const lines: string[] = [];
  lines.push(`SHOOT INSTRUCTIONS — ${plan.title}`);
  lines.push('='.repeat(72));
  lines.push(`Type:    ${plan.type === 'cover_letter' ? 'Cover letter' : 'YouTube'}`);
  lines.push(`Runtime: target ${plan.targetRuntimeSeconds}s, estimated ${totalEst}s`);
  lines.push(`Audience: ${audience}`);
  lines.push('');
  for (const s of scenes) {
    lines.push(`SCENE #${s.order} · ${s.title}  (~${s.estimatedDurationSeconds}s)`);
    lines.push('-'.repeat(72));
    lines.push(`FRAMING: ${s.framingNotes || '(none)'}`);
    lines.push('');
    lines.push('SCRIPT:');
    lines.push(s.script || '(no script written yet)');
    if (s.pacingNotes) {
      lines.push('');
      lines.push(`PACING: ${s.pacingNotes}`);
    }
    if (s.transitionNote) {
      lines.push('');
      lines.push(`→ ${s.transitionNote}`);
    }
    lines.push('');
    lines.push('');
  }
  lines.push('='.repeat(72));
  lines.push(`Total estimated runtime: ${totalEst}s (target ${plan.targetRuntimeSeconds}s)`);
  return lines.join('\n');
}
