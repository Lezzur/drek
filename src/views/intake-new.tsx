import type { FC } from 'hono/jsx';
import { Layout, type LayoutProps } from './layout.js';

export interface NewBriefFormProps {
  /** Echo back form values on validation error. */
  values?: {
    title?: string;
    sourceUrl?: string;
    company?: string;
    rawText?: string;
  };
  error?: string | null;
  flash?: LayoutProps['flash'];
}

export const NewBriefForm: FC<NewBriefFormProps> = ({ values, error, flash }) => {
  const v = {
    title: values?.title ?? '',
    sourceUrl: values?.sourceUrl ?? '',
    company: values?.company ?? '',
    rawText: values?.rawText ?? '',
  };

  const charCountScript = `
(function () {
  var ta = document.getElementById('rawText');
  var counter = document.getElementById('rawTextCounter');
  if (!ta || !counter) return;
  var MAX = 50000;
  function update() {
    var n = ta.value.length;
    counter.textContent = n.toLocaleString() + ' / ' + MAX.toLocaleString();
    if (n >= MAX * 0.95) {
      counter.style.color = 'var(--danger)';
    } else if (n >= MAX * 0.80) {
      counter.style.color = 'var(--amber-fg)';
    } else {
      counter.style.color = 'var(--ink-3)';
    }
  }
  ta.addEventListener('input', update);
  update();
})();
`;

  return (
    <Layout
      title="Add brief"
      flash={error ? { type: 'err', message: error } : (flash ?? null)}
    >
      <h1>Add brief</h1>
      <p class="muted" style="margin-top:-8px; margin-bottom:20px;">
        Paste a job brief from Upwork, Freelancer, or any source. DREK will
        score it for YouTube production potential.
      </p>
      <form method="post" action="/intake" class="card">
        <label style="display:block; margin-bottom:14px;">
          <div class="field-label" style="margin-bottom:6px;">Title *</div>
          <input
            type="text"
            name="title"
            value={v.title}
            required
            maxlength={200}
            placeholder="e.g. Build a lead-routing automation (Upwork)"
            style="width:100%;"
          />
          <div class="muted" style="font-size:12px; margin-top:4px;">
            Short label shown in the pipeline. Max 200 characters.
          </div>
        </label>

        <label style="display:block; margin-bottom:14px;">
          <div class="field-label" style="margin-bottom:6px;">Source URL (optional)</div>
          <input
            type="url"
            name="sourceUrl"
            value={v.sourceUrl}
            placeholder="https://www.upwork.com/jobs/..."
            style="width:100%;"
          />
        </label>

        <label style="display:block; margin-bottom:14px;">
          <div class="field-label" style="margin-bottom:6px;">Company (optional)</div>
          <input
            type="text"
            name="company"
            value={v.company}
            placeholder="e.g. Acme Corp"
            style="width:100%;"
          />
        </label>

        <label style="display:block; margin-bottom:14px;">
          <div class="field-label" style="margin-bottom:6px;">Brief text *</div>
          <textarea
            id="rawText"
            name="rawText"
            rows={14}
            required
            maxlength={50000}
            placeholder="Paste the full job brief here. DREK uses this to score it for YouTube production potential."
          >{v.rawText}</textarea>
          <div class="row" style="margin-top:4px;">
            <span id="rawTextCounter" class="muted" style="font-size:12px;">0 / 50,000</span>
          </div>
        </label>

        <div class="row" style="gap:8px;">
          <button class="btn" type="submit">Add brief</button>
          <a class="btn secondary" href="/intake">Cancel</a>
        </div>
      </form>
      <script dangerouslySetInnerHTML={{ __html: charCountScript }} />
    </Layout>
  );
};
