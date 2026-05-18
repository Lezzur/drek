import { describe, it, expect } from 'vitest';
import { NewBriefForm } from '../../src/views/intake-new.js';

const toHtml = (node: unknown) => String(node);

describe('NewBriefForm', () => {
  it('renders all form fields', () => {
    const html = toHtml(NewBriefForm({}));
    expect(html).toContain('name="title"');
    expect(html).toContain('name="sourceUrl"');
    expect(html).toContain('name="company"');
    expect(html).toContain('name="rawText"');
    expect(html).toContain('action="/intake"');
    expect(html).toContain('method="post"');
  });

  it('echoes back values on validation error', () => {
    const html = toHtml(
      NewBriefForm({
        values: {
          title: 'My brief title',
          sourceUrl: 'https://upwork.com/jobs/123',
          company: 'Acme Corp',
          rawText: 'This is the brief body.',
        },
        error: 'brief text is required',
      }),
    );
    expect(html).toContain('My brief title');
    expect(html).toContain('https://upwork.com/jobs/123');
    expect(html).toContain('Acme Corp');
    expect(html).toContain('This is the brief body.');
    expect(html).toContain('brief text is required');
    expect(html).toContain('flash err');
  });

  it('renders character counter element for rawText', () => {
    const html = toHtml(NewBriefForm({}));
    expect(html).toContain('id="rawTextCounter"');
    expect(html).toContain('50,000');
  });

  it('marks title and rawText as required', () => {
    const html = toHtml(NewBriefForm({}));
    expect(html).toMatch(/<input[^>]*name="title"[^>]*required/);
    expect(html).toMatch(/<textarea[^>]*name="rawText"[^>]*required/);
  });

  it('does not show error flash when no error prop', () => {
    const html = toHtml(NewBriefForm({}));
    expect(html).not.toContain('flash err');
  });

  it('shows sourceUrl as optional URL input', () => {
    const html = toHtml(NewBriefForm({}));
    // Should use type="url" or at least have a placeholder hinting URL pattern
    expect(html).toContain('name="sourceUrl"');
    expect(html).toContain('https://');
  });
});
