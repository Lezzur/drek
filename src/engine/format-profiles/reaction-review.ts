import type { FormatProfile } from './types.js';

/**
 * `reaction_review` — Commentary on external content: an article, a tool
 * demo, a framework announcement, a competitor video, or a live product. The
 * host's perspective IS the product — the viewer comes for the expert
 * interpretation of something they may have already seen, not to be shown the
 * content itself.
 *
 * Clip/quote licensing: show enough to give the commentary context; do not
 * reproduce the full work. The "amount that is copyrightable" test: if the
 * clip could stand alone as a substitute for the original, it is too long.
 * Show the moment you are reacting to, cut, react.
 *
 * The profile defines 4 reaction_segment beats at 210s each. A shorter
 * reaction can use 3 segments; a longer one can expand segments or add a
 * fifth. The LLM uses sceneRange [6, 9] and the segment descriptions to
 * calibrate depth per segment.
 */

const REACTION_SEGMENT_DESCRIPTION =
  'One major claim, section, or moment from the source. Structure: (1) show the clip or quote — just enough to establish context, no more; (2) state what the source got right; (3) state what it got wrong or missed; (4) add the context or evidence the source is missing. The reaction must add information density — if you are only rephrasing the source, cut the segment. The viewer should finish this beat knowing something they could not get from the source alone.';

export const reaction_review: FormatProfile = {
  id: 'reaction_review',
  displayName: 'Reaction / Review',
  description:
    "Commentary on external content — an article, tool demo, framework announcement, or competitor video. The host's expert interpretation IS the product. Show just enough of the source to give context, then react. The format lives on credibility: say what the viewer could not say themselves after reading the same source.",
  sceneRange: [6, 9],
  runtimeRange: [1200, 2100], // 20-35 minutes
  beats: [
    {
      name: 'cold_open',
      targetDurationSeconds: 30,
      description:
        "Open on the most surprising, contentious, or revealing moment from the source material — the clip or quote that earns the question 'how did you get here?' Then cut to context setup. Do not open by introducing the source neutrally; the viewer can read the title for neutral description. Open on the moment that made you want to react.",
      shotConventions: ['screenshare', 'asset_animated'],
    },
    {
      name: 'context_setup',
      targetDurationSeconds: 120, // 2 min
      description:
        "Identify the source: what it is, who made it, why it is relevant to the channel's audience, and why you are reacting to it specifically now. State your prior — your position on the subject before watching/reading — so the viewer can track whether you updated. Keep this tight; the viewer came for the reaction, not the backstory.",
      shotConventions: ['screenshare'],
    },
    {
      name: 'reaction_a',
      targetDurationSeconds: 210, // 3.5 min
      description: REACTION_SEGMENT_DESCRIPTION,
      shotConventions: ['screenshare', 'diagram_overlay'],
    },
    {
      name: 'reaction_b',
      targetDurationSeconds: 210, // 3.5 min
      description: REACTION_SEGMENT_DESCRIPTION,
      shotConventions: ['screenshare', 'diagram_overlay'],
    },
    {
      name: 'reaction_c',
      targetDurationSeconds: 210, // 3.5 min
      description: REACTION_SEGMENT_DESCRIPTION,
      shotConventions: ['screenshare', 'diagram_overlay'],
    },
    {
      name: 'reaction_d',
      targetDurationSeconds: 210, // 3.5 min
      description: REACTION_SEGMENT_DESCRIPTION,
      shotConventions: ['screenshare', 'diagram_overlay'],
    },
    {
      name: 'synthesis',
      targetDurationSeconds: 180, // 3 min
      description:
        "Pull back from individual segments to the overall pattern. What is the source's core thesis or claim? Is it correct? What did you update on after engaging with it — did it change your position, strengthen it, or leave it unchanged? What is the single most important thing the source got right, and the single most important thing it missed? This beat closes the loop from context_setup where you stated your prior.",
      shotConventions: ['screenshare'],
    },
    {
      name: 'outro',
      targetDurationSeconds: 60, // 1 min
      description:
        "Honest reflection: what surprised you most about the source? CTA: consultation if the source is about something Rick implements for clients ('if you are evaluating [X] for your team and want a practitioner's opinion, that is what I do'). Community if the reaction is likely to produce debate ('drop your take in the comments — I want to know where you disagree').",
      shotConventions: ['headshot'],
    },
  ],
  hookGuidelines: `
Cold open on the most surprising or contentious moment in the source —
not a neutral summary, not an introduction. The viewer should feel,
within 5 seconds, that they are watching someone who has something
distinct to say about this material.

Reaction format hooks live on the gap between what the source claims
and what the host knows from experience. The hook should signal that
gap immediately.

Preferred hook archetypes:
- pattern_interrupt: open on the moment in the source that most
  contradicted your expectations or prior. "I expected X from this
  announcement. Here is what I found instead." Works when the source
  has a notable gap between its framing and its content.
- bold_claim: open with your overall verdict before showing the
  source. "This is the most misleading AI framework comparison I have
  seen in 2026 — and I want to be specific about why." Works when
  the review is negative and the claim is defensible.
- demo_first: show the most striking clip or output from the source
  without commentary, then pull back to context. Works when the
  source material is visually arresting and the reaction is "let me
  tell you what you are actually looking at here."

Avoid:
- story_cold_open: narrative setup before showing the source slows
  down a format that lives on immediacy.
- retention_question: "What do you think of [X]?" as the hook is
  weak — the viewer came to hear YOUR take, not to form their own.
`.trim(),
  pacingRules: {
    wordsPerMinute: 140,
    sentenceLengthGuide:
      'Conversational throughout — the format is inherently dialogue-like, one expert talking through material with the viewer. Medium sentences during reaction segments when building a critique. Short, punchy sentences when landing the most important point of each segment. Slow down during synthesis — this is where the viewer forms their own updated view and needs room to think.',
  },
  antiPatterns: [
    'Showing full clips that could substitute for the original — show just enough for context, then cut and react',
    'Reacting to things the viewer can look up — the reaction must add information density the viewer could not get by reading/watching the source themselves',
    'Reacting without a prior — state your position before engaging with the source so the viewer can track whether you updated',
    'Synthesis beat that just lists what each segment covered — synthesis must say something about the overall pattern and whether your prior changed',
    'Treating every claim in the source as equally worth reacting to — focus segments on the claims that most benefit from expert commentary',
    "Filler ('basically', 'literally', 'essentially', 'um', 'uh')",
    'Reaction that is entirely positive or entirely negative — credibility comes from calibrated assessment, not from cheerleading or dunking',
    'Skipping the context_setup prior statement — the viewer cannot track whether your position changed if they do not know where you started',
  ],
  ctaPolicy: `
Reaction viewers are often evaluating something for themselves —
they watched the source and came to the reaction video for a
practitioner's second opinion. The CTA should meet that intent:
"If you are evaluating [X] for a real project and want someone who
has used it in production, the consultation is the right next step."

Community CTA is strong for this format: reaction videos tend to
generate disagreement, and the comments are where that plays out.
"I want to hear where you disagree — drop your take below" converts
the passive viewer into a participant.

Pricing moment only if the subject of the review is something Rick
is hired to implement. If so, make the connection explicit.
`.trim(),
};
