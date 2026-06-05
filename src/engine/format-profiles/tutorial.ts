import type { FormatProfile } from './types.js';

/**
 * `tutorial` — Procedural, step-by-step walkthrough of building a complete
 * AI system or automation, faceless screen-capture with code/diagram
 * overlays. Contrast with `claude_code_build_along`:
 *
 *   - Build-Along is documentary: watch a real client brief get figured out
 *     live; the conversation IS the show; outcome is implicit.
 *   - Tutorial is procedural: the viewer should be able to rebuild what you
 *     built; the promise IS the show; outcome is explicit and reproducible.
 *
 * Target runtime is 30 minutes — long enough to cover architecture +
 * implementation + hardening + a real demo without skipping eval or
 * observability, short enough that the viewer commits to following along.
 *
 * Subject scope: building AI systems / automations (agents, pipelines,
 * retrieval, orchestration, evals). Tool-agnostic at the structural level —
 * the brief and audience profile determine specific stack references.
 */
export const tutorial: FormatProfile = {
  id: 'tutorial',
  displayName: 'Tutorial',
  description:
    'Procedural, step-by-step walkthrough of building a complete AI system or automation. Faceless screen-capture with code, terminal, and diagram overlays. The viewer should finish the video able to rebuild what you built — not impressed by it, equipped by it. Structure is load-bearing: promise the takeaway in the cold open, deliver it in the body, prove it in the live run.',
  sceneRange: [7, 8],
  runtimeRange: [1500, 2100], // 25-35 minutes; target is 30
  beats: [
    {
      name: 'cold_open',
      targetDurationSeconds: 30,
      description:
        'Show the finished AI system running on a real input for 5-10 seconds. No setup, no narration about what you are about to build — show it working. Then a single sentence that names what the viewer will be able to build by the end. The first 5 words have to land.',
      shotConventions: ['screenshare', 'terminal'],
    },
    {
      name: 'goal_and_prereqs',
      targetDurationSeconds: 240, // 4 min
      description:
        'Name the system you are building in one sentence. State the prereqs concretely: runtime, packages, API keys, starting repo state or commit. The viewer should know within four minutes whether they can follow along. End the beat at a clean starting state on screen.',
      shotConventions: ['screenshare', 'terminal'],
    },
    {
      name: 'architecture',
      targetDurationSeconds: 300, // 5 min
      description:
        'Walk the mental model before any code. Draw or annotate the shape: where the prompt lives, what tools the model can call, how context flows in, how outputs are validated. Name the load-bearing design decision and the cheaper alternative you rejected. The finished diagram is the connective tissue the rest of the video hangs off.',
      shotConventions: ['diagram_overlay', 'screenshare'],
    },
    {
      name: 'implementation_core',
      targetDurationSeconds: 540, // 9 min
      description:
        'Build the primary path end-to-end: the prompt, the tool/function definitions, the orchestration loop. Type in real time; narrate intent and outcome, not the keystrokes. Stop after each meaningful chunk to run it and show the output. Commit checkpoints out loud so viewers following along have anchor points.',
      shotConventions: ['screenshare', 'terminal', 'code_overlay'],
    },
    {
      name: 'implementation_hardening',
      targetDurationSeconds: 360, // 6 min
      description:
        'The upgrade beat. Add what separates a demo from a system: retries on transient model errors, structured output validation, an eval that actually fails on bad outputs, observability into the prompts and tool calls. Show one failure case, show the system catching it.',
      shotConventions: ['screenshare', 'terminal', 'code_overlay'],
    },
    {
      name: 'live_run',
      targetDurationSeconds: 180, // 3 min
      description:
        'Run the finished system on at least two distinct inputs — one normal, one adversarial or edge-case. Show real wall-clock time, real outputs, real token spend. Leave failures in if they happen; recovery is the point.',
      shotConventions: ['screenshare', 'terminal'],
    },
    {
      name: 'extend_and_pitfalls',
      targetDurationSeconds: 90, // 1.5 min
      description:
        'Two or three concrete extensions the viewer should try next, each one sentence. Then two or three traps to avoid (e.g. evaluating by vibes, letting the prompt drift without version control, ignoring token cost at scale). Specific, not generic.',
      shotConventions: ['screenshare', 'diagram_overlay'],
    },
    {
      name: 'outro',
      targetDurationSeconds: 60, // 1 min
      description:
        'Honest reflection on what the build actually took. Mention the repo or starter template (linked in description). CTA: consultation + community + the template link. Pricing moment if a build at this scope is something you sell: "A production version of this on the open market runs between X and Y."',
      shotConventions: ['screenshare'],
    },
  ],
  hookGuidelines: `
Cold open is a PROMISE, not a tease. Tutorials live or die on whether the
viewer believes you will deliver the thing you said you would build. Show
the finished system working in the first 5 seconds, then name the takeaway
in one sentence.

Preferred hook archetypes:
- demo_first: open with the finished AI system handling a real input for
  5-10 seconds, then cut to the promise sentence. Strongest hook for this
  format — proof up front.
- bold_claim: "By the end of this video you will have a working [system]
  running locally." Tutorials are one of the rare formats where bold_claim
  works, because the rest of the video literally delivers the claim.
- retention_question: "What is the one piece almost every AI agent tutorial
  skips? Eval. We are adding it from minute one." Use sparingly; works when
  the missing piece is the actual differentiator.

Avoid:
- pattern_interrupt: opening with the moment the build almost failed reads
  as drama and undercuts the "I will teach you this cleanly" promise. Save
  failure-moments for Build-Along.
- story_cold_open: too narrative. Tutorials are procedural — start with
  proof, not setup.
- "Hey guys, today we're going to build..." style intros. The viewer
  decides whether to keep watching within seconds; spending those seconds
  introducing yourself is how you lose them.
`.trim(),
  pacingRules: {
    wordsPerMinute: 140,
    sentenceLengthGuide:
      'Short and procedural during implementation beats — each step is one or two sentences. Medium length during architecture and pitfalls — concepts need room. Leave 1-2 second pauses after running code so the viewer can read the output. Faster in the live_run beat; let outputs speak.',
  },
  antiPatterns: [
    "Opening with 'Hey guys, today we're going to...'",
    'Showing code before explaining the system shape it lives inside — the viewer needs the architecture diagram first',
    'Starting from a half-configured state — every prereq should be named in goal_and_prereqs and visible at a clean checkpoint',
    'Narrating actions instead of intent — say "we need the SDK so the agent can call tools", not "now I am typing npm install"',
    'Evaluating by vibes — running the system once on a happy-path input and calling it done. The hardening beat must include a failing eval case',
    'Editing out failures the viewer would also hit — leave the failure and the recovery in, that is the whole reason they are watching a tutorial instead of reading the docs',
    'Skipping observability — the model returns text; without seeing prompt + tool calls + token usage the viewer cannot debug their own build',
    "Filler ('basically', 'literally', 'essentially', 'um', 'uh')",
    'Pretending it worked first try when it did not — viewers can tell, and the recovery is more educational than the success',
  ],
  ctaPolicy: `
Outro CTA = consultation booking + community join + repo/template link in
the description. Tutorials uniquely owe the viewer an artifact: the
starter repo, the prompt template, or the eval harness used in the build.
Linking that artifact is non-negotiable — it converts the "I followed
along" viewer into the "I built it" viewer, which is the segment that
becomes inbound leads.

Long-form CTA optimization is the priority over Shorts CTA (per the
channel's funnel math: long-form generates higher revenue per video at
lower view counts). A 30-minute tutorial viewer who finished is the
highest-intent lead the channel produces — the CTA should not waste that
intent. Pair the consultation pitch with a pricing anchor when the build
shown maps to something you would actually sell.
`.trim(),
};
