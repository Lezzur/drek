import { Hono } from 'hono';
import { z } from 'zod';
import { logger } from '../logger.js';
import { getPlan } from '../db/plans.js';
import { listScenes } from '../db/scenes.js';
import {
  computeSceneCoverage,
  deleteRecordingSession,
  listSessionsForPlan,
  logRecordingSession,
} from '../db/recording-sessions.js';
import { RECORDING_SESSION_TYPES } from '../db/schemas.js';
import { FootageTab } from '../views/footage.js';

const app = new Hono();

const sessionFormSchema = z.object({
  dateRecorded: z.string().min(1),
  sessionType: z.enum(RECORDING_SESSION_TYPES),
  durationMinutes: z.coerce.number().int().min(1).max(1440),
  filePath: z.string().min(1).max(1000),
  scenesCovered: z.union([z.string(), z.array(z.string())]),
  notes: z.string().optional().nullable(),
});

/**
 * GET /plans/:id/footage — render the footage manifest tab with coverage
 * summary, the log-session form, and the list of logged sessions.
 */
app.get('/plans/:id/footage', async (c) => {
  const id = c.req.param('id');
  const plan = await getPlan(id);
  if (!plan) return c.html('<h1>404 — plan not found</h1>', 404);

  const [scenes, sessions] = await Promise.all([
    listScenes(id),
    listSessionsForPlan(id),
  ]);
  const sceneIds = scenes.map((s) => s.id);
  const coverage = await computeSceneCoverage(id, sceneIds);

  return c.html(
    <FootageTab plan={plan} scenes={scenes} sessions={sessions} coverage={coverage} />,
  );
});

/**
 * POST /plans/:id/recording-sessions — log a new session.
 *
 * Accepts form-encoded data from the FootageTab form. scenesCovered comes
 * as either a string (single checkbox) or an array (multiple checkboxes).
 * Normalizes to a non-empty string[] then delegates to logRecordingSession.
 */
app.post('/plans/:id/recording-sessions', async (c) => {
  const id = c.req.param('id');
  const plan = await getPlan(id);
  if (!plan) return c.html('<h1>404 — plan not found</h1>', 404);

  let parsedForm: unknown;
  try {
    parsedForm = await c.req.parseBody({ all: true });
  } catch (err) {
    logger.warn({ planId: id, err: (err as Error).message }, 'footage form parse failed');
    return c.html('<h1>400 — bad form</h1>', 400);
  }

  const parsed = sessionFormSchema.safeParse(parsedForm);
  if (!parsed.success) {
    return c.html(
      `<h1>400 — invalid form</h1><pre>${JSON.stringify(parsed.error.flatten().fieldErrors, null, 2)}</pre>`,
      400,
    );
  }

  const scenesCovered = Array.isArray(parsed.data.scenesCovered)
    ? parsed.data.scenesCovered
    : [parsed.data.scenesCovered];

  if (scenesCovered.length === 0) {
    return c.html('<h1>400 — must select at least one scene</h1>', 400);
  }

  const dateRecorded = new Date(parsed.data.dateRecorded);
  if (Number.isNaN(dateRecorded.getTime())) {
    return c.html('<h1>400 — invalid dateRecorded</h1>', 400);
  }
  if (dateRecorded.getTime() > Date.now() + 24 * 60 * 60 * 1000) {
    // Allow up to one day in the future (timezone slop), reject anything beyond.
    return c.html('<h1>400 — dateRecorded cannot be in the future</h1>', 400);
  }

  try {
    await logRecordingSession({
      planId: id,
      dateRecorded,
      sessionType: parsed.data.sessionType,
      filePath: parsed.data.filePath,
      durationSeconds: parsed.data.durationMinutes * 60,
      scenesCovered,
      notes: parsed.data.notes && parsed.data.notes.length > 0 ? parsed.data.notes : null,
    });
  } catch (err) {
    logger.error({ planId: id, err: (err as Error).message }, 'logRecordingSession failed');
    return c.html('<h1>500 — failed to log session</h1>', 500);
  }

  return c.redirect(`/plans/${id}/footage`, 303);
});

/**
 * DELETE /recording-sessions/:id — remove a session log entry.
 * HTMX-friendly: returns an empty fragment so the swap removes the row.
 */
app.delete('/recording-sessions/:id', async (c) => {
  const id = c.req.param('id');
  const ok = await deleteRecordingSession(id);
  if (!ok) return c.json({ error: { code: 'NOT_FOUND', message: 'session not found' } }, 404);
  return c.html('', 200);
});

export default app;
