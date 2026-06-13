import type { FormatProfile } from './types.js';

/**
 * `case_study` — Results-led account of a real client engagement. Opens on
 * the outcome (the number, the transformation, the before/after), then works
 * backward to explain how it happened. The promise is proof, not instruction:
 * the viewer should finish the video convinced that Rick can produce the result
 * they just saw, not equipped to reproduce it themselves (contrast: tutorial).
 *
 * Structure is load-bearing: the result must appear in the first 30 seconds.
 * Any cold open that opens on the problem instead of the outcome will lose the
 * viewer before the story earns their attention.
 */
export const case_study: FormatProfile = {
  id: 'case_study',
  displayName: 'Case Study',
  description:
    'Results-led account of a real client engagement. Opens on the outcome — the number, the transformation, the before/after — then works backward through context, approach, and build to explain how it happened. The promise is proof, not instruction.',
  sceneRange: [5, 7],
  runtimeRange: [1080, 1500], // 18-25 minutes
  beats: [
    {
      name: 'cold_open',
      targetDurationSeconds: 30,
      description:
        'Open on the result. Show the outcome metric, the finished system running, or the client reaction — not the problem. The viewer decides in 5 seconds whether this result is relevant to them. Do not explain; do not set up. Show it, then cut.',
      shotConventions: ['screenshare', 'asset_animated'],
    },
    {
      name: 'client_context',
      targetDurationSeconds: 180, // 3 min
      description:
        'Who the client is (enough to make the problem concrete — not a full company history), what they were trying to do, and what had failed or was missing before this engagement. Keep it tight: one sentence per fact. The viewer is here for the solution, not the backstory.',
      shotConventions: ['screenshare'],
    },
    {
      name: 'approach_reveal',
      targetDurationSeconds: 180, // 3 min
      description:
        'The key architectural or strategic decision — the one choice that made the result possible. Name the cheaper or more obvious alternative that was rejected and why. Draw or annotate the shape of the solution before showing any code. This beat is the connective tissue between the problem and the build.',
      shotConventions: ['diagram_overlay', 'screenshare'],
    },
    {
      name: 'build_walkthrough',
      targetDurationSeconds: 480, // 8 min
      description:
        'Walk through the build at the level of "how it works" not "how to reproduce it." Show the interesting parts — the part that was harder than expected, the part that surprised you, the part the client specifically cared about. Narrate decisions, not keystrokes. The viewer should understand the system without being able to rebuild it from memory.',
      shotConventions: ['screenshare', 'terminal', 'diagram_overlay'],
    },
    {
      name: 'live_result',
      targetDurationSeconds: 180, // 3 min
      description:
        'Show the system producing the result from the cold open — in real time, with real data, no cuts. If the result was a metric (cost savings, time saved, leads generated), show the evidence: a dashboard, a report, a before/after comparison. This beat closes the loop opened in the cold open.',
      shotConventions: ['screenshare', 'web-ui'],
    },
    {
      name: 'outro',
      targetDurationSeconds: 60, // 1 min
      description:
        'Honest reflection: what was harder than expected, what you would do differently next time. Pricing moment: "A system like this on the open market runs between X and Y." CTA: consultation booking + community join. Do not pitch the viewer on something unrelated to what they just watched.',
      shotConventions: ['headshot'],
    },
  ],
  hookGuidelines: `
Cold open MUST show the result — not the problem, not the setup, not a
teaser line. The outcome metric, the working system, the before/after
transformation. The viewer is filtering for relevance within the first
5 seconds: "is the result of this case study something my situation
could produce?" Give them that answer immediately.

Preferred hook archetypes:
- demo_first: show the finished system or dashboard running on real client
  data for 5-10 seconds, then cut to the story. Strongest hook for case
  studies — proof up front, story pays it off.
- bold_claim: lead with the outcome number. "We cut their lead response
  time from 4 hours to 8 minutes." Works when the metric is dramatic
  enough to be credible but surprising enough to earn attention.

Avoid:
- story_cold_open: opening on the client's problem delays the result the
  viewer came to see. Case studies earn trust through outcomes, not
  through narrative setup.
- retention_question: "What if I told you..." type hooks undercut the
  documentary credibility that makes case studies work.
- pattern_interrupt: failure-moment openings suggest the build went wrong.
  Case studies need to open with success — the failure moments belong in
  build_walkthrough, not the hook.
`.trim(),
  pacingRules: {
    wordsPerMinute: 140,
    sentenceLengthGuide:
      'Conversational during client_context and outro. Short and specific during approach_reveal — each decision gets one sentence. Faster during build_walkthrough to match the screen action. Slow down on the live_result beat so the viewer can absorb the evidence.',
  },
  antiPatterns: [
    'Opening on the problem instead of the result — the result must appear in the first 30 seconds',
    "Narrating the client's full company history in client_context — one sentence per fact, maximum",
    'Showing code in tutorial-level detail — the viewer wants to understand the system, not reproduce it',
    'Skipping the approach_reveal beat and going straight from context to build — the architectural decision is the most transferable part of any case study',
    "Pricing moment that doesn't connect to the scope of what was shown — the number must feel like a natural consequence of the build",
    "Filler ('basically', 'literally', 'essentially', 'um', 'uh')",
    "Outro CTA that doesn't reference consultation — case study viewers are highest-intent leads; waste that with a generic subscribe ask",
  ],
  ctaPolicy: `
Case study viewers have watched proof of a specific outcome. The CTA
must connect to that outcome: "If your business needs [the thing you
just saw], book a consultation — link in the description." Do not
pivot to a generic channel pitch.

Pricing moment is non-negotiable: name the market-rate range for the
type of work shown. The viewer who is price-anchored is the viewer who
books — the viewer who isn't will ask budget questions in the discovery
call instead of committing.

CTA priority: consultation booking first, community join second.
`.trim(),
};
