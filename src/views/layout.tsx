/**
 * Base HTML layout for every DREK page. Server-rendered Hono JSX +
 * HTMX 2.x for interactivity. Desktop Chrome only (PRD §9.4 / D-16) so
 * no responsive concerns, no mobile media queries.
 *
 * Style strategy: minimal inline CSS, system fonts, functional/utilitarian
 * (D-17). No brand assets, no logo, monochrome with one accent. Internal
 * tool — UX matters but visual polish does not.
 */

import type { FC } from 'hono/jsx';

export interface LayoutProps {
  title: string;
  children: unknown;
  /** Optional toast-style flash message shown at the top. Set via the
   *  HX-Trigger header in action responses. */
  flash?: { type: 'ok' | 'warn' | 'err'; message: string } | null;
}

const STYLES = `
:root {
  --bg: #111110;
  --surface: #1c1c1a;
  --border: #2a2a27;
  --border-soft: #232320;
  --border-strong: #363632;
  --ink: #eae8e1;
  --ink-2: #c0beb7;
  --ink-3: #7a7872;
  --ink-4: #4e4c47;
  --link: #6ba3e0;
  --script-bg: #19180f;
  --danger: #e06060;
  --danger-bg: #2c1515;
  --blue-bg: #152035;
  --blue-fg: #6ba3e0;
  --amber-bg: #241908;
  --amber-fg: #c89040;
  --green-bg: #0e1f14;
  --green-fg: #50a870;
  --grey-bg: #1e1e1c;
  --grey-fg: #7a7872;
  --header-bg: #0c0c0b;
  --header-color: #eae8e1;
  --surface-raised: #252522;
  --row-hover: #222220;
  --input-bg: #161614;
  --btn-primary-hover: #cbc9c2;
  --btn-secondary-hover: #252522;
  --flash-ok-border: #1e4a2e;
  --flash-warn-border: #4a3010;
  --flash-err-border: #4a1515;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { height: 100%; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  font-size: 15px;
  line-height: 1.5;
  color: var(--ink);
  background: var(--bg);
}
a { color: var(--link); text-decoration: none; }
a:hover { text-decoration: underline; }
header.app {
  background: var(--header-bg);
  color: var(--header-color);
  padding: 14px 32px;
  display: flex;
  align-items: center;
  gap: 28px;
}
header.app .brand {
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 0.02em;
  color: var(--header-color);
  text-decoration: none;
}
header.app nav { display: flex; gap: 20px; margin-left: auto; }
header.app nav a {
  color: var(--header-color);
  font-size: 14px;
  opacity: 0.7;
  text-decoration: none;
}
header.app nav a:hover { opacity: 1; text-decoration: none; }
.header-inner {
  max-width: 1200px;
  width: 100%;
  margin: 0 auto;
  padding: 0 40px;
  display: flex;
  align-items: center;
  gap: 28px;
}
main {
  max-width: 1200px;
  margin: 0 auto;
  padding: 32px 40px;
}
h1 { font-size: 28px; font-weight: 600; letter-spacing: -0.01em; margin-bottom: 4px; }
h2 { font-size: 18px; font-weight: 600; margin-bottom: 12px; }
h3.section-label {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--ink-3);
  margin-bottom: 10px;
}
.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 20px;
  margin-bottom: 16px;
}
.btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  background: var(--ink);
  color: var(--bg);
  border: 1px solid var(--ink);
  border-radius: 7px;
  font: 500 14px/1 inherit;
  cursor: pointer;
  text-decoration: none;
  white-space: nowrap;
  flex-shrink: 0;
}
.btn:hover { background: var(--btn-primary-hover); border-color: var(--btn-primary-hover); text-decoration: none; color: var(--bg); }
.btn.secondary { background: var(--surface); color: var(--ink); border-color: var(--border-strong); }
.btn.secondary:hover { background: var(--btn-secondary-hover); text-decoration: none; color: var(--ink); }
.btn.accent { background: #4a7fc1; border-color: #4a7fc1; color: #fff; }
.btn.accent:hover { background: #3868a8; border-color: #3868a8; color: #fff; }
.btn.danger { background: var(--danger); border-color: var(--danger); color: #fff; }
.btn.danger:hover { background: #a00000; }
.btn.small { padding: 6px 10px; font-size: 13px; border-radius: 5px; }
.btn.linkish { background: transparent; border-color: transparent; color: var(--link); padding: 6px 8px; }
.btn.linkish:hover { background: var(--blue-bg); text-decoration: none; }
button.btn { font-family: inherit; }
.btn[disabled], button[disabled] { opacity: 0.45; cursor: not-allowed; pointer-events: none; }
.badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 500;
}
.badge::before {
  content: '';
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  flex-shrink: 0;
}
.badge.awaiting_review { background: var(--amber-bg); color: var(--amber-fg); }
.badge.requirements_reviewed,
.badge.projects_matched,
.badge.scenes_generated { background: var(--blue-bg); color: var(--blue-fg); }
.badge.finalized,
.badge.exported { background: var(--green-bg); color: var(--green-fg); }
.badge.dismissed { background: var(--grey-bg); color: var(--grey-fg); }
.flash {
  padding: 12px 16px;
  border-radius: 8px;
  margin-bottom: 16px;
  font-size: 14px;
}
.flash.ok { background: var(--green-bg); border: 1px solid var(--flash-ok-border); color: var(--green-fg); }
.flash.warn { background: var(--amber-bg); border: 1px solid var(--flash-warn-border); color: var(--amber-fg); }
.flash.err { background: var(--danger-bg); border: 1px solid var(--flash-err-border); color: var(--danger); }
.row { display: flex; gap: 8px; align-items: center; }
.spacer { flex: 1; }
.muted { color: var(--ink-3); font-size: 14px; }
.empty {
  text-align: center;
  padding: 32px 16px;
  color: var(--ink-3);
  font-size: 14px;
  background: var(--surface);
  border: 1px dashed var(--border-strong);
  border-radius: 10px;
}
form.inline { display: block; width: 100%; margin: 0; }
input[type="text"], input[type="number"], input[type="url"], select {
  padding: 9px 12px;
  border: 1px solid var(--border-strong);
  border-radius: 7px;
  font: inherit;
  font-size: 14px;
  background: var(--input-bg);
  color: var(--ink);
}
input:-webkit-autofill, input:-webkit-autofill:focus {
  -webkit-box-shadow: 0 0 0px 1000px var(--input-bg) inset;
  -webkit-text-fill-color: var(--ink);
}
input[type="number"]::-webkit-inner-spin-button, input[type="number"]::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
input[type="number"] { -moz-appearance: textfield; }
input[type="text"]:focus, input[type="number"]:focus, input[type="url"]:focus, select:focus, textarea:focus {
  border-color: var(--link);
  outline: none;
  box-shadow: 0 0 0 3px rgba(26,95,180,0.12);
}
textarea {
  width: 100%;
  font-family: inherit;
  font-size: 14px;
  padding: 10px 14px;
  border: 1px solid var(--border-strong);
  border-radius: 7px;
  resize: vertical;
  background: var(--input-bg);
  color: var(--ink);
  line-height: 1.6;
  min-height: 80px;
  scrollbar-width: thin;
  scrollbar-color: var(--border-strong) transparent;
}
textarea::-webkit-scrollbar { width: 5px; }
textarea::-webkit-scrollbar-track { background: transparent; }
textarea::-webkit-scrollbar-thumb { background: var(--border-strong); border-radius: 3px; }
textarea::-webkit-scrollbar-thumb:hover { background: var(--ink-4); }
table.plans {
  width: 100%;
  border-collapse: collapse;
}
table.plans th {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--ink-3);
  padding: 10px 14px;
  text-align: left;
  border-bottom: 1px solid var(--border-soft);
  background: transparent;
}
table.plans td {
  padding: 14px;
  font-size: 14px;
  border-top: 1px solid var(--border-soft);
}
table.plans tbody tr:hover td { background: var(--row-hover); }
table.plans .col-runtime { text-align: right; font-variant-numeric: tabular-nums; }
.scene-card {
  display: grid;
  grid-template-columns: 56px 1fr 36px;
  gap: 20px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 18px 20px;
  margin-bottom: 12px;
}
.scene-col-left {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding-top: 2px;
}
.scene-num {
  font-size: 24px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--ink);
}
.scene-dur {
  font-size: 12px;
  color: var(--ink-3);
  font-variant-numeric: tabular-nums;
}
.field-label {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--ink-3);
  margin-bottom: 4px;
}
.field-block {
  margin-bottom: 12px;
  cursor: pointer;
}
.field-block:last-child { margin-bottom: 0; }
.field-value { font-size: 14px; color: var(--ink-2); white-space: pre-wrap; }
.field-value.title-value { font-size: 16px; font-weight: 600; color: var(--ink); }
.field-value.script-value {
  background: var(--script-bg);
  border-left: 2px solid var(--ink-4);
  padding: 10px 14px;
  border-radius: 0 6px 6px 0;
  font-size: 14.5px;
  line-height: 1.6;
}
.field-empty { color: var(--ink-4); font-size: 13px; font-style: italic; }
.scene-project-ref {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px dashed var(--border-strong);
  font-size: 12px;
  color: var(--ink-3);
}
.scene-project-ref code {
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  background: var(--surface-raised);
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 11px;
}
.btn-delete-scene {
  width: 30px;
  height: 30px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 6px;
  color: var(--danger);
  cursor: pointer;
  font-size: 14px;
  font-family: inherit;
  padding: 0;
  flex-shrink: 0;
  align-self: flex-start;
}
.btn-delete-scene:hover { background: var(--danger-bg); border-color: var(--danger-bg); }
.btn-add-scene {
  padding: 10px 14px;
  border: 1px dashed var(--border-strong);
  border-radius: 8px;
  background: var(--surface);
  color: var(--ink-3);
  cursor: pointer;
  font: 14px inherit;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
}
.btn-add-scene:hover { background: var(--bg); color: var(--ink-2); border-color: var(--border); }
.htmx-indicator { display: none; }
.htmx-request.htmx-indicator { display: inline; }
button.btn.htmx-request { opacity: 0.55; cursor: wait; pointer-events: none; }
button.btn[disabled] { opacity: 0.55; cursor: wait; pointer-events: none; }
@keyframes drek-spin { to { transform: rotate(360deg); } }
.score-spinner { display: none; align-items: center; gap: 8px; margin-left: 16px; font-size: 13px; color: var(--ink-3); vertical-align: middle; }
.score-spinner.htmx-request { display: inline-flex; }
.score-spinner::before { content: ''; flex-shrink: 0; width: 12px; height: 12px; border: 2px solid rgba(122,120,114,0.25); border-top-color: var(--ink-3); border-radius: 50%; animation: drek-spin 0.75s linear infinite; }
.pipeline-indicator {
  display: none;
  align-items: center;
  gap: 10px;
  margin-top: 12px;
  padding: 11px 14px;
  background: var(--amber-bg);
  border: 1px solid rgba(200,144,64,0.35);
  border-radius: 7px;
  color: var(--amber-fg);
  font-size: 13px;
}
.pipeline-indicator.htmx-request { display: flex; }
.pipeline-indicator::before {
  content: '';
  flex-shrink: 0;
  width: 14px; height: 14px;
  border: 2px solid rgba(200,144,64,0.25);
  border-top-color: var(--amber-fg);
  border-radius: 50%;
  animation: drek-spin 0.75s linear infinite;
}
.runtime-bar-wrap {
  margin: 6px 0 12px;
}
.runtime-bar-track {
  height: 8px;
  background: var(--border-strong);
  border-radius: 999px;
  overflow: hidden;
  position: relative;
}
.runtime-bar-fill {
  height: 100%;
  border-radius: 999px;
  transition: width 0.3s ease;
}
.step-chip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 5px;
  font-size: 11px;
  font-weight: 700;
  flex-shrink: 0;
}
.btn .step-chip { background: rgba(0,0,0,0.15); color: var(--bg); }
.btn.secondary .step-chip { background: var(--border-strong); color: var(--ink); }
.btn.secondary .step-chip.done { background: var(--green-fg); color: #fff; }
.feature-chip {
  display: inline-block;
  background: var(--surface-raised);
  padding: 3px 8px;
  border-radius: 5px;
  font-size: 12px;
  color: var(--ink-2);
}
.modal-overlay {
  display: none;
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.55);
  z-index: 200;
  align-items: center;
  justify-content: center;
}
.modal-overlay.open { display: flex; }
.modal-card {
  background: var(--surface-raised);
  border: 1px solid var(--border-strong);
  border-radius: 12px;
  padding: 28px 24px 20px;
  max-width: 420px;
  width: 90%;
  box-shadow: 0 8px 40px rgba(0,0,0,0.5);
}
.modal-msg {
  font-size: 15px;
  color: var(--ink);
  margin-bottom: 20px;
  line-height: 1.5;
}
.modal-actions { display: flex; gap: 10px; justify-content: flex-end; }
.tag {
  display: inline-block;
  padding: 2px 7px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}
.tag.must { background: var(--danger-bg); color: var(--danger); }
.tag.nice { background: var(--grey-bg); color: var(--grey-fg); }
`;

const HTMX_CDN = 'https://unpkg.com/htmx.org@2.0.4';

const CONFIRM_SCRIPT = `
(function () {
  function getModal() { return document.getElementById('confirm-modal'); }
  function getMsgEl() { return document.getElementById('confirm-modal-msg'); }
  function getOkBtn() { return document.getElementById('confirm-ok'); }
  function getCancelBtn() { return document.getElementById('confirm-cancel'); }
  function close() {
    var m = getModal();
    if (m) m.classList.remove('open');
  }
  document.addEventListener('DOMContentLoaded', function () {
    var cancelBtn = getCancelBtn();
    var modal = getModal();
    if (cancelBtn) cancelBtn.addEventListener('click', close);
    if (modal) modal.addEventListener('click', function (e) { if (e.target === modal) close(); });
  });
  document.addEventListener('htmx:confirm', function (evt) {
    if (!evt.detail.question) return;
    evt.preventDefault();
    var msgEl = getMsgEl();
    var modal = getModal();
    var okBtn = getOkBtn();
    if (!msgEl || !modal || !okBtn) return;
    msgEl.textContent = evt.detail.question;
    modal.classList.add('open');
    okBtn.onclick = function () { close(); evt.detail.issueRequest(true); };
  });
})();
`;

export const Layout: FC<LayoutProps> = ({ title, children, flash }) => {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=1280" />
        <title>{title} — DREK</title>
        <link rel="icon" type="image/jpeg" href="data:image/jpeg;base64,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" />
        <style dangerouslySetInnerHTML={{ __html: STYLES }} />
        <script src={HTMX_CDN}></script>
      </head>
      <body>
        <header class="app">
          <div class="header-inner">
            <a href="/" class="brand">DREK</a>
            <nav>
              <a href="/">Dashboard</a>
              <a href="/intake">Intake</a>
              <a href="/listings">Available listings</a>
              <a href="/settings">Settings</a>
            </nav>
          </div>
        </header>
        <main>
          {flash ? (
            <div class={`flash ${flash.type}`}>{flash.message}</div>
          ) : null}
          {children}
        </main>
        <div id="confirm-modal" class="modal-overlay" role="dialog" aria-modal="true">
          <div class="modal-card">
            <p id="confirm-modal-msg" class="modal-msg"></p>
            <div class="modal-actions">
              <button id="confirm-cancel" class="btn secondary">Cancel</button>
              <button id="confirm-ok" class="btn">Confirm</button>
            </div>
          </div>
        </div>
        <script dangerouslySetInnerHTML={{ __html: CONFIRM_SCRIPT }} />
      </body>
    </html>
  );
};

export function renderPage(props: LayoutProps): string {
  // hono/jsx returns a string when stringified, so we can wrap directly.
  // We embed in a full HTML doctype.
  // The returned JSX is already a tree; hono renders it on c.html() — but
  // for the route handler ergonomics we also expose this helper.
  // (Actually unused for now; routes call c.html(<Layout>...) directly.)
  return `<!doctype html>${Layout(props) as unknown as string}`;
}
