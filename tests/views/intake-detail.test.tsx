import { describe, it, expect } from 'vitest';
import { BriefDetailPage } from '../../src/views/intake-detail.js';
import type { PipelineBrief, BriefScore } from '../../src/db/schemas.js';
import type { FormatProfile } from '../../src/engine/format-profiles/index.js';
import type { AudienceProfile } from '../../src/neurocore/audience-profiles.js';

const toHtml = (node: unknown) => String(node);

function fakeBrief(overrides: Partial<PipelineBrief> = {}): PipelineBrief {
  return {
    id: 'brief_abc',
    title: 'Build a RAG dashboard',
    company: 'Acme Corp',
    sourceUrl: 'https://upwork.com/jobs/123',
    rawText: 'We need a developer to build an AI-powered RAG system.',
    score: null,
    scoringRationale: null,
    stage: 'candidate',
    promotedPlanId: null,
    batchId: null,
    transformedBriefText: null,
    transformedScore: null,
    pinnedTechStack: null,
    createdAt: new Date('2026-05-01T00:00:00Z'),
    updatedAt: new Date('2026-05-01T00:00:00Z'),
    ...overrides,
  };
}

function fakeScore(): BriefScore {
  return {
    visualOutcome: 4,
    storyPotential: 4,
    scopeFit: 3,
    audienceMatch: 5,
    aggregate: 4.0,
  };
}

function fakeFormatProfile(): FormatProfile {
  return {
    id: 'claude_code_build_along',
    displayName: 'Claude Code Build Along',
    description: 'A format for building along',
    sceneRange: [6, 10],
    runtimeRange: [1500, 2100],
    beats: [],
    hookGuidelines: '',
    pacingRules: { wordsPerMinute: 150, sentenceLengthGuide: 'medium' },
    antiPatterns: [],
    ctaPolicy: '',
  } as unknown as FormatProfile;
}

function fakeAudienceProfile(): AudienceProfile {
  return {
    id: 'developer_longform',
    name: 'Developer / Learner — Long-form',
    description: 'desc',
    watchPersona: 'persona',
    painPoints: ['pain'],
    buyingTriggers: ['trigger'],
    voiceGuidelines: {
      tone: 'technical',
      vocabulary: 'professional',
      sentenceLengthGuide: 'medium',
      taboos: [],
    },
    hookPatterns: ['hook'],
    pacingRules: { wordsPerMinute: 150, avgSentenceWords: 15, densityNote: '' },
    ctaStyle: { type: 'subscribe_and_long_form', phrasing: 'Subscribe', placement: 'end' },
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

describe('BriefDetailPage', () => {
  it('renders brief title, company, and raw text', () => {
    const html = toHtml(
      BriefDetailPage({
        brief: fakeBrief(),
        formatProfiles: [fakeFormatProfile()],
        audienceProfiles: [fakeAudienceProfile()],
      }),
    );
    expect(html).toContain('Build a RAG dashboard');
    expect(html).toContain('Acme Corp');
    expect(html).toContain('We need a developer to build an AI-powered RAG system.');
  });

  it('renders score panel when score is set', () => {
    const html = toHtml(
      BriefDetailPage({
        brief: fakeBrief({ score: fakeScore(), scoringRationale: 'Strong AI angle.' }),
        formatProfiles: [fakeFormatProfile()],
        audienceProfiles: [fakeAudienceProfile()],
      }),
    );
    expect(html).toContain('4.0');
    expect(html).toContain('Visual outcome');
    expect(html).toContain('Story potential');
    expect(html).toContain('Scope fit');
    expect(html).toContain('Audience match');
    expect(html).toContain('Strong AI angle.');
  });

  it('shows "Score with LLM" button when no score', () => {
    const html = toHtml(
      BriefDetailPage({
        brief: fakeBrief({ score: null }),
        formatProfiles: [fakeFormatProfile()],
        audienceProfiles: [fakeAudienceProfile()],
      }),
    );
    expect(html).toContain('Score with LLM');
    expect(html).not.toContain('Re-score');
  });

  it('shows "Re-score" button when score exists', () => {
    const html = toHtml(
      BriefDetailPage({
        brief: fakeBrief({ score: fakeScore() }),
        formatProfiles: [fakeFormatProfile()],
        audienceProfiles: [fakeAudienceProfile()],
      }),
    );
    expect(html).toContain('Re-score');
  });

  it('promote form has format and audience dropdowns', () => {
    const html = toHtml(
      BriefDetailPage({
        brief: fakeBrief({ score: fakeScore() }),
        formatProfiles: [fakeFormatProfile()],
        audienceProfiles: [fakeAudienceProfile()],
      }),
    );
    expect(html).toContain('name="formatProfileId"');
    expect(html).toContain('Claude Code Build Along');
    expect(html).toContain('name="audienceProfileId"');
    expect(html).toContain('Developer / Learner');
  });

  it('shows "Already promoted" message when brief has promotedPlanId', () => {
    const html = toHtml(
      BriefDetailPage({
        brief: fakeBrief({ promotedPlanId: 'plan_xyz', score: fakeScore() }),
        formatProfiles: [fakeFormatProfile()],
        audienceProfiles: [fakeAudienceProfile()],
      }),
    );
    expect(html).toContain('Already promoted');
    expect(html).toContain('plan_xyz');
    expect(html).toContain('/plans/plan_xyz');
  });
});

// ---------------------------------------------------------------------------
// M29 — Transform button + before/after panel
// ---------------------------------------------------------------------------

function transformableScore(): BriefScore {
  // Weak narrative axes, strong technical fit — passes the M29 gate.
  return {
    visualOutcome: 2,
    storyPotential: 2,
    scopeFit: 4,
    audienceMatch: 4,
    aggregate: 3.0,
  };
}

describe('BriefDetailPage — Transform button', () => {
  it('shows Transform button when score passes the transformability gate', () => {
    const html = toHtml(
      BriefDetailPage({
        brief: fakeBrief({ score: transformableScore() }),
        formatProfiles: [fakeFormatProfile()],
        audienceProfiles: [fakeAudienceProfile()],
      }),
    );
    expect(html).toContain('Transform brief');
    expect(html).toContain('hx-post="/intake/brief_abc/transform"');
    expect(html).toContain('transformer candidate');
  });

  it('does NOT show Transform button when score fails the gate', () => {
    // All axes high — no narrative weakness, gate fails.
    const html = toHtml(
      BriefDetailPage({
        brief: fakeBrief({ score: fakeScore() }),
        formatProfiles: [fakeFormatProfile()],
        audienceProfiles: [fakeAudienceProfile()],
      }),
    );
    expect(html).not.toContain('Transform brief');
  });

  it('does NOT show Transform button when brief is already transformed', () => {
    const html = toHtml(
      BriefDetailPage({
        brief: fakeBrief({
          score: transformableScore(),
          transformedBriefText: 'already rewritten',
          transformedScore: { ...transformableScore(), visualOutcome: 4, storyPotential: 4, aggregate: 4.0 },
          pinnedTechStack: {
            primary: 'tech_vapi',
            supporting: [],
            rationale: 'voice surface',
          },
        }),
        formatProfiles: [fakeFormatProfile()],
        audienceProfiles: [fakeAudienceProfile()],
      }),
    );
    // The big "Transform brief" CTA in the score panel must be gone; the
    // before/after panel shows the (different-text) "Re-transform" instead.
    expect(html).not.toContain('Transform brief');
    expect(html).toContain('Re-transform');
  });
});

describe('BriefDetailPage — TransformPanel', () => {
  function transformedBrief() {
    return fakeBrief({
      score: transformableScore(),
      transformedBriefText: 'A small clinic needs a Vapi-driven phone screening agent...',
      transformedScore: {
        visualOutcome: 4,
        storyPotential: 4,
        scopeFit: 4,
        audienceMatch: 4,
        aggregate: 4.0,
      },
      pinnedTechStack: {
        primary: 'tech_vapi',
        supporting: ['tech_n8n'],
        rationale: 'voice surface + downstream automation',
      },
    });
  }

  it('renders transformed brief score, pinned stack, and re-transform button', () => {
    const html = toHtml(
      BriefDetailPage({
        brief: transformedBrief(),
        formatProfiles: [fakeFormatProfile()],
        audienceProfiles: [fakeAudienceProfile()],
      }),
    );
    expect(html).toContain('Transformed brief');
    expect(html).toContain('Score comparison');
    expect(html).toContain('Pinned tech stack');
    expect(html).toContain('tech_vapi');
    expect(html).toContain('tech_n8n');
    expect(html).toContain('voice surface + downstream automation');
    expect(html).toContain('Re-transform');
    expect(html).toContain('A small clinic needs a Vapi-driven phone');
  });

  it('shows drift warning when technical-axis delta exceeds 0.5', () => {
    const brief = fakeBrief({
      score: transformableScore(),
      transformedBriefText: 'rewritten text...',
      transformedScore: {
        visualOutcome: 4,
        storyPotential: 4,
        // scopeFit moved from 4 -> 2 (delta -2) → drift!
        scopeFit: 2,
        audienceMatch: 4,
        aggregate: 3.5,
      },
      pinnedTechStack: {
        primary: 'tech_vapi',
        supporting: [],
        rationale: 'r',
      },
    });
    const html = toHtml(
      BriefDetailPage({
        brief,
        formatProfiles: [fakeFormatProfile()],
        audienceProfiles: [fakeAudienceProfile()],
      }),
    );
    expect(html).toContain('Technical-axis drift');
  });

  it('hides drift warning when technical axes are preserved', () => {
    const html = toHtml(
      BriefDetailPage({
        brief: transformedBrief(),
        formatProfiles: [fakeFormatProfile()],
        audienceProfiles: [fakeAudienceProfile()],
      }),
    );
    expect(html).not.toContain('Technical-axis drift');
  });

  it('does NOT render the panel when there is no transformed brief', () => {
    const html = toHtml(
      BriefDetailPage({
        brief: fakeBrief({ score: transformableScore() }),
        formatProfiles: [fakeFormatProfile()],
        audienceProfiles: [fakeAudienceProfile()],
      }),
    );
    expect(html).not.toContain('Transformed brief');
    expect(html).not.toContain('Score comparison');
  });
});
