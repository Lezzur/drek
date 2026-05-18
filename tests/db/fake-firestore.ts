/**
 * A tiny in-memory Firestore stand-in. Implements just enough of the Firebase
 * Admin SDK's fluent API for DREK's CRUD modules. The goal is to exercise the
 * happy path through every CRUD function without spinning up the emulator.
 *
 * Real integration tests against the emulator are deferred to M13.
 */

type DocData = Record<string, unknown>;

interface DocSnap {
  id: string;
  exists: boolean;
  data(): DocData | undefined;
  ref: DocRef;
}

interface QuerySnap {
  docs: DocSnap[];
  empty: boolean;
  size: number;
}

interface DocRef {
  id: string;
  set(data: DocData, opts?: { merge?: boolean }): Promise<void>;
  get(): Promise<DocSnap>;
  update(data: DocData): Promise<void>;
  delete(): Promise<void>;
  collection(name: string): CollectionRef;
}

interface Query {
  where(field: string, op: '==', value: unknown): Query;
  orderBy(field: string, dir?: 'asc' | 'desc'): Query;
  limit(n: number): Query;
  startAfter(snap: DocSnap): Query;
  get(): Promise<QuerySnap>;
  count(): CountQuery;
}

interface CountQuery {
  get(): Promise<{ data: () => { count: number } }>;
}

interface CollectionRef extends Query {
  doc(id: string): DocRef;
  count(): CountQuery;
}

interface Batch {
  set(ref: DocRef, data: DocData, opts?: { merge?: boolean }): Batch;
  update(ref: DocRef, data: DocData): Batch;
  delete(ref: DocRef): Batch;
  commit(): Promise<void>;
}

interface FakeStore {
  // Path is a flat string key like 'plans/plan_1/scenes/scene_1' so subcollections
  // resolve naturally.
  data: Map<string, DocData>;
}

function makeQuery(store: FakeStore, basePath: string, filters: {
  wheres: Array<{ field: string; value: unknown }>;
  orderField: string | null;
  orderDir: 'asc' | 'desc';
  limit: number | null;
  startAfterId: string | null;
}): Query {
  return {
    where(field, _op, value) {
      return makeQuery(store, basePath, {
        ...filters,
        wheres: [...filters.wheres, { field, value }],
      });
    },
    orderBy(field, dir = 'asc') {
      return makeQuery(store, basePath, { ...filters, orderField: field, orderDir: dir });
    },
    limit(n) {
      return makeQuery(store, basePath, { ...filters, limit: n });
    },
    startAfter(snap) {
      return makeQuery(store, basePath, { ...filters, startAfterId: snap.id });
    },
    count(): CountQuery {
      return {
        async get() {
          const prefix = `${basePath}/`;
          let count = 0;
          for (const [key, data] of store.data.entries()) {
            if (!key.startsWith(prefix)) continue;
            const rest = key.slice(prefix.length);
            if (rest.includes('/')) continue;
            if (filters.wheres.every((w) => fieldEquals(data, w.field, w.value))) {
              count++;
            }
          }
          return { data: () => ({ count }) };
        },
      };
    },
    async get(): Promise<QuerySnap> {
      const prefix = `${basePath}/`;
      // Match docs directly under basePath (not deeper subcollection docs).
      const matches: Array<{ id: string; data: DocData }> = [];
      for (const [key, data] of store.data.entries()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        if (rest.includes('/')) continue; // sub-subcollection
        if (filters.wheres.every((w) => fieldEquals(data, w.field, w.value))) {
          matches.push({ id: rest, data });
        }
      }
      if (filters.orderField) {
        const dirSign = filters.orderDir === 'desc' ? -1 : 1;
        matches.sort((a, b) => {
          const av = readField(a.data, filters.orderField!);
          const bv = readField(b.data, filters.orderField!);
          if (av === bv) return 0;
          if (av === null || av === undefined) return 1;
          if (bv === null || bv === undefined) return -1;
          if (av < bv) return -1 * dirSign;
          if (av > bv) return 1 * dirSign;
          return 0;
        });
      }
      let result = matches;
      if (filters.startAfterId) {
        const idx = result.findIndex((m) => m.id === filters.startAfterId);
        if (idx >= 0) result = result.slice(idx + 1);
      }
      if (filters.limit !== null) result = result.slice(0, filters.limit);
      const docs: DocSnap[] = result.map(({ id, data }) =>
        makeDocSnap(store, basePath, id, data),
      );
      return { docs, empty: docs.length === 0, size: docs.length };
    },
  };
}

function fieldEquals(data: DocData, field: string, value: unknown): boolean {
  return readField(data, field) === value;
}

function readField(data: DocData, field: string): unknown {
  if (!field.includes('.')) return data[field];
  const parts = field.split('.');
  let cur: unknown = data;
  for (const p of parts) {
    if (cur && typeof cur === 'object' && p in (cur as object)) {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return undefined;
    }
  }
  return cur;
}

function makeDocSnap(store: FakeStore, basePath: string, id: string, data: DocData): DocSnap {
  return {
    id,
    exists: true,
    data: () => data,
    ref: makeDocRef(store, basePath, id),
  };
}

function makeDocRef(store: FakeStore, basePath: string, id: string): DocRef {
  const path = `${basePath}/${id}`;
  return {
    id,
    async set(data, opts) {
      if (opts?.merge) {
        const existing = store.data.get(path) ?? {};
        store.data.set(path, { ...existing, ...data });
      } else {
        store.data.set(path, { ...data });
      }
    },
    async get(): Promise<DocSnap> {
      const data = store.data.get(path);
      if (data === undefined) {
        return {
          id,
          exists: false,
          data: () => undefined,
          ref: makeDocRef(store, basePath, id),
        };
      }
      return makeDocSnap(store, basePath, id, data);
    },
    async update(data) {
      const existing = store.data.get(path);
      if (!existing) throw new Error(`update on missing doc: ${path}`);
      // Support dotted-path updates (e.g., 'content.structured.flag': true).
      const merged = { ...existing };
      for (const [k, v] of Object.entries(data)) {
        if (k.includes('.')) {
          const parts = k.split('.');
          let cur: Record<string, unknown> = merged;
          for (let i = 0; i < parts.length - 1; i++) {
            const segment = parts[i]!;
            const next = cur[segment];
            const nextObj: Record<string, unknown> =
              next && typeof next === 'object' && !Array.isArray(next)
                ? { ...(next as Record<string, unknown>) }
                : {};
            cur[segment] = nextObj;
            cur = nextObj;
          }
          cur[parts[parts.length - 1]!] = v;
        } else {
          merged[k] = v;
        }
      }
      store.data.set(path, merged);
    },
    async delete() {
      store.data.delete(path);
    },
    collection(name) {
      return makeCollectionRef(store, `${path}/${name}`);
    },
  };
}

function makeCollectionRef(store: FakeStore, basePath: string): CollectionRef {
  const baseQuery = makeQuery(store, basePath, {
    wheres: [],
    orderField: null,
    orderDir: 'asc',
    limit: null,
    startAfterId: null,
  });
  return {
    ...baseQuery,
    doc(id) {
      return makeDocRef(store, basePath, id);
    },
    count(): CountQuery {
      return {
        async get() {
          let count = 0;
          const prefix = `${basePath}/`;
          for (const key of store.data.keys()) {
            if (!key.startsWith(prefix)) continue;
            const rest = key.slice(prefix.length);
            if (rest.includes('/')) continue;
            count++;
          }
          return { data: () => ({ count }) };
        },
      };
    },
  };
}

export interface FakeFirestore {
  collection(name: string): CollectionRef;
  batch(): Batch;
  /** Test-only: peek at the underlying store. */
  _dump(): Record<string, DocData>;
}

export function createFakeFirestore(): FakeFirestore {
  const store: FakeStore = { data: new Map() };
  return {
    collection(name) {
      return makeCollectionRef(store, name);
    },
    batch(): Batch {
      const ops: Array<() => Promise<void>> = [];
      const b: Batch = {
        set(ref, data, opts) {
          ops.push(() => ref.set(data, opts));
          return b;
        },
        update(ref, data) {
          ops.push(() => ref.update(data));
          return b;
        },
        delete(ref) {
          ops.push(() => ref.delete());
          return b;
        },
        async commit() {
          for (const op of ops) await op();
        },
      };
      return b;
    },
    _dump() {
      return Object.fromEntries(store.data);
    },
  };
}
