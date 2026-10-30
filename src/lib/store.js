// LocalStore over IndexedDB: the device's complete copy of the library.
//
// Every user edit is stamped (clock.js), merged (merge.js) and queued in the
// outbox in one IndexedDB transaction, so nothing is lost if the app is closed
// right after an edit or the phone is offline for weeks. The sync engine drains
// the outbox and feeds remote changes back through applyRemote(). An in-memory
// mirror of the `records` collection drives the UI; covers are loaded lazily.
//
// Implements the LocalStore interface from docs/ARCHITECTURE.md.

import { createClock, randomId } from './clock.js';
import { applyChanges, mergeRecords, recordsEqual, sanitize, maxStamp } from './merge.js';
import { planApplyRemote } from './replica.js';

const DB_NAME = 'mazedar-library';
const DB_VERSION = 1;
const COLLECTIONS = ['records', 'covers'];
const MAX_SNAPSHOTS = 15;
const BACKUP_FORMAT = 'mazedar-library-backup';

function req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function done(t) {
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('IndexedDB transaction aborted'));
  });
}

function openDb(name) {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(name, DB_VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('records')) db.createObjectStore('records', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('covers')) db.createObjectStore('covers', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('snapshots')) db.createObjectStore('snapshots', { keyPath: 'id' });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.onblocked = () => reject(new Error('IndexedDB is blocked by another open tab'));
  });
}

export function newId(prefix) {
  return `${prefix}_${randomId(16)}`;
}

function assertCollection(c) {
  if (!COLLECTIONS.includes(c)) throw new Error(`unknown collection ${c}`);
}

/**
 * Open (or create) the local library.
 * @param {{ dbName?: string }} [opts]
 */
export async function openStore({ dbName = DB_NAME } = {}) {
  const db = await openDb(dbName);

  const readMeta = async (key) => {
    const t = db.transaction('meta', 'readonly');
    const row = await req(t.objectStore('meta').get(key));
    return row ? row.value : undefined;
  };
  const writeMeta = async (key, value) => {
    const t = db.transaction('meta', 'readwrite');
    t.objectStore('meta').put({ key, value });
    await done(t);
  };

  // Device identity + clock. The persistent device id lives in IndexedDB; each
  // session appends two random chars so two open tabs never mint equal stamps.
  let deviceId = await readMeta('deviceId');
  if (!deviceId) {
    deviceId = randomId(10);
    await writeMeta('deviceId', deviceId);
  }
  const clockKey = `mazedar:clock:${dbName}`;
  let saved = (await readMeta('clock')) || null;
  try {
    const ls = JSON.parse(localStorage.getItem(clockKey) || 'null');
    if (ls && (!saved || ls.l > saved.l || (ls.l === saved.l && ls.c > saved.c))) saved = ls;
  } catch { /* localStorage unavailable */ }
  let clockSaveTimer = null;
  const clock = createClock({
    deviceId: deviceId + randomId(2),
    state: saved,
    save: (state) => {
      try { localStorage.setItem(clockKey, JSON.stringify(state)); } catch { /* ignore */ }
      clearTimeout(clockSaveTimer);
      clockSaveTimer = setTimeout(() => writeMeta('clock', state).catch(() => {}), 500);
    },
  });

  // In-memory mirror of `records`.
  const records = new Map();
  {
    const t = db.transaction('records', 'readonly');
    for (const r of await req(t.objectStore('records').getAll())) {
      records.set(r.id, r);
      clock.observe(maxStamp(r));
    }
  }

  const listeners = new Set();
  const localWriteListeners = new Set();
  let version = 0;
  let pendingIds = new Set();
  let notifyScheduled = false;
  const coverCache = new Map();

  function notify(ids) {
    for (const id of ids) pendingIds.add(id);
    if (notifyScheduled) return;
    notifyScheduled = true;
    queueMicrotask(() => {
      notifyScheduled = false;
      const changed = pendingIds;
      pendingIds = new Set();
      version += 1;
      for (const cb of listeners) {
        try { cb({ ids: changed, version }); } catch (e) { console.error(e); }
      }
    });
  }

  // Other tabs on this device: refresh the mirror for ids they changed.
  let channel = null;
  try {
    channel = new BroadcastChannel(`mazedar-store:${dbName}`);
    channel.onmessage = async (ev) => {
      const { coll, ids } = ev.data || {};
      if (!Array.isArray(ids)) return;
      if (coll === 'covers') {
        for (const id of ids) coverCache.delete(id);
        notify(ids);
        return;
      }
      const rows = await getManyRaw('records', ids);
      rows.forEach((r, i) => (r ? records.set(ids[i], r) : records.delete(ids[i])));
      notify(ids);
    };
  } catch { /* BroadcastChannel unsupported */ }
  const broadcast = (coll, ids) => {
    try { channel?.postMessage({ coll, ids }); } catch { /* ignore */ }
  };

  // All writes go through one queue so read-merge-write sequences never interleave.
  let queue = Promise.resolve();
  const serial = (fn) => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  };

  let outboxSeq = Date.now();

  async function getManyRaw(coll, ids) {
    assertCollection(coll);
    const t = db.transaction(coll, 'readonly');
    const os = t.objectStore(coll);
    return Promise.all(ids.map((id) => req(os.get(id)).then((r) => r || undefined)));
  }

  /**
   * Local user edit(s). Each item: { id, kind?, ...fields }. Fields equal to the
   * current value are not re-stamped. Returns the stored records.
   */
  function putMany(coll, items) {
    assertCollection(coll);
    return serial(async () => {
      const t = db.transaction([coll, 'outbox'], 'readwrite');
      const os = t.objectStore(coll);
      const ob = t.objectStore('outbox');
      const out = [];
      for (const changes of items) {
        if (!changes || !changes.id) throw new Error('put: missing id');
        const cur = await req(os.get(changes.id));
        const stamp = clock.now();
        const candidate = applyChanges(cur, changes, stamp, { id: changes.id, kind: changes.kind });
        const final = cur ? mergeRecords(cur, candidate) : candidate;
        if (cur && recordsEqual(cur, final)) {
          out.push(cur);
          continue;
        }
        os.put(final);
        ob.put({ key: `${coll}|${final.id}`, coll, id: final.id, seq: ++outboxSeq });
        out.push(final);
      }
      await done(t);
      const ids = out.map((r) => r.id);
      if (coll === 'records') for (const r of out) records.set(r.id, r);
      else for (const id of ids) coverCache.delete(id);
      notify(ids);
      broadcast(coll, ids);
      for (const cb of localWriteListeners) {
        try { cb(); } catch (e) { console.error(e); }
      }
      return out;
    });
  }

  async function put(coll, changes) {
    const [r] = await putMany(coll, [changes]);
    return r;
  }

  /** LocalStore.applyRemote — merge records that came from the server or a backup. */
  function applyRemote(coll, incoming, { enqueue = false } = {}) {
    assertCollection(coll);
    return serial(async () => {
      if (!incoming.length) return [];
      const t = db.transaction([coll, 'outbox'], 'readwrite');
      const os = t.objectStore(coll);
      const ob = t.objectStore('outbox');
      const changed = [];
      for (const raw of incoming) {
        if (!raw || typeof raw.id !== 'string') continue;
        const cur = await req(os.get(raw.id));
        const plan = planApplyRemote(cur, raw);
        if (plan.changed) {
          os.put(plan.next);
          changed.push(plan.next);
        }
        const key = `${coll}|${raw.id}`;
        if (enqueue ? plan.changed : plan.outbox === 'keep') {
          if (!(await req(ob.get(key)))) ob.put({ key, coll, id: raw.id, seq: ++outboxSeq });
        } else if (!enqueue && plan.outbox === 'remove') {
          ob.delete(key);
        }
      }
      await done(t);
      const ids = changed.map((r) => r.id);
      if (coll === 'records') for (const r of changed) records.set(r.id, r);
      else for (const id of ids) coverCache.delete(id);
      if (ids.length) {
        notify(ids);
        broadcast(coll, ids);
      }
      return changed;
    });
  }

  async function outboxList(coll, limit = 100) {
    const t = db.transaction('outbox', 'readonly');
    const rows = await req(t.objectStore('outbox').getAll());
    return rows.filter((r) => r.coll === coll).sort((a, b) => a.seq - b.seq).slice(0, limit).map((r) => r.id);
  }

  async function pendingCount() {
    const t = db.transaction('outbox', 'readonly');
    return req(t.objectStore('outbox').count());
  }

  // ---- covers ----------------------------------------------------------------
  async function getCover(id) {
    if (coverCache.has(id)) return coverCache.get(id);
    const [row] = await getManyRaw('covers', [id]);
    const data = row && !row.deleted && typeof row.data === 'string' ? row.data : null;
    if (coverCache.size > 300) coverCache.delete(coverCache.keys().next().value);
    coverCache.set(id, data);
    return data;
  }

  async function setCover(bookId, dataUrl) {
    await put('covers', { id: bookId, kind: 'cover', data: dataUrl || null });
    await put('records', { id: bookId, hasCover: !!dataUrl });
  }

  // ---- seeding ---------------------------------------------------------------
  /** Merge deterministic seed records once per seed version (never enqueued). */
  async function seedIfNeeded(seedRecords, seedVersion) {
    const have = (await readMeta('seedVersion')) || 0;
    if (have >= seedVersion) return false;
    await serial(async () => {
      const t = db.transaction('records', 'readwrite');
      const os = t.objectStore('records');
      for (const s of seedRecords) {
        const cur = await req(os.get(s.id));
        const next = cur ? mergeRecords(cur, s) : sanitize(s);
        if (!cur || !recordsEqual(cur, next)) {
          os.put(next);
          records.set(next.id, next);
        }
      }
      await done(t);
    });
    await writeMeta('seedVersion', seedVersion);
    notify(seedRecords.map((r) => r.id));
    return true;
  }

  // ---- snapshots (automatic local backups) -------------------------------------
  async function snapshot(reason) {
    const recs = [...records.values()];
    const id = `snap_${Date.now()}_${randomId(4)}`;
    await serial(async () => {
      const t = db.transaction('snapshots', 'readwrite');
      const os = t.objectStore('snapshots');
      os.put({ id, ts: Date.now(), reason, count: recs.length, records: recs });
      const all = await req(os.getAll());
      all.sort((a, b) => b.ts - a.ts);
      for (const old of all.slice(MAX_SNAPSHOTS)) os.delete(old.id);
      await done(t);
    });
    await writeMeta('lastSnapshotAt', Date.now());
    return id;
  }

  async function listSnapshots() {
    const t = db.transaction('snapshots', 'readonly');
    const all = await req(t.objectStore('snapshots').getAll());
    return all.sort((a, b) => b.ts - a.ts).map(({ id, ts, reason, count }) => ({ id, ts, reason, count }));
  }

  /**
   * Make the library look like the snapshot again: changed fields are re-applied
   * as new edits (so they win and sync), records created after it go to trash.
   */
  async function restoreSnapshot(id) {
    const t = db.transaction('snapshots', 'readonly');
    const snap = await req(t.objectStore('snapshots').get(id));
    if (!snap) throw new Error('snapshot not found');
    await snapshot('পুনরুদ্ধারের আগে');
    const inSnap = new Map(snap.records.map((r) => [r.id, r]));
    const edits = [];
    for (const r of snap.records) {
      const cur = records.get(r.id);
      const changes = { id: r.id, kind: r.kind };
      let any = !cur;
      for (const [k, v] of Object.entries(sanitize(r))) {
        if (k === 'id' || k === 'kind' || k === '_v') continue;
        if (!cur || JSON.stringify(cur[k]) !== JSON.stringify(v)) {
          changes[k] = v;
          any = true;
        }
      }
      if (any) edits.push(changes);
    }
    for (const cur of records.values()) {
      if (!inSnap.has(cur.id) && !cur.deleted) edits.push({ id: cur.id, deleted: true, deletedAt: Date.now() });
    }
    if (edits.length) await putMany('records', edits);
    return edits.length;
  }

  async function autoSnapshotIfDue(maxAgeMs = 24 * 3600 * 1000) {
    const last = (await readMeta('lastSnapshotAt')) || 0;
    if (Date.now() - last > maxAgeMs && records.size) await snapshot('দৈনিক স্বয়ংক্রিয় ব্যাকআপ');
  }

  // ---- backup files -------------------------------------------------------------
  async function exportAll({ includeCovers = true } = {}) {
    const recs = [...records.values()];
    let covers = [];
    if (includeCovers) {
      const t = db.transaction('covers', 'readonly');
      covers = await req(t.objectStore('covers').getAll());
    }
    return {
      format: BACKUP_FORMAT,
      version: 1,
      exportedAt: new Date().toISOString(),
      records: recs,
      covers,
    };
  }

  /** Merge a backup file into the library (never overwrites newer edits). */
  async function importAll(data) {
    if (!data || data.format !== BACKUP_FORMAT || !Array.isArray(data.records)) {
      throw new Error('এটি মাজেদার লাইব্রেরির ব্যাকআপ ফাইল নয়');
    }
    await snapshot('ব্যাকআপ আনার আগে');
    const before = new Set(records.keys());
    const changed = await applyRemote('records', data.records, { enqueue: true });
    if (Array.isArray(data.covers) && data.covers.length) await applyRemote('covers', data.covers, { enqueue: true });
    for (const cb of localWriteListeners) {
      try { cb(); } catch (e) { console.error(e); }
    }
    const added = changed.filter((r) => !before.has(r.id)).length;
    return { added, updated: changed.length - added };
  }

  // ---- account binding ------------------------------------------------------------
  /** Delete everything on this device (used when switching to another account). */
  async function wipe() {
    await snapshot('অ্যাকাউন্ট বদলের আগে');
    await serial(async () => {
      const t = db.transaction(['records', 'covers', 'outbox', 'meta'], 'readwrite');
      t.objectStore('records').clear();
      t.objectStore('covers').clear();
      t.objectStore('outbox').clear();
      const meta = t.objectStore('meta');
      for (const key of await req(meta.getAllKeys())) {
        if (key !== 'deviceId' && key !== 'clock' && key !== 'lastSnapshotAt') meta.delete(key);
      }
      await done(t);
    });
    const ids = [...records.keys()];
    records.clear();
    coverCache.clear();
    notify(ids);
    broadcast('records', ids);
  }

  return {
    dbName,
    deviceId,
    clock,
    records,
    get version() { return version; },
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    onLocalWrite(cb) {
      localWriteListeners.add(cb);
      return () => localWriteListeners.delete(cb);
    },
    put,
    putMany,
    getManyRaw,
    outboxList,
    applyRemote: (coll, recs) => applyRemote(coll, recs),
    pendingCount,
    getMeta: readMeta,
    setMeta: writeMeta,
    getCover,
    setCover,
    seedIfNeeded,
    snapshot,
    listSnapshots,
    restoreSnapshot,
    autoSnapshotIfDue,
    exportAll,
    importAll,
    wipe,
    close() {
      try { channel?.close(); } catch { /* ignore */ }
      db.close();
    },
  };
}
