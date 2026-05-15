import { describe, it, expect } from 'vitest';
import { ListingsPage } from '../../src/views/listings.js';
import type { AvailableListing } from '../../src/db/schemas.js';

function fakeListing(overrides: Partial<AvailableListing> = {}): AvailableListing {
  return {
    id: 'lst_1',
    title: 'Backend Eng at Acme',
    company: 'Acme',
    summary: 'Build automation for the lead pipeline.',
    rawText: null,
    receivedAt: new Date('2026-05-15T10:00:00Z'),
    selectedAt: null,
    planId: null,
    ...overrides,
  };
}

const toHtml = (node: unknown) => String(node);

describe('ListingsPage', () => {
  it('renders the page title', () => {
    const html = toHtml(ListingsPage({ listings: [], showAll: false }));
    expect(html).toContain('<title>Available listings');
    expect(html).toContain('Available listings');
  });

  it('shows empty-state text when no listings', () => {
    const html = toHtml(ListingsPage({ listings: [], showAll: false }));
    expect(html).toContain('Nothing pending');
  });

  it('shows different empty-state when showAll=true and still no listings', () => {
    const html = toHtml(ListingsPage({ listings: [], showAll: true }));
    expect(html).toContain('No listings have been ingested yet');
  });

  it('renders each listing with title + company + summary', () => {
    const html = toHtml(
      ListingsPage({
        listings: [
          fakeListing({
            id: 'lst_a',
            title: 'Senior Eng at Foo',
            company: 'Foo Inc',
            summary: 'unique summary here',
          }),
        ],
        showAll: false,
      }),
    );
    expect(html).toContain('Senior Eng at Foo');
    expect(html).toContain('Foo Inc');
    expect(html).toContain('unique summary here');
  });

  it('handles null company gracefully', () => {
    const html = toHtml(
      ListingsPage({
        listings: [fakeListing({ company: null })],
        showAll: false,
      }),
    );
    expect(html).toContain('Unknown company');
  });

  it('links unselected listings to the cover-letter form with prefilled listingId', () => {
    const html = toHtml(
      ListingsPage({
        listings: [fakeListing({ id: 'lst_x' })],
        showAll: false,
      }),
    );
    expect(html).toContain('href="/plans/new/cover-letter?listingId=lst_x"');
    expect(html).toContain('Plan a cover letter');
  });

  it('links selected listings to their existing plan', () => {
    const html = toHtml(
      ListingsPage({
        listings: [fakeListing({ planId: 'plan_42', selectedAt: new Date() })],
        showAll: true,
      }),
    );
    expect(html).toContain('href="/plans/plan_42"');
    expect(html).toContain('Open plan');
    expect(html).toContain('badge finalized'); // "Selected" badge reuses style
  });

  it('shows the "show all" toggle when filtered to unselected', () => {
    const html = toHtml(ListingsPage({ listings: [], showAll: false }));
    expect(html).toContain('href="/listings?all=1"');
    expect(html).toContain('Show all');
  });

  it('shows the "show unselected only" toggle when showing all', () => {
    const html = toHtml(ListingsPage({ listings: [], showAll: true }));
    expect(html).toContain('href="/listings"');
    expect(html).toContain('Show unselected only');
  });
});
