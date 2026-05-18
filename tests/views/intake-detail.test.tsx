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
