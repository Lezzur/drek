import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';

vi.mock('../../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() },
}));

import { createFakeFirestore, type FakeFirestore } from './fake-firestore.js';
import {
  upsertPublishMetadata,
  getPublishMetadata,
  patchPublishMetadata,
  deletePublishMetadata,
} from '../../src/db/publish-metadata.js';

let fake: FakeFirestore;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asDb = () => fake as unknown as Firestore;

const DEL_ID = 'del_pub_test_1';

const META_V1 = {
  description:
    'In this video I walk through building a full-stack portfolio site using Claude Code in under 4 hours.',
  chapters: [
    { timestampSeconds: 0, label: 'Intro' },
    { timestampSeconds: 120, label: 'Project Setup' },
    { timestampSeconds: 600, label: 'Claude Code in Action' },
    { timestampSeconds: 3600, label: 'Final Review' },
  ],
  tags: ['claude-code', 'portfolio', 'ai-developer', 'tutorial'],
  pinnedComment: 'Links and resources from this video: https://example.com/resources',
  endScreenSuggestion: 'Watch my next video on deploying to production with zero downtime.',
};

const META_V2 = {
  description: 'UPDATED: How I built an AI-powered portfolio in one afternoon — full breakdown.',
  chapters: [
    { timestampSeconds: 0, label: 'Hook' },
    { timestampSeconds: 30, label: 'What We Are Building' },
    { timestampSeconds: 120, label: 'Claude Code Setup' },
    { timestampSeconds: 900, label: 'Live Build' },
    { timestampSeconds: 3800, label: 'Results' },
  ],
  tags: ['claude-code', 'portfolio', 'ai', 'productivity'],
  pinnedComment: 'Updated resource list: https://example.com/v2-resources',
  endScreenSuggestion: 'Next: Building a SaaS in a weekend with AI tools.',
};

beforeEach(() => {
  fake = createFakeFirestore();
});

describe('upsertPublishMetadata', () => {
  it('creates publish metadata and sets generatedAt', async () => {
    const meta = await upsertPublishMetadata(DEL_ID, META_V1, asDb());
    expect(meta.description).toBe(META_V1.description);
    expect(meta.chapters).toHaveLength(4);
    expect(meta.tags).toEqual(META_V1.tags);
    expect(meta.pinnedComment).toBe(META_V1.pinnedComment);
    expect(meta.endScreenSuggestion).toBe(META_V1.endScreenSuggestion);
    expect(meta.generatedAt).toBeInstanceOf(Date);
    expect(meta.lastEditedAt).toBeNull();
  });

  it('overwrites existing metadata on re-upsert with different content', async () => {
    await upsertPublishMetadata(DEL_ID, META_V1, asDb());
    const updated = await upsertPublishMetadata(DEL_ID, META_V2, asDb());
    expect(updated.description).toBe(META_V2.description);
    expect(updated.chapters).toHaveLength(5);
    expect(updated.tags).toEqual(META_V2.tags);
    // lastEditedAt resets to null on full upsert
    expect(updated.lastEditedAt).toBeNull();
  });

  it('stores at the fixed path deliverables/{id}/publish_metadata/current', async () => {
    await upsertPublishMetadata(DEL_ID, META_V1, asDb());
    const dump = fake._dump();
    const key = `deliverables/${DEL_ID}/publish_metadata/current`;
    expect(dump[key]).toBeDefined();
    expect(dump[key]!.description).toBe(META_V1.description);
  });
});

describe('getPublishMetadata', () => {
  it('returns null when no metadata exists', async () => {
    const result = await getPublishMetadata('del_missing', asDb());
    expect(result).toBeNull();
  });

  it('round-trips created metadata', async () => {
    await upsertPublishMetadata(DEL_ID, META_V1, asDb());
    const fetched = await getPublishMetadata(DEL_ID, asDb());
    expect(fetched?.description).toBe(META_V1.description);
    expect(fetched?.chapters).toHaveLength(4);
    expect(fetched?.pinnedComment).toBe(META_V1.pinnedComment);
  });
});

describe('patchPublishMetadata', () => {
  it('returns null when no metadata exists', async () => {
    const result = await patchPublishMetadata('del_missing', { description: 'X' }, asDb());
    expect(result).toBeNull();
  });

  it('merges patched fields and sets lastEditedAt', async () => {
    await upsertPublishMetadata(DEL_ID, META_V1, asDb());
    const before = await getPublishMetadata(DEL_ID, asDb());
    expect(before?.lastEditedAt).toBeNull();

    await new Promise((r) => setTimeout(r, 5));
    const patched = await patchPublishMetadata(
      DEL_ID,
      { description: 'Patched description here' },
      asDb(),
    );
    expect(patched?.description).toBe('Patched description here');
    // Other fields preserved
    expect(patched?.pinnedComment).toBe(META_V1.pinnedComment);
    expect(patched?.tags).toEqual(META_V1.tags);
    // lastEditedAt is now set
    expect(patched?.lastEditedAt).toBeInstanceOf(Date);
  });

  it('can patch tags independently', async () => {
    await upsertPublishMetadata(DEL_ID, META_V1, asDb());
    const patched = await patchPublishMetadata(
      DEL_ID,
      { tags: ['new-tag', 'another-tag', 'dev-tools'] },
      asDb(),
    );
    expect(patched?.tags).toEqual(['new-tag', 'another-tag', 'dev-tools']);
    // description still intact
    expect(patched?.description).toBe(META_V1.description);
  });
});

describe('deletePublishMetadata', () => {
  it('returns false when metadata does not exist', async () => {
    expect(await deletePublishMetadata('del_missing', asDb())).toBe(false);
  });

  it('returns true and removes the metadata', async () => {
    await upsertPublishMetadata(DEL_ID, META_V1, asDb());
    expect(await deletePublishMetadata(DEL_ID, asDb())).toBe(true);
    expect(await getPublishMetadata(DEL_ID, asDb())).toBeNull();
  });
});
