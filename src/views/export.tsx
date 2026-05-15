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
* { box-sizing: border-box; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  font-size: 18px;
  line-height: 1.6;
  color: #1a1a1a;
  background: #fafafa;
  margin: 0;
}
main { max-width: 880px; margin: 0 auto; padding: 32px; }
h1 { font-size: 28px; margin-top: 0; }
h2 { font-size: 22px; margin: 32px 0 8px 0; }
.bar {
  background: #1a1a1a;
  color: #fafafa;
  padding: 12px 32px;
  display: flex;
  gap: 12px;
  align-items: center;
}
.bar a, .bar button {
  background: transparent;
  color: #fafafa;
  border: 1px solid #fafafa;
  padding: 6px 14px;
  border-radius: 4px;
  font-size: 14px;
  cursor: pointer;
  text-decoration: none;
}
.bar a:hover, .bar button:hover { background: #fafafa; color: #1a1a1a; }
.bar .spacer { flex: 1; }
.meta { color: #555; font-size: 15px; margin-bottom: 24px; }
.scene {
  background: #fff;
  border: 1px solid #e0e0e0;
  border-radius: 6px;
  padding: 24px;
  margin-bottom: 20px;
  page-break-inside: avoid;
}
.scene-head { display: flex; align-items: baseline; gap: 12px; margin-bottom: 12px; }
.scene-num { font-size: 28px; font-weight: 700; color: #1a5fb4; }
.scene-title { font-size: 22px; font-weight: 600; flex: 1; }
.scene-dur { color: #666; font-size: 15px; }
.framing {
  background: #f4f4f4;
  border-left: 4px solid #1a5fb4;
  padding: 10px 14px;
  margin-bottom: 14px;
  font-size: 15px;
}
.framing-label {
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 1px;
  text-transform: uppercase;
  color: #666;
  display: block;
  margin-bottom: 4px;
}
.script { font-size: 19px; line-height: 1.7; white-space: pre-wrap; }
.transition {
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px dashed #ccc;
  font-size: 14px;
  color: #666;
  font-style: italic;
}
.pacing {
  margin-top: 10px;
  padding: 8px 12px;
  background: #fff5dc;
  border-left: 3px solid #d4b75b;
  font-size: 14px;
}
.runtime-summary {
  background: #fff;
  border: 1px solid #e0e0e0;
  border-radius: 6px;
  padding: 20px;
  margin-top: 24px;
  font-size: 17px;
  text-align: center;
  font-weight: 600;
}
.stale-banner {
  background: #fff5dc;
  border: 1px solid #d4b75b;
  color: #6a4c00;
  padding: 12px 16px;
  border-radius: 4px;
  margin: 0 0 16px 0;
}
@media print {
  .bar, .stale-banner { display: none !important; }
  body { background: #fff; font-size: 16px; }
  main { padding: 0; }
  .scene { box-shadow: none; border: 1px solid #999; }
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
            <div>
              <strong>Type:</strong> {plan.type === 'cover_letter' ? 'Cover letter' : 'YouTube'}
            </div>
            <div>
              <strong>Target runtime:</strong> {plan.targetRuntimeSeconds}s (estimated{' '}
              {totalEst}s)
            </div>
            <div>
              <strong>Audience:</strong> {audience}
            </div>
          </div>

          {scenes.map((s) => (
            <SceneInstructionBlock scene={s} />
          ))}

          <div class="runtime-summary">
            Total estimated runtime: {totalEst}s · Target: {plan.targetRuntimeSeconds}s
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
