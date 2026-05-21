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
    transformedBuildPlan: null,
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
// M29-redo — Transform button + build-plan panel
// ---------------------------------------------------------------------------

function transformableScore(): BriefScore {
  // 4/4/4/4 — meets the new technical-fit gate (>= 3.0 on scopeFit + audienceMatch).
  return {
    visualOutcome: 4,
    storyPotential: 4,
    scopeFit: 4,
    audienceMatch: 4,
    aggregate: 4.0,
  };
}

function failingScore(): BriefScore {
  // 5/5/2/2 — high narrative but technical axes below the gate.
  return {
    visualOutcome: 5,
    storyPotential: 5,
    scopeFit: 2,
    audienceMatch: 2,
    aggregate: 3.5,
  };
}

function samplePlan() {
  return {
    goal: 'Build a Vapi voice bot that qualifies inbound leads + drops them into goHighLevel.',
    finalProduct: 'Viewer sees a live phone call streaming a transcript and a new contact landing in goHighLevel.',
    toolchain: [
      { name: 'Vapi', role: 'voice surface', source: 'given' as const },
      { name: 'goHighLevel', role: 'CRM destination', source: 'assumed' as const },
      { name: 'Gmail', role: 'notification sink', source: 'assumed' as const },
    ],
    buildSteps: [
      { title: 'Scaffold Vapi assistant', description: 'New assistant with qualification prompt.', estimatedMinutes: 25 },
      { title: 'Wire goHighLevel webhook', description: 'Receive Vapi post-call payload.', estimatedMinutes: 35 },
      { title: 'Live test call', description: 'Place a real phone call end to end.', estimatedMinutes: 30 },
    ],
    shotHints: [
      'Open Vapi dashboard, point to call-flow editor',
      'goHighLevel contacts list before/after',
      'Live test call with transcript on screen',
    ],
  };
}

describe('BriefDetailPage — Transform button (M29-redo)', () => {
  it('shows the Transform → build plan button when technical-fit gate passes', () => {
    const html = toHtml(
      BriefDetailPage({
        brief: fakeBrief({ score: transformableScore() }),
        formatProfiles: [fakeFormatProfile()],
        audienceProfiles: [fakeAudienceProfile()],
      }),
    );
    expect(html).toContain('Transform → build plan');
    expect(html).toContain('hx-post="/intake/brief_abc/transform"');
    expect(html).toContain('extract the build plan');
  });

  it('does NOT show the Transform button when technical axes are below the gate', () => {
    const html = toHtml(
      BriefDetailPage({
        brief: fakeBrief({ score: failingScore() }),
        formatProfiles: [fakeFormatProfile()],
        audienceProfiles: [fakeAudienceProfile()],
      }),
    );
    expect(html).not.toContain('Transform → build plan');
  });

  it('hides the initial Transform button once the brief has a build plan; shows Re-transform instead', () => {
    const html = toHtml(
      BriefDetailPage({
        brief: fakeBrief({
          score: transformableScore(),
          transformedBuildPlan: samplePlan(),
          pinnedTechStack: { primary: 'tech_vapi', supporting: [], rationale: 'r' },
        }),
        formatProfiles: [fakeFormatProfile()],
        audienceProfiles: [fakeAudienceProfile()],
      }),
    );
    expect(html).not.toContain('Transform → build plan');
    expect(html).toContain('Re-transform');
  });
});

describe('BriefDetailPage — TransformPanel (build plan)', () => {
  function transformedBrief() {
    return fakeBrief({
      score: transformableScore(),
      transformedBuildPlan: samplePlan(),
      pinnedTechStack: {
        primary: 'tech_vapi',
        supporting: ['tech_n8n'],
        rationale: 'voice surface + downstream automation',
      },
    });
  }

  it('renders goal, final product, toolchain, build steps, shot hints, and tech stack', () => {
    const html = toHtml(
      BriefDetailPage({
        brief: transformedBrief(),
        formatProfiles: [fakeFormatProfile()],
        audienceProfiles: [fakeAudienceProfile()],
      }),
    );
    expect(html).toContain('Build plan');
    expect(html).toContain('Goal');
    expect(html).toContain('Final product');
    expect(html).toContain('Toolchain');
    expect(html).toContain('Build steps');
    expect(html).toContain('Shot hints');
    expect(html).toContain('Pinned tech stack');
    expect(html).toContain('tech_vapi');
    expect(html).toContain('tech_n8n');
    expect(html).toContain('voice surface + downstream automation');
    expect(html).toContain('Vapi voice bot');
    expect(html).toContain('Scaffold Vapi assistant');
    expect(html).toContain('25 min');
    // Source HTML has lowercase 'given' / 'assumed'; CSS uppercases for display.
    expect(html).toContain('given');
    expect(html).toContain('assumed');
  });

  it('shows the total estimated minutes (sum of step estimates)', () => {
    const html = toHtml(
      BriefDetailPage({
        brief: transformedBrief(),
        formatProfiles: [fakeFormatProfile()],
        audienceProfiles: [fakeAudienceProfile()],
      }),
    );
    // 25 + 35 + 30 = 90
    expect(html).toContain('~90 min total');
  });

  it('renders the Re-transform button', () => {
    const html = toHtml(
      BriefDetailPage({
        brief: transformedBrief(),
        formatProfiles: [fakeFormatProfile()],
        audienceProfiles: [fakeAudienceProfile()],
      }),
    );
    expect(html).toContain('Re-transform');
  });

  it('does NOT render the panel when the brief has no build plan', () => {
    const html = toHtml(
      BriefDetailPage({
        brief: fakeBrief({ score: transformableScore() }),
        formatProfiles: [fakeFormatProfile()],
        audienceProfiles: [fakeAudienceProfile()],
      }),
    );
    expect(html).not.toContain('Build plan');
    expect(html).not.toContain('Toolchain');
  });
});

// ---- M35 phase overview + reason field ----

function multiPhasePlan() {
  return {
    ...samplePlan(),
    phases: [
      {
        title: 'Working voice bot scaffold',
        goal: 'Phase 1 ships a working Vapi assistant that can answer a live call and read back the qualification script.',
        buildSteps: [
          { title: 'Scaffold Vapi assistant', description: 'Initial config.', estimatedMinutes: 30 },
          { title: 'Voice tuning', description: 'Pick voice + settings.', estimatedMinutes: 30 },
        ],
        shotHints: ['Vapi dashboard', 'Live call'],
      },
      {
        title: 'Wire CRM + email sink',
        goal: 'Phase 2 adds goHighLevel contact creation and Gmail summary delivery downstream of the call.',
        buildSteps: [
          { title: 'n8n webhook', description: 'Receive Vapi payload.', estimatedMinutes: 45 },
          { title: 'goHighLevel node', description: 'Create contact.', estimatedMinutes: 30 },
        ],
        shotHints: ['n8n canvas', 'goHighLevel contact'],
      },
    ],
  };
}

describe('BriefDetailPage — phase overview (M35)', () => {
  it('renders phase overview when phases are present', () => {
    const html = toHtml(
      BriefDetailPage({
        brief: fakeBrief({
          score: transformableScore(),
          transformedBuildPlan: multiPhasePlan(),
          pinnedTechStack: { primary: 'tech_vapi', supporting: [], rationale: 'r' },
        }),
        formatProfiles: [fakeFormatProfile()],
        audienceProfiles: [fakeAudienceProfile()],
      }),
    );
    expect(html).toContain('2-part series');
    expect(html).toContain('Phase 1: Working voice bot scaffold');
    expect(html).toContain('Phase 2: Wire CRM + email sink');
    expect(html).toContain('2 videos');
  });

  it('renders "Single-phase build" header when only one phase is present', () => {
    const html = toHtml(
      BriefDetailPage({
        brief: fakeBrief({
          score: transformableScore(),
          transformedBuildPlan: {
            ...samplePlan(),
            phases: [
              {
                title: 'Whole build',
                goal: 'One-session build covering the full Vapi + CRM integration.',
                buildSteps: samplePlan().buildSteps,
                shotHints: samplePlan().shotHints,
              },
            ],
          },
          pinnedTechStack: { primary: 'tech_vapi', supporting: [], rationale: 'r' },
        }),
        formatProfiles: [fakeFormatProfile()],
        audienceProfiles: [fakeAudienceProfile()],
      }),
    );
    expect(html).toContain('Single-phase build');
    expect(html).toContain('1 video');
  });

  it('does NOT render phase overview when phases field is absent (legacy plans)', () => {
    const html = toHtml(
      BriefDetailPage({
        brief: fakeBrief({
          score: transformableScore(),
          transformedBuildPlan: samplePlan(), // no phases field
          pinnedTechStack: { primary: 'tech_vapi', supporting: [], rationale: 'r' },
        }),
        formatProfiles: [fakeFormatProfile()],
        audienceProfiles: [fakeAudienceProfile()],
      }),
    );
    expect(html).not.toContain('Single-phase build');
    expect(html).not.toContain('-part series');
  });
});

describe('BriefDetailPage — score edit form reason field (M35)', () => {
  it('renders the optional overrideReason input field', () => {
    const html = toHtml(
      BriefDetailPage({
        brief: fakeBrief({ score: transformableScore() }),
        formatProfiles: [fakeFormatProfile()],
        audienceProfiles: [fakeAudienceProfile()],
      }),
    );
    expect(html).toContain('name="overrideReason"');
    expect(html).toContain('Why are you overriding?');
    expect(html).toContain('score.overridden');
  });
});

describe('BriefDetailPage — Transform/Re-transform loading spinner (M35.1)', () => {
  it('Transform button wires hx-indicator + hx-disabled-elt to the spinner span', () => {
    const html = toHtml(
      BriefDetailPage({
        brief: fakeBrief({ score: transformableScore() }),
        formatProfiles: [fakeFormatProfile()],
        audienceProfiles: [fakeAudienceProfile()],
      }),
    );
    expect(html).toContain('hx-indicator="#transform-indicator-brief_abc"');
    expect(html).toContain('id="transform-indicator-brief_abc"');
    expect(html).toContain('hx-disabled-elt="this"');
    // Spinner class (not just text) so the .score-spinner CSS rule animates it.
    expect(html).toMatch(/score-spinner htmx-indicator[^>]*id="transform-indicator-brief_abc"/);
  });

  it('Re-transform button wires hx-indicator + hx-disabled-elt to the spinner span', () => {
    const html = toHtml(
      BriefDetailPage({
        brief: fakeBrief({
          score: transformableScore(),
          transformedBuildPlan: samplePlan(),
          pinnedTechStack: { primary: 'tech_vapi', supporting: [], rationale: 'r' },
        }),
        formatProfiles: [fakeFormatProfile()],
        audienceProfiles: [fakeAudienceProfile()],
      }),
    );
    expect(html).toContain('hx-indicator="#retransform-indicator-brief_abc"');
    expect(html).toContain('id="retransform-indicator-brief_abc"');
    expect(html).toMatch(/score-spinner htmx-indicator[^>]*id="retransform-indicator-brief_abc"/);
  });
});
