import type { FormatProfile } from './types.js';

/**
 * `listicle` — Fast-paced enumeration of N items, each getting ~90 seconds.
 * Opens with the number and the stakes (why this list matters now), delivers
 * each item with exactly one insight and one demonstration, recaps the list
 * with the most actionable takeaways, and closes.
 *
 * The profile defines 8 item beats (item_a through item_h) at 90 seconds each,
 * totalling ~15 minutes with structural beats. The LLM may produce 7-10 scenes
 * in the item range depending on sceneRange; the profile is a representative
 * 8-item template. Cut any item that does not survive "would I post this
 * standalone?" — a shorter list of stronger items beats a padded one.
 *
 * Typical use: "7 Claude Code features most developers don't know about",
 * "5 mistakes that kill AI agent reliability", "10 Exa.ai queries that
 * changed how I do client research."
 */

const ITEM_BEAT_DESCRIPTION =
  'Name the item in the first 5 words. Give one sharp insight — the non-obvious part, the thing that is easy to miss, the thing that changes how you use the tool or approach the problem. Show it working in one demonstration: a terminal run, a code snippet, a before/after comparison. Land one actionable takeaway sentence. Cut. Do not add context or caveats that belong in a tutorial. Every item follows the same structure: name → insight → demo → takeaway.';

export const listicle: FormatProfile = {
  id: 'listicle',
  displayName: 'Listicle',
  description:
    'Fast-paced enumeration of 7-10 items, each given ~90 seconds. Opens with the number and the stakes. One insight + one demonstration per item, no throat-clearing between items. Cut to the item count that survives "would I post this item standalone?" — do not pad to reach a rounder number.',
  sceneRange: [10, 12],
  runtimeRange: [900, 1200], // 15-20 minutes
  beats: [
    {
      name: 'cold_open',
      targetDurationSeconds: 30,
      description:
        'State the number and the stakes in two sentences. "8 Claude Code features most developers do not know about — and at least three of them will change how you use it." Do not tease individual items; tease the value of the whole list. The viewer should commit to the full runtime in the first 10 seconds.',
      shotConventions: ['screenshare'],
    },
    {
      name: 'item_a',
      targetDurationSeconds: 90,
      description: ITEM_BEAT_DESCRIPTION,
      shotConventions: ['screenshare', 'terminal', 'code_overlay'],
    },
    {
      name: 'item_b',
      targetDurationSeconds: 90,
      description: ITEM_BEAT_DESCRIPTION,
      shotConventions: ['screenshare', 'terminal', 'code_overlay'],
    },
    {
      name: 'item_c',
      targetDurationSeconds: 90,
      description: ITEM_BEAT_DESCRIPTION,
      shotConventions: ['screenshare', 'terminal', 'code_overlay'],
    },
    {
      name: 'item_d',
      targetDurationSeconds: 90,
      description: ITEM_BEAT_DESCRIPTION,
      shotConventions: ['screenshare', 'terminal', 'code_overlay'],
    },
    {
      name: 'item_e',
      targetDurationSeconds: 90,
      description: ITEM_BEAT_DESCRIPTION,
      shotConventions: ['screenshare', 'terminal', 'code_overlay'],
    },
    {
      name: 'item_f',
      targetDurationSeconds: 90,
      description: ITEM_BEAT_DESCRIPTION,
      shotConventions: ['screenshare', 'terminal', 'code_overlay'],
    },
    {
      name: 'item_g',
      targetDurationSeconds: 90,
      description: ITEM_BEAT_DESCRIPTION,
      shotConventions: ['screenshare', 'terminal', 'code_overlay'],
    },
    {
      name: 'item_h',
      targetDurationSeconds: 90,
      description: ITEM_BEAT_DESCRIPTION,
      shotConventions: ['screenshare', 'terminal', 'code_overlay'],
    },
    {
      name: 'recap',
      targetDurationSeconds: 90,
      description:
        'Name all items in sequence, one sentence each. For each item, state the single most actionable takeaway rather than restating the insight. The recap should feel like a checklist the viewer can act on immediately. Pace is faster here — the viewer has seen all of this already.',
      shotConventions: ['screenshare'],
    },
    {
      name: 'outro',
      targetDurationSeconds: 60,
      description:
        'Honest reflection: which item on the list do you use most in your own client work? Pricing moment if the list is about a billable skill: "Knowing these saves or earns [X] per engagement." CTA: consultation booking + community join. Keep it short — the viewer came for the list, not the debrief.',
      shotConventions: ['headshot'],
    },
  ],
  hookGuidelines: `
Cold open states the number and the stakes immediately. No preamble,
no "today we are going to cover," no setup. "8 things. 90 seconds
each. Here is why item 3 alone is worth the runtime."

The title archetype for listicle hooks is already baked into the
format — the number IS the hook. The cold open's job is to make
the number feel earned before the viewer has seen a single item.

Preferred hook archetypes:
- bold_claim: pair the number with a strong claim about the list.
  "Most developers are using Claude Code at 30% capacity — these
  8 features are the other 70%." Works when the list reveals a gap
  or unlock the viewer didn't know they were missing.
- retention_question: "Which of these 8 Claude Code features did
  you already know? Most developers I show this list to miss at
  least 4." Works when the list is genuinely surprising for the
  target audience.
- demo_first: open on the most visually arresting item on the list,
  then pull back to the list structure. Works when item N is so
  surprising that showing it earns the viewer's commitment to
  see how the others compare.

Avoid:
- story_cold_open: listicle is density-led. Narrative preamble
  signals to the viewer that the list will be padded. Open on
  the number.
- pattern_interrupt: out-of-place in a format that promises
  structure. The viewer came for a list; start the list.
`.trim(),
  pacingRules: {
    wordsPerMinute: 200,
    sentenceLengthGuide:
      'Short and punchy throughout — every sentence in the item beats should fit in a tweet. Each item follows the same structure: name (5 words max) → insight (one sentence) → demo (let the screen run) → takeaway (one sentence). The recap beat can go even faster. Only slow down on the outro.',
  },
  antiPatterns: [
    'Padding items to a rounder number — 7 strong items beats 10 weak ones; cut any item that does not survive standalone',
    "Throat-clearing before or after each item — go directly: name → insight → demo → takeaway → cut to next item",
    'Items that are too abstract to demonstrate — every item must have a visible, screen-recordable demo',
    'Unequal item depth — if one item gets 4 minutes and another gets 30 seconds, the list structure has broken down',
    'Saving the best item for last to create suspense — this format is not a mystery; lead with strength or distribute strong items evenly',
    "Filler ('basically', 'literally', 'essentially', 'um', 'uh') — especially damaging at 200 WPM where every word is expensive",
    'Recap that restates insights instead of stating takeaways — the recap is a checklist, not a summary',
    'Items that require prerequisite knowledge from earlier items — each item must stand alone',
  ],
  ctaPolicy: `
Listicle viewers tend to be in discovery mode — sampling tools and
techniques at high speed. The CTA should match the mode: "If you
want help applying these to a real project, that is what consultation
is for."

Pricing moment is optional and only works if the list is about a
billable skill: "Knowing these 8 techniques saves roughly [X] hours
per client project."

CTA priority: community join first (discovery-mode viewers are more
likely to follow for more lists than to book immediately),
consultation second.
`.trim(),
};
