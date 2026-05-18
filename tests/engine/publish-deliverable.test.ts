import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';

vi.mock('../../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() },
}));

import { createFakeFirestore, type FakeFirestore } from '../db/fake-firestore.js';
import { createPlan } from '../../src/db/plans.js';
import { createDeliverable } from '../../src/db/deliverables.js';
import {
  publishDeliverable,
  InvalidYouTubeUrlError,
  YOUTUBE_URL_REGEX,
} from '../../src/engine/publish-deliverable.js';
import { PlanningEngineError } from '../../src/engine/errors.js';
import { NeurocoreError } from '../../src/neurocore/errors.js';
import type { NeurocoreClient } from '../../src/neurocore/client.js';
import type { PublishedScriptSignal } from '../../src/neurocore/types.js';

let fake: FakeFirestore;
const asDb = () => fake as unknown as Firestore;

interface FakeClient {
  client: NeurocoreClient;
  sent: PublishedScriptSignal[];
  /** Make the next sendPublishedScript call throw. */
  failNext: (err: Error) => void;
}

function makeFakeClient(): FakeClient {
  const sent: PublishedScriptSignal[] = [];
  let nextError: Error | null = null;
  const client: Partial<NeurocoreClient> = {
    async sendPublishedScript(payload: PublishedScriptSignal) {
      if (nextError) {
        const e = nextError;
        nextError = null;
        throw e;
      }
      sent.push(payload);
    },
  };
  return {
    client: client as NeurocoreClient,
    sent,
    failNext(err: Error) {
      nextError = err;
    },
  };
}

beforeEach(() => {
  fake = createFakeFirestore();
});

describe('YOUTUBE_URL_REGEX', () => {
  it('accepts standard YouTube URLs', () => {
    expect(YOUTUBE_URL_REGEX.test('https://www.youtube.com/watch?v=abc123')).toBe(true);
    expect(YOUTUBE_URL_REGEX.test('https://youtube.com/watch?v=abc')).toBe(true);
    expect(YOUTUBE_URL_REGEX.test('https://youtu.be/abc123')).toBe(true);
    expect(YOUTUBE_URL_REGEX.test('https://www.youtube.com/shorts/abc')).toBe(true);
  });

  it('rejects non-YouTube URLs', () => {
    expect(YOUTUBE_URL_REGEX.test('http://www.youtube.com/watch?v=abc')).toBe(false);
    expect(YOUTUBE_URL_REGEX.test('https://evil.com/youtube.com/watch?v=abc')).toBe(false);
    expect(YOUTUBE_URL_REGEX.test('javascript:alert(1)')).toBe(false);
    expect(YOUTUBE_URL_REGEX.test('')).toBe(false);
    expect(YOUTUBE_URL_REGEX.test('https://vimeo.com/abc')).toBe(false);
  });
});

describe('publishDeliverable', () => {
  it('marks deliverable as published + sends signal', async () => {
    const plan = await createPlan(
      {
        type: 'youtube_advanced',
        title: 'Ep 1',
        targetRuntimeSeconds: 1800,
        formatProfileId: 'claude_code_build_along',
      },
      asDb(),
    );
    const del = await createDeliverable(
      {
        planId: plan.id,
        kind: 'long_form',
        audienceProfileId: 'developer_longform',
        title: 'Ep 1',
        status: 'exported',
      },
      asDb(),
    );

    const fc = makeFakeClient();
    const result = await publishDeliverable(
      del.id,
      'https://www.youtube.com/watch?v=abc123',
      { db: asDb(), client: fc.client },
    );

    expect(result.signalSent).toBe(true);
    const delDoc = fake._dump()[`deliverables/${del.id}`] as Record<string, unknown>;
    expect(delDoc.status).toBe('published');
    expect(delDoc.youtubeUrl).toBe('https://www.youtube.com/watch?v=abc123');
    expect(delDoc.publishedAt).toBeInstanceOf(Date);

    expect(fc.sent).toHaveLength(1);
    expect(fc.sent[0]).toMatchObject({
      planId: plan.id,
      deliverableId: del.id,
      kind: 'long_form',
      audienceProfileId: 'developer_longform',
      youtubeUrl: 'https://www.youtube.com/watch?v=abc123',
      title: 'Ep 1',
    });
  });

  it('still marks published locally when Neurocore signal fails', async () => {
    const plan = await createPlan(
      {
        type: 'youtube_advanced',
        title: 'Ep 1',
        targetRuntimeSeconds: 1800,
        formatProfileId: 'claude_code_build_along',
      },
      asDb(),
    );
    const del = await createDeliverable(
      {
        planId: plan.id,
        kind: 'long_form',
        audienceProfileId: 'developer_longform',
        title: 'Ep 1',
        status: 'exported',
      },
      asDb(),
    );

    const fc = makeFakeClient();
    fc.failNext(new NeurocoreError('UNREACHABLE', '/v1/memory/signals', 'down'));

    const result = await publishDeliverable(
      del.id,
      'https://youtu.be/abc',
      { db: asDb(), client: fc.client },
    );

    expect(result.signalSent).toBe(false);
    expect(result.signalError).toContain('UNREACHABLE');
    // Local status transition still succeeded.
    const delDoc = fake._dump()[`deliverables/${del.id}`] as Record<string, unknown>;
    expect(delDoc.status).toBe('published');
  });

  it('rejects invalid YouTube URL', async () => {
    const plan = await createPlan(
      { type: 'youtube_advanced', title: 'T', targetRuntimeSeconds: 1800, formatProfileId: 'claude_code_build_along' },
      asDb(),
    );
    const del = await createDeliverable(
      {
        planId: plan.id,
        kind: 'long_form',
        audienceProfileId: 'developer_longform',
        title: 'T',
        status: 'exported',
      },
      asDb(),
    );
    const fc = makeFakeClient();

    await expect(
      publishDeliverable(del.id, 'https://evil.com/youtube', {
        db: asDb(),
        client: fc.client,
      }),
    ).rejects.toBeInstanceOf(InvalidYouTubeUrlError);

    // No signal fired, no status change.
    expect(fc.sent).toHaveLength(0);
    const delDoc = fake._dump()[`deliverables/${del.id}`] as Record<string, unknown>;
    expect(delDoc.status).toBe('exported');
  });

  it('rejects missing deliverable', async () => {
    const fc = makeFakeClient();
    try {
      await publishDeliverable('del_nope', 'https://youtu.be/x', {
        db: asDb(),
        client: fc.client,
      });
      expect.fail('should throw');
    } catch (err) {
      expect((err as PlanningEngineError).code).toBe('PLAN_NOT_FOUND');
    }
  });

  it('signal payload kind is short_clip for short_clip deliverable', async () => {
    const plan = await createPlan(
      { type: 'youtube_advanced', title: 'T', targetRuntimeSeconds: 1800, formatProfileId: 'claude_code_build_along' },
      asDb(),
    );
    const del = await createDeliverable(
      {
        planId: plan.id,
        kind: 'short_clip',
        audienceProfileId: 'business_owner_shorts',
        title: 'Short 1',
        status: 'exported',
      },
      asDb(),
    );
    const fc = makeFakeClient();
    await publishDeliverable(del.id, 'https://youtu.be/abc', {
      db: asDb(),
      client: fc.client,
    });
    expect(fc.sent[0]!.kind).toBe('short_clip');
    expect(fc.sent[0]!.audienceProfileId).toBe('business_owner_shorts');
  });
});
