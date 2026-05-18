import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';

vi.mock('../../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() },
}));

import { createFakeFirestore, type FakeFirestore } from '../db/fake-firestore.js';
import { createPlan } from '../../src/db/plans.js';
import { matchProjects, _internal } from '../../src/engine/match-projects.js';
import { LLMProviderError, type LLMProvider } from '../../src/providers/index.js';
import { NeurocoreError, type NeurocoreClient, type MemoryContextResponse } from '../../src/neurocore/index.js';
import type { Requirement } from '../../src/db/schemas.js';

let fake: FakeFirestore;
const asDb = () => fake as unknown as Firestore;

function makeProvider(responses: Array<string | { throws: Error }>): LLMProvider {
  const queue = [...responses];
  return {
    name: 'claude' as const,
    async generate() {
      const next = queue.shift();
      if (next === undefined) throw new Error('provider queue empty');
      if (typeof next === 'object' && 'throws' in next) throw next.throws;
      return next;
    },
  };
}

interface ClientStub {
  client: NeurocoreClient;
  calls: Array<{
    planMode: 'cover_letter' | 'youtube_lite';
    contactId?: string;
    jobContextHint?: string;
    tokenBudget?: number;
  }>;
}

function makeClient(
  responseOrError: MemoryContextResponse | { throws: Error },
): ClientStub {
  const calls: ClientStub['calls'] = [];
  const client = {
    async getProjectContext(params: {
      planMode: 'cover_letter' | 'youtube_lite';
      contactId?: string;
      jobContextHint?: string;
      tokenBudget?: number;
    }) {
      calls.push(params);
      if ('throws' in responseOrError) throw responseOrError.throws;
      return responseOrError;
    },
  } as unknown as NeurocoreClient;
  return { client, calls };
}

const SAMPLE_SYSTEM_BLOCK = `<projects_portfolio>
  <project relevance="0.000">
    <projectName>Neurocore</projectName>
    <slug>neurocore</slug>
    <demonstrableFeatures>memory injection across apps</demonstrableFeatures>
  </project>
  <project relevance="0.000">
    <projectName>Lead Pipeline</projectName>
    <slug>lead-pipeline</slug>
    <demonstrableFeatures>real-time lead routing dashboard</demonstrableFeatures>
  </project>
</projects_portfolio>
<listing_insight>
  <fit_score>78</fit_score>
  <proposal_hooks>Lead with translating client complaints into engineering tasks.</proposal_hooks>
  <quick_wins><quick_win>Show real-time dashboards</quick_win></quick_wins>
</listing_insight>`;

const SAMPLE_NEUROCORE_RESPONSE: MemoryContextResponse = {
  systemBlock: SAMPLE_SYSTEM_BLOCK,
  metadata: {
    layersIncluded: ['profile', 'projects', 'listing_insight'],
    memoryRecordIds: [],
    estimatedTokens: 800,
    degraded: false,
    budget: { requested: 6000, clampedTo: 6000, effective: 6000 },
  },
};

const SAMPLE_REQUIREMENTS: Requirement[] = [
  {
    skill: 'lead pipeline automation',
    category: 'automation',
    priority: 'must_show',
    evidence: 'build automation for our lead pipeline',
  },
];

async function makeCoverLetterPlan(opts?: {
  status?: 'awaiting_review' | 'requirements_reviewed';
  withListing?: boolean;
}): Promise<string> {
  const plan = await createPlan(
    {
      type: 'cover_letter',
      title: 'Backend Eng at Acme',
      targetRuntimeSeconds: 120,
      sourceListingText: 'Looking for engineer to build lead pipeline...',
      sourceListingId: opts?.withListing ? 'lst_42' : null,
      status: opts?.status ?? 'requirements_reviewed',
    },
    asDb(),
  );
  // Seed requirements directly (the M4 step would have done this).
  await fake.collection('plans').doc(plan.id).update({ requirements: SAMPLE_REQUIREMENTS });
  return plan.id;
}

async function makeYouTubePlan(opts?: {
  status?: 'requirements_reviewed';
  userConstraints?: string;
}): Promise<string> {
  const plan = await createPlan(
    {
      type: 'youtube_lite',
      title: 'How I built a lead pipeline that auto-routes inbound leads',
      targetRuntimeSeconds: 600,
      status: opts?.status ?? 'requirements_reviewed',
      userConstraints: opts?.userConstraints,
    },
    asDb(),
  );
  return plan.id;
}

const SAMPLE_LLM_REPLY = JSON.stringify([
  {
    projectSlug: 'lead-pipeline',
    projectName: 'Lead Pipeline',
    matchedFeatures: ['real-time lead routing dashboard', 'slack alerts on new leads'],
    relevanceScore: 0.92,
    suggestedDemoSequence:
      'Open in the dashboard. Trigger a new lead via the form. Show the worker logs picking it up. Cut to the Slack alert.',
  },
  {
    projectSlug: 'neurocore',
    projectName: 'Neurocore',
    matchedFeatures: ['memory injection across apps'],
    relevanceScore: 0.62,
    suggestedDemoSequence:
      'Quick architecture diagram. Then a live POST showing the memory context endpoint return JSON.',
  },
]);

beforeEach(() => {
  fake = createFakeFirestore();
});

describe('matchProjects — happy path', () => {
  it('cover_letter: calls Neurocore with videoPlanCoverLetter scope and persists matches', async () => {
    const planId = await makeCoverLetterPlan({ withListing: true });
    const { client, calls } = makeClient(SAMPLE_NEUROCORE_RESPONSE);
    const provider = makeProvider([SAMPLE_LLM_REPLY]);

    const result = await matchProjects(planId, { provider, client, db: asDb() });

    expect(result.matchedProjects).toHaveLength(2);
    expect(result.matchedProjects[0]?.projectSlug).toBe('lead-pipeline');
    expect(result.plan.status).toBe('projects_matched');
    expect(result.plan.matchedProjects).toHaveLength(2);
    expect(result.retried).toBe(false);
    expect(result.degraded).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.planMode).toBe('cover_letter');
    expect(calls[0]?.contactId).toBe('lst_42');
    expect(calls[0]?.jobContextHint).toContain('lead pipeline automation');
  });

  it('youtube: calls Neurocore with videoPlanYoutube scope and uses topic as hint', async () => {
    const planId = await makeYouTubePlan({ userConstraints: 'Focus on B2B' });
    const { client, calls } = makeClient(SAMPLE_NEUROCORE_RESPONSE);
    const provider = makeProvider([SAMPLE_LLM_REPLY]);

    const result = await matchProjects(planId, { provider, client, db: asDb() });

    expect(result.matchedProjects).toHaveLength(2);
    expect(result.plan.status).toBe('projects_matched');
    expect(calls[0]?.planMode).toBe('youtube_lite');
    expect(calls[0]?.contactId).toBeUndefined();
    expect(calls[0]?.jobContextHint).toContain('lead pipeline');
    expect(calls[0]?.jobContextHint).toContain('Focus on B2B');
  });

  it('surfaces degraded=true when Neurocore reports partial result', async () => {
    const planId = await makeCoverLetterPlan();
    const { client } = makeClient({
      ...SAMPLE_NEUROCORE_RESPONSE,
      metadata: { ...SAMPLE_NEUROCORE_RESPONSE.metadata, degraded: true },
    });
    const provider = makeProvider([SAMPLE_LLM_REPLY]);
    const result = await matchProjects(planId, { provider, client, db: asDb() });
    expect(result.degraded).toBe(true);
    // Status still transitions — degraded context is usable.
    expect(result.plan.status).toBe('projects_matched');
  });
});

describe('matchProjects — retry on bad output', () => {
  it('retries once with stricter prompt then succeeds', async () => {
    const planId = await makeCoverLetterPlan();
    const { client } = makeClient(SAMPLE_NEUROCORE_RESPONSE);
    const provider = makeProvider(['not json at all', SAMPLE_LLM_REPLY]);
    const result = await matchProjects(planId, { provider, client, db: asDb() });
    expect(result.retried).toBe(true);
    expect(result.matchedProjects).toHaveLength(2);
  });

  it('throws INVALID_OUTPUT when both attempts fail', async () => {
    const planId = await makeCoverLetterPlan();
    const { client } = makeClient(SAMPLE_NEUROCORE_RESPONSE);
    const provider = makeProvider(['nope', 'also nope']);
    await expect(matchProjects(planId, { provider, client, db: asDb() })).rejects.toMatchObject({
      code: 'INVALID_OUTPUT',
      step: 'match-projects',
    });
    // Plan should still be at requirements_reviewed (no advance on failure).
    const data = (await fake.collection('plans').doc(planId).get()).data() as
      | { status?: string }
      | undefined;
    expect(data?.status).toBe('requirements_reviewed');
  });

  it('rejects matches that miss required fields (e.g. no projectSlug)', async () => {
    const planId = await makeCoverLetterPlan();
    const { client } = makeClient(SAMPLE_NEUROCORE_RESPONSE);
    const broken = JSON.stringify([
      { projectName: 'x', matchedFeatures: [], relevanceScore: 0.5, suggestedDemoSequence: 'y' },
    ]);
    const provider = makeProvider([broken, broken]);
    await expect(matchProjects(planId, { provider, client, db: asDb() })).rejects.toMatchObject({
      code: 'INVALID_OUTPUT',
    });
  });

  it('rejects matches with relevanceScore out of range', async () => {
    const planId = await makeCoverLetterPlan();
    const { client } = makeClient(SAMPLE_NEUROCORE_RESPONSE);
    const broken = JSON.stringify([
      {
        projectSlug: 'x',
        projectName: 'x',
        matchedFeatures: [],
        relevanceScore: 1.7,
        suggestedDemoSequence: 'y',
      },
    ]);
    const provider = makeProvider([broken, broken]);
    await expect(matchProjects(planId, { provider, client, db: asDb() })).rejects.toMatchObject({
      code: 'INVALID_OUTPUT',
    });
  });
});

describe('matchProjects — input / state validation', () => {
  it('PLAN_NOT_FOUND for unknown id', async () => {
    const { client } = makeClient(SAMPLE_NEUROCORE_RESPONSE);
    await expect(
      matchProjects('plan_missing', {
        provider: makeProvider([SAMPLE_LLM_REPLY]),
        client,
        db: asDb(),
      }),
    ).rejects.toMatchObject({ code: 'PLAN_NOT_FOUND' });
  });

  it('DISALLOWED_TRANSITION when plan is past projects_matched in the lifecycle', async () => {
    const planId = await makeCoverLetterPlan({ status: 'awaiting_review' });
    // awaiting_review → projects_matched is not allowed (must go through requirements_reviewed first)
    const { client } = makeClient(SAMPLE_NEUROCORE_RESPONSE);
    await expect(
      matchProjects(planId, {
        provider: makeProvider([SAMPLE_LLM_REPLY]),
        client,
        db: asDb(),
      }),
    ).rejects.toMatchObject({ code: 'DISALLOWED_TRANSITION' });
  });

  it('NO_REQUIREMENTS when cover_letter plan has no requirements', async () => {
    const plan = await createPlan(
      {
        type: 'cover_letter',
        title: 'X',
        targetRuntimeSeconds: 60,
        sourceListingText: 'some text',
        status: 'requirements_reviewed',
      },
      asDb(),
    );
    const { client } = makeClient(SAMPLE_NEUROCORE_RESPONSE);
    await expect(
      matchProjects(plan.id, {
        provider: makeProvider([SAMPLE_LLM_REPLY]),
        client,
        db: asDb(),
      }),
    ).rejects.toMatchObject({ code: 'NO_REQUIREMENTS' });
  });

  it('youtube plans do NOT require requirements', async () => {
    const planId = await makeYouTubePlan();
    const { client } = makeClient(SAMPLE_NEUROCORE_RESPONSE);
    const result = await matchProjects(planId, {
      provider: makeProvider([SAMPLE_LLM_REPLY]),
      client,
      db: asDb(),
    });
    expect(result.matchedProjects).toHaveLength(2);
  });
});

describe('matchProjects — failure mappings', () => {
  it('wraps NeurocoreError as PlanningEngineError(LLM_FAILED)', async () => {
    const planId = await makeCoverLetterPlan();
    const { client } = makeClient({
      throws: new NeurocoreError('UNREACHABLE', '/v1/memory/context', 'connection refused'),
    });
    await expect(
      matchProjects(planId, {
        provider: makeProvider([SAMPLE_LLM_REPLY]),
        client,
        db: asDb(),
      }),
    ).rejects.toMatchObject({ code: 'LLM_FAILED' });
  });

  it('wraps LLMProviderError as LLM_FAILED', async () => {
    const planId = await makeCoverLetterPlan();
    const { client } = makeClient(SAMPLE_NEUROCORE_RESPONSE);
    await expect(
      matchProjects(planId, {
        provider: makeProvider([{ throws: new LLMProviderError('claude', 'TIMEOUT', 'slow') }]),
        client,
        db: asDb(),
      }),
    ).rejects.toMatchObject({ code: 'LLM_FAILED' });
  });
});

describe('buildJobContextHint', () => {
  it('joins skills for cover_letter mode', () => {
    const hint = _internal.buildJobContextHint({
      type: 'cover_letter',
      title: 'X',
      requirements: SAMPLE_REQUIREMENTS,
      userConstraints: null,
    });
    expect(hint).toBe('Needs: lead pipeline automation');
  });

  it('falls back to title when cover_letter has no requirements', () => {
    const hint = _internal.buildJobContextHint({
      type: 'cover_letter',
      title: 'Senior Eng at Acme',
      requirements: [],
      userConstraints: null,
    });
    expect(hint).toBe('Senior Eng at Acme');
  });

  it('combines title and constraints for youtube', () => {
    const hint = _internal.buildJobContextHint({
      type: 'youtube_lite',
      title: 'How I built X',
      userConstraints: 'No music, fast cuts',
      requirements: [],
    });
    expect(hint).toContain('How I built X');
    expect(hint).toContain('No music, fast cuts');
  });
});
