import type { Firestore } from 'firebase-admin/firestore';
import { z } from 'zod';
import { logger } from '../logger.js';
import { getLLMProvider, LLMProviderError, type LLMProvider } from '../providers/index.js';
import { getPlan, patchPlan } from '../db/plans.js';
import { createScene, listScenes, deleteScene } from '../db/scenes.js';
import { findLongFormDeliverable, DeliverableNotFoundError } from '../db/deliverables.js';
import {
  SCENE_INTERFACE_TYPES,
  type Plan,
  type Scene,
} from '../db/schemas.js';
import { extractJson } from './json-utils.js';
import { PlanningEngineError } from './errors.js';
import {
  compositionRulesToPrompt,
  getCompositionRules,
  runtimeToWordCount,
  runtimeToSceneRange,
} from './composition-rules.js';
import { getFormatProfile, FormatProfileNotFoundError, type FormatProfile } from './format-profiles/index.js';
import { getAudienceProfileClient } from '../neurocore/audience-profiles.js';
import { buildSystemPrompt } from './compose-prompt.js';

/**
 * Call 3 of the four-step pipeline: scene generation.
 *
 * Takes a plan with confirmed requirements (cover_letter) or topic
 * (youtube) plus matched projects, and produces a list of scene cards
 * — title, description, framing notes, project ref, estimated duration —
 * but NOT scripts. Call 4 (write-scripts) fills the scripts in.
 *
 * On success, persists each scene as a doc under plans/{id}/scenes and
 * leaves plan.status at projects_matched. The transition to
 * scenes_generated happens after script writing completes (M6 Call 4).
 *
 * Re-runnable: existing scenes for the plan are deleted before the new
 * batch is written. This is the right UX for "regenerate scenes" — Rick
 * gets a fresh take, not a confusing merge.
 */

const STEP_NAME = 'generate-scenes';
const MAX_PORTFOLIO_CHARS = 30_000;

// LLM emits scenes without ids/planId/order — we assign those during persist.
// `script` is included optionally so the model can pre-stage script direction
// hints; Call 4 overwrites them with full spoken text.
const generatedSceneSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().min(1),
  framingNotes: z.string().min(1),
  projectRef: z.string().nullable().optional(),
  estimatedDurationSeconds: z.number().int().nonnegative().optional(),
  interfaceType: z.enum(SCENE_INTERFACE_TYPES).optional(),
});
type GeneratedScene = z.infer<typeof generatedSceneSchema>;
const generatedScenesArraySchema = z.array(generatedSceneSchema).min(1).max(20);

// v2 youtube_advanced scene schema — includes beatTag required from the format profile.
const v2GeneratedSceneSchema = z.object({
  beatTag: z.string().min(1),
  title: z.string().min(1).max(200),
  description: z.string().min(1),
  framingNotes: z.string().min(1),
  estimatedDurationSeconds: z.number().int().nonnegative(),
  projectRef: z.string().nullable().optional(),
});
type V2GeneratedScene = z.infer<typeof v2GeneratedSceneSchema>;
// No min/max here — we validate count against sceneRange from the format profile.
const v2GeneratedScenesArraySchema = z.array(v2GeneratedSceneSchema);

interface GenerateScenesOptions {
  provider?: LLMProvider;
  db?: Firestore;
  /** Override per-call LLM timeout. Defaults to 60s for generate-scenes. */
  timeoutMs?: number;
}

export interface GenerateScenesResult {
  plan: Plan;
  scenes: Scene[];
  retried: boolean;
  durationMs: number;
}

export async function generateScenes(
  planId: string,
  opts: GenerateScenesOptions = {},
): Promise<GenerateScenesResult> {
  const t0 = Date.now();
  const provider = opts.provider ?? await getLLMProvider();
  const DEFAULT_TIMEOUT_MS = 60_000;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // ---- Load plan -------------------------------------------------------
  const plan = await getPlan(planId, opts.db);
  if (!plan) {
    throw new PlanningEngineError(STEP_NAME, 'PLAN_NOT_FOUND', `no plan with id ${planId}`, {
      planId,
    });
  }

  // ---- Dispatch by plan type -------------------------------------------
  if (plan.type === 'youtube_advanced') {
    return generateScenesYoutubeAdvanced(planId, plan, provider, timeoutMs, opts, t0);
  }

  // ---- v1 path: cover_letter + youtube_lite (BYTE-IDENTICAL to original) --
  return generateScenesV1(planId, plan, provider, timeoutMs, opts, t0);
}

// ---------------------------------------------------------------------------
// v1 cover_letter + youtube_lite path — BYTE-IDENTICAL logic to original
// ---------------------------------------------------------------------------

async function generateScenesV1(
  planId: string,
  plan: Plan,
  provider: LLMProvider,
  timeoutMs: number,
  opts: GenerateScenesOptions,
  t0: number,
): Promise<GenerateScenesResult> {
  // Allow entry from projects_matched (forward) or scenes_generated (regen).
  if (plan.status !== 'projects_matched' && plan.status !== 'scenes_generated') {
    throw new PlanningEngineError(
      STEP_NAME,
      'WRONG_PLAN_STATUS',
      `scene generation requires projects_matched or scenes_generated, got ${plan.status}`,
      { planId },
    );
  }
  if (plan.matchedProjects.length === 0) {
    throw new PlanningEngineError(
      STEP_NAME,
      'NO_PROJECT_MATCHES',
      'plan has no matched projects — run project matching (M5) first',
      { planId },
    );
  }

  // ---- Build prompt and call LLM ------------------------------------
  const basePrompt = buildPrompt(plan);
  let retried = false;
  let generated: GeneratedScene[];

  try {
    const raw = await invokeLLM(provider, basePrompt, timeoutMs);
    const parsed = tryParseGeneratedScenes(raw);
    if (parsed.ok) {
      generated = parsed.value;
    } else {
      retried = true;
      const stricter = `${basePrompt}\n\nIMPORTANT: Your previous response was not parseable. Respond with ONLY a JSON array — no fences, no prose. Start with [ and end with ].`;
      const raw2 = await invokeLLM(provider, stricter, timeoutMs);
      const parsed2 = tryParseGeneratedScenes(raw2);
      if (!parsed2.ok) {
        throw new PlanningEngineError(
          STEP_NAME,
          'INVALID_OUTPUT',
          `LLM output did not parse as scenes after retry: ${parsed2.reason}`,
          { planId, detail: parsed2.detail },
        );
      }
      generated = parsed2.value;
    }
  } catch (err) {
    if (err instanceof PlanningEngineError) throw err;
    if (err instanceof LLMProviderError) {
      throw new PlanningEngineError(
        STEP_NAME,
        'LLM_FAILED',
        `${err.providerName} CLI failed: ${err.message}`,
        { planId, detail: { providerCode: err.code } },
      );
    }
    throw err;
  }

  // ---- Wipe existing scenes (clean regenerate) ---------------------
  try {
    const existing = await listScenes(planId, opts.db);
    for (const old of existing) {
      await deleteScene(planId, old.id, opts.db);
    }
  } catch (err) {
    throw new PlanningEngineError(
      STEP_NAME,
      'PERSIST_FAILED',
      `failed to clear old scenes: ${(err as Error).message}`,
      { planId },
    );
  }

  // ---- Persist new scenes ------------------------------------------
  const created: Scene[] = [];
  try {
    for (let i = 0; i < generated.length; i++) {
      const g = generated[i]!;
      const scene = await createScene(
        planId,
        {
          title: g.title,
          description: g.description,
          framingNotes: g.framingNotes,
          script: '', // Call 4 fills this in
          order: i + 1,
          estimatedDurationSeconds: g.estimatedDurationSeconds ?? 0,
          projectRef: g.projectRef ?? null,
        },
        opts.db,
      );
      created.push(scene);
    }
  } catch (err) {
    throw new PlanningEngineError(
      STEP_NAME,
      'PERSIST_FAILED',
      `failed to persist scene ${created.length + 1}: ${(err as Error).message}`,
      { planId },
    );
  }

  const durationMs = Date.now() - t0;
  logger.info(
    {
      planId,
      planType: plan.type,
      sceneCount: created.length,
      retried,
      durationMs,
    },
    'scene generation complete',
  );
  return { plan, scenes: created, retried, durationMs };
}

// ---------------------------------------------------------------------------
// v2 youtube_advanced path
// ---------------------------------------------------------------------------

async function generateScenesYoutubeAdvanced(
  planId: string,
  plan: Plan,
  provider: LLMProvider,
  timeoutMs: number,
  opts: GenerateScenesOptions,
  t0: number,
): Promise<GenerateScenesResult> {
  // ---- Pre-conditions --------------------------------------------------

  if (plan.status !== 'projects_matched' && plan.status !== 'scenes_generated') {
    throw new PlanningEngineError(
      STEP_NAME,
      'WRONG_PLAN_STATUS',
      `youtube_advanced scene generation requires projects_matched or scenes_generated, got ${plan.status}`,
      { planId },
    );
  }
  if (plan.matchedProjects.length === 0) {
    throw new PlanningEngineError(
      STEP_NAME,
      'NO_PROJECT_MATCHES',
      'plan has no matched projects — run project matching first',
      { planId },
    );
  }
  if (!plan.formatProfileId) {
    throw new PlanningEngineError(
      STEP_NAME,
      'NO_FORMAT_PROFILE',
      'youtube_advanced plan has no formatProfileId',
      { planId },
    );
  }

  let formatProfile: FormatProfile;
  try {
    formatProfile = getFormatProfile(plan.formatProfileId);
  } catch (err) {
    if (err instanceof FormatProfileNotFoundError) {
      throw new PlanningEngineError(
        STEP_NAME,
        'NO_FORMAT_PROFILE',
        `formatProfileId "${plan.formatProfileId}" not found in registry`,
        { planId },
      );
    }
    throw err;
  }

  // Resolve audience profile from the long_form Deliverable.
  let longFormDeliverable;
  try {
    longFormDeliverable = await findLongFormDeliverable(planId, opts.db);
  } catch (err) {
    if (err instanceof DeliverableNotFoundError) {
      throw new PlanningEngineError(
        STEP_NAME,
        'NO_LONG_FORM_DELIVERABLE',
        `no long_form Deliverable found for plan ${planId}`,
        { planId },
      );
    }
    throw err;
  }

  const audienceProfile = await getAudienceProfileClient().get(longFormDeliverable.audienceProfileId);

  // Build episode requirements context from the encoded episode_plan requirement.
  const episodePlanReq = plan.requirements.find((r) => r.skill === 'episode_plan');
  const episodePlanText = episodePlanReq
    ? `EPISODE PLAN:\n${episodePlanReq.evidence}`
    : '(no episode plan yet — generate scenes from matched projects)';

  // ---- Build system prompt and task instructions -----------------------
  const [minScenes, maxScenes] = formatProfile.sceneRange;
  const beatNames = formatProfile.beats.map((b) => b.name).join(', ');
  const beatDetails = formatProfile.beats
    .map((b) => `  - ${b.name}: ~${b.targetDurationSeconds}s — ${b.description}`)
    .join('\n');
  const targetRuntime = formatProfile.runtimeRange[0] + formatProfile.runtimeRange[1]; // sum, divide below
  const midRuntime = Math.round((formatProfile.runtimeRange[0] + formatProfile.runtimeRange[1]) / 2);

  const taskInstructions = `Generate ${minScenes}-${maxScenes} scene cards for this episode. The scene count MUST fall within [${minScenes}, ${maxScenes}].

Each scene must:
- Be tagged with \`beatTag\` set to one of the format profile beat names listed below (use them in order)
- Have a title, description, framingNotes (free-text), and estimatedDurationSeconds aligned to the beat's target
- NOT include a script yet (scripts are written in a later step)

Beat names (in order): ${beatNames}
Beat details:
${beatDetails}

Target episode runtime: ~${midRuntime}s. Sum of estimatedDurationSeconds should be within ±25% of target.

Matched projects (use projectSlug for projectRef, or null for non-project scenes):
${plan.matchedProjects.map((p, i) => `  ${i + 1}. ${p.projectName} (slug: ${p.projectSlug})`).join('\n')}

${episodePlanText}

Return a JSON array of scene objects:
[
  {
    "beatTag": "<beat name from the list above>",
    "title": "...",
    "description": "...",
    "framingNotes": "...",
    "estimatedDurationSeconds": <int>,
    "projectRef": "<project slug if applicable, else null>"
  },
  ...
]

RULES:
- Scene count MUST be ${minScenes}-${maxScenes}. No exceptions.
- Every beatTag MUST be one of: ${beatNames}
- Output JSON ONLY. No fences, no prose. Start with [ and end with ].`;

  const systemPrompt = buildSystemPrompt({
    formatProfile,
    audienceProfile,
    taskInstructions,
  });

  const portfolioBlock = plan.matchedProjects
    .map((p, i) => {
      const feats = p.matchedFeatures.map((f) => `      - ${f}`).join('\n');
      return [
        `Project ${i + 1}: ${p.projectName} (slug: ${p.projectSlug}, relevance: ${p.relevanceScore.toFixed(2)})`,
        '  Matched features:',
        feats,
        `  Suggested demo sequence: ${p.suggestedDemoSequence}`,
      ].join('\n');
    })
    .join('\n\n')
    .slice(0, MAX_PORTFOLIO_CHARS);

  const fullPrompt = `${systemPrompt}\n\nMATCHED PROJECTS:\n\n${portfolioBlock}`;
  const knownBeatNames = new Set(formatProfile.beats.map((b) => b.name));

  // ---- Call the LLM with validation + retry logic ----------------------
  let retried = false;
  let generated: V2GeneratedScene[];

  const tryParseAndValidate = (raw: string): { ok: true; value: V2GeneratedScene[] } | { ok: false; reason: string; detail: unknown } => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(extractJson(raw));
    } catch (err) {
      return { ok: false, reason: 'not valid JSON', detail: (err as Error).message };
    }
    const validated = v2GeneratedScenesArraySchema.safeParse(parsed);
    if (!validated.success) {
      return { ok: false, reason: 'schema validation failed', detail: validated.error.issues };
    }
    return { ok: true, value: validated.data };
  };

  try {
    const raw = await invokeLLM(provider, fullPrompt, timeoutMs);
    const parsed = tryParseAndValidate(raw);

    if (!parsed.ok) {
      retried = true;
      const stricter = `${fullPrompt}\n\nIMPORTANT: Your previous response was not parseable. Respond with ONLY a JSON array — no fences, no prose. Start with [ and end with ].`;
      const raw2 = await invokeLLM(provider, stricter, timeoutMs);
      const parsed2 = tryParseAndValidate(raw2);
      if (!parsed2.ok) {
        throw new PlanningEngineError(
          STEP_NAME,
          'INVALID_OUTPUT',
          `LLM output did not parse as v2 scenes after retry: ${parsed2.reason}`,
          { planId, detail: parsed2.detail },
        );
      }
      generated = parsed2.value;
    } else {
      generated = parsed.value;
    }

    // ---- Validate scene count -------------------------------------------
    if (generated.length < minScenes || generated.length > maxScenes) {
      if (retried) {
        throw new PlanningEngineError(
          STEP_NAME,
          'INVALID_OUTPUT',
          `LLM returned ${generated.length} scenes; expected ${minScenes}-${maxScenes} after retry`,
          { planId, detail: { count: generated.length, range: [minScenes, maxScenes] } },
        );
      }
      retried = true;
      const countPrompt = `${fullPrompt}\n\nIMPORTANT: You returned ${generated.length} scenes. The scene count MUST be between ${minScenes} and ${maxScenes}. Return exactly ${minScenes}-${maxScenes} scenes.`;
      const raw2 = await invokeLLM(provider, countPrompt, timeoutMs);
      const parsed2 = tryParseAndValidate(raw2);
      if (!parsed2.ok || parsed2.value.length < minScenes || parsed2.value.length > maxScenes) {
        throw new PlanningEngineError(
          STEP_NAME,
          'INVALID_OUTPUT',
          `LLM returned wrong scene count (${!parsed2.ok ? 'parse error' : parsed2.value.length}) after retry`,
          { planId, detail: parsed2.ok ? { count: parsed2.value.length } : parsed2.detail },
        );
      }
      generated = parsed2.value;
    }

    // ---- Validate beat tags -------------------------------------------
    const unknownBeats = generated.filter((s) => !knownBeatNames.has(s.beatTag));
    if (unknownBeats.length > 0 && !retried) {
      retried = true;
      const beatPrompt = `${fullPrompt}\n\nIMPORTANT: You used unknown beat names: ${unknownBeats.map((s) => s.beatTag).join(', ')}. Every beatTag MUST be one of: ${beatNames}. Try again.`;
      const raw2 = await invokeLLM(provider, beatPrompt, timeoutMs);
      const parsed2 = tryParseAndValidate(raw2);
      if (!parsed2.ok) {
        throw new PlanningEngineError(
          STEP_NAME,
          'INVALID_OUTPUT',
          `LLM output invalid after beat-tag retry: ${parsed2.reason}`,
          { planId, detail: parsed2.detail },
        );
      }
      generated = parsed2.value;
      const stillUnknown = generated.filter((s) => !knownBeatNames.has(s.beatTag));
      if (stillUnknown.length > 0) {
        throw new PlanningEngineError(
          STEP_NAME,
          'INVALID_OUTPUT',
          `LLM still returned unknown beatTags after retry: ${stillUnknown.map((s) => s.beatTag).join(', ')}`,
          { planId },
        );
      }
    } else if (unknownBeats.length > 0) {
      // Already retried once — fail out.
      throw new PlanningEngineError(
        STEP_NAME,
        'INVALID_OUTPUT',
        `LLM returned unknown beatTags: ${unknownBeats.map((s) => s.beatTag).join(', ')}`,
        { planId },
      );
    }

    // ---- Validate total duration (±25% of midpoint runtime) -----------
    const totalDuration = generated.reduce((sum, s) => sum + s.estimatedDurationSeconds, 0);
    const minDuration = midRuntime * 0.75;
    const maxDuration = midRuntime * 1.25;
    if (totalDuration < minDuration || totalDuration > maxDuration) {
      logger.warn(
        { planId, totalDuration, midRuntime, minDuration, maxDuration },
        'generate-scenes: total duration outside ±25% of target — proceeding anyway (scenes persisted)',
      );
    }
  } catch (err) {
    if (err instanceof PlanningEngineError) throw err;
    if (err instanceof LLMProviderError) {
      throw new PlanningEngineError(
        STEP_NAME,
        'LLM_FAILED',
        `${err.providerName} CLI failed: ${err.message}`,
        { planId, detail: { providerCode: err.code } },
      );
    }
    throw err;
  }

  // ---- Wipe existing scenes (clean regenerate) -------------------------
  try {
    const existing = await listScenes(planId, opts.db);
    for (const old of existing) {
      await deleteScene(planId, old.id, opts.db);
    }
  } catch (err) {
    throw new PlanningEngineError(
      STEP_NAME,
      'PERSIST_FAILED',
      `failed to clear old scenes: ${(err as Error).message}`,
      { planId },
    );
  }

  // ---- Persist new scenes + advance status to scenes_generated ---------
  const created: Scene[] = [];
  try {
    for (let i = 0; i < generated.length; i++) {
      const g = generated[i]!;
      const scene = await createScene(
        planId,
        {
          title: g.title,
          description: g.description,
          framingNotes: g.framingNotes,
          script: '', // write-scripts step fills these in
          order: i + 1,
          estimatedDurationSeconds: g.estimatedDurationSeconds,
          projectRef: g.projectRef ?? null,
          beatTag: g.beatTag,
        },
        opts.db,
      );
      created.push(scene);
    }
  } catch (err) {
    throw new PlanningEngineError(
      STEP_NAME,
      'PERSIST_FAILED',
      `failed to persist scene ${created.length + 1}: ${(err as Error).message}`,
      { planId },
    );
  }

  // Advance status only after successful persistence.
  let updatedPlan: Plan | null;
  try {
    updatedPlan = await patchPlan(planId, { status: 'scenes_generated' }, opts.db);
  } catch (err) {
    throw new PlanningEngineError(
      STEP_NAME,
      'PERSIST_FAILED',
      `scenes persisted but failed to advance plan status: ${(err as Error).message}`,
      { planId },
    );
  }
  if (!updatedPlan) {
    throw new PlanningEngineError(
      STEP_NAME,
      'PLAN_NOT_FOUND',
      'plan disappeared during scene persistence',
      { planId },
    );
  }

  const durationMs = Date.now() - t0;
  logger.info(
    {
      planId,
      planType: 'youtube_advanced',
      sceneCount: created.length,
      retried,
      durationMs,
    },
    'scene generation complete (youtube_advanced)',
  );
  return { plan: updatedPlan, scenes: created, retried, durationMs };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function buildPrompt(plan: Plan): string {
  const rules = getCompositionRules(plan.type);
  const totalWords = runtimeToWordCount(plan.targetRuntimeSeconds, rules.wordsPerMinute);
  const [minScenes, maxScenes] = runtimeToSceneRange(plan.targetRuntimeSeconds, rules);

  const projectsBlock = plan.matchedProjects
    .map((p, i) => {
      const feats = p.matchedFeatures.map((f) => `      - ${f}`).join('\n');
      return [
        `Project ${i + 1}: ${p.projectName} (slug: ${p.projectSlug}, relevance: ${p.relevanceScore.toFixed(2)})`,
        '  Matched features:',
        feats,
        `  Suggested demo sequence: ${p.suggestedDemoSequence}`,
      ].join('\n');
    })
    .join('\n\n')
    .slice(0, MAX_PORTFOLIO_CHARS);

  const briefBody = renderBrief(plan).slice(0, 6_000);

  return `You are planning the scene cards for a video Rick is about to record. You decide what scenes there are, what each one SHOWS, and what's framed on camera — but you do NOT write the scripts yet. That's a separate step.

${compositionRulesToPrompt(rules)}

TARGET RUNTIME: ${plan.targetRuntimeSeconds}s  (~${totalWords} words of spoken text total at ${rules.wordsPerMinute} wpm)
TARGET SCENE COUNT: ${minScenes}-${maxScenes} scenes (recommended; you may go slightly above or below if the content demands it)

OUTPUT FORMAT:
A single JSON array of scene objects, in playback order. Each element matches:
{
  "title": "<3-8 words — what happens in this scene>",
  "description": "<1-3 sentences — what's being shown, explained, or demonstrated. Concrete.>",
  "framingNotes": "<1-2 sentences — what's on camera: screenshare of X, headshot, terminal, dashboard, etc.>",
  "projectRef": "<projectSlug from MATCHED PROJECTS — or null if the scene is intro/closing/transition>",
  "estimatedDurationSeconds": <integer — your best estimate for this scene>,
  "interfaceType": "<one of: web-ui | terminal | api-response | code-walkthrough | diagram | logs | headshot>"
}

RULES:
- projectRef MUST come from MATCHED PROJECTS or be null. Intro/closing scenes are usually null.
- Sum of estimatedDurationSeconds should land within ±15% of the target runtime.
- Scene count within ${minScenes}-${maxScenes} unless one fewer/more clearly serves the structure.
- Output JSON ONLY. No fences. No prose. Start with [ and end with ].

BRIEF FOR THIS VIDEO:

${briefBody}

MATCHED PROJECTS (use these — do not invent others):

${projectsBlock}`;
}

function renderBrief(plan: Plan): string {
  if (plan.type === 'cover_letter') {
    const reqs = plan.requirements
      .map((r) => {
        const tag = r.priority === 'must_show' ? '[MUST_SHOW]' : '[NICE_TO_SHOW]';
        return `- ${tag} ${r.skill} — ${r.evidence}`;
      })
      .join('\n');
    const constraints = plan.userConstraints ? `\n\nRick's constraints:\n${plan.userConstraints}` : '';
    return `Plan type: cover_letter\nListing: ${plan.title}\n\nRequirements:\n${reqs}${constraints}`;
  }
  const constraints = plan.userConstraints ? `\n\nRick's constraints:\n${plan.userConstraints}` : '';
  return `Plan type: youtube\nTopic: ${plan.title}${constraints}`;
}

async function invokeLLM(
  provider: LLMProvider,
  prompt: string,
  timeoutMs: number,
): Promise<string> {
  return provider.generate(prompt, { timeoutMs });
}

type ParseOutcome =
  | { ok: true; value: GeneratedScene[] }
  | { ok: false; reason: string; detail: unknown };

function tryParseGeneratedScenes(raw: string): ParseOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(raw));
  } catch (err) {
    return { ok: false, reason: 'not valid JSON', detail: (err as Error).message };
  }
  const validated = generatedScenesArraySchema.safeParse(parsed);
  if (!validated.success) {
    return {
      ok: false,
      reason: 'JSON parsed but failed schema validation',
      detail: validated.error.issues,
    };
  }
  return { ok: true, value: validated.data };
}

export const _internal = {
  buildPrompt,
  renderBrief,
  tryParseGeneratedScenes,
};
