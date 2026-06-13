import type { FormatProfile } from './types.js';

/**
 * `essay_opinion` — Single-argument opinion piece. Opens with the thesis cold,
 * builds evidence through two or three supporting threads, steelmans the
 * opposing view, rebuts it, and lands a conclusion that advances the argument
 * rather than merely restating it. The format is unscripted in tone but
 * rigorous in structure.
 *
 * The key constraint: the thesis must be falsifiable, or it isn't an argument.
 * "AI tools are changing development" is not a thesis — it's an observation.
 * "Claude Code is a better pairing for client work than Cursor because it
 * externalizes the reasoning loop" is a thesis. The steelman beat exists to
 * prove the thesis was tested against its strongest opposition, not protected
 * from it.
 */
export const essay_opinion: FormatProfile = {
  id: 'essay_opinion',
  displayName: 'Essay / Opinion',
  description:
    'Single-argument opinion piece. Opens with the thesis cold, builds evidence through supporting threads, steelmans the opposing view, rebuts it, and lands a conclusion that advances rather than restates. The thesis must be falsifiable — an observation is not an argument.',
  sceneRange: [6, 8],
  runtimeRange: [1080, 1500], // 18-25 minutes
  beats: [
    {
      name: 'cold_open',
      targetDurationSeconds: 30,
      description:
        'State the thesis cold — the controversial, surprising, or counterintuitive claim the whole video exists to argue. Do not set up, contextualize, or hedge before landing it. The viewer decides whether to keep watching based on whether the thesis is worth arguing about. If the claim needs two sentences of setup before it sounds interesting, the claim is not sharp enough.',
      shotConventions: ['screenshare'],
    },
    {
      name: 'thesis',
      targetDurationSeconds: 120, // 2 min
      description:
        'Expand the thesis from the cold open into a precise, citable claim. Define any terms that could be argued about. Name what the argument is NOT claiming (to pre-empt obvious misreadings). State what evidence would falsify the thesis — this signals to the viewer that this is an argument, not a rant. End the beat with a one-sentence roadmap: "I am going to make this case in three parts."',
      shotConventions: ['screenshare'],
    },
    {
      name: 'evidence_core',
      targetDurationSeconds: 360, // 6 min
      description:
        'The primary evidence. Show, do not just assert: demonstrations, data, concrete examples from real work. The strongest evidence should come first, before the viewer has decided whether to engage. Each piece of evidence should be citable — a viewer pausing the video should be able to write down "he said X because Y." Do not pad with background the viewer can look up.',
      shotConventions: ['screenshare', 'diagram_overlay'],
    },
    {
      name: 'evidence_support',
      targetDurationSeconds: 240, // 4 min
      description:
        'Secondary evidence threads — complementary arguments that reinforce the core claim from different angles. These might be: a historical analogy, a second domain where the same pattern holds, or a consequence of the thesis that is independently verifiable. Do not simply repeat evidence_core with different examples. Each thread should make the thesis harder to dismiss in a distinct way.',
      shotConventions: ['screenshare', 'diagram_overlay'],
    },
    {
      name: 'steelman',
      targetDurationSeconds: 180, // 3 min
      description:
        'State the strongest version of the opposing argument — stronger than most opponents would state it themselves. The steelman should be uncomfortable: if it is easy to dismiss, it is not a steelman. The viewer who disagrees with the thesis should feel, at the end of this beat, that you have genuinely understood their position. Slow down here; the viewer who disagrees is listening hardest.',
      shotConventions: ['screenshare'],
    },
    {
      name: 'rebuttal',
      targetDurationSeconds: 120, // 2 min
      description:
        'Rebut the steelman. The rebuttal must engage with the steelman as stated, not a weaker version. Concede anything in the opposing view that is genuinely correct (this strengthens, not weakens, the rebuttal). The goal is not to win — it is to show that the opposing view, even at its strongest, does not overturn the thesis.',
      shotConventions: ['screenshare'],
    },
    {
      name: 'outro',
      targetDurationSeconds: 60, // 1 min
      description:
        'Advance the argument — do not just restate the thesis. What should the viewer DO differently given that the thesis is true? What is the implication for their work, their tool choices, their mental model? CTA: consultation for viewers whose work is affected by the argument, community for viewers who want to continue the debate.',
      shotConventions: ['screenshare', 'headshot'],
    },
  ],
  hookGuidelines: `
Cold open states the thesis immediately — the controversial, surprising,
or counterintuitive claim. No setup. No context. No hedge. The viewer
is filtering for "is this argument worth my time?" in the first 5
seconds. Make the claim sharp enough that the answer is yes.

A sharp thesis is one that a reasonable person could disagree with.
"AI coding tools are getting better" is not a thesis. "The case for
Claude Code over Cursor is strongest for consultants, not for product
engineers — and the industry has the advice backwards" is a thesis.

Preferred hook archetypes:
- bold_claim: state the thesis as a strong, citable claim. Most
  effective for this format because the thesis IS the hook. The
  viewer who agrees wants validation; the viewer who disagrees wants
  to rebut; both stay.
- pattern_interrupt: open with the moment the evidence crystallized —
  the thing you saw or built that made the thesis inescapable — then
  state the thesis. Works when the evidence is more surprising than
  the claim itself.
- retention_question: frame the thesis as a question the video will
  answer definitively. "Is Claude Code actually better for client
  work, or is this just a Anthropic preference?" Works when the
  question is genuinely contested and the viewer cannot guess the
  answer from the channel's prior positioning.

Avoid:
- demo_first: essays are argument-led, not evidence-led. Opening on
  a demo delays the claim the viewer needs to decide whether to engage.
- story_cold_open: narrative setup before the thesis loses viewers
  who came for the argument.
`.trim(),
  pacingRules: {
    wordsPerMinute: 160,
    sentenceLengthGuide:
      'Longer sentences during evidence_core and evidence_support to build the argument — claims need their supporting clauses. Short, punchy sentences for thesis and cold_open — the claim must be quotable. Slow down during steelman; the viewer who disagrees is listening hardest and deserves to feel heard. Medium length during rebuttal — systematic, not aggressive.',
  },
  antiPatterns: [
    'Opening with setup or context before the thesis — state the claim cold',
    'A thesis that is not falsifiable ("AI is transforming development") — the claim must be one a reasonable person could dispute',
    'A steelman that misrepresents or weakens the opposing view — steelman means strongest version, not strawman',
    'Rebuttal that does not engage with the steelman as stated — address the argument, not a weaker version',
    'Conclusion that just restates the thesis — advance the argument; tell the viewer what to do differently',
    'Evidence that asserts instead of shows — every claim needs a demonstration, data point, or concrete example from real work',
    "Filler ('basically', 'literally', 'essentially', 'um', 'uh')",
    'Hedging the thesis mid-video — if new evidence makes the claim untenable, say so explicitly; do not quietly weaken it',
  ],
  ctaPolicy: `
Essay viewers engaged with an argument. The CTA should connect to
the practical implication of the thesis: "If the argument is correct,
here is what you should do about it — and if you want help applying
it to your specific situation, that is what the consultation is for."

Pricing moment applies when the thesis is about a choice Rick gets
hired to make for clients (tool selection, architecture decisions,
process design). If so: "I charge [X] to work through this decision
with a team — the cost of getting it wrong is [Y]."

Do not use a generic CTA that ignores the argument the viewer just
engaged with for 20 minutes.
`.trim(),
};
