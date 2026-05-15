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
  --bg: #fafaf7;
  --surface: #ffffff;
  --border: #e8e6e0;
  --border-soft: #eee9e0;
  --border-strong: #d4d2cc;
  --ink: #1a1a1a;
  --ink-2: #3a3a3a;
  --ink-3: #6b6b6b;
  --ink-4: #9a9a9a;
  --link: #1a5fb4;
  --script-bg: #fbf9f3;
  --danger: #b80000;
  --danger-bg: #fdebeb;
  --blue-bg: #e8f0fb;
  --blue-fg: #1a5fb4;
  --amber-bg: #fdf2dd;
  --amber-fg: #7a4d00;
  --green-bg: #e3f4ea;
  --green-fg: #1a6b3a;
  --grey-bg: #ececea;
  --grey-fg: #5a5a5a;
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
  background: var(--ink);
  color: var(--bg);
  padding: 14px 32px;
  display: flex;
  align-items: center;
  gap: 28px;
}
header.app .brand {
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 0.02em;
  color: var(--bg);
  text-decoration: none;
}
header.app nav { display: flex; gap: 20px; margin-left: auto; }
header.app nav a {
  color: var(--bg);
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
}
.btn:hover { background: #333; border-color: #333; text-decoration: none; color: var(--bg); }
.btn.secondary { background: #fff; color: var(--ink); border-color: var(--border-strong); }
.btn.secondary:hover { background: #f4f2ec; text-decoration: none; color: var(--ink); }
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
.flash.ok { background: var(--green-bg); border: 1px solid #c8e8d5; color: var(--green-fg); }
.flash.warn { background: var(--amber-bg); border: 1px solid #e8d4a0; color: var(--amber-fg); }
.flash.err { background: var(--danger-bg); border: 1px solid #f0b8b8; color: var(--danger); }
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
form.inline { display: inline-block; margin: 0; }
input[type="text"], input[type="number"], select {
  padding: 9px 12px;
  border: 1px solid var(--border-strong);
  border-radius: 7px;
  font: inherit;
  font-size: 14px;
  background: #fff;
  color: var(--ink);
}
input[type="text"]:focus, input[type="number"]:focus, select:focus, textarea:focus {
  border-color: var(--link);
  outline: none;
  box-shadow: 0 0 0 3px rgba(26,95,180,0.12);
}
textarea {
  width: 100%;
  font-family: inherit;
  font-size: 14px;
  padding: 9px 12px;
  border: 1px solid var(--border-strong);
  border-radius: 7px;
  resize: vertical;
  background: #fff;
  color: var(--ink);
  line-height: 1.5;
}
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
table.plans tbody tr:hover td { background: #f7f5ee; }
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
  border-left: 3px solid var(--link);
  padding: 10px 12px;
  border-radius: 0 6px 6px 0;
  font-size: 14.5px;
  line-height: 1.6;
}
.field-empty { color: var(--ink-4); font-size: 13px; font-style: italic; }
.scene-project-ref {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px dashed #ece8de;
  font-size: 12px;
  color: var(--ink-3);
}
.scene-project-ref code {
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  background: #f4f2ec;
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
  background: #fff;
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
.htmx-request .htmx-indicator { display: inline; }
.runtime-bar-wrap {
  margin: 6px 0 12px;
}
.runtime-bar-track {
  height: 8px;
  background: #ececea;
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
.btn .step-chip { background: rgba(255,255,255,0.18); color: #fff; }
.btn.secondary .step-chip { background: var(--ink); color: #fff; }
.btn.secondary .step-chip.done { background: var(--green-fg); color: #fff; }
.feature-chip {
  display: inline-block;
  background: #f4f2ec;
  padding: 3px 8px;
  border-radius: 5px;
  font-size: 12px;
  color: var(--ink-2);
}
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

export const Layout: FC<LayoutProps> = ({ title, children, flash }) => {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=1280" />
        <title>{title} — DREK</title>
        <style dangerouslySetInnerHTML={{ __html: STYLES }} />
        <script src={HTMX_CDN}></script>
      </head>
      <body>
        <header class="app">
          <div class="header-inner">
            <a href="/" class="brand">DREK</a>
            <nav>
              <a href="/">Dashboard</a>
              <a href="/listings">Available listings</a>
            </nav>
          </div>
        </header>
        <main>
          {flash ? (
            <div class={`flash ${flash.type}`}>{flash.message}</div>
          ) : null}
          {children}
        </main>
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
