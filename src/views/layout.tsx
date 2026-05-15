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
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  font-size: 16px;
  line-height: 1.5;
  color: #1a1a1a;
  background: #fafafa;
}
a { color: #1a5fb4; text-decoration: none; }
a:hover { text-decoration: underline; }
header.app {
  background: #1a1a1a;
  color: #fafafa;
  padding: 12px 24px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
header.app h1 {
  font-size: 18px;
  font-weight: 600;
  margin: 0;
}
header.app nav a {
  color: #fafafa;
  margin-right: 16px;
  font-size: 14px;
}
main {
  max-width: 1200px;
  margin: 0 auto;
  padding: 24px;
}
h2 { margin-top: 0; }
.btn {
  display: inline-block;
  padding: 8px 14px;
  background: #1a1a1a;
  color: #fafafa;
  border: 1px solid #1a1a1a;
  border-radius: 4px;
  font-size: 14px;
  cursor: pointer;
  text-decoration: none;
}
.btn:hover { background: #333; text-decoration: none; }
.btn.secondary { background: #fafafa; color: #1a1a1a; }
.btn.secondary:hover { background: #eaeaea; }
.btn.danger { background: #b80000; border-color: #b80000; }
.btn.small { padding: 4px 10px; font-size: 13px; }
.btn.linkish { background: transparent; color: #1a5fb4; border: none; padding: 4px 8px; }
.btn.linkish:hover { background: #eef4fb; text-decoration: underline; }
button.btn { font-family: inherit; }
.row { display: flex; gap: 8px; align-items: center; }
.spacer { flex: 1; }
.muted { color: #666; font-size: 14px; }
.flash {
  padding: 10px 14px;
  border-radius: 4px;
  margin-bottom: 16px;
  font-size: 14px;
}
.flash.ok { background: #e6f5ea; border: 1px solid #71c490; color: #1c5b30; }
.flash.warn { background: #fff5dc; border: 1px solid #d4b75b; color: #6a4c00; }
.flash.err { background: #fde8e8; border: 1px solid #d36b6b; color: #6a1a1a; }
.card {
  background: #fff;
  border: 1px solid #e0e0e0;
  border-radius: 6px;
  padding: 16px;
  margin-bottom: 12px;
}
.badge {
  display: inline-block;
  padding: 2px 8px;
  background: #eee;
  color: #444;
  border-radius: 10px;
  font-size: 12px;
  font-weight: 500;
}
.badge.awaiting_review { background: #fff5dc; color: #6a4c00; }
.badge.requirements_reviewed,
.badge.projects_matched,
.badge.scenes_generated { background: #e3eefb; color: #1a3f6a; }
.badge.finalized,
.badge.exported { background: #e6f5ea; color: #1c5b30; }
.badge.dismissed { background: #f4f4f4; color: #777; }
table.plans {
  width: 100%;
  border-collapse: collapse;
}
table.plans th, table.plans td {
  text-align: left;
  padding: 10px 12px;
  border-bottom: 1px solid #eee;
  font-size: 14px;
}
table.plans th { background: #f4f4f4; font-weight: 600; }
table.plans tr:hover td { background: #f8f8f8; }
form.inline { display: inline-block; margin: 0; }
input.runtime, input[type="number"] {
  width: 80px;
  padding: 4px 8px;
  font-size: 14px;
}
textarea {
  width: 100%;
  font-family: inherit;
  font-size: 14px;
  padding: 8px;
  border: 1px solid #ccc;
  border-radius: 4px;
  resize: vertical;
}
.empty {
  text-align: center;
  padding: 48px 16px;
  color: #777;
  font-size: 15px;
  background: #fff;
  border: 1px dashed #ccc;
  border-radius: 6px;
}
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
          <h1>DREK · AI Video Director</h1>
          <nav>
            <a href="/">Dashboard</a>
            <a href="/listings">Available listings</a>
          </nav>
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
