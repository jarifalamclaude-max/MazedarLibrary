// Cloud sync: replicates the LocalStore collections through Firestore at
// libraries/{uid}/{collection}/{id} (see "Sync engine contract" in
// docs/ARCHITECTURE.md).
//
// Push: outbox ids are merged into the server copy inside a transaction
// (field-level last-writer-wins, merge.js) and the merged records are handed
// back to store.applyRemote, which drops an id from the outbox only when the
// server copy holds everything this device has. Nothing else ever removes an
// outbox entry, so an edit made while a push is in flight is simply pushed again
// and no local edit can be lost.
// Pull: one listener per collection on `_srv > since - overlap`; every remote
// document is merged locally, and `since` only moves forward from server
// (non-cache) snapshots after their documents have been applied.
//
// Every failure ends up in the status (never as an unhandled rejection); failed
// pushes retry with capped exponential backoff and jitter, and immediately when
// connectivity returns.

import { isDataField, maxStamp, mergeRecords, recordsEqual, sanitize } from './merge.js';

const ALL = 2 ** 31 - 1; // "no limit" for outboxList (fits IndexedDB's count range)
const APPLY_CHUNK = 250; // records per store.applyRemote call while pulling
const MAX_WARNINGS = 200;

const ERROR_TEXT = {
  'permission-denied': 'ক্লাউডে এই অ্যাকাউন্টের লাইব্রেরি পড়া/লেখার অনুমতি নেই — Firestore-এর Rules ঠিক আছে কি না দেখুন',
  unauthenticated: 'লগইনের মেয়াদ শেষ — আবার লগইন করুন',
  'resource-exhausted': 'ক্লাউডের আজকের ব্যবহারসীমা শেষ — একটু পরে আবার চেষ্টা হবে',
  'failed-precondition': 'ক্লাউড ডেটাবেস প্রস্তুত নয় — Firebase কনসোলে Firestore Database তৈরি করা আছে কি না দেখুন',
  'not-found': 'ক্লাউড ডেটাবেস পাওয়া যায়নি — Firebase কনসোলে Firestore Database তৈরি করুন',
  'invalid-argument': 'ক্লাউড একটি রেকর্ড নিতে পারেনি (খুব বড় বা অচল ডেটা)',
  internal: 'ক্লাউডে সাময়িক সমস্যা — আবার চেষ্টা হবে',
  unknown: 'ক্লাউডে অজানা সমস্যা — আবার চেষ্টা হবে',
};

function codeOf(err) {
  const c = err && err.code;
  return typeof c === 'string' ? c.replace(/^firestore\//, '') : '';
}

function describeError(err) {
  const code = codeOf(err);
  const text = ERROR_TEXT[code] || 'ক্লাউড সিঙ্কে সমস্যা হয়েছে';
  const detail = code || (err && err.message) || String(err);
  return `${text} (${detail})`;
}

const isNetworkCode = (code) => code === 'unavailable' || code === 'deadline-exceeded';

function isPlainObject(v) {
  if (v === null || typeof v !== 'object') return false;
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
}

// Firestore values -> plain JSON (Timestamps become millis; references,
// GeoPoints, Bytes and anything else exotic are dropped).
function toPlain(v, depth = 0) {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (depth > 32 || typeof v !== 'object') return undefined;
  if (Array.isArray(v)) {
    return v.map((x) => {
      const p = toPlain(x, depth + 1);
      return p === undefined ? null : p;
    });
  }
  if (typeof v.toMillis === 'function') {
    try {
      const ms = v.toMillis();
      return Number.isFinite(ms) ? ms : undefined;
    } catch {
      return undefined;
    }
  }
  if (!isPlainObject(v)) return undefined;
  const o = {};
  for (const [k, x] of Object.entries(v)) {
    const p = toPlain(x, depth + 1);
    if (p !== undefined) o[k] = p;
  }
  return o;
}

function srvMillis(v) {
  if (!v || typeof v.toMillis !== 'function') return null;
  try {
    const ms = v.toMillis();
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

/**
 * Turn a server document into a record the merge can trust, or null if it is
 * unusable (not a map, or its `id` field names another document).
 * @returns {{ record: object, srv: number|null } | null}
 */
function normalizeRemote(docId, raw) {
  if (!isPlainObject(raw)) return null;
  if (raw.id !== undefined && raw.id !== docId) return null;
  const out = { id: docId };
  if (typeof raw.kind === 'string') out.kind = raw.kind;
  const stamps = isPlainObject(raw._v) ? raw._v : {};
  const v = {};
  for (const [k, val] of Object.entries(raw)) {
    if (!isDataField(k)) continue;
    const plain = toPlain(val);
    if (plain === undefined) continue;
    out[k] = plain;
    if (typeof stamps[k] === 'string' && stamps[k]) v[k] = stamps[k];
  }
  out._v = v;
  return { record: out, srv: srvMillis(raw._srv) };
}

function utf8Length(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xdc00 && c <= 0xdfff ? 1 : 3;
  }
  return n;
}

// Upper bound on what a record costs in a Firestore commit request.
function approxBytes(rec) {
  try {
    return utf8Length(JSON.stringify(rec)) + 256;
  } catch {
    return 1024;
  }
}

const validDocId = (id) => typeof id === 'string' && id.length > 0 && id.length <= 1500
  && !id.includes('/') && id !== '.' && id !== '..' && !/^__.*__$/.test(id);

function defaultIsOnline() {
  return globalThis.navigator?.onLine ?? true;
}

function defaultSubscribeOnline(cb) {
  const target = globalThis;
  if (typeof target.addEventListener !== 'function') return () => {};
  target.addEventListener('online', cb);
  return () => target.removeEventListener('online', cb);
}

/**
 * Create the Firestore <-> LocalStore replication engine.
 *
 * @param {object} opts
 * @param {object} opts.fs  Firestore function bag: { collection, doc, query, where, onSnapshot, runTransaction, serverTimestamp, Timestamp }
 * @param {object} opts.db  Firestore instance
 * @param {string} opts.uid signed-in user id
 * @param {object} opts.store LocalStore (getManyRaw, outboxList, applyRemote, getMeta, setMeta, onLocalWrite?)
 * @param {{ observe: (stamp: string) => void }} opts.clock  every remote stamp is observed
 * @param {string[]} [opts.collections]
 * @param {() => boolean} [opts.isOnline]
 * @param {(cb: () => void) => (() => void)} [opts.subscribeOnline]  fires when connectivity returns
 * @param {number} [opts.batchSize]  max documents per transaction
 * @param {number} [opts.pushDebounceMs]
 * @param {number} [opts.overlapMs]  re-read window below the watermark when (re)subscribing
 * @param {object|null} [opts.logger]
 * @param {number} [opts.maxBatchBytes]  max estimated payload per transaction (Firestore allows 10 MiB)
 * @param {number} [opts.maxDebounceMs]  a steady stream of edits still pushes this often
 * @param {number} [opts.backoffBaseMs]
 * @param {number} [opts.backoffMaxMs]
 * @param {number} [opts.stopTimeoutMs]  stop() waits at most this long for a hung network call
 * @param {{ setTimeout: Function, clearTimeout: Function }} [opts.timers]  injectable for tests
 * @param {() => number} [opts.now]  wall clock (ms) for lastSyncedAt and scheduling
 * @param {() => number} [opts.random]  jitter source
 * @returns {{ start: () => Promise<void>, stop: () => Promise<void>, syncNow: () => Promise<void>,
 *   fullResync: () => Promise<void>, getStatus: () => { state: string, pending: number, lastSyncedAt: number|null, error: string|null },
 *   onStatus: (cb: Function) => (() => void), notifyLocalWrite: () => void }}
 */
export function createSyncEngine(opts = {}) {
  const {
    fs, db, uid, store, clock,
    collections = ['records', 'covers'],
    isOnline = defaultIsOnline,
    subscribeOnline = defaultSubscribeOnline,
    batchSize = 100,
    pushDebounceMs = 400,
    overlapMs = 120000,
    logger = console,
    maxBatchBytes = 4 * 1024 * 1024,
    maxDebounceMs = Math.max(2000, 5 * pushDebounceMs),
    backoffBaseMs = 1000,
    backoffMaxMs = 60000,
    stopTimeoutMs = 15000,
    timers = globalThis,
    now = () => Date.now(),
    random = Math.random,
  } = opts;

  for (const k of ['collection', 'doc', 'query', 'where', 'onSnapshot', 'runTransaction', 'serverTimestamp']) {
    if (typeof fs?.[k] !== 'function') throw new TypeError(`createSyncEngine: fs.${k} missing`);
  }
  if (typeof fs.Timestamp?.fromMillis !== 'function') throw new TypeError('createSyncEngine: fs.Timestamp missing');
  if (!db) throw new TypeError('createSyncEngine: db missing');
  if (typeof uid !== 'string' || !validDocId(uid)) throw new TypeError('createSyncEngine: invalid uid');
  for (const k of ['getManyRaw', 'outboxList', 'applyRemote', 'getMeta', 'setMeta']) {
    if (typeof store?.[k] !== 'function') throw new TypeError(`createSyncEngine: store.${k} missing`);
  }
  if (typeof clock?.observe !== 'function') throw new TypeError('createSyncEngine: clock.observe missing');
  if (!collections.length || !collections.every(validDocId)) throw new TypeError('createSyncEngine: bad collections');
  const chunkSize = Math.max(1, Math.min(500, Math.floor(batchSize) || 1));

  // ---- small utilities -------------------------------------------------------------
  const log = (level, ...args) => {
    try {
      (logger?.[level] || logger?.log)?.call(logger, ...args);
    } catch { /* a broken logger must not break sync */ }
  };
  const warned = new Set();
  const warnOnce = (key, ...args) => {
    if (warned.has(key) || warned.size >= MAX_WARNINGS) return;
    warned.add(key);
    log('warn', ...args);
  };
  const later = (fn, ms) => timers.setTimeout(fn, Math.max(0, ms));
  const cancel = (t) => {
    if (t !== null && t !== undefined) timers.clearTimeout(t);
  };
  const online = () => {
    try {
      return isOnline() !== false;
    } catch {
      return true;
    }
  };
  const sinceKey = (coll) => `sync:${uid}:${coll}:since`;
  const lastSyncedKey = `sync:${uid}:lastSyncedAt`;
  const okey = (coll, id) => `${coll}|${id}`;
  const collRef = (coll) => fs.collection(db, 'libraries', uid, coll);

  function backoffDelay(attempt) {
    const exp = Math.min(backoffMaxMs, backoffBaseMs * 2 ** Math.max(0, attempt - 1));
    return Math.min(backoffMaxMs, Math.round(exp / 2 + random() * (exp / 2)));
  }

  // Every async job is tracked so stop() can wait for it; jobs never reject.
  const inflight = new Set();
  function track(promise) {
    const p = promise.catch((err) => log('error', 'sync: unexpected failure', err));
    inflight.add(p);
    p.finally(() => inflight.delete(p));
    return p;
  }

  function observeStamps(records) {
    let m = '';
    for (const r of records) {
      const s = maxStamp(r);
      if (typeof s === 'string' && s > m) m = s;
    }
    if (!m) return;
    try {
      clock.observe(m);
    } catch (err) {
      log('warn', 'sync: clock.observe failed', err);
    }
  }

  // ---- state -----------------------------------------------------------------------
  const lanes = collections.map((coll) => ({
    coll,
    gen: 0,
    unsub: null,
    since: 0,
    live: false, // last processed snapshot came from the server
    everLive: false, // had a server snapshot since start()
    fromCache: false, // last processed snapshot came from the cache (offline)
    needFull: true, // process snapshot.docs instead of docChanges()
    error: null,
    retryAttempt: 0,
    retryTimer: null,
    chain: Promise.resolve(),
  }));

  let running = false;
  let session = 0;
  let ready = Promise.resolve();
  let status = Object.freeze({ state: 'starting', pending: 0, lastSyncedAt: null, error: null });
  const statusCbs = new Set();
  const waiters = new Set();
  let pending = 0;
  let initialPullDone = false;
  let syncConfirmed = false;
  let netDown = false;
  let pushError = null;
  let pushing = null;
  let pushRequested = false;
  let pushTimer = null;
  let pushTimerAt = Infinity;
  let pushAttempt = 0;
  let backoffUntil = 0;
  let debounceStart = 0;
  let writesDuringPush = 0;
  const poisoned = new Map(); // okey -> { stamp, message }: the server refuses this version
  const orphans = new Set(); // okey: queued id with no record locally or on the server
  let unsubOnline = null;
  let unsubLocal = null;
  let listening = false; // init() has loaded the watermarks and subscribed

  // ---- status ----------------------------------------------------------------------
  function currentError() {
    if (pushError) return pushError;
    for (const lane of lanes) if (lane.error) return lane.error;
    if (poisoned.size) {
      const [first] = poisoned.values();
      return `${poisoned.size}টি রেকর্ড ক্লাউডে তোলা যাচ্ছে না — ${first.message}`;
    }
    return null;
  }

  function computeState() {
    const error = currentError();
    if (error) return { state: 'error', error };
    if (!online() || netDown || lanes.some((l) => l.fromCache)) return { state: 'offline', error: null };
    if (!initialPullDone) return { state: 'starting', error: null };
    if (pushing || pending > 0 || lanes.some((l) => !l.live)) return { state: 'syncing', error: null };
    return { state: 'synced', error: null };
  }

  function setStatus(next) {
    const s = status;
    if (s.state === next.state && s.pending === next.pending && s.lastSyncedAt === next.lastSyncedAt && s.error === next.error) return;
    status = Object.freeze({ state: next.state, pending: next.pending, lastSyncedAt: next.lastSyncedAt, error: next.error });
    for (const cb of [...statusCbs]) {
      try {
        cb(status);
      } catch (err) {
        log('error', 'sync: status listener failed', err);
      }
    }
  }

  function runWaiters(all = false) {
    for (const w of [...waiters]) {
      let ok = all;
      if (!ok) {
        try {
          ok = !!w.pred();
        } catch {
          ok = true;
        }
      }
      if (ok) {
        waiters.delete(w);
        w.resolve();
      }
    }
  }

  function waitFor(pred) {
    if (!running || pred()) return Promise.resolve();
    return new Promise((resolve) => waiters.add({ pred, resolve }));
  }

  function refreshStatus() {
    if (!running) return;
    const { state, error } = computeState();
    let { lastSyncedAt } = status;
    if (state === 'synced' && (status.state !== 'synced' || syncConfirmed)) {
      lastSyncedAt = now();
      if (status.state !== 'synced') {
        track(Promise.resolve().then(() => store.setMeta(lastSyncedKey, lastSyncedAt)));
      }
    }
    syncConfirmed = false;
    setStatus({ state, pending, lastSyncedAt, error });
    runWaiters();
  }

  // Coalesces concurrent calls: callers arriving mid-run share one follow-up run.
  function coalesced(task) {
    let current = null;
    let queued = null;
    const run = () => {
      if (!current) {
        current = Promise.resolve().then(task).finally(() => {
          current = null;
        });
        return current;
      }
      if (!queued) {
        queued = current.then(() => {
          queued = null;
          return run();
        });
      }
      return queued;
    };
    return run;
  }

  const countPending = coalesced(async () => {
    const sid = session;
    try {
      let n = 0;
      for (const coll of collections) {
        const ids = await store.outboxList(coll, ALL);
        for (const id of ids) if (!orphans.has(okey(coll, id))) n += 1;
      }
      if (sid !== session) return;
      pending = n;
    } catch (err) {
      warnOnce('outbox-read', 'sync: could not read the outbox', err);
    }
    if (sid === session) refreshStatus();
  });
  const refreshPending = () => track(countPending());

  // ---- push ------------------------------------------------------------------------
  function armPushTimer(at) {
    cancel(pushTimer);
    pushTimerAt = at;
    pushTimer = later(() => {
      pushTimer = null;
      pushTimerAt = Infinity;
      startPush();
    }, at - now());
  }

  /** Push no later than `delayMs` from now (but not before the backoff ends). */
  function schedulePush(delayMs) {
    if (!running) return;
    if (pushing) {
      pushRequested = true;
      return;
    }
    const at = Math.max(now() + delayMs, backoffUntil);
    if (pushTimer !== null && pushTimerAt <= at) return;
    armPushTimer(at);
  }

  function startPush() {
    if (!running) return Promise.resolve();
    if (pushing) {
      pushRequested = true;
      return pushing;
    }
    cancel(pushTimer);
    pushTimer = null;
    pushTimerAt = Infinity;
    pushRequested = false;
    debounceStart = 0;
    const sid = session;
    pushing = track(pushOnce(sid).finally(() => {
      pushing = null;
      if (sid !== session) return;
      if (pushRequested) {
        pushRequested = false;
        schedulePush(pushDebounceMs);
      }
      refreshPending();
    }));
    refreshStatus();
    return pushing;
  }

  async function pushOnce(sid) {
    if (!online()) return;
    writesDuringPush = 0;
    let result;
    try {
      result = await pushAll(sid);
    } catch (err) {
      if (sid === session) onPushFailure(err);
      return;
    }
    if (sid !== session) return;
    pushError = null;
    if (result.contacted) {
      netDown = false;
      syncConfirmed = true;
    }
    if (result.leftovers > 0 && writesDuringPush === 0) {
      // Still queued although nothing was edited meanwhile: retry, but slow down.
      pushAttempt += 1;
      backoffUntil = now() + backoffDelay(pushAttempt);
      schedulePush(0);
    } else {
      pushAttempt = 0;
      backoffUntil = 0;
      if (result.leftovers > 0) schedulePush(pushDebounceMs);
    }
  }

  function onPushFailure(err) {
    const code = codeOf(err);
    if (isNetworkCode(code)) {
      netDown = true;
      pushError = null;
    } else if (code !== 'aborted' && code !== 'cancelled') {
      pushError = describeError(err);
    }
    pushAttempt += 1;
    const delay = backoffDelay(pushAttempt);
    backoffUntil = now() + delay;
    log('warn', `sync: push failed (${code || (err && err.message) || err}); retry in ${Math.round(delay / 1000)}s`);
    schedulePush(0);
    refreshStatus();
  }

  async function pushAll(sid) {
    let leftovers = 0;
    let contacted = false;
    for (const coll of collections) {
      const r = await pushCollection(coll, sid);
      if (sid !== session) break;
      leftovers += r.leftovers;
      contacted = contacted || r.contacted;
    }
    return { leftovers, contacted };
  }

  // Drains one collection's outbox in transactions of <= batchSize docs and
  // <= maxBatchBytes; each queued id is attempted at most once per cycle.
  async function pushCollection(coll, sid) {
    const attempted = new Set();
    let contacted = false;
    for (;;) {
      if (sid !== session) return { leftovers: 0, contacted };
      const ids = (await store.outboxList(coll, ALL)).filter((id) => !attempted.has(id));
      if (!ids.length) break;
      const head = ids.slice(0, chunkSize);
      const locals = await store.getManyRaw(coll, head);
      const chunk = [];
      let bytes = 0;
      for (let i = 0; i < head.length; i++) {
        const id = head[i];
        const local = locals[i];
        const k = okey(coll, id);
        if (!validDocId(id)) {
          attempted.add(id);
          poison(coll, id, local, 'অচল আইডি');
          continue;
        }
        const bad = poisoned.get(k);
        if (bad && local && bad.stamp === maxStamp(local)) {
          attempted.add(id);
          continue;
        }
        if (bad) poisoned.delete(k);
        const size = local ? approxBytes(local) : 256;
        if (chunk.length && bytes + size > maxBatchBytes) break;
        chunk.push({ id, local });
        bytes += size;
        attempted.add(id);
      }
      if (chunk.length) {
        await pushChunk(coll, chunk, sid);
        contacted = true;
      }
    }
    if (sid !== session) return { leftovers: 0, contacted };
    const still = await store.outboxList(coll, ALL);
    const leftovers = still.filter((id) => {
      const k = okey(coll, id);
      return attempted.has(id) && !poisoned.has(k) && !orphans.has(k);
    }).length;
    return { leftovers, contacted };
  }

  function poison(coll, id, local, reason) {
    const k = okey(coll, id);
    if (!poisoned.has(k)) log('error', `sync: ${coll}/${id} cannot be uploaded: ${reason}`);
    poisoned.set(k, { stamp: local ? maxStamp(local) : '', message: `${coll}/${id}: ${reason}` });
  }

  // A transaction the server refuses as invalid is split in halves until the
  // offending document is isolated, so one bad record cannot block the rest.
  async function pushChunk(coll, chunk, sid) {
    try {
      await commitChunk(coll, chunk, sid);
    } catch (err) {
      if (codeOf(err) !== 'invalid-argument' || sid !== session) throw err;
      if (chunk.length > 1) {
        const mid = Math.ceil(chunk.length / 2);
        await pushChunk(coll, chunk.slice(0, mid), sid);
        await pushChunk(coll, chunk.slice(mid), sid);
        return;
      }
      poison(coll, chunk[0].id, chunk[0].local, (err && err.message) || 'invalid-argument');
      refreshStatus();
    }
  }

  async function commitChunk(coll, chunk, sid) {
    const cref = collRef(coll);
    const refs = chunk.map(({ id }) => fs.doc(cref, id));
    const locals = chunk.map(({ local }) => (local ? sanitize(local) : undefined));
    let merged = [];
    let missing = [];
    await fs.runTransaction(db, async (tx) => {
      const snaps = await Promise.all(refs.map((ref) => tx.get(ref)));
      merged = [];
      missing = [];
      snaps.forEach((snap, i) => {
        const { id } = chunk[i];
        const remote = snap.exists() ? normalizeRemote(id, safeData(snap)) : null;
        if (snap.exists() && !remote) warnOnce(`bad:${coll}/${id}`, `sync: replacing unusable server document ${coll}/${id}`);
        const local = locals[i];
        if (!local) {
          if (remote) merged.push(remote.record);
          else missing.push(id);
          return;
        }
        const next = mergeRecords(remote?.record, local);
        // Skip the write when the server already has all of it (and is visible to listeners).
        if (!(remote && remote.srv !== null && recordsEqual(next, remote.record))) {
          tx.set(refs[i], { ...next, _srv: fs.serverTimestamp() });
        }
        merged.push(next);
      });
    });
    if (sid !== session) return;
    for (const id of missing) {
      orphans.add(okey(coll, id));
      warnOnce(`orphan:${coll}/${id}`, `sync: ${coll}/${id} is queued but exists nowhere; ignoring it`);
    }
    observeStamps(merged);
    if (merged.length) await store.applyRemote(coll, merged);
  }

  function safeData(snap) {
    try {
      return snap.data();
    } catch {
      return undefined;
    }
  }

  // ---- pull ------------------------------------------------------------------------
  function listen(lane) {
    unlisten(lane);
    const gen = ++lane.gen;
    lane.needFull = true;
    lane.live = false;
    lane.fromCache = false;
    try {
      const from = fs.Timestamp.fromMillis(Math.max(0, lane.since - overlapMs));
      const q = fs.query(collRef(lane.coll), fs.where('_srv', '>', from));
      const unsub = fs.onSnapshot(
        q,
        { includeMetadataChanges: true },
        (snap) => onLaneSnapshot(lane, gen, snap),
        (err) => onLaneError(lane, gen, err),
      );
      if (gen === lane.gen) lane.unsub = unsub;
      else unsub();
    } catch (err) {
      onLaneError(lane, gen, err);
    }
  }

  function unlisten(lane) {
    cancel(lane.retryTimer);
    lane.retryTimer = null;
    lane.gen += 1;
    const unsub = lane.unsub;
    lane.unsub = null;
    if (unsub) {
      try {
        unsub();
      } catch (err) {
        log('warn', 'sync: unsubscribe failed', err);
      }
    }
  }

  function retryLane(lane, attemptDelay) {
    cancel(lane.retryTimer);
    lane.retryTimer = later(() => {
      lane.retryTimer = null;
      if (running) listen(lane);
    }, attemptDelay);
  }

  function onLaneSnapshot(lane, gen, snap) {
    if (!running || gen !== lane.gen) return;
    const job = lane.chain.then(() => processSnapshot(lane, gen, snap));
    lane.chain = job.catch(() => {});
    track(job.catch((err) => onLaneFailure(lane, gen, err)));
  }

  async function processSnapshot(lane, gen, snap) {
    if (!running || gen !== lane.gen) return;
    const meta = snap.metadata || {};
    if (meta.hasPendingWrites) {
      // docChanges() of the next snapshot are relative to this one: read all docs then.
      lane.needFull = true;
      return;
    }
    const fromCache = !!meta.fromCache;
    const docs = lane.needFull
      ? snap.docs
      : snap.docChanges().filter((c) => c.type !== 'removed').map((c) => c.doc);
    const records = [];
    let maxSrv = 0;
    for (const d of docs) {
      const norm = normalizeRemote(d.id, safeData(d));
      if (!norm) {
        warnOnce(`bad:${lane.coll}/${d.id}`, `sync: skipping unusable server document ${lane.coll}/${d.id}`);
        continue;
      }
      records.push(norm.record);
      if (norm.srv !== null && norm.srv > maxSrv) maxSrv = norm.srv;
    }
    observeStamps(records);
    for (let i = 0; i < records.length; i += APPLY_CHUNK) {
      await store.applyRemote(lane.coll, records.slice(i, i + APPLY_CHUNK));
    }
    if (!running || gen !== lane.gen) return;
    lane.needFull = false;
    const wasOffline = lane.fromCache || !lane.live;
    lane.fromCache = fromCache;
    if (fromCache) {
      lane.live = false;
      refreshStatus();
      return;
    }
    lane.live = true;
    lane.everLive = true;
    lane.error = null;
    lane.retryAttempt = 0;
    if (lanes.every((l) => l.everLive)) initialPullDone = true;
    syncConfirmed = true;
    if (maxSrv > lane.since) {
      lane.since = maxSrv;
      try {
        await store.setMeta(sinceKey(lane.coll), maxSrv);
      } catch (err) {
        warnOnce('since-write', 'sync: could not save the sync watermark', err);
      }
    }
    if (netDown || wasOffline) {
      // The server is reachable again: retry queued pushes right away.
      netDown = false;
      pushAttempt = 0;
      backoffUntil = 0;
    }
    await refreshPending();
    if (running && pending > 0) schedulePush(wasOffline ? 0 : pushDebounceMs);
  }

  function onLaneError(lane, gen, err) {
    if (!running || gen !== lane.gen) return;
    unlisten(lane); // the SDK already dropped the listener; this ignores any stragglers
    lane.live = false;
    lane.fromCache = false;
    const code = codeOf(err);
    if (isNetworkCode(code)) netDown = true;
    else lane.error = describeError(err);
    lane.retryAttempt += 1;
    const delay = backoffDelay(lane.retryAttempt);
    log('warn', `sync: ${lane.coll} listener failed (${code || (err && err.message) || err}); retry in ${Math.round(delay / 1000)}s`);
    retryLane(lane, delay);
    refreshStatus();
  }

  // Applying a snapshot failed (e.g. the local database refused the write):
  // resubscribe later so the whole result set is delivered again.
  function onLaneFailure(lane, gen, err) {
    if (!running || gen !== lane.gen) return;
    unlisten(lane);
    lane.live = false;
    lane.error = `লাইব্রেরিতে ক্লাউডের তথ্য লেখা যায়নি (${(err && err.message) || err})`;
    lane.retryAttempt += 1;
    const delay = backoffDelay(lane.retryAttempt);
    log('error', `sync: applying ${lane.coll} snapshot failed; retry in ${Math.round(delay / 1000)}s`, err);
    retryLane(lane, delay);
    refreshStatus();
  }

  // Re-subscribe listeners that died (and are waiting for a retry) right away.
  function relistenDead() {
    if (!listening) return;
    for (const lane of lanes) {
      if (!lane.unsub) {
        lane.retryAttempt = 0;
        listen(lane);
      }
    }
  }

  function onOnline() {
    if (!running) return;
    netDown = false;
    pushAttempt = 0;
    backoffUntil = 0;
    relistenDead();
    startPush();
    refreshStatus();
  }

  async function init(sid) {
    try {
      const saved = await store.getMeta(lastSyncedKey);
      if (sid === session && Number.isFinite(saved) && status.lastSyncedAt === null) {
        setStatus({ ...status, lastSyncedAt: saved });
      }
      for (const lane of lanes) {
        const v = await store.getMeta(sinceKey(lane.coll));
        lane.since = Number.isFinite(v) && v > 0 ? v : 0;
      }
    } catch (err) {
      log('warn', 'sync: could not read the saved sync state; pulling everything', err);
    }
    if (sid !== session) return;
    for (const lane of lanes) listen(lane);
    listening = true;
    await refreshPending();
    if (sid !== session) return;
    startPush();
  }

  // ---- public API --------------------------------------------------------------------
  const api = {
    /** Begin syncing (idempotent). Resolves once listeners are set up; never rejects. */
    start() {
      if (running) return ready;
      running = true;
      const sid = ++session;
      listening = false;
      initialPullDone = false;
      netDown = false;
      pushError = null;
      pushAttempt = 0;
      backoffUntil = 0;
      poisoned.clear();
      orphans.clear();
      for (const lane of lanes) {
        lane.live = false;
        lane.everLive = false;
        lane.fromCache = false;
        lane.error = null;
        lane.retryAttempt = 0;
      }
      try {
        unsubOnline = subscribeOnline(onOnline);
      } catch (err) {
        log('warn', 'sync: subscribeOnline failed', err);
      }
      try {
        unsubLocal = typeof store.onLocalWrite === 'function' ? store.onLocalWrite(() => api.notifyLocalWrite()) : null;
      } catch (err) {
        log('warn', 'sync: store.onLocalWrite failed', err);
      }
      refreshStatus();
      ready = track(init(sid));
      return ready;
    },

    /** Unsubscribe everything and wait for in-flight work (at most stopTimeoutMs for network calls). */
    async stop() {
      if (running) {
        running = false;
        listening = false;
        session += 1;
        cancel(pushTimer);
        pushTimer = null;
        pushTimerAt = Infinity;
        for (const lane of lanes) unlisten(lane);
        for (const u of [unsubOnline, unsubLocal]) {
          try {
            if (typeof u === 'function') u();
          } catch (err) {
            log('warn', 'sync: unsubscribe failed', err);
          }
        }
        unsubOnline = null;
        unsubLocal = null;
        runWaiters(true);
      }
      if (!inflight.size) return;
      // Work started before stop() checks the session before touching the store,
      // so giving up on a hung network call cannot corrupt anything later.
      let expired = false;
      let timer = null;
      const deadline = new Promise((resolve) => {
        timer = later(resolve, stopTimeoutMs);
      }).then(() => {
        expired = true;
      });
      while (inflight.size && !expired) {
        await Promise.race([Promise.allSettled([...inflight]), deadline]);
      }
      cancel(timer);
      if (expired && inflight.size) log('warn', 'sync: stop() gave up waiting for a network call');
    },

    /** Push everything queued now (skips debounce/backoff); resolves when done. Never rejects. */
    async syncNow() {
      if (!running) return;
      await ready;
      if (!running) return;
      pushAttempt = 0;
      backoffUntil = 0;
      relistenDead();
      if (pushing) await pushing;
      if (!running) return;
      await startPush();
      await refreshPending();
    },

    /** Forget the watermarks, re-read the whole library from the server and push. */
    async fullResync() {
      if (!running) return;
      await ready;
      const sid = session;
      for (const lane of lanes) {
        lane.since = 0;
        try {
          await store.setMeta(sinceKey(lane.coll), 0);
        } catch (err) {
          log('warn', 'sync: could not reset the watermark', err);
        }
      }
      if (sid !== session) return;
      const gens = lanes.map((lane) => {
        lane.retryAttempt = 0;
        listen(lane);
        return lane.gen;
      });
      await api.syncNow();
      await waitFor(() => sid !== session
        || status.state === 'offline' || status.state === 'error'
        || lanes.every((lane, i) => lane.gen !== gens[i] || lane.live));
    },

    /** Current status (a new frozen object whenever anything changes). */
    getStatus() {
      return status;
    },

    /** cb(status) on every status change. Returns an unsubscribe function. */
    onStatus(cb) {
      statusCbs.add(cb);
      return () => statusCbs.delete(cb);
    },

    /** A local edit was written: push soon (debounced). */
    notifyLocalWrite() {
      if (!running) return;
      writesDuringPush += 1;
      if (pushing) {
        pushRequested = true;
      } else {
        const t = now();
        if (!debounceStart) debounceStart = t;
        const at = Math.max(Math.min(t + pushDebounceMs, debounceStart + maxDebounceMs), backoffUntil);
        armPushTimer(at);
      }
      refreshPending();
    },

    /** Internal state for tests and diagnostics. */
    debug() {
      return {
        running,
        since: Object.fromEntries(lanes.map((l) => [l.coll, l.since])),
        live: Object.fromEntries(lanes.map((l) => [l.coll, l.live])),
        poisoned: [...poisoned.keys()],
        orphans: [...orphans],
        pushAttempt,
        inflight: inflight.size,
      };
    },
  };
  return api;
}
