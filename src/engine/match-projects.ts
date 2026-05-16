import type { Firestore } from 'firebase-admin/firestore';
import { z } from 'zod';
import { logger } from '../logger.js';
import { getLLMProvider, LLMProviderError, type LLMProvider } from '../providers/index.js';
import { getPlan, patchPlan } from '../db/plans.js';
import {
  matchedProjectSchema,
  isAllowedPlanTransition,
  type Plan,
  type MatchedProject,
} from '../db/schemas.js';
import {
  getNeurocoreClient,
  NeurocoreError,
  type MemoryContextResponse,
  type NeurocoreClient,
} from '../neurocore/index.js';
import { extractJson } from './json-utils.js';
import { PlanningEngineError } from './errors.js';

/**
 * Call 2 of the four-step planning pipeline: project matching.
 *
 * Pulls Neurocore's project portfolio (plus PI's per-listing fit-score
 * insight via the contactId we pass) and asks the LLM to rank which of
 * Rick's projects to feature in the video. Cover letter mode matches the
 * requirements detected in M4; YouTube mode matches the manual topic
 * (plan.title + userConstraints).
 *
 * The Neurocore systemBlock is the heart of this step — it carries
 * <projects_portfolio>, <listing_insight> (proposalHooks, businessProfile,
 * quickWins, redFlags), and Rick's <profile>. The LLM gets all the
 * context PI already computed.
 */

const STEP_NAME = 'match-projects';
const MAX_CONTEXT_CHARS = 60_000;
const MAX_REQUIREMENTS_CHARS = 8_000;

const matchedProjectsArraySchema = z.array(matchedProjectSchema);

const SYSTEM_PROMPT_COVER_LETTER = `You are picking which of Rick's existing projects to feature in a COVER LETTER VIDEO (a 1-3 minute Loom recording for a hiring manager).

The reviewer is evaluative. They want to see proof Rick can do the work the listing asks for. Pick projects whose demoable features directly back the required skills. Stay tight — fewer, sharper matches beat sprawling lists.

Use the <listing_insight> block (especially <proposal_hooks>, <quick_wins>, <red_flags>) to bias selection — these are PI's per-listing tactical reads, treat them as creative direction. Avoid projects that conflict with <red_flags>. Lead with projects that prove what <proposal_hooks> says to lead with.

OUTPUT FORMAT:
Return a single JSON array, 1-4 elements, ordered most-to-least relevant. Each element matches:
{
  "projectSlug": "<slug from <projects_portfolio>>",
  "projectName": "<human name from <projects_portfolio>>",
  "matchedFeatures": ["<demoable feature 1>", "<feature 2>", ...],
  "relevanceScore": <number 0..1 — how directly this project proves what the listing wants>,
  "suggestedDemoSequence": "<2-4 sentences: what to show on screen for this project, in order>"
}

RULES:
- projectSlug MUST come from the <projects_portfolio> block — do not invent projects.
- matchedFeatures must come from the project's own demoable features. If a project has none aligned, skip the project entirely.
- relevanceScore: 0.9+ means "explicit fit", 0.6-0.8 means "strong adjacent fit", below 0.6 means "skip — better candidates exist".
- suggestedDemoSequence is the literal shot list. Spec what's on screen, in order. Example: "Open in the dashboard. Trigger a new lead. Show the worker logs picking it up. Cut to the alert in Slack."
- Output JSON ONLY. No fences, no prose. Start with [ and end with ].`;

const SYSTEM_PROMPT_YOUTUBE = `You are picking which of Rick's existing projects to feature in a YOUTUBE VIDEO targeted at potential CLIENTS who want AI systems and automations built for their businesses.

Primary audience: business owners, founders, ops leads — they care about business outcomes, time saved, money made. Practitioners (devs, engineers) are a secondary audience that gets pulled in naturally if the technical work is credible. DREK should not optimize for practitioners at the expense of clients.

Pick projects that best illustrate the topic in a way that makes a viewer say "I want this built for my business." Lead with projects that have visible business impact (dashboards, metrics, real outputs). Avoid pure-research demos.

OUTPUT FORMAT:
Return a single JSON array, 2-4 elements, ordered most-to-least relevant. Each element matches:
{
  "projectSlug": "<slug from <projects_portfolio>>",
  "projectName": "<human name>",
  "matchedFeatures": ["<demoable business-facing feature>", ...],
  "relevanceScore": <number 0..1>,
  "suggestedDemoSequence": "<2-4 sentences: shot list, business-outcome-first>"
}

RULES:
- projectSlug MUST come from <projects_portfolio>.
- Lead with the business outcome, then show the system that produces it. Tech-first framing is wrong for this audience.
- matchedFeatures must be ones a non-technical viewer can FOLLOW, not internal architecture diagrams.
- Output JSON ONLY. No fences. Start with [ and end with ].`;

interface MatchProjectsOptions {
  provider?: LLMProvider;
  client?: NeurocoreClient;
  db?: Firestore;
  timeoutMs?: number;
  /** Override the per-call Neurocore token budget. Defaults to the
   *  injection profile's max (6000 for cover letter, 8000 for YouTube). */
  tokenBudget?: number;
}

export interface MatchProjectsResult {
  plan: Plan;
  matchedProjects: MatchedProject[];
  /** True iff Neurocore returned a degraded response (e.g. embedding service
   *  partial-outage). The matches are still usable, just possibly thinner. */
  degraded: boolean;
  retried: boolean;
  durationMs: number;
}

export async function matchProjects(
  planId: string,
  opts: MatchProjectsOptions = {},
): Promise<MatchProjectsResult> {
  const t0 = Date.now();
  const provider = opts.provider ?? getLLMProvider();
  const client = opts.client ?? getNeurocoreClient();

  // ---- Load + validate plan ------------------------------------------
  const plan = await getPlan(planId, opts.db);
  if (!plan) {
    throw new PlanningEngineError(STEP_NAME, 'PLAN_NOT_FOUND', `no plan with id ${planId}`, {
      planId,
    });
  }
  if (!isAllowedPlanTransition(plan.status, 'projects_matched')) {
    throw new PlanningEngineError(
      STEP_NAME,
      'DISALLOWED_TRANSITION',
      `cannot transition from ${plan.status} to projects_matched`,
      { planId, detail: { from: plan.status, to: 'projects_matched' } },
    );
  }
  if (plan.type === 'cover_letter' && plan.requirements.length === 0) {
    throw new PlanningEngineError(
      STEP_NAME,
      'NO_REQUIREMENTS',
      'cover letter plan has no requirements — run requirement detection (M4) first',
      { planId },
    );
  }

  // ---- Fetch Neurocore context ---------------------------------------
  // contactId === listingId by DREK convention. PI's fit-score insight
  // lives under that key, so passing it pulls in proposalHooks etc.
  const jobContextHint = buildJobContextHint(plan);
  let context: MemoryContextResponse;
  try {
    context = await client.getProjectContext({
      planMode: plan.type,
      ...(plan.sourceListingId ? { contactId: plan.sourceListingId } : {}),
      ...(jobContextHint ? { jobContextHint } : {}),
      ...(opts.tokenBudget !== undefined ? { tokenBudget: opts.tokenBudget } : {}),
    });
  } catch (err) {
    if (err instanceof NeurocoreError) {
      throw new PlanningEngineError(
        STEP_NAME,
        'LLM_FAILED', // sloppy but accurate — "external dep failed"; UI just retries
        `neurocore unreachable: ${err.message}`,
        { planId, detail: { neurocoreCode: err.code } },
      );
    }
    throw err;
  }

  const systemBlock = context.systemBlock.slice(0, MAX_CONTEXT_CHARS);

  // ---- Build prompt and call LLM ------------------------------------
  const basePrompt = buildPrompt(plan, systemBlock);
  let retried = false;
  let matchedProjects: MatchedProject[];

  try {
    const raw = await invokeLLM(provider, basePrompt, opts.timeoutMs);
    const parsed = tryParseMatchedProjects(raw);
    if (parsed.ok) {
      matchedProjects = parsed.value;
    } else {
      retried = true;
      const stricter = `${basePrompt}\n\nIMPORTANT: Your previous response was not parseable. Respond with ONLY a JSON array — no fences, no prose. Start with [ and end with ].`;
      const raw2 = await invokeLLM(provider, stricter, opts.timeoutMs);
      const parsed2 = tryParseMatchedProjects(raw2);
      if (!parsed2.ok) {
        throw new PlanningEngineError(
          STEP_NAME,
          'INVALID_OUTPUT',
          `LLM output did not parse as MatchedProject[] after retry: ${parsed2.reason}`,
          { planId, detail: parsed2.detail },
        );
      }
      matchedProjects = parsed2.value;
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

  if (matchedProjects.length === 0) {
    throw new PlanningEngineError(
      STEP_NAME,
      'NO_PROJECT_MATCHES',
      'LLM returned no matched projects — the listing may be too niche or the portfolio has no relevant work',
      { planId },
    );
  }

  // ---- Persist + transition ------------------------------------------
  let updated: Plan | null;
  try {
    updated = await patchPlan(
      planId,
      { matchedProjects, status: 'projects_matched' },
      opts.db,
    );
  } catch (err) {
    throw new PlanningEngineError(
      STEP_NAME,
      'PERSIST_FAILED',
      `failed to persist matched projects: ${(err as Error).message}`,
      { planId },
    );
  }
  if (!updated) {
    throw new PlanningEngineError(
      STEP_NAME,
      'PLAN_NOT_FOUND',
      'plan disappeared during project matching',
      { planId },
    );
  }

  const durationMs = Date.now() - t0;
  logger.info(
    {
      planId,
      planType: plan.type,
      matchCount: matchedProjects.length,
      retried,
      degraded: context.metadata.degraded,
      contextTokens: context.metadata.estimatedTokens,
      durationMs,
    },
    'project matching complete',
  );
  return {
    plan: updated,
    matchedProjects,
    degraded: context.metadata.degraded,
    retried,
    durationMs,
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

type JobContextHintInput = Pick<Plan, 'type' | 'title' | 'requirements' | 'userConstraints'>;

function buildJobContextHint(plan: JobContextHintInput): string {
  if (plan.type === 'cover_letter') {
    // Skill snippet biases the Neurocore vector search — keep it short.
    const skills = plan.requirements
      .slice(0, 6)
      .map((r) => r.skill)
      .join(', ');
    return skills.length > 0 ? `Needs: ${skills}` : plan.title;
  }
  // YouTube: title + user constraints if any, capped.
  const parts = [plan.title];
  if (plan.userConstraints) parts.push(plan.userConstraints);
  return parts.join(' — ').slice(0, 500);
}

function buildPrompt(plan: Plan, systemBlock: string): string {
  const promptHeader = plan.type === 'cover_letter' ? SYSTEM_PROMPT_COVER_LETTER : SYSTEM_PROMPT_YOUTUBE;
  const userBrief = renderUserBrief(plan).slice(0, MAX_REQUIREMENTS_CHARS);
  return `${promptHeader}\n\nCONTEXT FROM NEUROCORE (project portfolio + Rick's profile + listing insight when present):\n\n${systemBlock}\n\nBRIEF FOR THIS VIDEO:\n\n${userBrief}`;
}

function renderUserBrief(plan: Plan): string {
  if (plan.type === 'cover_letter') {
    const reqs = plan.requirements
      .map((r, i) => {
        const tag = r.priority === 'must_show' ? '[MUST_SHOW]' : '[NICE_TO_SHOW]';
        return `${i + 1}. ${tag} ${r.skill} (${r.category}) — evidence: "${r.evidence}"`;
      })
      .join('\n');
    const constraints = plan.userConstraints
      ? `\n\nRick's additional constraints for this video:\n${plan.userConstraints}`
      : '';
    return `Plan type: cover_letter\nListing: ${plan.title}\n\nRequirements extracted from the listing:\n${reqs}${constraints}`;
  }
  // YouTube
  const constraints = plan.userConstraints
    ? `\n\nRick's additional constraints:\n${plan.userConstraints}`
    : '';
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
  | { ok: true; value: MatchedProject[] }
  | { ok: false; reason: string; detail: unknown };

function tryParseMatchedProjects(raw: string): ParseOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(raw));
  } catch (err) {
    return { ok: false, reason: 'not valid JSON', detail: (err as Error).message };
  }
  const validated = matchedProjectsArraySchema.safeParse(parsed);
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
  SYSTEM_PROMPT_COVER_LETTER,
  SYSTEM_PROMPT_YOUTUBE,
  buildPrompt,
  buildJobContextHint,
  renderUserBrief,
  tryParseMatchedProjects,
};
