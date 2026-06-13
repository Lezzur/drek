/**
 * Base HTML layout for every DREK page. Server-rendered Hono JSX +
 * HTMX 2.x for interactivity. Desktop Chrome only (PRD §9.4 / D-16) so
 * no responsive concerns, no mobile media queries.
 *
 * Style strategy: "studio console" theme — deep blue-graphite base with
 * an amber record-light accent. Space Grotesk for display type, Inter
 * for body, JetBrains Mono for numerals/code. All theme values flow
 * through the CSS variables below; per-view inline styles reference the
 * same variables, so the palette is the single source of truth.
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
  --bg: #0b0d11;
  --bg-subtle: #10131a;
  --surface: #131720;
  --surface-raised: #1b2029;
  --input-bg: #0e1117;
  --row-hover: #171c26;
  --header-bg: rgba(10, 12, 16, 0.82);
  --header-color: #ccd3de;
  --border: #232a37;
  --border-soft: #1b212c;
  --border-strong: #313a4b;
  --ink: #ccd3de;
  --ink-1: #ccd3de;
  --ink-2: #b4bcc9;
  --ink-3: #7b8494;
  --ink-4: #4b5260;
  --accent: #ffb224;
  --link: #82aaf5;
  --script-bg: #11151d;
  --danger: #ef6a61;
  --danger-bg: #2b1614;
  --blue-bg: #16233a;
  --blue-fg: #82aaf5;
  --amber-bg: #2b2008;
  --amber-fg: #e7a93b;
  --green-bg: #11261a;
  --green-fg: #57c47c;
  --grey-bg: #1b202a;
  --grey-fg: #7b8494;
  --btn-primary-hover: #ffc14d;
  --btn-secondary-hover: #1c222d;
  --flash-ok-border: #234d33;
  --flash-warn-border: #4d3a12;
  --flash-err-border: #4d1d1a;
  --font-display: 'Space Grotesk', 'Inter', system-ui, sans-serif;
  --font-mono: 'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { height: 100%; }
body {
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  font-size: 15px;
  line-height: 1.55;
  color: var(--ink);
  background:
    radial-gradient(1100px 420px at 50% -180px, rgba(255, 178, 36, 0.055), transparent 70%),
    var(--bg);
  background-attachment: fixed;
}
::selection { background: rgba(255, 178, 36, 0.28); }
* { scrollbar-width: thin; scrollbar-color: var(--border-strong) transparent; }
::-webkit-scrollbar { width: 9px; height: 9px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--border-strong); border-radius: 6px; }
::-webkit-scrollbar-thumb:hover { background: var(--ink-4); }
a { color: var(--link); text-decoration: none; }
a:hover { text-decoration: underline; }
code { font-family: var(--font-mono); }
header.app {
  position: sticky;
  top: 0;
  z-index: 100;
  background: var(--header-bg);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  color: var(--header-color);
  padding: 0 32px;
  border-bottom: 1px solid var(--border-soft);
}
header.app .brand {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  font-family: var(--font-display);
  font-size: 16px;
  font-weight: 700;
  letter-spacing: 0.14em;
  color: var(--header-color);
  text-decoration: none;
}
header.app .brand:hover { text-decoration: none; }
.brand-mark {
  width: 11px;
  height: 11px;
  border-radius: 3px;
  background: var(--accent);
  box-shadow: 0 0 10px rgba(255, 178, 36, 0.55);
  flex-shrink: 0;
}
header.app nav { display: flex; gap: 4px; margin-left: auto; }
header.app nav a {
  color: var(--ink-3);
  font-size: 13.5px;
  font-weight: 500;
  padding: 6px 12px;
  border-radius: 7px;
  text-decoration: none;
  transition: color 0.12s ease, background 0.12s ease;
}
header.app nav a:hover { color: var(--ink); background: var(--surface-raised); text-decoration: none; }
header.app nav a.active {
  color: var(--accent);
  background: rgba(255, 178, 36, 0.09);
}
.header-inner {
  max-width: 1200px;
  width: 100%;
  margin: 0 auto;
  padding: 13px 40px;
  display: flex;
  align-items: center;
  gap: 28px;
}
main {
  max-width: 1200px;
  margin: 0 auto;
  padding: 34px 40px 64px;
}
h1 {
  font-family: var(--font-display);
  font-size: 28px;
  font-weight: 700;
  letter-spacing: -0.015em;
  margin-bottom: 4px;
}
h2 {
  font-family: var(--font-display);
  font-size: 18px;
  font-weight: 600;
  letter-spacing: -0.005em;
  margin-bottom: 12px;
}
h3.section-label {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--ink-3);
  margin-bottom: 10px;
}
.card {
  background: linear-gradient(180deg, #161b25 0%, var(--surface) 100%);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 20px;
  margin-bottom: 16px;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.035), 0 2px 10px rgba(0, 0, 0, 0.35);
}
.btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 10px 15px;
  background: var(--accent);
  color: #181307;
  border: 1px solid transparent;
  border-radius: 8px;
  font: 600 14px/1 inherit;
  cursor: pointer;
  text-decoration: none;
  white-space: nowrap;
  flex-shrink: 0;
  transition: background 0.12s ease, transform 0.08s ease, box-shadow 0.12s ease;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.4);
}
.btn:hover {
  background: var(--btn-primary-hover);
  border-color: transparent;
  text-decoration: none;
  color: #181307;
  box-shadow: 0 2px 8px rgba(255, 178, 36, 0.22);
}
.btn:active { transform: translateY(1px); }
.btn.secondary {
  background: var(--surface-raised);
  color: var(--ink);
  border-color: var(--border-strong);
  font-weight: 500;
  box-shadow: none;
}
.btn.secondary:hover { background: var(--btn-secondary-hover); border-color: var(--ink-4); text-decoration: none; color: var(--ink); box-shadow: none; }
.btn.accent { background: #3f6cc7; border-color: transparent; color: #fff; }
.btn.accent:hover { background: #5381d8; border-color: transparent; color: #fff; box-shadow: 0 2px 8px rgba(63, 108, 199, 0.3); }
.btn.danger { background: var(--danger); border-color: transparent; color: #fff; }
.btn.danger:hover { background: #d8504a; box-shadow: 0 2px 8px rgba(239, 106, 97, 0.25); }
.btn.small { padding: 6px 10px; font-size: 13px; border-radius: 6px; }
/* Square 32x32 reorder buttons — comfortable tap target with a legible glyph,
   replacing the cramped single-arrow .btn.small on the scene list. */
.btn.scene-move { padding: 0; width: 32px; height: 32px; font-size: 15px; line-height: 1; display: inline-flex; align-items: center; justify-content: center; }
.btn.linkish { background: transparent; border-color: transparent; color: var(--link); padding: 6px 8px; font-weight: 500; box-shadow: none; }
.btn.linkish:hover { background: var(--blue-bg); color: var(--link); text-decoration: none; box-shadow: none; }
button.btn { font-family: inherit; }
.btn[disabled], button[disabled] { opacity: 0.45; cursor: not-allowed; pointer-events: none; }
.badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 11px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 500;
  border: 1px solid color-mix(in srgb, currentColor 22%, transparent);
}
.badge::before {
  content: '';
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  box-shadow: 0 0 5px currentColor;
  flex-shrink: 0;
}
.badge.awaiting_review { background: var(--amber-bg); color: var(--amber-fg); }
.badge.requirements_reviewed,
.badge.projects_matched,
.badge.scenes_generated { background: var(--blue-bg); color: var(--blue-fg); }
.badge.finalized,
.badge.exported { background: var(--green-bg); color: var(--green-fg); }
.badge.dismissed { background: var(--grey-bg); color: var(--grey-fg); }
.badge.pipeline-queued { background: var(--grey-bg); color: var(--ink-2); }
.badge.pipeline-running { background: var(--blue-bg); color: var(--blue-fg); }
.badge.pipeline-running::before { animation: drek-pulse 1.2s ease-in-out infinite; }
.badge.pipeline-failed { background: var(--danger-bg); color: var(--danger); }
@keyframes drek-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
.flash {
  padding: 12px 16px;
  border-radius: 9px;
  margin-bottom: 16px;
  font-size: 14px;
}
.flash.ok { background: var(--green-bg); border: 1px solid var(--flash-ok-border); color: var(--green-fg); }
.flash.warn { background: var(--amber-bg); border: 1px solid var(--flash-warn-border); color: var(--amber-fg); }
.flash.err { background: var(--danger-bg); border: 1px solid var(--flash-err-border); color: var(--danger); }
.row { display: flex; gap: 8px; align-items: center; }
.spacer { flex: 1; }
.muted { color: var(--ink-3); font-size: 14px; }
.back-link { display: inline-block; font-size: 14px; color: var(--ink-3); text-decoration: none; }
.back-link:hover { color: var(--ink-2); text-decoration: none; }
.empty {
  text-align: center;
  padding: 32px 16px;
  color: var(--ink-3);
  font-size: 14px;
  background: var(--surface);
  border: 1px dashed var(--border-strong);
  border-radius: 12px;
}
.empty.lg { padding: 48px 24px; }
form.inline { display: block; width: 100%; margin: 0; }
input[type="text"], input[type="number"], input[type="url"], select {
  padding: 9px 12px;
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  font: inherit;
  font-size: 14px;
  background: var(--input-bg);
  color: var(--ink);
  transition: border-color 0.12s ease, box-shadow 0.12s ease;
}
input:-webkit-autofill, input:-webkit-autofill:focus {
  -webkit-box-shadow: 0 0 0px 1000px var(--input-bg) inset;
  -webkit-text-fill-color: var(--ink);
}
input[type="number"]::-webkit-inner-spin-button, input[type="number"]::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
input[type="number"] { -moz-appearance: textfield; }
input[type="text"]:focus, input[type="number"]:focus, input[type="url"]:focus, select:focus, textarea:focus {
  border-color: var(--accent);
  outline: none;
  box-shadow: 0 0 0 3px rgba(255, 178, 36, 0.14);
}
textarea {
  width: 100%;
  font-family: inherit;
  font-size: 14px;
  padding: 10px 14px;
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  resize: vertical;
  background: var(--input-bg);
  color: var(--ink);
  line-height: 1.6;
  min-height: 80px;
  transition: border-color 0.12s ease, box-shadow 0.12s ease;
  scrollbar-width: thin;
  scrollbar-color: var(--border-strong) transparent;
}
textarea::-webkit-scrollbar { width: 5px; }
textarea::-webkit-scrollbar-track { background: transparent; }
textarea::-webkit-scrollbar-thumb { background: var(--border-strong); border-radius: 3px; }
textarea::-webkit-scrollbar-thumb:hover { background: var(--ink-4); }
input[type="checkbox"] {
  appearance: none;
  -webkit-appearance: none;
  width: 18px;
  height: 18px;
  margin: 0;
  border: 1.5px solid var(--border-strong);
  border-radius: 4px;
  background: transparent;
  cursor: pointer;
  display: inline-grid;
  place-content: center;
  transition: border-color 0.12s ease, background 0.12s ease;
  flex-shrink: 0;
}
input[type="checkbox"]:hover { border-color: var(--ink-4); }
input[type="checkbox"]:checked {
  background: var(--accent);
  border-color: var(--accent);
}
input[type="checkbox"]:checked::after {
  content: "";
  width: 5px;
  height: 9px;
  margin-top: -1px;
  border: solid var(--surface);
  border-width: 0 2px 2px 0;
  transform: rotate(45deg);
}
input[type="checkbox"]:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
table.plans {
  width: 100%;
  border-collapse: collapse;
}
table.plans th {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--ink-3);
  padding: 10px 14px;
  text-align: left;
  border-bottom: 1px solid var(--border);
  background: transparent;
}
table.plans td {
  padding: 14px;
  font-size: 14px;
  border-top: 1px solid var(--border-soft);
}
table.plans tbody tr { transition: background 0.1s ease; }
table.plans tbody tr:hover td { background: var(--row-hover); }
table.plans .col-runtime { text-align: right; font-family: var(--font-mono); font-size: 13px; font-variant-numeric: tabular-nums; }
.scene-card {
  display: grid;
  grid-template-columns: 56px 1fr 36px;
  gap: 20px;
  background: linear-gradient(180deg, #161b25 0%, var(--surface) 100%);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 18px 20px;
  margin-bottom: 12px;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.035), 0 2px 10px rgba(0, 0, 0, 0.35);
}
.scene-col-left {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding-top: 2px;
}
.scene-num {
  font-family: var(--font-mono);
  font-size: 22px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: var(--accent);
}
.scene-dur {
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--ink-3);
  font-variant-numeric: tabular-nums;
}
.field-label {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.1em;
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
  border-left: 2px solid var(--accent);
  padding: 10px 14px;
  border-radius: 0 8px 8px 0;
  font-size: 14.5px;
  line-height: 1.65;
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
  font-family: var(--font-mono);
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
  transition: color 0.12s ease, border-color 0.12s ease;
}
.btn-add-scene:hover { background: var(--bg-subtle); color: var(--ink-2); border-color: var(--ink-4); }
.htmx-indicator { display: none; }
.htmx-request.htmx-indicator { display: inline; }
button.btn.htmx-request { opacity: 0.55; cursor: wait; pointer-events: none; }
button.btn[disabled] { opacity: 0.55; cursor: wait; pointer-events: none; }
@keyframes drek-spin { to { transform: rotate(360deg); } }
.score-spinner { display: none; align-items: center; gap: 8px; margin-left: 16px; font-size: 13px; color: var(--ink-3); vertical-align: middle; }
.score-spinner.htmx-request { display: inline-flex; }
.score-spinner::before { content: ''; flex-shrink: 0; width: 12px; height: 12px; border: 2px solid rgba(123, 132, 148, 0.25); border-top-color: var(--ink-3); border-radius: 50%; animation: drek-spin 0.75s linear infinite; }
.pipeline-indicator {
  display: none;
  align-items: center;
  gap: 10px;
  margin-top: 12px;
  padding: 11px 14px;
  background: var(--amber-bg);
  border: 1px solid rgba(231, 169, 59, 0.35);
  border-radius: 8px;
  color: var(--amber-fg);
  font-size: 13px;
}
.pipeline-indicator.htmx-request { display: flex; }
.pipeline-indicator::before {
  content: '';
  flex-shrink: 0;
  width: 14px; height: 14px;
  border: 2px solid rgba(231, 169, 59, 0.25);
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
.btn .step-chip { background: rgba(0, 0, 0, 0.16); color: #181307; }
.btn.secondary .step-chip { background: var(--border-strong); color: var(--ink); }
.btn.secondary .step-chip.done { background: var(--green-fg); color: #0d2014; }
.feature-chip {
  display: inline-block;
  background: var(--surface-raised);
  border: 1px solid var(--border);
  padding: 3px 8px;
  border-radius: 5px;
  font-size: 12px;
  color: var(--ink-2);
}
.modal-overlay {
  display: none;
  position: fixed;
  inset: 0;
  background: rgba(5, 6, 9, 0.6);
  backdrop-filter: blur(3px);
  -webkit-backdrop-filter: blur(3px);
  z-index: 200;
  align-items: center;
  justify-content: center;
}
.modal-overlay.open { display: flex; }
.modal-card {
  background: var(--surface-raised);
  border: 1px solid var(--border-strong);
  border-radius: 14px;
  padding: 28px 24px 20px;
  max-width: 420px;
  width: 90%;
  box-shadow: 0 12px 48px rgba(0, 0, 0, 0.6);
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

const FONTS_CSS =
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Space+Grotesk:wght@500;600;700&family=JetBrains+Mono:wght@400;600;700&display=swap';

/** Amber play-button mark on a dark rounded tile. */
const FAVICON_SVG =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#0b0d11"/><path d="M12 9.5 23 16l-11 6.5z" fill="#ffb224"/></svg>',
  );

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
  // Reusable styled confirm. Shows the modal with \`message\`; runs onConfirm()
  // only if the user clicks Confirm. Both the htmx:confirm handler and custom
  // scripts (e.g. the intake bulk actions) go through this so every
  // confirmation looks the same. Falls back to native confirm() if the modal
  // markup is somehow absent.
  function drekConfirm(message, onConfirm) {
    var msgEl = getMsgEl();
    var modal = getModal();
    var okBtn = getOkBtn();
    if (!msgEl || !modal || !okBtn) {
      if (window.confirm(message) && onConfirm) onConfirm();
      return;
    }
    msgEl.textContent = message;
    modal.classList.add('open');
    okBtn.onclick = function () { close(); if (onConfirm) onConfirm(); };
  }
  window.drekConfirm = drekConfirm;
  document.addEventListener('DOMContentLoaded', function () {
    var cancelBtn = getCancelBtn();
    var modal = getModal();
    if (cancelBtn) cancelBtn.addEventListener('click', close);
    if (modal) modal.addEventListener('click', function (e) { if (e.target === modal) close(); });
    // Highlight the nav link for the current section.
    document.querySelectorAll('header.app nav a').forEach(function (a) {
      var href = a.getAttribute('href');
      var here = location.pathname;
      if (href === '/' ? here === '/' : here.indexOf(href) === 0) a.classList.add('active');
    });
  });
  document.addEventListener('htmx:confirm', function (evt) {
    if (!evt.detail.question) return;
    evt.preventDefault();
    drekConfirm(evt.detail.question, function () { evt.detail.issueRequest(true); });
  });
})();
`;

/** Consistent "← Back to X" link. Replaces the per-page hand-styled anchors
 *  that drifted between 13px/14px and ink-3/muted. */
export const BackLink: FC<{ href: string; label: string }> = ({ href, label }) => (
  <a href={href} class="back-link">← {label}</a>
);

export const Layout: FC<LayoutProps> = ({ title, children, flash }) => {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=1280" />
        <title>{title} — DREK</title>
        <link rel="icon" type="image/svg+xml" href={FAVICON_SVG} />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
        <link rel="stylesheet" href={FONTS_CSS} />
        <style dangerouslySetInnerHTML={{ __html: STYLES }} />
        <script src={HTMX_CDN}></script>
      </head>
      <body>
        <header class="app">
          <div class="header-inner">
            <a href="/" class="brand">
              <span class="brand-mark"></span>
              DREK
            </a>
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
