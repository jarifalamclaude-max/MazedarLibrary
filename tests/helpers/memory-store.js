// In-memory LocalStore with the same contract as src/lib/store.js (see
// docs/ARCHITECTURE.md), for tests. Every operation runs atomically through one
// queue, like the IndexedDB transactions it stands in for, and returns copies so
// callers can never mutate stored state by accident.

import { applyChanges, mergeRecords, recordsEqual, sanitize, maxStamp } from '../../src/lib/merge.js';
import { planApplyRemote } from '../../src/lib/replica.js';

const COLLECTIONS = ['records', 'covers'];

const copy = (v) => (v === undefined ? undefined : structuredClone(v));

/**
 * @param {object} opts
 * @param {{ now: () => string, observe: (s: string) => void }} opts.clock  createClock(...) result
 * @param {() => (Promise<void>|void)} [opts.delay]  awaited before every operation (simulated IDB latency)
 * @param {string} [opts.name]
 */
export function createMemoryStore({ clock, delay = null, name = 'mem' } = {}) {
  if (!clock) throw new Error('memory store: clock required');
  const data = { records: new Map(), covers: new Map() };
  const outbox = new Map(); // `${coll}|${id}` -> seq
  const meta = new Map();
  const localWriteCbs = new Set();
  const changeCbs = new Set();
  const stats = { puts: 0, applyRemoteCalls: 0, applyRemoteRecords: 0, stampsInApplyRemote: 0 };
  /** Test hooks: `beforeApplyRemote(coll, records)` may throw or await. */
  const hooks = {};
  let seq = 0;
  let queue = Promise.resolve();

  const serial = (fn) => {
    const run = queue.then(async () => {
      if (delay) await delay();
      return fn();
    });
    queue = run.catch(() => {});
    return run;
  };

  const check = (coll) => {
    if (!COLLECTIONS.includes(coll)) throw new Error(`unknown collection ${coll}`);
  };
  const key = (coll, id) => `${coll}|${id}`;

  const emitChange = (coll, ids) => {
    if (!ids.length) return;
    for (const cb of changeCbs) cb({ coll, ids });
  };
  const emitLocalWrite = () => {
    for (const cb of localWriteCbs) {
      try { cb(); } catch (e) { console.error(e); }
    }
  };

  function writeLocal(coll, changes) {
    if (!changes || !changes.id) throw new Error('put: missing id');
    const map = data[coll];
    const cur = map.get(changes.id);
    const candidate = applyChanges(cur, changes, clock.now(), { id: changes.id, kind: changes.kind });
    const final = sanitize(cur ? mergeRecords(cur, candidate) : candidate);
    if (cur && recordsEqual(cur, final)) return { rec: cur, changed: false };
    map.set(final.id, final);
    outbox.set(key(coll, final.id), ++seq);
    stats.puts += 1;
    return { rec: final, changed: true };
  }

  const store = {
    name,
    clock,
    hooks,
    stats,

    /** LocalStore.getManyRaw */
    async getManyRaw(coll, ids) {
      check(coll);
      if (delay) await delay();
      return ids.map((id) => copy(data[coll].get(id)));
    },

    /** LocalStore.outboxList: ids not known to be on the server, oldest first. */
    async outboxList(coll, limit = 100) {
      check(coll);
      if (delay) await delay();
      return store.outboxIds(coll).slice(0, limit);
    },

    /** LocalStore.applyRemote (planApplyRemote semantics, never stamps). */
    applyRemote(coll, records) {
      check(coll);
      const incoming = copy(records);
      return serial(async () => {
        if (hooks.beforeApplyRemote) await hooks.beforeApplyRemote(coll, incoming);
        stats.applyRemoteCalls += 1;
        const before = clock.state ? JSON.stringify(clock.state()) : '';
        const changed = [];
        for (const raw of incoming) {
          if (!raw || typeof raw.id !== 'string') continue;
          stats.applyRemoteRecords += 1;
          const plan = planApplyRemote(data[coll].get(raw.id), raw);
          if (plan.changed) {
            data[coll].set(raw.id, plan.next);
            changed.push(raw.id);
          }
          const k = key(coll, raw.id);
          if (plan.outbox === 'remove') outbox.delete(k);
          else if (!outbox.has(k)) outbox.set(k, ++seq);
        }
        if (clock.state && JSON.stringify(clock.state()) !== before) stats.stampsInApplyRemote += 1;
        emitChange(coll, changed);
      });
    },

    async getMeta(k) {
      if (delay) await delay();
      return copy(meta.get(k));
    },

    async setMeta(k, value) {
      if (delay) await delay();
      meta.set(k, copy(value));
    },

    /** LocalStore.onLocalWrite: cb() after every local user edit. */
    onLocalWrite(cb) {
      localWriteCbs.add(cb);
      return () => localWriteCbs.delete(cb);
    },

    /**
     * Local user edit: stamps changed fields with clock.now(), merges, writes and
     * queues the id, then notifies onLocalWrite listeners.
     */
    put(coll, changes) {
      check(coll);
      const input = copy(changes);
      return serial(() => {
        const { rec, changed } = writeLocal(coll, input);
        if (changed) {
          emitChange(coll, [rec.id]);
          emitLocalWrite();
        }
        return copy(rec);
      });
    },

    /** Several edits in one atomic step (one onLocalWrite notification). */
    putMany(coll, items) {
      check(coll);
      const input = copy(items);
      return serial(() => {
        const out = input.map((c) => writeLocal(coll, c));
        const ids = out.filter((o) => o.changed).map((o) => o.rec.id);
        if (ids.length) {
          emitChange(coll, ids);
          emitLocalWrite();
        }
        return out.map((o) => copy(o.rec));
      });
    },

    /** Merge deterministic seed records without queueing them (like seedIfNeeded). */
    seed(coll, records) {
      check(coll);
      const input = copy(records);
      return serial(() => {
        const ids = [];
        for (const s of input) {
          const cur = data[coll].get(s.id);
          const next = cur ? mergeRecords(cur, s) : sanitize(s);
          if (!cur || !recordsEqual(cur, next)) {
            data[coll].set(s.id, next);
            ids.push(s.id);
          }
          clock.observe(maxStamp(next));
        }
        emitChange(coll, ids);
      });
    },

    /** Change events: cb({ coll, ids }) for local and remote changes. */
    subscribe(cb) {
      changeCbs.add(cb);
      return () => changeCbs.delete(cb);
    },

    // ---- synchronous inspection helpers for assertions -------------------------
    get(coll, id) {
      check(coll);
      return copy(data[coll].get(id));
    },
    all(coll) {
      check(coll);
      return [...data[coll].values()].map(copy).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    },
    outboxIds(coll) {
      check(coll);
      return [...outbox.entries()]
        .filter(([k]) => k.startsWith(`${coll}|`))
        .sort((a, b) => a[1] - b[1])
        .map(([k]) => k.slice(coll.length + 1));
    },
    pendingCount() {
      return outbox.size;
    },
    metaSnapshot() {
      return Object.fromEntries([...meta.entries()].map(([k, v]) => [k, copy(v)]));
    },
    /** Resolves once every queued operation has finished. */
    idle() {
      return queue.then(() => {});
    },
  };
  return store;
}
