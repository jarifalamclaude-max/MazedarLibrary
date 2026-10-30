// In-memory fake of the Firestore v9 modular API subset used by src/lib/sync.js:
// collection, doc, query, where, onSnapshot (includeMetadataChanges, fromCache,
// hasPendingWrites, docChanges), runTransaction (optimistic concurrency with the
// SDK's retry policy), serverTimestamp, Timestamp, plus setDoc/getDocs for tests.
//
// One fake server is shared by many clients ("devices"). Each client has its own
// network switch, auth uid and latency. Offline clients' listeners get a
// fromCache snapshot and resync when the client comes back; offline transactions
// fail with 'unavailable' after the SDK's retries. Security rules default to
// the same policy as firebase/firestore.rules. Time is virtual (createScheduler),
// so tests are fast and fully deterministic for a given PRNG seed.

/** Seeded PRNG (mulberry32): returns () => float in [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Virtual clock + timers. Nothing runs until the test calls advance()/runUntil();
 * between timers all pending promise callbacks are drained.
 * @param {{ start?: number }} [opts]
 */
export function createScheduler({ start = Date.UTC(2026, 9, 30, 12) } = {}) {
  let now = start;
  let seq = 0;
  const timers = new Map();
  const errors = [];
  const tick = () => new Promise((resolve) => setImmediate(resolve));

  function earliest() {
    let best = null;
    for (const t of timers.values()) {
      if (!best || t.at < best.at || (t.at === best.at && t.seq < best.seq)) best = t;
    }
    return best;
  }

  const api = {
    now: () => now,
    setTimeout(fn, ms = 0) {
      const id = ++seq;
      timers.set(id, { id, seq: id, at: now + Math.max(0, Number(ms) || 0), fn });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    sleep(ms) {
      return new Promise((resolve) => api.setTimeout(resolve, ms));
    },
    pendingTimers: () => timers.size,
    errors,
    /** Run every timer due within `ms`, draining promise callbacks in between. */
    async advance(ms = 0) {
      const target = now + ms;
      for (;;) {
        await tick();
        const t = earliest();
        if (!t || t.at > target) break;
        timers.delete(t.id);
        now = Math.max(now, t.at);
        try {
          t.fn();
        } catch (e) {
          errors.push(e);
        }
      }
      now = Math.max(now, target);
      await tick();
      if (errors.length) throw errors.shift();
    },
    /** Advance in `step` increments until `pred()` is truthy (or fail after `timeout`). */
    async runUntil(pred, { timeout = 10 * 60 * 1000, step = 50, label = 'condition' } = {}) {
      const end = now + timeout;
      for (;;) {
        if (await pred()) return;
        if (now >= end) throw new Error(`runUntil: timed out waiting for ${label}`);
        await api.advance(step);
      }
    },
  };
  return api;
}

/** Firestore-style error (the SDK's FirestoreError has name 'FirebaseError' and a code). */
export class FakeFirestoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FirebaseError';
    this.code = code;
  }
}

export class Timestamp {
  constructor(seconds, nanoseconds) {
    this.seconds = seconds;
    this.nanoseconds = nanoseconds;
  }
  static fromMillis(ms) {
    const seconds = Math.floor(ms / 1000);
    const nanoseconds = Math.floor((ms - seconds * 1000) * 1e6);
    return new Timestamp(seconds, nanoseconds);
  }
  static fromDate(d) {
    return Timestamp.fromMillis(d.getTime());
  }
  toMillis() {
    return this.seconds * 1000 + this.nanoseconds / 1e6;
  }
  toDate() {
    return new Date(this.toMillis());
  }
  isEqual(o) {
    return o instanceof Timestamp && o.seconds === this.seconds && o.nanoseconds === this.nanoseconds;
  }
  valueOf() {
    const s = this.seconds + 62135596800; // shift so the string sorts like the value
    return `${String(s).padStart(12, '0')}.${String(this.nanoseconds).padStart(9, '0')}`;
  }
  toJSON() {
    return { seconds: this.seconds, nanoseconds: this.nanoseconds, type: 'firestore/timestamp/1.0' };
  }
}

class ServerTimestampSentinel {
  constructor() {
    this._methodName = 'serverTimestamp';
  }
}

const MAX_DOC_BYTES = 1048576;
const MAX_REQUEST_BYTES = 10 * 1048576;
const MAX_TX_WRITES = 500;
const PERMANENT = new Set([
  'invalid-argument', 'not-found', 'already-exists', 'permission-denied', 'failed-precondition',
  'aborted', 'out-of-range', 'unimplemented', 'data-loss',
]);

function isRetryable(err) {
  if (err?.name !== 'FirebaseError') return false;
  const c = err.code;
  return c === 'aborted' || c === 'failed-precondition' || c === 'already-exists' || !PERMANENT.has(c);
}

function isPlainObject(v) {
  if (v === null || typeof v !== 'object') return false;
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
}

function splitPath(segments) {
  const parts = [];
  for (const s of segments) {
    if (typeof s !== 'string' || !s) throw new FakeFirestoreError('invalid-argument', `Invalid path segment ${String(s)}`);
    parts.push(...s.split('/'));
  }
  if (parts.some((p) => !p)) throw new FakeFirestoreError('invalid-argument', 'Path has an empty segment');
  return parts;
}

function utf8Bytes(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xd800 && c <= 0xdbff ? 4 : c >= 0xdc00 && c <= 0xdfff ? 0 : 3;
  }
  return n;
}

// Rough Firestore storage size, enough for the 1 MiB / 10 MiB limits.
function valueBytes(v) {
  if (v === null || v === undefined) return 1;
  if (typeof v === 'boolean') return 1;
  if (typeof v === 'number') return 8;
  if (typeof v === 'string') return utf8Bytes(v) + 1;
  if (v instanceof Timestamp) return 8;
  if (Array.isArray(v)) return v.reduce((n, x) => n + valueBytes(x), 0);
  if (typeof v === 'object') {
    let n = 0;
    for (const [k, x] of Object.entries(v)) n += utf8Bytes(k) + 1 + valueBytes(x);
    return n;
  }
  return 8;
}

function cloneValue(v) {
  if (v instanceof Timestamp) return new Timestamp(v.seconds, v.nanoseconds);
  if (Array.isArray(v)) return v.map(cloneValue);
  if (isPlainObject(v)) {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = cloneValue(x);
    return o;
  }
  return v; // primitives, and raw garbage injected by tests
}

/**
 * Copy user data into a storable value, validating like the SDK does.
 * Sentinels are kept and resolved at commit time.
 */
function prepareData(data, { ignoreUndefined }) {
  if (!isPlainObject(data)) throw new FakeFirestoreError('invalid-argument', 'Document data must be an object');
  const walk = (v, path, inArray) => {
    if (v === undefined) {
      if (ignoreUndefined) return undefined;
      throw new FakeFirestoreError('invalid-argument', `Unsupported field value: undefined (found in field ${path})`);
    }
    if (v === null || typeof v === 'boolean' || typeof v === 'string') return v;
    if (typeof v === 'number') return v;
    if (v instanceof Timestamp) return new Timestamp(v.seconds, v.nanoseconds);
    if (v instanceof ServerTimestampSentinel) {
      if (inArray) throw new FakeFirestoreError('invalid-argument', `serverTimestamp() is not supported inside arrays (field ${path})`);
      return v;
    }
    if (Array.isArray(v)) {
      if (inArray) throw new FakeFirestoreError('invalid-argument', `Nested arrays are not supported (field ${path})`);
      return v.map((x, i) => {
        const r = walk(x, `${path}.${i}`, true);
        if (r === undefined) throw new FakeFirestoreError('invalid-argument', `Unsupported field value: undefined (found in field ${path})`);
        return r;
      });
    }
    if (isPlainObject(v)) {
      const o = {};
      for (const [k, x] of Object.entries(v)) {
        if (/^__.*__$/.test(k)) throw new FakeFirestoreError('invalid-argument', `Reserved field name ${k}`);
        const r = walk(x, path ? `${path}.${k}` : k, false);
        if (r !== undefined) o[k] = r;
      }
      return o;
    }
    throw new FakeFirestoreError('invalid-argument', `Unsupported field value: ${typeof v} (found in field ${path})`);
  };
  return walk(data, '', false);
}

function resolveSentinels(v, ts) {
  if (v instanceof ServerTimestampSentinel) return ts;
  if (Array.isArray(v)) return v.map((x) => resolveSentinels(x, ts));
  if (isPlainObject(v)) {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = resolveSentinels(x, ts);
    return o;
  }
  return v;
}

function compareValues(a, b) {
  if (a instanceof Timestamp && b instanceof Timestamp) return a.toMillis() - b.toMillis();
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  return null; // different types never satisfy a range filter
}

function sameType(a, b) {
  return (a instanceof Timestamp && b instanceof Timestamp) || (typeof a === typeof b && !(a instanceof Timestamp) && !(b instanceof Timestamp));
}

function matchesFilters(data, filters) {
  for (const f of filters) {
    if (!data || !(f.field in data)) return false;
    const v = data[f.field];
    if (f.op === '==') {
      if (!sameType(v, f.value)) return false;
      if (compareValues(v, f.value) !== 0) return false;
      continue;
    }
    const c = compareValues(v, f.value);
    if (c === null) return false;
    if (f.op === '>' && !(c > 0)) return false;
    if (f.op === '>=' && !(c >= 0)) return false;
    if (f.op === '<' && !(c < 0)) return false;
    if (f.op === '<=' && !(c <= 0)) return false;
  }
  return true;
}

/**
 * The default rules: same policy as firebase/firestore.rules.
 * @param {{ auth: {uid:string}|null, op: 'get'|'list'|'create'|'update'|'delete', path: string, data?: object, time?: Timestamp }} req
 */
export function libraryRules({ auth, op, path, data, time }) {
  const seg = path.split('/');
  if (!auth || seg[0] !== 'libraries' || seg[1] !== auth.uid) return false;
  if (op === 'list') return seg.length === 3;
  if (seg.length !== 4) return false;
  if (op === 'get') return true;
  if (op === 'delete') return false;
  if (!['records', 'covers'].includes(seg[2])) return false;
  return isPlainObject(data)
    && data.id === seg[3]
    && isPlainObject(data._v)
    && data._srv instanceof Timestamp && !!time && data._srv.isEqual(time)
    && (data.kind === undefined || typeof data.kind === 'string');
}

/**
 * Create a fake Firestore backend.
 * @param {object} [opts]
 * @param {ReturnType<typeof createScheduler>} [opts.scheduler]
 * @param {() => number} [opts.rng]  seeded PRNG for retry jitter and random latency
 * @param {(req: object) => boolean} [opts.rules]
 */
export function createFakeFirestore({ scheduler = createScheduler(), rng = mulberry32(1), rules = libraryRules } = {}) {
  const sched = scheduler;
  const docs = new Map(); // path -> { data, version, updateTime }
  const clients = new Set();
  let version = 0;
  let lastCommitMs = 0;
  let currentRules = rules;
  let autoId = 0;
  const hooks = {};
  const stats = {
    commits: [], txAttempts: 0, txConflicts: 0, txReads: 0, listens: 0, snapshots: 0, docsDelivered: 0, rejected: 0,
  };

  const nextServerTime = () => {
    lastCommitMs = Math.max(lastCommitMs + 1, Math.floor(sched.now()));
    return Timestamp.fromMillis(lastCommitMs);
  };

  function clientOf(x) {
    const c = x?._client || x?.firestore?._client;
    if (!c || !clients.has(c)) throw new FakeFirestoreError('invalid-argument', 'Not a fake Firestore instance or reference');
    if (c.terminated) throw new FakeFirestoreError('failed-precondition', 'The client has already been terminated.');
    return c;
  }

  const lat = (c) => Math.max(0, typeof c.latency === 'function' ? c.latency(rng) : c.latency);
  const allowed = (c, req) => !!currentRules({ auth: c.uid ? { uid: c.uid } : null, ...req });
  const denied = () => new FakeFirestoreError('permission-denied', 'Missing or insufficient permissions.');
  const offline = () => new FakeFirestoreError('unavailable', 'Failed to get document because the client is offline.');

  // ---- references --------------------------------------------------------------
  class CollectionReference {
    constructor(db, path) {
      this.type = 'collection';
      this.firestore = db;
      this.path = path;
      this.id = path.split('/').pop();
    }
  }
  class DocumentReference {
    constructor(db, path) {
      this.type = 'document';
      this.firestore = db;
      this.path = path;
      this.id = path.split('/').pop();
    }
    get parent() {
      return new CollectionReference(this.firestore, this.path.split('/').slice(0, -1).join('/'));
    }
  }
  class Query {
    constructor(db, collPath, filters) {
      this.type = 'query';
      this.firestore = db;
      this._collPath = collPath;
      this._filters = filters;
    }
  }

  function collection(parent, ...segments) {
    const base = parent instanceof DocumentReference ? [parent.path] : [];
    const db = parent instanceof DocumentReference ? parent.firestore : parent;
    clientOf(db);
    const parts = splitPath([...base, ...segments]);
    if (parts.length % 2 !== 1) throw new FakeFirestoreError('invalid-argument', `Invalid collection path ${parts.join('/')}`);
    return new CollectionReference(db, parts.join('/'));
  }

  function doc(parent, ...segments) {
    let db = parent;
    let base = [];
    if (parent instanceof CollectionReference) {
      db = parent.firestore;
      base = [parent.path];
      if (!segments.length) segments = [`auto${String(++autoId).padStart(6, '0')}`];
    }
    clientOf(db);
    const parts = splitPath([...base, ...segments]);
    if (parts.length % 2 !== 0) throw new FakeFirestoreError('invalid-argument', `Invalid document path ${parts.join('/')}`);
    return new DocumentReference(db, parts.join('/'));
  }

  function where(field, op, value) {
    if (!['<', '<=', '==', '>', '>='].includes(op)) throw new FakeFirestoreError('unimplemented', `fake: operator ${op}`);
    return { type: 'where', field, op, value };
  }

  function query(base, ...constraints) {
    const collPath = base instanceof Query ? base._collPath : base.path;
    const filters = base instanceof Query ? [...base._filters] : [];
    if (!(base instanceof Query) && !(base instanceof CollectionReference)) {
      throw new FakeFirestoreError('invalid-argument', 'query() expects a collection or query');
    }
    for (const c of constraints) {
      if (c?.type !== 'where') throw new FakeFirestoreError('unimplemented', 'fake: only where() constraints');
      filters.push(c);
    }
    return new Query(base.firestore, collPath, filters);
  }

  const asQuery = (t) => (t instanceof Query ? t : t instanceof CollectionReference ? new Query(t.firestore, t.path, []) : null);
  const parentPath = (path) => path.split('/').slice(0, -1).join('/');

  // ---- snapshots -------------------------------------------------------------------
  function sortEntries(entries, filters) {
    const field = filters.find((f) => f.op !== '==')?.field;
    return entries.sort(([pa, ea], [pb, eb]) => {
      if (field) {
        const c = compareValues(ea.data[field], eb.data[field]);
        if (c) return c;
      }
      return pa < pb ? -1 : pa > pb ? 1 : 0;
    });
  }

  function docSnapshot(db, path, entry, meta) {
    const ref = new DocumentReference(db, path);
    return {
      id: ref.id,
      ref,
      metadata: meta,
      exists: () => !!entry,
      data: () => (entry ? cloneValue(entry.data) : undefined),
      get: (field) => (entry ? cloneValue(entry.data[field]) : undefined),
    };
  }

  function querySnapshot(listener, view, changes, meta) {
    const db = listener.client.db;
    const docsArr = view.map(([path, e]) => docSnapshot(db, path, e, { fromCache: meta.fromCache, hasPendingWrites: !!e.pending }));
    const byPath = new Map(docsArr.map((d, i) => [view[i][0], d]));
    const metadata = {
      fromCache: meta.fromCache,
      hasPendingWrites: meta.hasPendingWrites,
      isEqual: (o) => o.fromCache === meta.fromCache && o.hasPendingWrites === meta.hasPendingWrites,
    };
    return {
      query: listener.query,
      docs: docsArr,
      size: docsArr.length,
      empty: docsArr.length === 0,
      metadata,
      forEach: (cb, thisArg) => docsArr.forEach(cb, thisArg),
      docChanges: (opts = {}) => changes
        .filter((ch) => opts.includeMetadataChanges || !ch.metadataOnly)
        .map((ch) => ({
          type: ch.type,
          doc: ch.type === 'removed' ? docSnapshot(db, ch.path, ch.entry, metadata) : byPath.get(ch.path),
          oldIndex: ch.oldIndex,
          newIndex: ch.newIndex,
        })),
    };
  }

  // The view a client would compute for a query: server state + its pending writes.
  function computeView(c, q, source) {
    const out = [];
    const prefix = `${q._collPath}/`;
    const base = source === 'server' ? docs : c.cache;
    const merged = new Map();
    for (const [path, e] of base) {
      if (path.startsWith(prefix) && parentPath(path) === q._collPath) merged.set(path, e);
    }
    for (const w of c.pending) {
      if (parentPath(w.path) === q._collPath) merged.set(w.path, { data: w.local, version: -w.id, pending: true });
    }
    for (const [path, e] of merged) if (matchesFilters(e.data, q._filters)) out.push([path, e]);
    return sortEntries(out, q._filters);
  }

  function diff(oldView, newView) {
    const oldIdx = new Map(oldView.map(([p], i) => [p, i]));
    const newIdx = new Map(newView.map(([p], i) => [p, i]));
    const changes = [];
    for (const [p, e] of oldView) {
      if (!newIdx.has(p)) changes.push({ type: 'removed', path: p, entry: e, oldIndex: oldIdx.get(p), newIndex: -1 });
    }
    for (const [p, e] of newView) {
      if (!oldIdx.has(p)) {
        changes.push({ type: 'added', path: p, entry: e, oldIndex: -1, newIndex: newIdx.get(p) });
        continue;
      }
      const prev = oldView[oldIdx.get(p)][1];
      if (prev.version !== e.version) {
        const metadataOnly = !!prev.pending !== !!e.pending && JSON.stringify(prev.data) === JSON.stringify(e.data);
        changes.push({ type: 'modified', path: p, entry: e, oldIndex: oldIdx.get(p), newIndex: newIdx.get(p), metadataOnly });
      }
    }
    return changes;
  }

  function scheduleDelivery(listener) {
    if (!listener.active || listener.scheduled) return;
    listener.scheduled = true;
    sched.setTimeout(() => deliver(listener), lat(listener.client));
  }

  function deliver(listener) {
    listener.scheduled = false;
    if (!listener.active) return;
    const c = listener.client;
    const q = listener.query;
    let fromCache;
    let view;
    if (c.online) {
      if (!allowed(c, { op: 'list', path: q._collPath })) {
        stopListener(listener);
        stats.rejected += 1;
        listener.onError?.(denied());
        return;
      }
      view = computeView(c, q, 'server');
      fromCache = false;
      for (const [p, e] of view) if (!e.pending) c.cache.set(p, e);
    } else {
      view = listener.delivered ? computeView(c, q, 'cache') : computeView(c, q, 'cache');
      fromCache = true;
    }
    const changes = diff(listener.view, view);
    const hasPendingWrites = view.some(([, e]) => e.pending);
    const metaChanged = !listener.delivered || listener.fromCache !== fromCache || listener.hasPendingWrites !== hasPendingWrites;
    const dataChanged = changes.some((ch) => !ch.metadataOnly);
    if (!dataChanged && !(metaChanged && (listener.includeMeta || !listener.delivered))) {
      listener.fromCache = fromCache;
      listener.hasPendingWrites = hasPendingWrites;
      listener.view = view;
      return;
    }
    listener.view = view;
    listener.fromCache = fromCache;
    listener.hasPendingWrites = hasPendingWrites;
    listener.delivered = true;
    stats.snapshots += 1;
    stats.docsDelivered += changes.filter((ch) => ch.type !== 'removed').length;
    listener.onNext(querySnapshot(listener, view, changes, { fromCache, hasPendingWrites }));
  }

  function stopListener(listener) {
    listener.active = false;
    listener.client.listeners.delete(listener);
  }

  function notifyServerChange(paths) {
    const parents = new Set(paths.map(parentPath));
    for (const c of clients) {
      if (!c.online || c.terminated) continue;
      for (const l of c.listeners) if (parents.has(l.query._collPath)) scheduleDelivery(l);
    }
  }

  function notifyLocalChange(c, path) {
    for (const l of c.listeners) if (l.query._collPath === parentPath(path)) scheduleDelivery(l);
  }

  function onSnapshot(target, ...args) {
    const q = asQuery(target);
    if (!q) throw new FakeFirestoreError('unimplemented', 'fake: onSnapshot supports queries and collections only');
    const c = clientOf(q.firestore);
    let options = {};
    if (args[0] && typeof args[0] === 'object' && typeof args[0].next !== 'function' && typeof args[0].error !== 'function') {
      options = args.shift();
    }
    let onNext;
    let onError;
    if (args[0] && typeof args[0] === 'object') {
      onNext = args[0].next?.bind(args[0]);
      onError = args[0].error?.bind(args[0]);
    } else {
      [onNext, onError] = args;
    }
    const listener = {
      client: c,
      query: q,
      includeMeta: !!options.includeMetadataChanges,
      onNext: onNext || (() => {}),
      onError,
      view: [],
      delivered: false,
      fromCache: true,
      hasPendingWrites: false,
      scheduled: false,
      active: true,
    };
    c.listeners.add(listener);
    stats.listens += 1;
    scheduleDelivery(listener);
    return () => stopListener(listener);
  }

  // ---- writes --------------------------------------------------------------------
  function checkLimits(writes) {
    if (writes.length > MAX_TX_WRITES) throw new FakeFirestoreError('invalid-argument', `Maximum ${MAX_TX_WRITES} writes allowed per request`);
    let total = 0;
    for (const w of writes) {
      const size = valueBytes(w.data) + utf8Bytes(w.path) + 16;
      if (size > MAX_DOC_BYTES) {
        throw new FakeFirestoreError('invalid-argument', `Document '${w.path}' cannot be written because its size (${size} bytes) exceeds the maximum allowed size of ${MAX_DOC_BYTES} bytes.`);
      }
      total += size;
    }
    if (total > MAX_REQUEST_BYTES) throw new FakeFirestoreError('invalid-argument', 'Request payload size exceeds the limit: 10485760 bytes.');
    return total;
  }

  // Applies writes atomically: rules, limits, then storage + listener updates.
  function commitWrites(c, writes) {
    const bytes = checkLimits(writes);
    const ts = nextServerTime();
    const resolved = writes.map((w) => ({ path: w.path, data: resolveSentinels(w.data, ts) }));
    for (const w of resolved) {
      const exists = docs.has(w.path);
      if (!allowed(c, { op: exists ? 'update' : 'create', path: w.path, data: w.data, time: ts })) throw denied();
    }
    for (const w of resolved) {
      version += 1;
      docs.set(w.path, { data: w.data, version, updateTime: ts });
    }
    stats.commits.push({ client: c.name, writes: resolved.length, bytes, paths: resolved.map((w) => w.path), at: ts.toMillis() });
    notifyServerChange(resolved.map((w) => w.path));
  }

  class Transaction {
    constructor(c) {
      this._c = c;
      this._reads = new Map();
      this._writes = [];
    }
    async get(ref) {
      if (!(ref instanceof DocumentReference) || clientOf(ref.firestore) !== this._c) {
        throw new FakeFirestoreError('invalid-argument', 'transaction.get() needs a reference from this Firestore instance');
      }
      if (this._writes.length) {
        throw new FakeFirestoreError('invalid-argument', 'Firestore transactions require all reads to be executed before all writes.');
      }
      await sched.sleep(lat(this._c));
      if (!this._c.online) throw offline();
      const entry = docs.get(ref.path);
      if (!allowed(this._c, { op: 'get', path: ref.path })) throw denied();
      stats.txReads += 1;
      this._reads.set(ref.path, entry ? entry.version : 0);
      return docSnapshot(this._c.db, ref.path, entry, { fromCache: false, hasPendingWrites: false });
    }
    set(ref, data, options) {
      if (!(ref instanceof DocumentReference) || clientOf(ref.firestore) !== this._c) {
        throw new FakeFirestoreError('invalid-argument', 'transaction.set() needs a reference from this Firestore instance');
      }
      if (options?.merge || options?.mergeFields) throw new FakeFirestoreError('unimplemented', 'fake: set with merge');
      this._writes.push({ path: ref.path, data: prepareData(data, { ignoreUndefined: this._c.ignoreUndefined }) });
      return this;
    }
    update() {
      throw new FakeFirestoreError('unimplemented', 'fake: transaction.update');
    }
    delete() {
      throw new FakeFirestoreError('unimplemented', 'fake: transaction.delete');
    }
  }

  async function commitTransaction(c, tx, attempt) {
    if (hooks.beforeCommit) await hooks.beforeCommit({ db: c.db, client: c.name, attempt, writes: tx._writes.map((w) => ({ ...w })) });
    await sched.sleep(lat(c));
    if (!c.online) throw new FakeFirestoreError('unavailable', 'Could not reach Cloud Firestore backend.');
    for (const [path, v] of tx._reads) {
      const cur = docs.get(path);
      if ((cur ? cur.version : 0) !== v) {
        stats.txConflicts += 1;
        throw new FakeFirestoreError('aborted', 'Transaction was aborted because of contention on a document.');
      }
    }
    if (tx._writes.length) commitWrites(c, tx._writes);
  }

  /** runTransaction(db, updateFunction, { maxAttempts = 5 }) with the SDK's retry policy. */
  async function runTransaction(db, updateFunction, options = {}) {
    const c = clientOf(db);
    let attemptsLeft = options.maxAttempts ?? 5;
    let attempt = 0;
    let backoff = 0;
    for (;;) {
      attemptsLeft -= 1;
      attempt += 1;
      if (backoff) await sched.sleep(backoff * (0.5 + rng()));
      stats.txAttempts += 1;
      const tx = new Transaction(c);
      try {
        const result = await updateFunction(tx);
        await commitTransaction(c, tx, attempt);
        return result;
      } catch (err) {
        if (attemptsLeft > 0 && isRetryable(err)) {
          backoff = backoff ? Math.min(backoff * 1.5, 60000) : 1000;
          continue;
        }
        throw err;
      }
    }
  }

  function serverTimestamp() {
    return new ServerTimestampSentinel();
  }

  // ---- plain writes/reads (latency-compensated like the SDK) for tests ---------------
  let pendingId = 0;
  function setDoc(ref, data) {
    const c = clientOf(ref.firestore);
    const prepared = prepareData(data, { ignoreUndefined: c.ignoreUndefined });
    const w = { id: ++pendingId, path: ref.path, data: prepared, local: resolveSentinels(prepared, Timestamp.fromMillis(sched.now())) };
    return new Promise((resolve, reject) => {
      w.resolve = resolve;
      w.reject = reject;
      c.pending.push(w);
      notifyLocalChange(c, w.path);
      if (c.online) flushPending(c);
    });
  }

  function flushPending(c) {
    if (c.flushing) return;
    c.flushing = true;
    sched.setTimeout(() => {
      c.flushing = false;
      if (!c.online) return;
      const w = c.pending[0];
      if (!w) return;
      c.pending.shift();
      try {
        commitWrites(c, [w]);
        w.resolve();
      } catch (e) {
        w.reject(e);
      }
      notifyLocalChange(c, w.path);
      if (c.pending.length) flushPending(c);
    }, lat(c));
  }

  async function getDocs(target) {
    const q = asQuery(target);
    const c = clientOf(q.firestore);
    await sched.sleep(lat(c));
    if (!c.online) throw offline();
    if (!allowed(c, { op: 'list', path: q._collPath })) throw denied();
    const view = computeView(c, q, 'server');
    return querySnapshot({ client: c, query: q }, view, [], { fromCache: false, hasPendingWrites: false });
  }

  const fs = {
    collection, doc, query, where, onSnapshot, runTransaction, serverTimestamp, Timestamp, setDoc, getDocs,
  };

  return {
    fs,
    hooks,
    stats,
    scheduler: sched,
    /**
     * A client = one device's Firestore instance (pass it as `db`).
     * @param {{ name?: string, uid?: string|null, latency?: number|((rng:()=>number)=>number), online?: boolean, ignoreUndefinedProperties?: boolean }} opts
     */
    connect({ name = `c${clients.size + 1}`, uid = null, latency = 0, online = true, ignoreUndefinedProperties = false } = {}) {
      const c = {
        name, uid, latency, online, ignoreUndefined: ignoreUndefinedProperties,
        listeners: new Set(), cache: new Map(), pending: [], terminated: false, flushing: false,
      };
      c.db = { type: 'firestore', name, _client: c };
      clients.add(c);
      return c.db;
    },
    /** Network switch for one client: offline listeners go to cache; back online they resync. */
    setOnline(db, online) {
      const c = clientOf(db);
      if (c.online === online) return;
      c.online = online;
      for (const l of c.listeners) scheduleDelivery(l);
      if (online && c.pending.length) flushPending(c);
    },
    isOnline: (db) => clientOf(db).online,
    setAuth(db, uid) {
      clientOf(db).uid = uid;
    },
    setLatency(db, latency) {
      clientOf(db).latency = latency;
    },
    setRules(fn) {
      currentRules = fn;
    },
    /** Write anything straight into the server (like the console/Admin SDK: no rules, no validation). */
    rawSet(path, data) {
      version += 1;
      docs.set(path, { data, version, updateTime: Timestamp.fromMillis(lastCommitMs) });
      notifyServerChange([path]);
    },
    /** Commit time for a raw write (so it shows up in `_srv > since` queries). */
    nextServerTime,
    /** Server documents of one collection: [{ id, data }] sorted by id (data deep-copied). */
    dump(collPath) {
      return [...docs.entries()]
        .filter(([p]) => parentPath(p) === collPath)
        .map(([p, e]) => ({ id: p.split('/').pop(), data: cloneValue(e.data) }))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    },
    activeListeners: () => [...clients].reduce((n, c) => n + c.listeners.size, 0),
    terminate(db) {
      const c = clientOf(db);
      for (const l of [...c.listeners]) stopListener(l);
      c.terminated = true;
    },
  };
}
