import type { FormatProfile } from './types.js';

/**
 * `claude_code_build_along` — DREK v2's default format. Implements "The
 * Gauntlet" structure from the YouTube Channel Master Document. Faceless,
 * screen-recorded build of a real client brief using Claude Code. The
 * conversation between Rick and Claude IS the show.
 *
 * Reference: TECH-SPEC-drek-v2-youtube-2026-05-18.md §8.1.
 */
export const claude_code_build_along: FormatProfile = {
  id: 'claude_code_build_along',
  displayName: 'Claude Code Build-Along',
  description:
    'Faceless, screen-recorded build of a real client brief using Claude Code. Conversation-angle: the dialogue with Claude IS the show. Implements "The Gauntlet" structure from the channel master doc.',
  sceneRange: [5, 7],
  runtimeRange: [1500, 2100], // 25-35 minutes
  beats: [
    {
      name: 'cold_open',
      targetDurationSeconds: 30,
      description:
        'Flash the finished demo, no context, cut to black + title card. The first 5 words must land.',
      shotConventions: ['screenshare', 'asset_animated'],
    },
    {
      name: 'problem',
      targetDurationSeconds: 270, // 4.5 min midpoint of 4-5 min
      description:
        'Read the brief like a detective. Pull out the real problem hiding in the client words. End with one sharp mission statement.',
      shotConventions: ['screenshare'],
    },
    {
      name: 'war_room',
      targetDurationSeconds: 480, // 8 min
      description:
        'Brainstorm + architecture collapsed into one fast segment. Rick and Claude going back and forth, diagram building live on screen. Every decision gets one sentence of justification. The finished diagram IS the connective tissue map.',
      shotConventions: ['screenshare', 'diagram_overlay'],
    },
    {
      name: 'build_reel',
      targetDurationSeconds: 600, // 10 min
      description:
        'Fast-cut Claude Code session. Narrate only interesting moments — the pivot, the fix, the unexpected solution. Terminal is b-roll; your voice is the main track.',
      shotConventions: ['screenshare', 'terminal'],
    },
    {
      name: 'breakdown',
      targetDurationSeconds: 240, // 4 min
      description:
        'Walk through the finished system AFTER the build — explanation and validation in one. Why each service earned its place.',
      shotConventions: ['screenshare', 'diagram_overlay'],
    },
    {
      name: 'demo',
      targetDurationSeconds: 240, // 4 min
      description:
        'Clean live run of the working product. No cuts. Real time. Glitches stay in.',
      shotConventions: ['screenshare', 'web-ui'],
    },
    {
      name: 'outro',
      targetDurationSeconds: 60, // 1 min
      description:
        'Honest reflection. What was harder than expected. What you would do differently. Pricing moment: "A build like this on the open market runs between X and Y." CTA: consultation + community.',
      shotConventions: ['headshot'],
    },
  ],
  hookGuidelines: `
Cold open MUST be FROM the finished product, not a setup line. The first
5 words have to land — the viewer decides within seconds whether to keep
watching.

Preferred hook archetypes:
- demo_first: show the finished thing working for 3-5 seconds, then cut.
- pattern_interrupt: open with the moment the build almost failed.

Avoid:
- bold_claim: reads as marketing, breaks the documentary tone.
- "Hey guys, today we're going to..." style intros.
- Setup lines that delay the demo reveal past second 3.
`.trim(),
  pacingRules: {
    wordsPerMinute: 150,
    sentenceLengthGuide:
      'Mix short and medium. build_reel can go faster; war_room allows slower deliberation. Leave 1-2 second pauses after big claims.',
  },
  antiPatterns: [
    "Opening with 'Hey guys, today we're going to...'",
    'Showing the brief without first showing the result it produced',
    'Architecture diagram that never finishes drawing on screen — viewer needs to see the completed shape',
    'Narrating what Claude is doing while it does it — narrate intent and outcome, let the action play',
    "Outro that doesn't land a pricing moment",
    "Filler ('basically', 'literally', 'essentially', 'um', 'uh')",
  ],
  ctaPolicy: `
Outro CTA = consultation booking + community join. Long-form CTA
optimization is the priority over Shorts CTA (per Nami's funnel math:
long-form generates 3.3× revenue per video at 1/4 the views). The
viewer who finished 25-35 minutes is the highest-intent lead the channel
will produce — the CTA should not waste that intent.
`.trim(),
};
