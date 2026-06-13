import type { Firestore } from 'firebase-admin/firestore';
import { logger } from '../logger.js';
import { getLLMProvider, LLMProviderError, type LLMProvider } from '../providers/index.js';
import { defaultLlmTimeoutMs } from './llm-timeout.js';
import { getPlan, patchPlan } from '../db/plans.js';
import { listScenes, patchScene } from '../db/scenes.js';
import {
  findLongFormDeliverable,
  DeliverableNotFoundError,
} from '../db/deliverables.js';
import { getFormatProfile, FormatProfileNotFoundError } from './format-profiles/index.js';
import { getAudienceProfileClient } from '../neurocore/audience-profiles.js';
import { buildSystemPrompt } from './compose-prompt.js';
import { extractJson } from './json-utils.js';
import { PlanningEngineError } from './errors.js';
import {
  SCENE_INTERFACE_TYPES,
  SHOT_ITEM_SOURCES,
  ON_SCREEN_TEXT_STYLES,
  type BrollItem,
  type CutPoint,
  type OnScreenTextOverlay,
  type PrimaryShot,
  type Scene,
} from '../db/schemas.js';

/**
 * Call 6 of the v2 youtube_advanced pipeline: shot list generation.
 *
 * Produces per-scene structured shot data — primary shot, B-roll items,
 * supplementary shot list items, on-screen text overlays, and cut points.
 *
 * Batched: ALL scenes go through a single LLM call so cross-scene shot
 * coherence is preserved (e.g., the same B-roll asset isn't suggested
 * for two consecutive scenes; cut points line up at scene boundaries).
 *
 * Persists via per-scene patchScene calls in sequence. Status transitions
 * hook_selected → shot_list_generated. Retry-once on bad JSON.
 */

const STEP_NAME = 'generate-shot-list';
const MAX_SCRIPTS_CHARS = 60_000;  // Defensive cap on combined scripts

const TASK_INSTRUCTIONS = `Generate the per-scene shot list for an entire video plan in ONE batched response.

For EACH scene, produce:
- primaryShot: the main shot type + a one-sentence description
- brollItems: 0-5 cutaway shots that support the primary shot
- shotListItems: 0-5 supplementary shots (screenshots, asset stills, diagram overlays)
- onScreenTextOverlays: 0-5 text overlays that appear during this scene
- cutPoints: 0-8 places in the script where the editor should cut (script line indices, 0-based)

Allowed values:
- primaryShot.type and brollItem.type and shotListItem.type MUST be one of:
  ${SCENE_INTERFACE_TYPES.join(', ')}
- brollItem.source and shotListItem.source MUST be one of:
  ${SHOT_ITEM_SOURCES.join(', ')}
- onScreenTextOverlay.styleHint MUST be one of:
  ${ON_SCREEN_TEXT_STYLES.join(', ')}

For each B-roll / shot list item:
- description: short — 1 sentence what the editor sees
- durationSeconds: 1-600 (integer)

For each text overlay:
- textContent: max 80 characters
- timingHint: when in the scene to display (e.g., "first 3 seconds", "during the demo")
- styleHint: one of the allowed values

For each cut point:
- scriptLineNumber: zero-based index into the scene's script (split by newlines)
- reason: 1 short sentence

CROSS-SCENE COHERENCE:
- Avoid re-suggesting the same B-roll asset across multiple scenes (each asset earns its place once)
- Cut points should line up cleanly at scene boundaries — don't cut mid-thought
- Honor the format profile's shot conventions per beat

OUTPUT FORMAT — return a single JSON object keyed by sceneId:
{
  "<sceneId>": {
    "primaryShot": { "type": "<type>", "description": "..." },
    "brollItems": [ { "type": "...", "description": "...", "source": "...", "durationSeconds": <int> }, ... ],
    "shotListItems": [ ... same shape as brollItems ... ],
    "onScreenTextOverlays": [ { "textContent": "...", "timingHint": "...", "styleHint": "..." }, ... ],
    "cutPoints": [ { "scriptLineNumber": <int>, "reason": "..." }, ... ]
  },
  ...
}

RULES:
- EVERY sceneId from the input list must appear as a key. Missing scenes are invalid.
- Output JSON ONLY. No fences, no prose. Start with { and end with }.`;

interface ShotListPerScene {
  primaryShot: PrimaryShot;
  brollItems: BrollItem[];
  shotListItems: BrollItem[];
  onScreenTextOverlays: OnScreenTextOverlay[];
  cutPoints: CutPoint[];
}

type ParseOutcome =
  | { ok: true; value: Record<string, ShotListPerScene> }
  | { ok: false; reason: string; detail?: unknown };

function tryParseShotList(raw: string): ParseOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(raw));
  } catch (err) {
    return { ok: false, reason: 'not valid JSON', detail: (err as Error).message };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'expected JSON object keyed by sceneId', detail: parsed };
  }
  return { ok: true, value: parsed as Record<string, ShotListPerScene> };
}

interface ValidationResult {
  valid: boolean;
  reason?: string;
}

const VALID_SHOT_TYPES = new Set<string>(SCENE_INTERFACE_TYPES);
const VALID_SOURCES = new Set<string>(SHOT_ITEM_SOURCES);
const VALID_OVERLAY_STYLES = new Set<string>(ON_SCREEN_TEXT_STYLES);

function validateShotList(
  shotList: Record<string, ShotListPerScene>,
  expectedSceneIds: string[],
): ValidationResult {
  // Every expected scene must have an entry
  for (const sceneId of expectedSceneIds) {
    if (!shotList[sceneId]) {
      return { valid: false, reason: `missing entry for sceneId "${sceneId}"` };
    }
  }
  // Validate each entry
  for (const sceneId of expectedSceneIds) {
    const entry = shotList[sceneId];
    if (!entry) continue; // already guarded above

    if (!entry.primaryShot || typeof entry.primaryShot !== 'object') {
      return { valid: false, reason: `scene ${sceneId}: missing primaryShot` };
    }
    if (!VALID_SHOT_TYPES.has(entry.primaryShot.type)) {
      return {
        valid: false,
        reason: `scene ${sceneId}: primaryShot.type "${entry.primaryShot.type}" not in [${SCENE_INTERFACE_TYPES.join(', ')}]`,
      };
    }
    if (typeof entry.primaryShot.description !== 'string' || entry.primaryShot.description.length === 0) {
      return { valid: false, reason: `scene ${sceneId}: primaryShot.description empty` };
    }

    // Validate brollItems + shotListItems (same shape)
    for (const fieldName of ['brollItems', 'shotListItems'] as const) {
      const items = entry[fieldName];
      if (!Array.isArray(items)) {
        return { valid: false, reason: `scene ${sceneId}: ${fieldName} not an array` };
      }
      for (const item of items) {
        if (!VALID_SHOT_TYPES.has(item.type)) {
          return {
            valid: false,
            reason: `scene ${sceneId}: ${fieldName} item.type "${item.type}" invalid`,
          };
        }
        if (!VALID_SOURCES.has(item.source)) {
          return {
            valid: false,
            reason: `scene ${sceneId}: ${fieldName} item.source "${item.source}" invalid`,
          };
        }
        if (!Number.isInteger(item.durationSeconds) || item.durationSeconds < 1 || item.durationSeconds > 600) {
          return {
            valid: false,
            reason: `scene ${sceneId}: ${fieldName} durationSeconds ${item.durationSeconds} not in 1-600`,
          };
        }
      }
    }

    // onScreenTextOverlays
    if (!Array.isArray(entry.onScreenTextOverlays)) {
      return { valid: false, reason: `scene ${sceneId}: onScreenTextOverlays not an array` };
    }
    for (const overlay of entry.onScreenTextOverlays) {
      if (typeof overlay.textContent !== 'string' || overlay.textContent.length === 0 || overlay.textContent.length > 80) {
        return {
          valid: false,
          reason: `scene ${sceneId}: overlay.textContent length ${overlay.textContent?.length} not in 1-80`,
        };
      }
      if (!VALID_OVERLAY_STYLES.has(overlay.styleHint)) {
        return {
          valid: false,
          reason: `scene ${sceneId}: overlay.styleHint "${overlay.styleHint}" not in [${ON_SCREEN_TEXT_STYLES.join(', ')}]`,
        };
      }
    }

    // cutPoints
    if (!Array.isArray(entry.cutPoints)) {
      return { valid: false, reason: `scene ${sceneId}: cutPoints not an array` };
    }
    for (const cp of entry.cutPoints) {
      if (!Number.isInteger(cp.scriptLineNumber) || cp.scriptLineNumber < 0) {
        return {
          valid: false,
          reason: `scene ${sceneId}: cutPoint.scriptLineNumber ${cp.scriptLineNumber} not a non-negative int`,
        };
      }
      if (typeof cp.reason !== 'string' || cp.reason.length === 0) {
        return { valid: false, reason: `scene ${sceneId}: cutPoint.reason empty` };
      }
    }
  }
  return { valid: true };
}

export interface GenerateShotListResult {
  scenes: Scene[];
  retried: boolean;
  durationMs: number;
}

export async function generateShotList(
  planId: string,
  opts: { provider?: LLMProvider; db?: Firestore; timeoutMs?: number } = {},
): Promise<GenerateShotListResult> {
  const t0 = Date.now();
  const provider = opts.provider ?? (await getLLMProvider());
  const timeoutMs = defaultLlmTimeoutMs(opts.timeoutMs);

  // ---- Load plan + pre-conditions ---------------------------------------

  const plan = await getPlan(planId, opts.db);
  if (!plan) {
    throw new PlanningEngineError(STEP_NAME, 'PLAN_NOT_FOUND', `no plan with id ${planId}`, {
      planId,
    });
  }

  if (plan.type !== 'youtube_advanced') {
    throw new PlanningEngineError(
      STEP_NAME,
      'WRONG_PLAN_TYPE',
      `generate-shot-list only supports youtube_advanced plans, got ${plan.type}`,
      { planId },
    );
  }

  const allowedStatuses: string[] = ['hook_selected', 'shot_list_generated'];
  if (!allowedStatuses.includes(plan.status)) {
    throw new PlanningEngineError(
      STEP_NAME,
      'DISALLOWED_TRANSITION',
      `cannot generate shot list from status ${plan.status} — plan must be in hook_selected or shot_list_generated`,
      { planId, detail: { currentStatus: plan.status } },
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

  let formatProfile;
  try {
    formatProfile = getFormatProfile(plan.formatProfileId);
  } catch (err) {
    if (err instanceof FormatProfileNotFoundError) {
      throw new PlanningEngineError(
        STEP_NAME,
        'NO_FORMAT_PROFILE',
        `formatProfileId "${plan.formatProfileId}" not in registry`,
        { planId },
      );
    }
    throw err;
  }

  let longForm;
  try {
    longForm = await findLongFormDeliverable(planId, opts.db);
  } catch (err) {
    if (err instanceof DeliverableNotFoundError) {
      throw new PlanningEngineError(
        STEP_NAME,
        'NO_LONG_FORM_DELIVERABLE',
        `no long_form Deliverable for plan ${planId}`,
        { planId },
      );
    }
    throw err;
  }

  const audienceProfile = await getAudienceProfileClient().get(longForm.audienceProfileId);

  // ---- Load scenes + build user prompt ----------------------------------

  const scenes = await listScenes(planId, opts.db);
  if (scenes.length === 0) {
    throw new PlanningEngineError(
      STEP_NAME,
      'INVALID_OUTPUT',
      'no scenes exist for this plan — generate scenes before shot list',
      { planId },
    );
  }

  const scenesSummary = scenes
    .map((s) => {
      const beat = s.beatTag ? ` [beat: ${s.beatTag}]` : '';
      const script = (s.script || '(no script yet)').slice(0, 4_000);
      return [
        `--- sceneId: ${s.id} (order ${s.order})${beat} ---`,
        `Title: ${s.title}`,
        `Description: ${s.description}`,
        `Framing notes: ${s.framingNotes}`,
        `Script:`,
        script,
      ].join('\n');
    })
    .join('\n\n')
    .slice(0, MAX_SCRIPTS_CHARS);

  const sceneIds = scenes.map((s) => s.id);

  const systemPrompt = buildSystemPrompt({
    formatProfile,
    audienceProfile,
    taskInstructions: TASK_INSTRUCTIONS,
  });

  const userPrompt = [
    systemPrompt,
    '',
    `SCENE IDS (every one must appear in your output): ${sceneIds.join(', ')}`,
    '',
    'SCENES:',
    scenesSummary,
  ].join('\n');

  // ---- LLM call with retry-once -----------------------------------------

  let shotList: Record<string, ShotListPerScene>;
  let retried = false;

  try {
    const raw = await provider.generate(userPrompt, { timeoutMs });
    const parsed = tryParseShotList(raw);
    if (!parsed.ok) {
      retried = true;
      const stricter = `${userPrompt}\n\nIMPORTANT: Your previous response was not parseable as JSON. Respond with ONLY a JSON object — no fences, no prose. Start with { and end with }.`;
      const raw2 = await provider.generate(stricter, { timeoutMs });
      const parsed2 = tryParseShotList(raw2);
      if (!parsed2.ok) {
        throw new PlanningEngineError(
          STEP_NAME,
          'INVALID_OUTPUT',
          `LLM output did not parse after retry: ${parsed2.reason}`,
          { planId, detail: parsed2.detail },
        );
      }
      const validation2 = validateShotList(parsed2.value, sceneIds);
      if (!validation2.valid) {
        throw new PlanningEngineError(
          STEP_NAME,
          'INVALID_OUTPUT',
          `Shot list failed validation after retry: ${validation2.reason}`,
          { planId },
        );
      }
      shotList = parsed2.value;
    } else {
      const validation = validateShotList(parsed.value, sceneIds);
      if (!validation.valid) {
        retried = true;
        const stricterValidation = `${userPrompt}\n\nIMPORTANT: Your previous response failed validation: ${validation.reason}. Respond with ONLY a valid JSON object with every required sceneId as a key. Start with { and end with }.`;
        const raw2 = await provider.generate(stricterValidation, { timeoutMs });
        const parsed2 = tryParseShotList(raw2);
        if (!parsed2.ok) {
          throw new PlanningEngineError(
            STEP_NAME,
            'INVALID_OUTPUT',
            `LLM output did not parse after retry: ${parsed2.reason}`,
            { planId, detail: parsed2.detail },
          );
        }
        const validation2 = validateShotList(parsed2.value, sceneIds);
        if (!validation2.valid) {
          throw new PlanningEngineError(
            STEP_NAME,
            'INVALID_OUTPUT',
            `Shot list failed validation after retry: ${validation2.reason}`,
            { planId },
          );
        }
        shotList = parsed2.value;
      } else {
        shotList = parsed.value;
      }
    }
  } catch (err) {
    if (err instanceof PlanningEngineError) throw err;
    if (err instanceof LLMProviderError) {
      throw new PlanningEngineError(
        STEP_NAME,
        'LLM_FAILED',
        `LLM call failed: ${err.message}`,
        { planId, detail: { code: err.code } },
      );
    }
    throw err;
  }

  // ---- Persist per scene -------------------------------------------------
  // Sequential patchScene calls — fake-firestore doesn't support
  // multi-doc batched updates across subcollections in a single call here,
  // and the per-call cost is low. If any patch fails mid-loop we surface
  // PERSIST_FAILED — plan status stays at hook_selected so Rick can retry.

  const updatedScenes: Scene[] = [];
  for (const scene of scenes) {
    const entry = shotList[scene.id]!; // validated above
    try {
      const updated = await patchScene(
        planId,
        scene.id,
        {
          primaryShot: entry.primaryShot,
          brollItems: entry.brollItems,
          shotListItems: entry.shotListItems,
          onScreenTextOverlays: entry.onScreenTextOverlays,
          cutPoints: entry.cutPoints,
        },
        opts.db,
      );
      if (updated) updatedScenes.push(updated);
    } catch (err) {
      throw new PlanningEngineError(
        STEP_NAME,
        'PERSIST_FAILED',
        `failed to persist shot list for scene ${scene.id}: ${(err as Error).message}`,
        { planId, detail: { sceneId: scene.id } },
      );
    }
  }

  // ---- Status transition ------------------------------------------------
  if (plan.status === 'hook_selected') {
    await patchPlan(planId, { status: 'shot_list_generated' }, opts.db);
  }
  // If plan.status was already shot_list_generated (regeneration), no transition needed.

  const durationMs = Date.now() - t0;
  logger.info(
    {
      step: STEP_NAME,
      planId,
      sceneCount: scenes.length,
      retried,
      durationMs,
    },
    'shot list generated',
  );

  return { scenes: updatedScenes, retried, durationMs };
}
