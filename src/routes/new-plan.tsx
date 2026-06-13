import { Hono } from 'hono';
import { z } from 'zod';
import { logger } from '../logger.js';
import { createPlan } from '../db/plans.js';
import { getListing, markListingSelected } from '../db/listings.js';
import { listFormatProfiles } from '../engine/format-profiles/index.js';
import { getAudienceProfileClient } from '../neurocore/audience-profiles.js';
import { createYoutubeAdvancedPlanDirect } from '../intake/service.js';
import {
  NewCoverLetterPlanPage,
  NewYoutubePlanPage,
  NewYoutubeAdvancedPlanPage,
} from '../views/new-plan.js';

const app = new Hono();

// Both forms validate target runtime against the same bounds as the Plan
// schema (30s..1h). z.coerce because HTML form inputs arrive as strings.
const RUNTIME = z.coerce.number().int().min(30).max(3600);

const coverLetterCreate = z.object({
  title: z.string().min(1, 'title is required'),
  sourceListingText: z.string().min(1, 'listing text is required'),
  targetRuntimeSeconds: RUNTIME,
  userConstraints: z.string().optional(),
  sourceListingId: z.string().optional(),
});

const youtubeCreate = z.object({
  title: z.string().min(1, 'topic is required'),
  targetRuntimeSeconds: RUNTIME,
  userConstraints: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Cover letter
// ---------------------------------------------------------------------------

app.get('/plans/new/cover-letter', async (c) => {
  const url = new URL(c.req.url);
  const listingId = url.searchParams.get('listingId');
  let prefilled = null;
  if (listingId) {
    const l = await getListing(listingId);
    if (l) {
      prefilled = { id: l.id, title: l.title, rawText: l.rawText };
    }
  }
  // Fallback: accept title/text as query params (for PI listings not in DREK's DB)
  if (!prefilled) {
    const title = url.searchParams.get('title');
    const text = url.searchParams.get('text');
    if (title || text) {
      prefilled = { id: listingId ?? undefined, title: title ?? '', rawText: text ?? '' };
    }
  }
  return c.html(<NewCoverLetterPlanPage prefilled={prefilled} />);
});

app.post('/plans/new/cover-letter', async (c) => {
  const form = await c.req.formData();
  const raw = Object.fromEntries(form) as Record<string, string>;
  const parsed = coverLetterCreate.safeParse({
    ...raw,
    targetRuntimeSeconds: raw.targetRuntimeSeconds,
  });
  if (!parsed.success) {
    return c.html(
      <NewCoverLetterPlanPage
        values={{
          title: raw.title,
          sourceListingText: raw.sourceListingText,
          targetRuntimeSeconds: Number(raw.targetRuntimeSeconds) || 120,
          userConstraints: raw.userConstraints,
        }}
        error={parsed.error.errors[0]?.message ?? 'invalid input'}
      />,
      400,
    );
  }

  try {
    const plan = await createPlan({
      type: 'cover_letter',
      title: parsed.data.title,
      sourceListingText: parsed.data.sourceListingText,
      sourceListingId: parsed.data.sourceListingId ?? null,
      targetRuntimeSeconds: parsed.data.targetRuntimeSeconds,
      userConstraints: parsed.data.userConstraints ?? null,
      // Manual cover letters skip the polling-triggered awaiting_review
      // state — Rick made them, they're already "his". They go straight
      // to awaiting_review anyway because that's the entry state for the
      // M4 requirement detection step. Same path as polled listings from
      // this point forward, just without the auto-creation.
      status: 'awaiting_review',
    });
    if (parsed.data.sourceListingId) {
      await markListingSelected(parsed.data.sourceListingId, plan.id);
    }
    return c.redirect(`/plans/${plan.id}`, 303);
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'cover letter plan create failed');
    return c.html(
      <NewCoverLetterPlanPage
        values={{
          title: parsed.data.title,
          sourceListingText: parsed.data.sourceListingText,
          targetRuntimeSeconds: parsed.data.targetRuntimeSeconds,
          userConstraints: parsed.data.userConstraints,
        }}
        error={`Failed to create plan: ${(err as Error).message}`}
      />,
      500,
    );
  }
});

// ---------------------------------------------------------------------------
// YouTube
// ---------------------------------------------------------------------------

app.get('/plans/new/youtube', async (c) => {
  return c.html(<NewYoutubePlanPage />);
});

app.post('/plans/new/youtube', async (c) => {
  const form = await c.req.formData();
  const raw = Object.fromEntries(form) as Record<string, string>;
  const parsed = youtubeCreate.safeParse(raw);
  if (!parsed.success) {
    return c.html(
      <NewYoutubePlanPage
        values={{
          title: raw.title,
          targetRuntimeSeconds: Number(raw.targetRuntimeSeconds) || 600,
          userConstraints: raw.userConstraints,
        }}
        error={parsed.error.errors[0]?.message ?? 'invalid input'}
      />,
      400,
    );
  }

  try {
    const plan = await createPlan({
      // 'youtube' renamed 'youtube_lite' in v2. The existing form covers the
      // lite path; youtube_advanced has its own form added in M16/M17.
      type: 'youtube_lite',
      title: parsed.data.title,
      targetRuntimeSeconds: parsed.data.targetRuntimeSeconds,
      userConstraints: parsed.data.userConstraints ?? null,
      // YouTube plans skip requirement review entirely (no listing to
      // analyze). Land directly at requirements_reviewed so the M5
      // project-matching step's transition is allowed.
      status: 'requirements_reviewed',
    });
    return c.redirect(`/plans/${plan.id}`, 303);
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'youtube plan create failed');
    return c.html(
      <NewYoutubePlanPage
        values={{
          title: parsed.data.title,
          targetRuntimeSeconds: parsed.data.targetRuntimeSeconds,
          userConstraints: parsed.data.userConstraints,
        }}
        error={`Failed to create plan: ${(err as Error).message}`}
      />,
      500,
    );
  }
});

// ---------------------------------------------------------------------------
// YouTube Advanced
// ---------------------------------------------------------------------------

const youtubeAdvancedCreate = z.object({
  title: z.string().min(1, 'title is required'),
  formatProfileId: z.string().min(1, 'format profile is required'),
  audienceProfileId: z.string().min(1, 'audience profile is required'),
  targetRuntimeSeconds: RUNTIME.optional(),
  userConstraints: z.string().optional(),
});

app.get('/plans/new/youtube-advanced', async (c) => {
  const formatProfiles = listFormatProfiles();
  let audienceProfiles: Awaited<ReturnType<ReturnType<typeof getAudienceProfileClient>['list']>> = [];
  let listError: string | null = null;
  try {
    audienceProfiles = await getAudienceProfileClient().list();
  } catch (err) {
    listError = `Could not load audience profiles from Neurocore: ${(err as Error).message}`;
    logger.warn({ err: (err as Error).message }, 'new-plan: audience profile list failed');
  }
  return c.html(
    <NewYoutubeAdvancedPlanPage
      formatProfiles={formatProfiles}
      audienceProfiles={audienceProfiles}
      error={listError}
    />,
  );
});

app.post('/plans/new/youtube-advanced', async (c) => {
  const form = await c.req.formData();
  const raw = Object.fromEntries(form) as Record<string, string>;
  const parsed = youtubeAdvancedCreate.safeParse({
    ...raw,
    targetRuntimeSeconds: raw.targetRuntimeSeconds || undefined,
  });

  const formatProfiles = listFormatProfiles();
  let audienceProfiles: Awaited<ReturnType<ReturnType<typeof getAudienceProfileClient>['list']>> = [];
  try {
    audienceProfiles = await getAudienceProfileClient().list();
  } catch {
    // Continue — validation error will surface before we need the list.
  }

  if (!parsed.success) {
    return c.html(
      <NewYoutubeAdvancedPlanPage
        formatProfiles={formatProfiles}
        audienceProfiles={audienceProfiles}
        values={{
          title: raw.title,
          formatProfileId: raw.formatProfileId,
          audienceProfileId: raw.audienceProfileId,
          targetRuntimeSeconds: Number(raw.targetRuntimeSeconds) || undefined,
          userConstraints: raw.userConstraints,
        }}
        error={parsed.error.errors[0]?.message ?? 'invalid input'}
      />,
      400,
    );
  }

  try {
    const { planId } = await createYoutubeAdvancedPlanDirect({
      title: parsed.data.title,
      formatProfileId: parsed.data.formatProfileId,
      audienceProfileId: parsed.data.audienceProfileId,
      targetRuntimeSeconds: parsed.data.targetRuntimeSeconds,
      userConstraints: parsed.data.userConstraints ?? null,
    });
    return c.redirect(`/plans/${planId}`, 303);
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'youtube-advanced plan direct-create failed');
    return c.html(
      <NewYoutubeAdvancedPlanPage
        formatProfiles={formatProfiles}
        audienceProfiles={audienceProfiles}
        values={{
          title: parsed.data.title,
          formatProfileId: parsed.data.formatProfileId,
          audienceProfileId: parsed.data.audienceProfileId,
          targetRuntimeSeconds: parsed.data.targetRuntimeSeconds,
          userConstraints: parsed.data.userConstraints,
        }}
        error={`Failed to create plan: ${(err as Error).message}`}
      />,
      500,
    );
  }
});

export default app;
