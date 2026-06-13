import type { FormatProfile } from './types.js';

/**
 * `comparison` — Structured X vs Y evaluation of two tools, approaches, or
 * frameworks on a shared set of criteria. Opens with the verdict (which wins
 * and for what use case), then rewinds to justify it. Symmetrical scene
 * budget: Option A and Option B get equal airtime on equal criteria.
 *
 * The format lives or dies on the quality of the criteria. Vague criteria
 * ("ease of use", "performance") produce opinions. Concrete criteria
 * ("time-to-first-working-integration", "token cost per API call",
 * "handling of streaming tool calls") produce evidence. Define the criteria
 * explicitly in criteria_framing and hold to them symmetrically.
 */
export const comparison: FormatProfile = {
  id: 'comparison',
  displayName: 'Comparison',
  description:
    'Structured X vs Y evaluation on a shared set of criteria. Opens with the verdict, then rewinds to justify it. Symmetrical scene budget: both options get equal airtime on equal criteria. The format lives on the quality of the criteria — concrete beats vague every time.',
  sceneRange: [6, 7],
  runtimeRange: [1200, 1500], // 20-25 minutes
  beats: [
    {
      name: 'cold_open',
      targetDurationSeconds: 30,
      description:
        'Reveal the verdict in one sentence: "Option A wins for [use case X]; Option B wins for [use case Y]." Then rewind to the test setup. The viewer should know your conclusion before they know your evidence — they stay to have their disagreement resolved or their prior confirmed, not to be kept in suspense.',
      shotConventions: ['screenshare'],
    },
    {
      name: 'criteria_framing',
      targetDurationSeconds: 180, // 3 min
      description:
        'Name the 3-5 criteria this comparison will be decided on. Each criterion must be concrete enough to test: not "developer experience" but "time from API key to working integration." State the test setup (same prompt, same dataset, same environment) so the viewer knows the comparison is fair. Name what the comparison will NOT cover and why.',
      shotConventions: ['screenshare', 'diagram_overlay'],
    },
    {
      name: 'option_a',
      targetDurationSeconds: 300, // 5 min
      description:
        'Walk Option A through each criterion in the established order. Show real usage — real code, real terminal output, real timing. Narrate observations, not keystrokes. Acknowledge what Option A does well before naming its weaknesses. Do not reveal which wins until the head_to_head beat.',
      shotConventions: ['screenshare', 'terminal'],
    },
    {
      name: 'option_b',
      targetDurationSeconds: 300, // 5 min
      description:
        'Walk Option B through the same criteria in the same order as option_a. Same format, same depth, same tone. Symmetry is load-bearing: if one option gets more detail, the comparison reads as unfair. Acknowledge what Option B does well before naming its weaknesses.',
      shotConventions: ['screenshare', 'terminal'],
    },
    {
      name: 'head_to_head',
      targetDurationSeconds: 240, // 4 min
      description:
        'Criterion by criterion comparison: show the evidence side-by-side for each of the criteria named in criteria_framing. One winner per criterion, with a one-sentence rationale. Do not introduce new criteria here — only compare what was established up front. Use a table or split-screen if the data supports it.',
      shotConventions: ['screenshare', 'diagram_overlay'],
    },
    {
      name: 'verdict',
      targetDurationSeconds: 120, // 2 min
      description:
        'Name the overall winner and the specific use case it wins for. Name the case where the other option is the right choice. Be explicit: "If you are doing X, use A. If you are doing Y, use B. If you are doing Z, the answer depends on..." Viewers will screenshot or clip this beat — make the recommendation quotable.',
      shotConventions: ['screenshare'],
    },
    {
      name: 'outro',
      targetDurationSeconds: 60, // 1 min
      description:
        'Honest reflection on what surprised you about the test. Pricing moment only if the comparison is relevant to a client engagement (e.g., "choosing between these two in a client project typically saves or costs X in development time"). CTA: consultation booking for viewers who want help making this decision for their specific situation.',
      shotConventions: ['screenshare', 'headshot'],
    },
  ],
  hookGuidelines: `
Cold open reveals the verdict immediately. "X wins for [use case A];
Y wins for [use case B]." The viewer should know your conclusion in
the first 10 seconds.

This is counter-intuitive — most comparison videos save the verdict
for the end. That structure works for entertainment. For a technical
audience, it works against you: they came for the answer, and keeping
it from them reads as padding. Give them the answer; they stay to
understand the evidence, resolve disagreement, or confirm their prior.

Preferred hook archetypes:
- bold_claim: lead with the verdict as a claim. "Claude Code beats
  Cursor for agentic workflows — and it's not close." Works when the
  conclusion is opinionated and defensible.
- demo_first: show the key differentiator moment — the test where
  Option A clearly won or lost — then rewind to criteria. Works when
  the difference is visible (timing, output quality, error handling).

Avoid:
- retention_question: "Which is better — X or Y?" as the hook wastes
  the opening. The viewer clicked on a comparison video; they know
  you're going to compare. Get to the verdict.
- story_cold_open: comparison videos are evidence-led, not narrative.
  A story opening delays the substance that earns the viewer's time.
`.trim(),
  pacingRules: {
    wordsPerMinute: 150,
    sentenceLengthGuide:
      'Short and crisp during criteria_framing and verdict — every sentence should be citable. Medium length during option_a and option_b to allow observation and nuance. Faster during head_to_head while going criterion-by-criterion. The verdict beat should slow down: viewers need to absorb the recommendation.',
  },
  antiPatterns: [
    'Keeping the verdict until the end — comparison viewers came for the answer, not the journey',
    'Asymmetrical scene budgets — if Option A gets 7 minutes and Option B gets 3, the comparison is not credible',
    'Vague criteria like "ease of use" or "performance" — every criterion must be testable with observable evidence',
    'Introducing new criteria in head_to_head that were not named in criteria_framing',
    'Picking options where one is obviously superior — the comparison must be genuinely contested',
    'Skipping what each option does well — the viewer who uses Option B deserves a fair account of its strengths',
    "Filler ('basically', 'literally', 'essentially', 'um', 'uh')",
    'Verdict that hedges to the point of uselessness — "it depends" is not a verdict; name what it depends on and give a decision tree',
  ],
  ctaPolicy: `
Comparison viewers are often mid-decision. The CTA should meet them
there: "If you are deciding between these for a real project and want
a second opinion, book a consultation — I can help you evaluate for
your specific use case."

Pricing moment only applies if the comparison is about tools Rick
evaluates in client work. If so: "The wrong choice here costs a team
roughly X in rework or migration time — that's why I charge Y to do
this evaluation properly."

CTA priority: consultation booking first (decision-stage viewers are
the highest-intent segment the channel produces), community join second.
`.trim(),
};
