import type { FC } from 'hono/jsx';
import { Layout } from './layout.js';

interface PrefilledListing {
  id?: string;
  title: string;
  rawText: string | null;
}

export interface NewCoverLetterFormProps {
  prefilled?: PrefilledListing | null;
  /** Echo back form input on validation error so Rick doesn't lose his typing. */
  values?: {
    title?: string;
    sourceListingText?: string;
    targetRuntimeSeconds?: number;
    userConstraints?: string;
  };
  error?: string | null;
}

export const NewCoverLetterPlanPage: FC<NewCoverLetterFormProps> = ({
  prefilled,
  values,
  error,
}) => {
  const v = {
    title: values?.title ?? prefilled?.title ?? '',
    sourceListingText: values?.sourceListingText ?? prefilled?.rawText ?? '',
    targetRuntimeSeconds: values?.targetRuntimeSeconds ?? 120,
    userConstraints: values?.userConstraints ?? '',
  };
  return (
    <Layout title="New cover letter plan" flash={error ? { type: 'err', message: error } : null}>
      <h2>New cover letter plan</h2>
      <p class="muted" style="margin-top:6px; margin-bottom:20px;">
        Paste the job listing. DREK will extract video requirements, match
        your projects, and generate scenes + scripts in Rick's voice.
      </p>
      {prefilled ? (
        <div class="flash ok">
          Pre-filled from {prefilled.id ? <>listing <strong>{prefilled.id}</strong></> : 'Prospect Intelligence'}.
        </div>
      ) : null}
      <form method="post" action="/plans/new/cover-letter" class="card">
        <label style="display:block; margin-bottom:14px;">
          <div class="field-label" style="margin-bottom:6px;">Plan title</div>
          <input
            type="text"
            name="title"
            value={v.title}
            required
            placeholder="e.g. Senior Backend Eng at Acme"
            style="width:100%;"
          />
          <div class="muted" style="font-size:12px; margin-top:4px;">
            Shown in the dashboard. Usually <em>role at company</em>.
          </div>
        </label>

        <label style="display:block; margin-bottom:14px;">
          <div class="field-label" style="margin-bottom:6px;">Listing text *</div>
          <textarea
            name="sourceListingText"
            rows={12}
            required
            placeholder="Paste the full job listing here — DREK uses this to extract video demonstration requirements."
          >{v.sourceListingText}</textarea>
        </label>

        <label style="display:block; margin-bottom:14px;">
          <div class="field-label" style="margin-bottom:6px;">Target runtime (seconds)</div>
          <input
            type="number"
            name="targetRuntimeSeconds"
            value={v.targetRuntimeSeconds}
            min={30}
            max={3600}
            required
          />
          <div class="muted" style="font-size:12px; margin-top:4px;">
            Default 120s (2 min). DREK calibrates scene count and script density.
          </div>
        </label>

        <label style="display:block; margin-bottom:14px;">
          <div class="field-label" style="margin-bottom:6px;">Your constraints (optional)</div>
          <textarea
            name="userConstraints"
            rows={3}
            placeholder="e.g. headless only, no GUI demos; mention pricing at the end; keep it under 90 seconds"
          >{v.userConstraints}</textarea>
          <div class="muted" style="font-size:12px; margin-top:4px;">
            Free text. Passed to the LLM alongside the listing.
          </div>
        </label>

        <div class="row" style="gap:8px;">
          <button class="btn" type="submit">Create plan</button>
          <a class="btn secondary" href="/">Cancel</a>
        </div>
      </form>
    </Layout>
  );
};

export interface NewYoutubeFormProps {
  values?: {
    title?: string;
    targetRuntimeSeconds?: number;
    userConstraints?: string;
  };
  error?: string | null;
}

export const NewYoutubePlanPage: FC<NewYoutubeFormProps> = ({ values, error }) => {
  const v = {
    title: values?.title ?? '',
    targetRuntimeSeconds: values?.targetRuntimeSeconds ?? 600,
    userConstraints: values?.userConstraints ?? '',
  };
  return (
    <Layout title="New YouTube plan" flash={error ? { type: 'err', message: error } : null}>
      <h2>New YouTube plan</h2>
      <p class="muted" style="margin-top:6px; margin-bottom:20px;">
        Enter the topic. DREK targets potential clients — videos are framed
        around business outcomes, not technology. Practitioners get pulled
        in by the technical credibility, not the framing.
      </p>
      <form method="post" action="/plans/new/youtube" class="card">
        <label style="display:block; margin-bottom:14px;">
          <div class="field-label" style="margin-bottom:6px;">Topic / title *</div>
          <input
            type="text"
            name="title"
            value={v.title}
            required
            placeholder="e.g. How I built a lead pipeline that auto-routes inbound leads"
            style="width:100%;"
          />
        </label>

        <label style="display:block; margin-bottom:14px;">
          <div class="field-label" style="margin-bottom:6px;">Target runtime (seconds)</div>
          <input
            type="number"
            name="targetRuntimeSeconds"
            value={v.targetRuntimeSeconds}
            min={30}
            max={3600}
            required
          />
          <div class="muted" style="font-size:12px; margin-top:4px;">
            Default 600s (10 min). 8-15 minutes is the typical YouTube range.
          </div>
        </label>

        <label style="display:block; margin-bottom:14px;">
          <div class="field-label" style="margin-bottom:6px;">Angle / constraints (optional)</div>
          <textarea
            name="userConstraints"
            rows={4}
            placeholder="e.g. focus on B2B founders; lead with cost savings; don't talk about tech stack until 2 minutes in"
          >{v.userConstraints}</textarea>
          <div class="muted" style="font-size:12px; margin-top:4px;">
            Free text. Tells DREK how to frame the topic.
          </div>
        </label>

        <div class="row" style="gap:8px;">
          <button class="btn" type="submit">Create plan</button>
          <a class="btn secondary" href="/">Cancel</a>
        </div>
      </form>
    </Layout>
  );
};
