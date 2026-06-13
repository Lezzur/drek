import { describe, it, expect } from 'vitest';
import { DashboardPage, PollResult, staleCutoff } from '../../src/views/dashboard.js';
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
    formatProfileId: null,
    pipelineBriefId: null,
    workspacePath: null,
    selectedHookVariantId: null,
    selectedTitleVariantId: null,
    selectedThumbnailConceptId: null,
    pipelineState: 'idle',
    pipelineError: null,
    ...overrides,
  };
}

/** A plan created moments ago — lands in the Inbox bucket, not Stale. */
function freshPlan(overrides: Partial<Plan> = {}): Plan {
  return fakePlan({ createdAt: new Date(), updatedAt: new Date(), ...overrides });
}

const BASE = { filter: {}, lastPollAt: null, freshWindowDays: 3 };

async function toHtml(node: unknown): Promise<string> {
  // hono/jsx nodes stringify lazily.
  return String(node);
}

describe('staleCutoff', () => {
  it('is exactly N days before now', () => {
    const now = new Date('2026-06-11T00:00:00Z');
    expect(staleCutoff(3, now).toISOString()).toBe('2026-06-08T00:00:00.000Z');
  });
});

describe('DashboardPage', () => {
  it('renders the page shell with the title', async () => {
    const html = await toHtml(DashboardPage({ plans: [], ...BASE }));
    expect(html).toContain('<title>Dashboard');
    expect(html).toMatch(/<title>Dashboard\s+—\s+DREK<\/title>/);
  });

  it('shows the calm empty state on the unfiltered view', async () => {
    const html = await toHtml(DashboardPage({ plans: [], ...BASE }));
    expect(html).toContain('Nothing needs you right now');
  });

  it('shows the filter empty-state when a filter matches nothing', async () => {
    const html = await toHtml(
      DashboardPage({ plans: [], ...BASE, filter: { type: 'youtube_lite' } }),
    );
    expect(html).toContain('No plans match the current filter');
  });

  it('groups ready plans under Ready to record with an export link', async () => {
    const plans = [freshPlan({ id: 'plan_r', title: 'Ready One', status: 'scenes_generated' })];
    const html = await toHtml(DashboardPage({ plans, ...BASE }));
    expect(html).toContain('Ready to record');
    expect(html).toContain('href="/plans/plan_r/export"');
  });

  it('groups queued/running plans under Generating with a self-refresh', async () => {
    const plans = [freshPlan({ id: 'plan_q', pipelineState: 'queued' })];
    const html = await toHtml(DashboardPage({ plans, ...BASE }));
    expect(html).toContain('Generating');
    expect(html).toContain('hx-trigger="every 8s"');
  });

  it('does not self-refresh when nothing is in the pipeline', async () => {
    const plans = [freshPlan({ id: 'plan_i' })];
    const html = await toHtml(DashboardPage({ plans, ...BASE }));
    expect(html).not.toContain('hx-trigger="every 8s"');
  });

  it('shows failed pipelines under Needs attention with the error and a retry', async () => {
    const plans = [
      freshPlan({ id: 'plan_f', pipelineState: 'failed', pipelineError: 'claude CLI failed: boom' }),
    ];
    const html = await toHtml(DashboardPage({ plans, ...BASE }));
    expect(html).toContain('Needs attention');
    expect(html).toContain('claude CLI failed: boom');
    expect(html).toContain('hx-post="/plans/plan_f/queue-row"');
  });

  it('puts fresh awaiting_review plans in Inbox with Generate + Dismiss', async () => {
    const plans = [freshPlan({ id: 'plan_n', title: 'Fresh listing' })];
    const html = await toHtml(DashboardPage({ plans, ...BASE }));
    expect(html).toContain('Inbox');
    expect(html).toContain('hx-post="/plans/plan_n/queue-row"');
    expect(html).toContain('hx-post="/plans/plan_n/dismiss"');
  });

  it('collapses old awaiting_review plans into Stale with a bulk dismiss', async () => {
    const plans = [fakePlan({ id: 'plan_old' })]; // createdAt 2026-05-15, way past 3d
    const html = await toHtml(DashboardPage({ plans, ...BASE }));
    expect(html).toContain('stale listing');
    expect(html).toContain('hx-post="/plans/dismiss-stale"');
  });

  it('renders a flat table when a filter is active', async () => {
    const plans = [
      fakePlan({ id: 'plan_1', title: 'A', status: 'awaiting_review' }),
      fakePlan({ id: 'plan_2', title: 'B', status: 'finalized' }),
    ];
    const html = await toHtml(
      DashboardPage({ plans, ...BASE, filter: { type: 'cover_letter' } }),
    );
    expect(html).toContain('href="/plans/plan_1"');
    expect(html).toContain('href="/plans/plan_2"');
    expect(html).not.toContain('stale listing');
  });

  it('embeds the active filter into the form select', async () => {
    const html = await toHtml(
      DashboardPage({
        plans: [],
        ...BASE,
        filter: { type: 'youtube_lite', status: 'projects_matched' },
      }),
    );
    expect(html).toMatch(/<option value="youtube_lite" selected[^>]*>YouTube \(lite\)<\/option>/);
    expect(html).toMatch(/<option value="projects_matched" selected[^>]*>Projects matched<\/option>/);
  });

  it('shows last poll time when provided', async () => {
    const html = await toHtml(
      DashboardPage({ plans: [], ...BASE, lastPollAt: '2026-05-15T10:00:00.000Z' }),
    );
    expect(html).toContain('Last poll:');
    expect(html).not.toContain('never');
  });

  it('shows "never" when no poll has happened yet', async () => {
    const html = await toHtml(DashboardPage({ plans: [], ...BASE }));
    expect(html).toContain('Last poll: never');
  });
});

describe('PollResult', () => {
  it('shows the created-plans count', async () => {
    const html = await toHtml(
      PollResult({ createdPlans: 3, queuedPipelines: 0, skipped: 0, failed: 0, disabled: false }),
    );
    expect(html).toContain('3 new plans');
  });

  it('mentions queued script generation', async () => {
    const html = await toHtml(
      PollResult({ createdPlans: 2, queuedPipelines: 2, skipped: 0, failed: 0, disabled: false }),
    );
    expect(html).toContain('2 queued for script generation');
  });

  it('singularizes when exactly one new plan', async () => {
    const html = await toHtml(
      PollResult({ createdPlans: 1, queuedPipelines: 0, skipped: 0, failed: 0, disabled: false }),
    );
    expect(html).toContain('1 new plan');
    expect(html).not.toContain('1 new plans');
  });

  it('shows "No new listings" when nothing changed', async () => {
    const html = await toHtml(
      PollResult({ createdPlans: 0, queuedPipelines: 0, skipped: 0, failed: 0, disabled: false }),
    );
    expect(html).toContain('No new listings');
  });

  it('shows error styling when any listing failed', async () => {
    const html = await toHtml(
      PollResult({ createdPlans: 1, queuedPipelines: 0, skipped: 0, failed: 2, disabled: false }),
    );
    expect(html).toContain('flash err');
    expect(html).toContain('2 failed');
  });

  it('shows the disabled message when polling is off', async () => {
    const html = await toHtml(
      PollResult({ createdPlans: 0, queuedPipelines: 0, skipped: 0, failed: 0, disabled: true }),
    );
    expect(html).toContain('Polling is disabled');
  });

  it('auto-refreshes the page after one second', async () => {
    const html = await toHtml(
      PollResult({ createdPlans: 1, queuedPipelines: 0, skipped: 0, failed: 0, disabled: false }),
    );
    expect(html).toContain('hx-get="/"');
    expect(html).toContain('hx-trigger="load delay:1s"');
  });
});
