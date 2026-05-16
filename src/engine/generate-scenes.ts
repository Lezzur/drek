import type { Firestore } from 'firebase-admin/firestore';
import { z } from 'zod';
import { logger } from '../logger.js';
import { getLLMProvider, LLMProviderError, type LLMProvider } from '../providers/index.js';
import { getPlan } from '../db/plans.js';
import { createScene, listScenes, deleteScene } from '../db/scenes.js';
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

interface GenerateScenesOptions {
  provider?: LLMProvider;
  db?: Firestore;
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

  // ---- Load + validate plan ------------------------------------------
  const plan = await getPlan(planId, opts.db);
  if (!plan) {
    throw new PlanningEngineError(STEP_NAME, 'PLAN_NOT_FOUND', `no plan with id ${planId}`, {
      planId,
    });
  }
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
    const raw = await invokeLLM(provider, basePrompt, opts.timeoutMs);
    const parsed = tryParseGeneratedScenes(raw);
    if (parsed.ok) {
      generated = parsed.value;
    } else {
      retried = true;
      const stricter = `${basePrompt}\n\nIMPORTANT: Your previous response was not parseable. Respond with ONLY a JSON array — no fences, no prose. Start with [ and end with ].`;
      const raw2 = await invokeLLM(provider, stricter, opts.timeoutMs);
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
  timeoutMs: number | undefined,
): Promise<string> {
  return provider.generate(prompt, timeoutMs !== undefined ? { timeoutMs } : undefined);
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
