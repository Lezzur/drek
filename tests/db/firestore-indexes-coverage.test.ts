import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Static coverage check: every `// FIRESTORE-INDEX:` annotation in `src/`
 * must have a matching entry in `firestore.indexes.json`.
 *
 * Why this exists: composite-index gaps surfaced TWICE in production
 * (M25 pipeline_briefs(batchId, createdAt) + M35 tech_stack_profiles
 * (status, updatedAt)). Both were latent for weeks because nothing in
 * dev exercised them. The annotation convention + this test catches
 * future drift at PR time.
 *
 * Convention:
 *   `// FIRESTORE-INDEX: <collection>(<field>:<ASC|DESC>, ...)`
 *
 * Place the comment directly above any query that uses .where() + .orderBy()
 * (or any multi-field composite that Firestore can't auto-index).
 *
 * The test does NOT detect MISSING annotations on new composite queries —
 * that's still on the human writing the query. But it DOES catch:
 *   - annotation references a collection/fieldset that has no index entry
 *   - index entry exists but no annotation references it (dead index)
 */

const REPO_ROOT = resolve(__dirname, '../..');
const SRC_DIR = join(REPO_ROOT, 'src');
const INDEXES_FILE = join(REPO_ROOT, 'firestore.indexes.json');

interface FieldEntry {
  fieldPath: string;
  order: 'ASCENDING' | 'DESCENDING';
}
interface IndexEntry {
  collectionGroup: string;
  queryScope: string;
  fields: FieldEntry[];
}
interface AnnotatedQuery {
  collection: string;
  fields: FieldEntry[];
  file: string;
  line: number;
}

const ANNOTATION_RE = /\/\/\s*FIRESTORE-INDEX:\s*(\w+)\((.+?)\)\s*$/;

function walkTs(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) walkTs(full, acc);
    else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) acc.push(full);
  }
  return acc;
}

function parseAnnotations(): AnnotatedQuery[] {
  const out: AnnotatedQuery[] = [];
  for (const file of walkTs(SRC_DIR)) {
    const lines = readFileSync(file, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i]!.match(ANNOTATION_RE);
      if (!m) continue;
      const collection = m[1]!;
      const fieldSpec = m[2]!;
      const fields: FieldEntry[] = fieldSpec.split(',').map((part) => {
        const [path, dir] = part.trim().split(':');
        if (!path || !dir) {
          throw new Error(
            `Malformed FIRESTORE-INDEX annotation at ${file}:${i + 1} — expected "field:ASC|DESC", got "${part}"`,
          );
        }
        const order: 'ASCENDING' | 'DESCENDING' =
          dir.toUpperCase() === 'DESC' ? 'DESCENDING' : 'ASCENDING';
        return { fieldPath: path, order };
      });
      out.push({
        collection,
        fields,
        file: file.replace(REPO_ROOT + '/', ''),
        line: i + 1,
      });
    }
  }
  return out;
}

function loadIndexes(): IndexEntry[] {
  const raw = JSON.parse(readFileSync(INDEXES_FILE, 'utf8')) as {
    indexes: IndexEntry[];
  };
  return raw.indexes;
}

function indexMatches(idx: IndexEntry, q: AnnotatedQuery): boolean {
  if (idx.collectionGroup !== q.collection) return false;
  if (idx.fields.length !== q.fields.length) return false;
  for (let i = 0; i < idx.fields.length; i++) {
    if (idx.fields[i]!.fieldPath !== q.fields[i]!.fieldPath) return false;
    if (idx.fields[i]!.order !== q.fields[i]!.order) return false;
  }
  return true;
}

describe('firestore-indexes coverage', () => {
  const annotations = parseAnnotations();
  const indexes = loadIndexes();

  it('finds at least one annotated query (sanity)', () => {
    expect(annotations.length).toBeGreaterThan(0);
  });

  it('every FIRESTORE-INDEX annotation has a matching index entry', () => {
    const missing: string[] = [];
    for (const a of annotations) {
      const hit = indexes.some((idx) => indexMatches(idx, a));
      if (!hit) {
        const fieldStr = a.fields
          .map((f) => `${f.fieldPath}:${f.order === 'DESCENDING' ? 'DESC' : 'ASC'}`)
          .join(', ');
        missing.push(`  ${a.file}:${a.line} — ${a.collection}(${fieldStr})`);
      }
    }
    if (missing.length > 0) {
      throw new Error(
        `Missing firestore.indexes.json entries for these annotated queries:\n${missing.join('\n')}\n\nAdd entries to firestore.indexes.json and deploy: firebase deploy --only firestore:indexes`,
      );
    }
  });

  it('every composite index in firestore.indexes.json is referenced by some annotation', () => {
    // Skips single-field indexes (auto-indexed by Firestore anyway).
    const orphans: string[] = [];
    for (const idx of indexes) {
      if (idx.fields.length < 2) continue;
      const hit = annotations.some((a) => indexMatches(idx, a));
      if (!hit) {
        const fieldStr = idx.fields
          .map((f) => `${f.fieldPath}:${f.order === 'DESCENDING' ? 'DESC' : 'ASC'}`)
          .join(', ');
        orphans.push(`  ${idx.collectionGroup}(${fieldStr})`);
      }
    }
    if (orphans.length > 0) {
      throw new Error(
        `Composite indexes with no corresponding code annotation:\n${orphans.join('\n')}\n\nEither delete the dead index or add a // FIRESTORE-INDEX comment above its query.`,
      );
    }
  });
});
