import { describe, it, expect } from 'vitest';
import {
  NewCoverLetterPlanPage,
  NewYoutubePlanPage,
} from '../../src/views/new-plan.js';

const toHtml = (node: unknown) => String(node);

describe('NewCoverLetterPlanPage', () => {
  it('renders form fields with default values', () => {
    const html = toHtml(NewCoverLetterPlanPage({}));
    expect(html).toContain('<title>New cover letter plan');
    expect(html).toContain('name="title"');
    expect(html).toContain('name="sourceListingText"');
    expect(html).toContain('name="targetRuntimeSeconds"');
    expect(html).toContain('value="120"'); // default runtime
    expect(html).toContain('name="userConstraints"');
    expect(html).toContain('action="/plans/new/cover-letter"');
    expect(html).toContain('method="post"');
  });

  it('prefills from an available listing when provided', () => {
    const html = toHtml(
      NewCoverLetterPlanPage({
        prefilled: {
          id: 'lst_42',
          title: 'Backend Eng at Acme',
          rawText: 'The full listing text here.',
        },
      }),
    );
    expect(html).toContain('Pre-filled from available listing');
    expect(html).toContain('lst_42');
    expect(html).toContain('Backend Eng at Acme');
    expect(html).toContain('The full listing text here.');
  });

  it('echoes back values on validation error', () => {
    const html = toHtml(
      NewCoverLetterPlanPage({
        values: {
          title: 'Echo title',
          sourceListingText: 'Echo body',
          targetRuntimeSeconds: 240,
          userConstraints: 'no music',
        },
        error: 'listing text is required',
      }),
    );
    expect(html).toContain('Echo title');
    expect(html).toContain('Echo body');
    expect(html).toContain('value="240"');
    expect(html).toContain('no music');
    expect(html).toContain('flash err');
    expect(html).toContain('listing text is required');
  });

  it('marks sourceListingText as required', () => {
    const html = toHtml(NewCoverLetterPlanPage({}));
    expect(html).toMatch(/<textarea[^>]*name="sourceListingText"[^>]*required/);
  });
});

describe('NewYoutubePlanPage', () => {
  it('renders form with default 600s runtime', () => {
    const html = toHtml(NewYoutubePlanPage({}));
    expect(html).toContain('<title>New YouTube plan');
    expect(html).toContain('value="600"');
    expect(html).toContain('action="/plans/new/youtube"');
  });

  it('does NOT include a sourceListingText field', () => {
    const html = toHtml(NewYoutubePlanPage({}));
    expect(html).not.toContain('name="sourceListingText"');
  });

  it('echoes back values on validation error', () => {
    const html = toHtml(
      NewYoutubePlanPage({
        values: { title: 'How I built X', targetRuntimeSeconds: 480, userConstraints: 'B2B founders' },
        error: 'topic is required',
      }),
    );
    expect(html).toContain('How I built X');
    expect(html).toContain('value="480"');
    expect(html).toContain('B2B founders');
    expect(html).toContain('topic is required');
  });
});
