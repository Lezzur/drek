import { describe, it, expect } from 'vitest';
import { DashboardPage, PollResult } from '../../src/views/dashboard.js';
import type { Plan } from '../../src/db/schemas.js';

function fakePlan(overrides: Partial<Plan> = {}): Plan {
  return {
    id: 'plan_1',
    type: 'cover_letter',
    status: 'awaiting_review',
    title: 'Backend Eng at Acme',
    sourceListingId: 'lst_1',
    sourceListingText: 'text',
    requirements: [],
    matchedProjects: [],
    targetRuntimeSeconds: 120,
    estimatedRuntimeSeconds: 0,
    userConstraints: null,
    createdAt: new Date('2026-05-15T10:00:00Z'),
    updatedAt: new Date('2026-05-15T10:00:00Z'),
    exportedAt: null,
    ...overrides,
  };
}

async function toHtml(node: unknown): Promise<string> {
  // hono/jsx nodes stringify lazily.
  return String(node);
}

describe('DashboardPage', () => {
  it('renders the page shell with the title', async () => {
    const html = await toHtml(
      DashboardPage({ plans: [], filter: {}, lastPollAt: null }),
    );
    expect(html).toContain('<title>Dashboard');
    expect(html).toContain('DREK · AI Video Director');
  });

  it('shows the empty-state message when no plans match', async () => {
    const html = await toHtml(
      DashboardPage({ plans: [], filter: {}, lastPollAt: null }),
    );
    expect(html).toContain('No plans match the current filter');
  });

  it('renders the plans table with one row per plan', async () => {
    const plans = [
      fakePlan({ id: 'plan_1', title: 'A', status: 'awaiting_review' }),
      fakePlan({ id: 'plan_2', title: 'B', status: 'finalized' }),
    ];
    const html = await toHtml(
      DashboardPage({ plans, filter: {}, lastPollAt: null }),
    );
    expect(html).toContain('A');
    expect(html).toContain('B');
    expect(html).toContain('href="/plans/plan_1"');
    expect(html).toContain('href="/plans/plan_2"');
  });

  it('shows the Dismiss button only on awaiting_review plans', async () => {
    const plans = [
      fakePlan({ id: 'plan_1', status: 'awaiting_review' }),
      fakePlan({ id: 'plan_2', status: 'finalized' }),
    ];
    const html = await toHtml(
      DashboardPage({ plans, filter: {}, lastPollAt: null }),
    );
    // The dismiss button is wired to /plans/:id/dismiss with hx-post.
    expect(html).toContain('hx-post="/plans/plan_1/dismiss"');
    expect(html).not.toContain('hx-post="/plans/plan_2/dismiss"');
  });

  it('embeds the active filter into the form select', async () => {
    const html = await toHtml(
      DashboardPage({
        plans: [],
        filter: { type: 'youtube', status: 'projects_matched' },
        lastPollAt: null,
      }),
    );
    expect(html).toMatch(/<option value="youtube" selected[^>]*>YouTube<\/option>/);
    expect(html).toMatch(/<option value="projects_matched" selected[^>]*>Projects matched<\/option>/);
  });

  it('shows last poll time when provided', async () => {
    const html = await toHtml(
      DashboardPage({
        plans: [],
        filter: {},
        lastPollAt: '2026-05-15T10:00:00.000Z',
      }),
    );
    expect(html).toContain('Last poll:');
    expect(html).not.toContain('never');
  });

  it('shows "never" when no poll has happened yet', async () => {
    const html = await toHtml(
      DashboardPage({ plans: [], filter: {}, lastPollAt: null }),
    );
    expect(html).toContain('Last poll: never');
  });
});

describe('PollResult', () => {
  it('shows the created-plans count', async () => {
    const html = await toHtml(
      PollResult({ createdPlans: 3, skipped: 0, failed: 0, disabled: false }),
    );
    expect(html).toContain('3 new plans');
  });

  it('singularizes when exactly one new plan', async () => {
    const html = await toHtml(
      PollResult({ createdPlans: 1, skipped: 0, failed: 0, disabled: false }),
    );
    expect(html).toContain('1 new plan');
    expect(html).not.toContain('1 new plans');
  });

  it('shows "No new listings" when nothing changed', async () => {
    const html = await toHtml(
      PollResult({ createdPlans: 0, skipped: 0, failed: 0, disabled: false }),
    );
    expect(html).toContain('No new listings');
  });

  it('shows error styling when any listing failed', async () => {
    const html = await toHtml(
      PollResult({ createdPlans: 1, skipped: 0, failed: 2, disabled: false }),
    );
    expect(html).toContain('flash err');
    expect(html).toContain('2 failed');
  });

  it('shows the disabled message when polling is off', async () => {
    const html = await toHtml(
      PollResult({ createdPlans: 0, skipped: 0, failed: 0, disabled: true }),
    );
    expect(html).toContain('Polling is disabled');
  });

  it('auto-refreshes the page after one second', async () => {
    const html = await toHtml(
      PollResult({ createdPlans: 1, skipped: 0, failed: 0, disabled: false }),
    );
    expect(html).toContain('hx-get="/"');
    expect(html).toContain('hx-trigger="load delay:1s"');
  });
});
