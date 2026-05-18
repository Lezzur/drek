import type { Firestore } from 'firebase-admin/firestore';
import { logger } from '../logger.js';
import { getLLMProvider, LLMProviderError, type LLMProvider } from '../providers/index.js';
import { getPlan, patchPlan } from '../db/plans.js';
import {
  findLongFormDeliverable,
  createDeliverable,
  DeliverableNotFoundError,
} from '../db/deliverables.js';
import { listScenes } from '../db/scenes.js';
import { getFormatProfile, FormatProfileNotFoundError } from './format-profiles/index.js';
import {
  getAudienceProfileClient,
  AudienceProfileNotFoundError,
  AudienceProfileUnavailableError,
} from '../neurocore/audience-profiles.js';
import { buildSystemPrompt } from './compose-prompt.js';
import { extractJson } from './json-utils.js';
import { PlanningEngineError } from './errors.js';

/**
 * Call 9 of the v2 youtube_advanced pipeline: Shorts candidate extraction.
 *
 * Generates 3-5 short-clip candidates from the long-form scripts. Candidates
 * are EPHEMERAL — they are NOT persisted as Deliverable docs at extraction
 * time. The route layer holds them in memory; Rick approves a subset and
 * each approved candidate becomes a short_clip Deliverable via
 * approveShortCandidate().
 *
 * Pre-conditions:
 * - plan.type === 'youtube_advanced'
 * - plan.status is 'metadata_generated' or 'finalized'
 * - long-form Deliverable exists
 *
 * Bound to the business_owner_shorts AudienceProfile (NOT the long-form
 * audience — Shorts target a different viewer). If that profile is missing
 * in Neurocore, throws PlanningEngineError with NO_FORMAT_PROFILE code so
 * the route layer can guide Rick to the M14 Track A seed step.
 *
 * Status invariant: extract-shorts only advances plan.status to
 * 'shorts_extracted' when at least one candidate was returned.
 */

const STEP_NAME = 'extract-shorts';
const DEFAULT_TIMEOUT_MS = 90_000;
const MIN_CANDIDATES = 3;
const MAX_CANDIDATES = 5;
const MIN_REWORK_WORDS = 150; // ~60s at 150 wpm
const MAX_REWORK_WORDS = 225; // ~90s at 150 wpm
const SHORTS_AUDIENCE_ID = 'business_owner_shorts';

/**
 * Hardcoded beat-importance weights per spec §4.5 Call 9. Fed to the LLM
 * as ranking input — NOT used as a hard filter. The LLM may override these
 * if a particular line in a low-weight beat is exceptional.
 */
export const BEAT_WEIGHTS: Record<string, number> = {
  cold_open: 7,
  problem: 5,
  war_room: 6,
  build_reel: 5,
  breakdown: 4,
  demo: 10,
  outro: 8,
};

const TASK_INSTRUCTIONS = `Extract 3-5 candidate Short clips (60-90s vertical) from the long-form scripts.

OUTPUT FORMAT — return a JSON array of 3-5 objects:
[
  {
    "sourceSceneIds": ["<scene id>", "..."],
    "cutWindow": { "startLine": <int>, "endLine": <int> },
    "reworkedScript": "<the full reworked vertical-Short script, 150-225 words>",
    "hookText": "<the first 1-2 lines, must work as standalone hook>",
    "verticalReframingNotes": "<one paragraph on how to crop / what to keep on-screen>",
    "suggestedTitleHint": "<short, hooky Short title>",
    "suggestedThumbnailHint": "<one sentence describing the vertical-thumbnail visual concept>",
    "beatImportanceScore": <int 1-10>
  },
  ...
]

RULES:
- 3-5 candidates total.
- reworkedScript: MUST be 150-225 words. Count carefully — this is a 60-90 second Short at 150 wpm.
- sourceSceneIds: every id must reference one of the scenes listed below. Do NOT invent ids.
- cutWindow.startLine / endLine reference line offsets within the source scene's script.
- hookText: 1-2 sentences that work without context. The viewer doesn't see the previous scene.
- verticalReframingNotes: practical guidance for cropping the horizontal footage to 9:16.
- beatImportanceScore: 1-10 — use BEAT_WEIGHTS below as input but override when content warrants.
- Audience: business owners scrolling Shorts during downtime. Hook fast, CTA implicit (subscribe), tone confident.
- Output JSON ONLY. No fences, no prose. Start with [ end with ].`;

export interface ShortCandidate {
  /** Ephemeral id — generated server-side at extraction time. NOT persisted. */
  id: string;
  sourceSceneIds: string[];
  cutWindow: { startLine: number; endLine: number };
  reworkedScript: string;
  hookText: string;
  verticalReframingNotes: string;
  suggestedTitleHint: string;
  suggestedThumbnailHint: string;
  beatImportanceScore: number;
}

interface RawCandidate {
  sourceSceneIds: unknown;
  cutWindow: unknown;
  reworkedScript: unknown;
  hookText: unknown;
  verticalReframingNotes: unknown;
  suggestedTitleHint: unknown;
  suggestedThumbnailHint: unknown;
  beatImportanceScore: unknown;
}

type ParseOutcome =
  | { ok: true; value: RawCandidate[] }
  | { ok: false; reason: string };

function tryParse(raw: string): ParseOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(raw));
  } catch (err) {
    return { ok: false, reason: `not valid JSON: ${(err as Error).message}` };
  }
  if (!Array.isArray(parsed)) return { ok: false, reason: 'expected JSON array' };
  return { ok: true, value: parsed as RawCandidate[] };
}

interface ValidationResult {
  valid: boolean;
  reason?: string;
}

function countWords(s: string): number {
  return s.trim().split(/\s+/).filter((w) => w.length > 0).length;
}

function validateCandidates(
  candidates: RawCandidate[],
  knownSceneIds: Set<string>,
): ValidationResult {
  if (candidates.length < MIN_CANDIDATES || candidates.length > MAX_CANDIDATES) {
    return {
      valid: false,
      reason: `candidate count ${candidates.length} not in ${MIN_CANDIDATES}-${MAX_CANDIDATES}`,
    };
  }
  for (const [i, c] of candidates.entries()) {
    if (!Array.isArray(c.sourceSceneIds) || c.sourceSceneIds.length === 0) {
      return { valid: false, reason: `candidate[${i}] sourceSceneIds empty` };
    }
    for (const sid of c.sourceSceneIds) {
      if (typeof sid !== 'string' || !knownSceneIds.has(sid)) {
        return {
          valid: false,
          reason: `candidate[${i}] phantom sceneId ${JSON.stringify(sid)}`,
        };
      }
    }
    if (
      typeof c.cutWindow !== 'object' || c.cutWindow === null ||
      typeof (c.cutWindow as Record<string, unknown>).startLine !== 'number' ||
      typeof (c.cutWindow as Record<string, unknown>).endLine !== 'number'
    ) {
      return { valid: false, reason: `candidate[${i}] cutWindow invalid` };
    }
    if (typeof c.reworkedScript !== 'string' || c.reworkedScript.length === 0) {
      return { valid: false, reason: `candidate[${i}] reworkedScript empty` };
    }
    const wc = countWords(c.reworkedScript);
    if (wc < MIN_REWORK_WORDS || wc > MAX_REWORK_WORDS) {
      return {
        valid: false,
        reason: `candidate[${i}] reworkedScript word count ${wc} not in ${MIN_REWORK_WORDS}-${MAX_REWORK_WORDS}`,
      };
    }
    if (typeof c.hookText !== 'string' || c.hookText.length === 0) {
      return { valid: false, reason: `candidate[${i}] hookText empty` };
    }
    if (
      typeof c.verticalReframingNotes !== 'string' ||
      c.verticalReframingNotes.length === 0
    ) {
      return { valid: false, reason: `candidate[${i}] verticalReframingNotes empty` };
    }
    if (typeof c.suggestedTitleHint !== 'string' || c.suggestedTitleHint.length === 0) {
      return { valid: false, reason: `candidate[${i}] suggestedTitleHint empty` };
    }
    if (
      typeof c.suggestedThumbnailHint !== 'string' ||
      c.suggestedThumbnailHint.length === 0
    ) {
      return { valid: false, reason: `candidate[${i}] suggestedThumbnailHint empty` };
    }
    if (
      typeof c.beatImportanceScore !== 'number' ||
      c.beatImportanceScore < 1 ||
      c.beatImportanceScore > 10
    ) {
      return {
        valid: false,
        reason: `candidate[${i}] beatImportanceScore ${String(c.beatImportanceScore)} not in 1-10`,
      };
    }
  }
  return { valid: true };
}

let idCounter = 0;
function makeShortCandidateId(): string {
  idCounter += 1;
  return `short_${Date.now().toString(36)}_${idCounter}`;
}

export interface ExtractShortsResult {
  candidates: ShortCandidate[];
  retried: boolean;
  durationMs: number;
}

export async function extractShortsCandidates(
  planId: string,
  opts: { provider?: LLMProvider; db?: Firestore; timeoutMs?: number } = {},
): Promise<ExtractShortsResult> {
  const t0 = Date.now();
  const provider = opts.provider ?? (await getLLMProvider());
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const plan = await getPlan(planId, opts.db);
  if (!plan) {
    throw new PlanningEngineError(STEP_NAME, 'PLAN_NOT_FOUND', `no plan ${planId}`, {
      planId,
    });
  }
  if (plan.type !== 'youtube_advanced') {
    throw new PlanningEngineError(
      STEP_NAME,
      'WRONG_PLAN_TYPE',
      `extract-shorts only supports youtube_advanced, got ${plan.type}`,
      { planId },
    );
  }

  // Per spec, extract-shorts runs after long-form is locked. The plan state
  // machine has `thumbnail_selected -> shorts_extracted -> finalized ->
  // metadata_generated`, so any of those three downstream statuses count as
  // valid entry points. Re-extraction from finalized / metadata_generated
  // does NOT roll the status back (that would violate the transition rules
  // and is conceptually wrong — long-form is already locked).
  const allowedStatuses = [
    'thumbnail_selected',
    'shorts_extracted',
    'finalized',
    'metadata_generated',
  ];
  if (!allowedStatuses.includes(plan.status)) {
    throw new PlanningEngineError(
      STEP_NAME,
      'DISALLOWED_TRANSITION',
      `extract-shorts requires plan.status in {thumbnail_selected, shorts_extracted, finalized, metadata_generated}; got ${plan.status}`,
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

  // Verify the long-form deliverable exists.
  try {
    await findLongFormDeliverable(planId, opts.db);
  } catch (err) {
    if (err instanceof DeliverableNotFoundError) {
      throw new PlanningEngineError(
        STEP_NAME,
        'NO_LONG_FORM_DELIVERABLE',
        `no long-form deliverable for plan ${planId}`,
        { planId },
      );
    }
    throw err;
  }

  // Shorts bind to business_owner_shorts — NOT the long-form audience.
  let audienceProfile;
  try {
    audienceProfile = await getAudienceProfileClient().get(SHORTS_AUDIENCE_ID);
  } catch (err) {
    if (
      err instanceof AudienceProfileNotFoundError ||
      err instanceof AudienceProfileUnavailableError
    ) {
      throw new PlanningEngineError(
        STEP_NAME,
        'NO_FORMAT_PROFILE',
        `Shorts AudienceProfile "${SHORTS_AUDIENCE_ID}" is not available in Neurocore. Run M14 Track A seed script (scripts/seed-audience-profiles.ts in the Neurocore repo) before extracting Shorts.`,
        { planId, detail: { audienceProfileId: SHORTS_AUDIENCE_ID } },
      );
    }
    throw err;
  }

  const scenes = await listScenes(planId, opts.db);
  if (scenes.length === 0) {
    throw new PlanningEngineError(
      STEP_NAME,
      'INVALID_OUTPUT',
      'no scenes to extract Shorts from',
      { planId },
    );
  }
  const knownSceneIds = new Set(scenes.map((s) => s.id));

  // Build the scripts dump for the prompt.
  const scriptsDump = scenes
    .map((s) => {
      const beat = s.beatTag ?? 'untagged';
      const weight = s.beatTag ? BEAT_WEIGHTS[s.beatTag] ?? 0 : 0;
      return `--- scene ${s.order} | id=${s.id} | beat=${beat} | weight=${weight} ---\n${s.script || '(no script)'}`;
    })
    .join('\n\n');

  const weightsLegend = Object.entries(BEAT_WEIGHTS)
    .map(([beat, w]) => `  ${beat}: ${w}`)
    .join('\n');

  const systemPrompt = buildSystemPrompt({
    formatProfile,
    audienceProfile,
    taskInstructions: TASK_INSTRUCTIONS,
  });

  const userPrompt = [
    systemPrompt,
    '',
    'BEAT_WEIGHTS (priority guidance — not a hard filter):',
    weightsLegend,
    '',
    'SCENES:',
    scriptsDump,
  ].join('\n');

  let validCandidates: RawCandidate[];
  let retried = false;

  try {
    const raw = await provider.generate(userPrompt, { timeoutMs });
    const parsed = tryParse(raw);
    if (!parsed.ok) {
      retried = true;
      const stricter = `${userPrompt}\n\nIMPORTANT: Your previous response was not parseable as a JSON array. Respond with ONLY a JSON array — no fences, no prose. Start with [ and end with ].`;
      const raw2 = await provider.generate(stricter, { timeoutMs });
      const parsed2 = tryParse(raw2);
      if (!parsed2.ok) {
        throw new PlanningEngineError(
          STEP_NAME,
          'INVALID_OUTPUT',
          `LLM output did not parse after retry: ${parsed2.reason}`,
          { planId },
        );
      }
      const v2 = validateCandidates(parsed2.value, knownSceneIds);
      if (!v2.valid) {
        throw new PlanningEngineError(
          STEP_NAME,
          'INVALID_OUTPUT',
          `Shorts candidates failed validation after retry: ${v2.reason}`,
          { planId },
        );
      }
      validCandidates = parsed2.value;
    } else {
      const v1 = validateCandidates(parsed.value, knownSceneIds);
      if (!v1.valid) {
        retried = true;
        const stricterValidation = `${userPrompt}\n\nIMPORTANT: Your previous response failed validation: ${v1.reason}. Respond with ONLY valid JSON matching the schema exactly. Start with [ and end with ].`;
        const raw2 = await provider.generate(stricterValidation, { timeoutMs });
        const parsed2 = tryParse(raw2);
        if (!parsed2.ok) {
          throw new PlanningEngineError(
            STEP_NAME,
            'INVALID_OUTPUT',
            `LLM output did not parse after retry: ${parsed2.reason}`,
            { planId },
          );
        }
        const v2 = validateCandidates(parsed2.value, knownSceneIds);
        if (!v2.valid) {
          throw new PlanningEngineError(
            STEP_NAME,
            'INVALID_OUTPUT',
            `Shorts candidates failed validation after retry: ${v2.reason}`,
            { planId },
          );
        }
        validCandidates = parsed2.value;
      } else {
        validCandidates = parsed.value;
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

  const candidates: ShortCandidate[] = validCandidates.map((c) => ({
    id: makeShortCandidateId(),
    sourceSceneIds: c.sourceSceneIds as string[],
    cutWindow: c.cutWindow as { startLine: number; endLine: number },
    reworkedScript: c.reworkedScript as string,
    hookText: c.hookText as string,
    verticalReframingNotes: c.verticalReframingNotes as string,
    suggestedTitleHint: c.suggestedTitleHint as string,
    suggestedThumbnailHint: c.suggestedThumbnailHint as string,
    beatImportanceScore: c.beatImportanceScore as number,
  }));

  // Only advance status when at least one candidate was returned AND the
  // current status is the legal predecessor (thumbnail_selected). Re-extracts
  // from later statuses don't roll the status back.
  if (candidates.length > 0 && plan.status === 'thumbnail_selected') {
    await patchPlan(planId, { status: 'shorts_extracted' }, opts.db);
  }

  const durationMs = Date.now() - t0;
  logger.info(
    {
      step: STEP_NAME,
      planId,
      candidateCount: candidates.length,
      retried,
      durationMs,
    },
    'shorts candidates extracted',
  );

  return { candidates, retried, durationMs };
}

/**
 * Approve a Short candidate — persist it as a short_clip Deliverable
 * bound to business_owner_shorts. Idempotency is the caller's job
 * (HTMX disabled-button on submit is sufficient for v2).
 */
export async function approveShortCandidate(
  planId: string,
  candidate: ShortCandidate,
  opts: { db?: Firestore } = {},
): Promise<{ deliverableId: string }> {
  const plan = await getPlan(planId, opts.db);
  if (!plan) {
    throw new PlanningEngineError(STEP_NAME, 'PLAN_NOT_FOUND', `no plan ${planId}`, {
      planId,
    });
  }
  if (plan.type !== 'youtube_advanced') {
    throw new PlanningEngineError(
      STEP_NAME,
      'WRONG_PLAN_TYPE',
      `approve-short only supports youtube_advanced, got ${plan.type}`,
      { planId },
    );
  }

  const deliverable = await createDeliverable(
    {
      planId,
      kind: 'short_clip',
      audienceProfileId: SHORTS_AUDIENCE_ID,
      title: candidate.suggestedTitleHint,
      status: 'scripts_ready',
      scriptOverrideSceneIds: candidate.sourceSceneIds,
      customScripts: [
        {
          sourceSceneId: candidate.sourceSceneIds[0] ?? null,
          script: candidate.reworkedScript,
        },
      ],
    },
    opts.db,
  );

  logger.info(
    {
      step: 'approve-short-candidate',
      planId,
      deliverableId: deliverable.id,
      candidateId: candidate.id,
    },
    'short candidate approved and persisted as deliverable',
  );

  return { deliverableId: deliverable.id };
}
