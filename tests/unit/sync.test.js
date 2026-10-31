import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSyncEngine } from '../../src/lib/sync.js';
import { planApplyRemote } from '../../src/lib/replica.js';
import { createClock, SEED_STAMP } from '../../src/lib/clock.js';
import { applyChanges, canonical, mergeRecords, sanitize } from '../../src/lib/merge.js';
import { buildSeedRecords } from '../../src/lib/seed.js';
import { createMemoryStore } from '../helpers/memory-store.js';
import { createFakeFirestore, createScheduler, libraryRules, mulberry32, Timestamp } from '../helpers/fake-firestore.js';

// ---- harness ------------------------------------------------------------------------

const unhandled = [];
process.on('unhandledRejection', (reason) => unhandled.push(reason));

function makeWorld(seed = 1) {
  const sched = createScheduler();
  const rng = mulberry32(seed);
  const server = createFakeFirestore({ scheduler: sched, rng });
  return { sched, rng, server, fs: server.fs };
}

function captureLogger(logs) {
  const at = (level) => (...args) => logs.push({ level, text: args.map((a) => (a instanceof Error ? a.message : String(a))).join(' ') });
  return { log: at('log'), info: at('info'), warn: at('warn'), error: at('error') };
}

/** One device: clock + memory store + Firestore client + (re)startable engine. */
function makeReplica(world, name, opts = {}) {
  const { uid = 'u1', authUid = uid, latency = 5, storeDelay = null, engine: engineOpts = {} } = opts;
  const { sched, server } = world;
  const clock = createClock({ deviceId: name, now: sched.now });
  const store = createMemoryStore({ clock, delay: storeDelay, name });
  const db = server.connect({ name, uid: authUid, latency });
  const onlineCbs = new Set();
  const logs = [];
  const r = {
    name, uid, clock, store, db, logs, engine: null, online: true, states: [], statuses: [],
    setOnline(on) {
      r.online = on;
      server.setOnline(db, on);
      if (on) for (const cb of [...onlineCbs]) cb();
    },
    start(extra = {}) {
      const e = createSyncEngine({
        fs: server.fs, db, uid, store, clock,
        isOnline: () => r.online,
        subscribeOnline: (cb) => {
          onlineCbs.add(cb);
          return () => onlineCbs.delete(cb);
        },
        timers: sched,
        now: sched.now,
        random: world.rng,
        logger: captureLogger(logs),
        pushDebounceMs: 20,
        ...engineOpts,
        ...extra,
      });
      r.states = [e.getStatus().state];
      e.onStatus((s) => {
        r.statuses.push(s);
        if (r.states.at(-1) !== s.state) r.states.push(s.state);
      });
      r.engine = e;
      e.start();
      return e;
    },
    async stop() {
      const e = r.engine;
      r.engine = null;
      if (e) await settle(sched, e.stop(), `${name} stop`);
    },
    state: () => r.engine?.getStatus().state,
    onlineListeners: () => onlineCbs.size,
  };
  return r;
}

/** Await a promise while advancing virtual time. */
async function settle(sched, promise, label = 'promise') {
  let done = false;
  let value;
  let error;
  promise.then((v) => {
    done = true;
    value = v;
  }, (e) => {
    done = true;
    error = e;
  });
  await sched.runUntil(() => done, { label, step: 10 });
  if (error) throw error;
  return value;
}

const serverRecords = (server, uid, coll) => server.dump(`libraries/${uid}/${coll}`).map(({ data }) => sanitize(data));
const allSynced = (...reps) => reps.every((r) => r.state() === 'synced');
const same = (a, b) => canonical(a) === canonical(b);
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];

function seedRecord(id, fields) {
  const _v = {};
  for (const k of Object.keys(fields)) _v[k] = SEED_STAMP;
  return { id, ...fields, _v };
}

// ---- replica.js -----------------------------------------------------------------------

test('planApplyRemote: merges, reports changes and decides the outbox', () => {
  const remote = { id: 'b1', kind: 'book', title: 'ক', _v: { title: 's1' } };
  // nothing local: take the remote copy, nothing to push
  assert.deepEqual(planApplyRemote(undefined, remote), { next: sanitize(remote), changed: true, outbox: 'remove' });
  // identical copy: unchanged, server has everything
  const same1 = planApplyRemote(sanitize(remote), { ...remote, _srv: 123 });
  assert.equal(same1.changed, false);
  assert.equal(same1.outbox, 'remove');
  // local is ahead on a field: keep it queued, local unchanged
  const ahead = applyChanges(remote, { notes: 'local' }, 's2');
  const p2 = planApplyRemote(ahead, remote);
  assert.equal(p2.changed, false);
  assert.equal(p2.outbox, 'keep');
  // remote is ahead: take it, outbox can go
  const newer = applyChanges(remote, { title: 'খ' }, 's3');
  const p3 = planApplyRemote(remote, newer);
  assert.equal(p3.changed, true);
  assert.equal(p3.next.title, 'খ');
  assert.equal(p3.outbox, 'remove');
  // both ahead on different fields: merged, still queued
  const p4 = planApplyRemote(ahead, newer);
  assert.equal(p4.next.title, 'খ');
  assert.equal(p4.next.notes, 'local');
  assert.equal(p4.changed, true);
  assert.equal(p4.outbox, 'keep');
  assert.throws(() => planApplyRemote(remote, { title: 'x' }), /string id/);
  assert.throws(() => planApplyRemote(remote, { id: 'other', _v: {} }), /id mismatch/);
});

test('planApplyRemote never stamps and keeps seeds below edits', () => {
  const seed = seedRecord('b_h001', { kind: 'book', title: 'নন্দিত নরকে', favorite: false });
  delete seed._v.kind;
  const edited = applyChanges(seed, { favorite: true }, '0mh2k3x1a.0000.aa');
  const onSeed = planApplyRemote(seed, edited);
  assert.equal(onSeed.next.favorite, true);
  assert.equal(onSeed.outbox, 'remove');
  const onEdited = planApplyRemote(edited, seed);
  assert.equal(onEdited.changed, false);
  assert.equal(onEdited.outbox, 'keep'); // the server copy (seed) lacks the edit
  assert.deepEqual(Object.values(onSeed.next._v).sort(), ['0mh2k3x1a.0000.aa', SEED_STAMP].sort());
});

// ---- (a) basic push / pull --------------------------------------------------------------

test('(a) two devices push and pull through one server', async () => {
  const w = makeWorld(1);
  const A = makeReplica(w, 'deva');
  const B = makeReplica(w, 'devb');
  A.start();
  B.start();
  await w.sched.runUntil(() => allSynced(A, B), { label: 'initial sync' });

  await A.store.put('records', { id: 'b_1', kind: 'book', title: 'নন্দিত নরকে', copies: 1 });
  await w.sched.runUntil(() => B.store.get('records', 'b_1')?.title === 'নন্দিত নরকে' && allSynced(A, B), { label: 'A -> B' });

  await B.store.put('records', { id: 'b_1', favorite: true });
  await A.store.put('records', { id: 'b_1', title: 'নন্দিত নরকে (২য় মুদ্রণ)' });
  await A.store.put('covers', { id: 'b_1', kind: 'cover', data: 'data:image/jpeg;base64,AAAA' });
  await w.sched.runUntil(() => A.store.get('records', 'b_1')?.favorite === true
    && B.store.get('records', 'b_1')?.title.includes('২য়') && B.store.get('covers', 'b_1')
    && allSynced(A, B), { label: 'concurrent edits' });

  assert.deepEqual(A.store.all('records'), B.store.all('records'));
  assert.deepEqual(A.store.all('covers'), B.store.all('covers'));
  assert.deepEqual(serverRecords(w.server, 'u1', 'records'), A.store.all('records'));
  assert.deepEqual(serverRecords(w.server, 'u1', 'covers'), A.store.all('covers'));
  assert.equal(A.store.pendingCount() + B.store.pendingCount(), 0);
  assert.equal(A.engine.getStatus().pending, 0);
  assert.equal(typeof A.engine.getStatus().lastSyncedAt, 'number');
  assert.equal(A.store.stats.stampsInApplyRemote + B.store.stats.stampsInApplyRemote, 0);

  // remote stamps were observed: a new edit on A sorts after B's edit
  const bStamp = A.store.get('records', 'b_1')._v.favorite;
  const rec = await A.store.put('records', { id: 'b_1', notes: 'পরে' });
  assert.ok(rec._v.notes > bStamp);

  await A.stop();
  await B.stop();
  assert.equal(w.server.activeListeners(), 0);
  assert.equal(A.onlineListeners() + B.onlineListeners(), 0);
  assert.equal(w.sched.pendingTimers(), 0, 'stop() must clear every timer');
});

// ---- (b) randomized convergence -----------------------------------------------------------

const TITLES = ['নন্দিত নরকে', 'হিমু', 'মিসির আলি', 'Himu', 'জোছনা ও জননীর গল্প', 'দেয়াল', 'কোথাও কেউ নেই', ''];
const OPS = [
  ['create', 12], ['edit', 30], ['editMany', 6], ['delete', 6], ['restore', 4], ['cover', 7],
  ['network', 10], ['restart', 6], ['sleep', 12], ['syncNow', 3], ['fullResync', 1], ['author', 3],
  ['burst', 5],
];
const OPS_TOTAL = OPS.reduce((n, [, w]) => n + w, 0);

function weighted(rng) {
  let x = rng() * OPS_TOTAL;
  for (const [op, w] of OPS) {
    x -= w;
    if (x < 0) return op;
  }
  return OPS[0][0];
}

function randomValue(rng, field) {
  switch (field) {
    case 'title': return `${pick(rng, TITLES)}${rng() < 0.5 ? ` ${Math.floor(rng() * 100)}` : ''}`;
    case 'notes': return pick(rng, ['', 'ভালো বই', 'ধার দেওয়া', 'note', null]);
    case 'copies': return 1 + Math.floor(rng() * 3);
    case 'favorite': return rng() < 0.5;
    case 'readStatus': return pick(rng, ['', 'reading', 'read']);
    default: return null;
  }
}

function randomData(rng, n) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let s = '';
  for (let i = 0; i < n; i++) s += chars[Math.floor(rng() * 64)];
  return `data:image/jpeg;base64,${s}`;
}

async function randomizedScenario(seed, { ops = 300 } = {}) {
  const world = makeWorld(seed);
  const { sched, server } = world;
  const rng = mulberry32(seed * 7919 + 17);
  const seeds = [
    seedRecord('a_humayun', { kind: 'author', name: 'হুমায়ূন আহমেদ', note: '', deleted: false }),
    ...Array.from({ length: 20 }, (_, i) => seedRecord(`b_h${String(i + 1).padStart(3, '0')}`, {
      kind: 'book', title: `সিড ${i + 1}`, authorId: 'a_humayun', copies: 1, favorite: false, readStatus: '', deleted: false,
    })),
  ];
  for (const s of seeds) delete s._v.kind;
  const reps = ['r0', 'r1', 'r2'].map((n) => makeReplica(world, n, {
    latency: (r) => 1 + Math.floor(r() * 30),
    storeDelay: () => (rng() < 0.25 ? sched.sleep(1 + Math.floor(rng() * 4)) : null),
    engine: {
      batchSize: 1 + Math.floor(rng() * 8),
      overlapMs: 200,
      pushDebounceMs: 10 + Math.floor(rng() * 50),
      maxBatchBytes: 6000,
    },
  }));

  // Ground truth: for every field, the (stamp, value) of the newest write anywhere.
  const truth = new Map();
  const note = (coll, rec) => {
    for (const [f, s] of Object.entries(rec._v)) {
      const k = `${coll}|${rec.id}|${f}`;
      const cur = truth.get(k);
      if (!cur || s > cur.stamp) truth.set(k, { stamp: s, value: structuredClone(rec[f]) });
    }
  };
  for (const s of seeds) note('records', sanitize(s));
  await settle(sched, Promise.all(reps.map((r) => r.store.seed('records', seeds))), 'seed');

  for (const r of reps) r.start();
  const writes = [];
  const write = (r, coll, changes) => writes.push(r.store.put(coll, changes).then((rec) => note(coll, rec)));
  // Most edits hit a few recently touched records, so replicas really do
  // push the same documents concurrently (transaction contention).
  const hot = [];
  const touch = (id) => {
    const at = hot.indexOf(id);
    if (at >= 0) hot.splice(at, 1);
    hot.push(id);
    if (hot.length > 6) hot.shift();
  };
  const local = (r, coll, pred = () => true) => {
    const list = r.store.all(coll).filter(pred);
    if (!list.length) return null;
    const hotOnes = list.filter((x) => hot.includes(x.id));
    const rec = hotOnes.length && rng() < 0.6 ? pick(rng, hotOnes) : pick(rng, list);
    touch(rec.id);
    return rec;
  };
  const counts = {};
  let created = 0;

  for (let i = 0; i < ops; i++) {
    const r = pick(rng, reps);
    const op = weighted(rng);
    counts[op] = (counts[op] || 0) + 1;
    switch (op) {
      case 'create':
        created += 1;
        touch(`b_s${seed}x${i}`);
        write(r, 'records', {
          id: `b_s${seed}x${i}`, kind: 'book', title: randomValue(rng, 'title'), authorId: 'a_humayun',
          copies: 1, favorite: false, readStatus: '', deleted: false, createdAt: sched.now(),
        });
        break;
      case 'burst': {
        // the same record edited on every replica at (almost) the same moment
        const rec = local(r, 'records', (x) => x.kind === 'book');
        if (!rec) break;
        for (const other of reps) {
          if (!other.store.get('records', rec.id)) continue;
          const f = pick(rng, ['title', 'notes', 'copies', 'favorite', 'readStatus']);
          write(other, 'records', { id: rec.id, [f]: randomValue(rng, f) });
        }
        break;
      }
      case 'author':
        write(r, 'records', { id: `a_s${seed}x${i}`, kind: 'author', name: randomValue(rng, 'title'), note: '', deleted: false });
        break;
      case 'edit': {
        const rec = local(r, 'records', (x) => x.kind === 'book');
        if (!rec) break;
        const f = pick(rng, ['title', 'notes', 'copies', 'favorite', 'readStatus']);
        write(r, 'records', { id: rec.id, [f]: randomValue(rng, f) });
        break;
      }
      case 'editMany': {
        const rec = local(r, 'records', (x) => x.kind === 'book');
        if (!rec) break;
        write(r, 'records', { id: rec.id, title: randomValue(rng, 'title'), notes: randomValue(rng, 'notes'), favorite: rng() < 0.5 });
        break;
      }
      case 'delete': {
        const rec = local(r, 'records', (x) => !x.deleted);
        if (rec) write(r, 'records', { id: rec.id, deleted: true, deletedAt: sched.now() });
        break;
      }
      case 'restore': {
        const rec = local(r, 'records', (x) => x.deleted);
        if (rec) write(r, 'records', { id: rec.id, deleted: false, deletedAt: null });
        break;
      }
      case 'cover': {
        const rec = local(r, 'records', (x) => x.kind === 'book');
        if (!rec) break;
        const data = rng() < 0.2 ? null : randomData(rng, 300 + Math.floor(rng() * 2500));
        write(r, 'covers', { id: rec.id, kind: 'cover', data });
        write(r, 'records', { id: rec.id, hasCover: !!data });
        break;
      }
      case 'network':
        r.setOnline(!r.online);
        break;
      case 'restart':
        if (r.engine) await r.stop();
        else r.start();
        break;
      case 'sleep':
        await sched.advance(Math.floor(rng() * 3000));
        break;
      case 'syncNow':
        r.engine?.syncNow();
        break;
      case 'fullResync':
        r.engine?.fullResync();
        break;
      default:
        throw new Error(op);
    }
    await sched.advance(Math.floor(rng() * 40));
  }

  // Heal: everyone online and running, then wait until nothing moves.
  for (const r of reps) {
    if (!r.online) r.setOnline(true);
    if (!r.engine) r.start();
  }
  await settle(sched, Promise.all(writes), 'local writes');
  const recordsOf = (r) => r.store.all('records');
  const coversOf = (r) => r.store.all('covers');
  await sched.runUntil(() => reps.every((r) => r.state() === 'synced' && r.store.pendingCount() === 0)
    && reps.every((r) => same(recordsOf(r), recordsOf(reps[0])) && same(coversOf(r), coversOf(reps[0]))),
  { timeout: 2 * 60 * 60 * 1000, step: 500, label: `convergence (seed ${seed})` });

  // 1. every replica equals the server for everything the server holds
  for (const coll of ['records', 'covers']) {
    const srv = serverRecords(server, 'u1', coll);
    const mine = new Map(reps[0].store.all(coll).map((x) => [x.id, x]));
    for (const doc of srv) assert.deepEqual(mine.get(doc.id), doc, `${coll}/${doc.id} differs from server`);
    const onServer = new Set(srv.map((d) => d.id));
    // 2. anything not on the server is an untouched seed (seeds are never pushed)
    for (const [id, rec] of mine) {
      if (onServer.has(id)) continue;
      assert.ok(Object.values(rec._v).every((s) => s === SEED_STAMP), `${coll}/${id} never reached the server`);
    }
  }
  // 3. no lost update: every field holds the newest value ever written
  const finalOf = new Map();
  for (const coll of ['records', 'covers']) for (const rec of reps[0].store.all(coll)) finalOf.set(`${coll}|${rec.id}`, rec);
  for (const [k, { stamp, value }] of truth) {
    const [coll, id, f] = k.split('|');
    const rec = finalOf.get(`${coll}|${id}`);
    assert.ok(rec, `${coll}/${id} missing`);
    assert.equal(rec._v[f], stamp, `${k}: stamp`);
    assert.deepEqual(rec[f], value, `${k}: value`);
  }
  for (const [key, rec] of finalOf) {
    for (const f of Object.keys(rec._v)) assert.ok(truth.has(`${key}|${f}`), `${key}.${f} was never written`);
  }
  // 4. quiescent: no further traffic once converged
  const commits = server.stats.commits.length;
  await sched.advance(5 * 60 * 1000);
  assert.equal(server.stats.commits.length, commits, 'engines kept writing after convergence');
  for (const r of reps) await r.stop();
  return {
    counts, created, commits, conflicts: server.stats.txConflicts, attempts: server.stats.txAttempts,
    fields: truth.size, docs: serverRecords(server, 'u1', 'records').length,
  };
}

const FUZZ_SEEDS = Number(process.env.SYNC_FUZZ_SEEDS || 5);
const FUZZ_OPS = Number(process.env.SYNC_FUZZ_OPS || 300);

test(`(b) randomized convergence: 3 replicas x ${FUZZ_OPS} ops x ${FUZZ_SEEDS} seeds`, async (t) => {
  const totals = { commits: 0, conflicts: 0, attempts: 0, fields: 0, network: 0, restart: 0 };
  for (let seed = 1; seed <= FUZZ_SEEDS; seed++) {
    const r = await randomizedScenario(seed, { ops: FUZZ_OPS });
    totals.commits += r.commits;
    totals.conflicts += r.conflicts;
    totals.attempts += r.attempts;
    totals.fields += r.fields;
    totals.network += r.counts.network || 0;
    totals.restart += r.counts.restart || 0;
  }
  t.diagnostic(`fuzz totals: ${JSON.stringify(totals)}`);
  assert.ok(totals.conflicts > 0, 'the scenario should exercise transaction contention');
  assert.ok(totals.network > 0 && totals.restart > 0);
});

test('(b) heavy contention: 4 replicas hammering the same 3 records converge with no lost update', async (t) => {
  const w = makeWorld(31);
  const rng = mulberry32(3131);
  const reps = ['h0', 'h1', 'h2', 'h3'].map((n) => makeReplica(w, n, {
    latency: (r) => 2 + Math.floor(r() * 25),
    engine: { pushDebounceMs: 5 },
  }));
  const ids = ['b_x', 'b_y', 'b_z'];
  await reps[0].store.putMany('records', ids.map((id) => ({ id, kind: 'book', title: id, copies: 1 })));
  for (const r of reps) r.start();
  await w.sched.runUntil(() => allSynced(...reps) && reps.every((r) => r.store.all('records').length === 3), { label: 'shared' });
  const truth = new Map();
  const writes = [];
  for (let i = 0; i < 400; i++) {
    const r = pick(rng, reps);
    const id = pick(rng, ids);
    const f = pick(rng, ['title', 'notes', 'copies', 'favorite', 'readStatus']);
    writes.push(r.store.put('records', { id, [f]: randomValue(rng, f) }).then((rec) => {
      const k = `${id}|${f}`;
      const cur = truth.get(k);
      if (!cur || rec._v[f] > cur.stamp) truth.set(k, { stamp: rec._v[f], value: rec[f] });
    }));
    await w.sched.advance(Math.floor(rng() * 8));
  }
  await settle(w.sched, Promise.all(writes), 'writes');
  await w.sched.runUntil(() => allSynced(...reps) && reps.every((r) => r.store.pendingCount() === 0
    && same(r.store.all('records'), reps[0].store.all('records'))), { label: 'converged', timeout: 60 * 60 * 1000, step: 200 });
  const final = new Map(reps[0].store.all('records').map((x) => [x.id, x]));
  for (const [k, { stamp, value }] of truth) {
    const [id, f] = k.split('|');
    assert.equal(final.get(id)._v[f], stamp, k);
    assert.deepEqual(final.get(id)[f], value, k);
  }
  assert.deepEqual(serverRecords(w.server, 'u1', 'records'), reps[0].store.all('records'));
  const { txConflicts, txAttempts, commits } = w.server.stats;
  t.diagnostic(`contention: ${txConflicts} conflicts / ${txAttempts} transaction attempts / ${commits.length} commits`);
  assert.ok(txConflicts >= 1, `expected real contention, got ${txConflicts}`); // the amount varies with timing; any conflict proves the retry path ran
  for (const r of reps) await r.stop();
});

// ---- (c) seeds ------------------------------------------------------------------------------

test('(c) seed records are never pushed and never override edits', async () => {
  const w = makeWorld(3);
  const seeds = buildSeedRecords();
  const reps = ['sa', 'sb', 'sc'].map((n) => makeReplica(w, n));
  for (const r of reps) await r.store.seed('records', seeds);
  for (const r of reps) r.start();
  await w.sched.runUntil(() => allSynced(...reps), { label: 'seeded replicas synced' });
  assert.equal(serverRecords(w.server, 'u1', 'records').length, 0, 'seeds must not be uploaded');
  assert.equal(w.server.stats.commits.length, 0);

  const [A, B, C] = reps;
  await A.store.put('records', { id: 'b_h001', favorite: true, readStatus: 'read' });
  await B.store.put('records', { id: 'hc001', note: 'প্রথম উপন্যাস' });
  await w.sched.runUntil(() => reps.every((r) => r.store.get('records', 'b_h001').favorite === true
    && r.store.get('records', 'hc001').note === 'প্রথম উপন্যাস') && allSynced(...reps), { label: 'edits spread' });
  assert.deepEqual(serverRecords(w.server, 'u1', 'records').map((r) => r.id), ['b_h001', 'hc001']);

  // re-seeding (e.g. app update) keeps the edits and queues nothing
  for (const r of reps) await r.store.seed('records', seeds);
  for (const r of reps) {
    assert.equal(r.store.get('records', 'b_h001').favorite, true);
    assert.equal(r.store.get('records', 'b_h001').title, seeds.find((s) => s.id === 'b_h001').title);
    assert.equal(r.store.pendingCount(), 0);
  }
  // a brand-new device with the same seed gets the edits and uploads nothing
  const D = makeReplica(w, 'sd');
  await D.store.seed('records', seeds);
  const commitsBefore = w.server.stats.commits.length;
  D.start();
  await w.sched.runUntil(() => allSynced(D), { label: 'new device' });
  assert.equal(D.store.get('records', 'b_h001').favorite, true);
  assert.equal(D.store.get('records', 'hc001').note, 'প্রথম উপন্যাস');
  await w.sched.advance(60000);
  assert.equal(w.server.stats.commits.length, commitsBefore);
  assert.deepEqual(D.store.all('records'), A.store.all('records'));
  assert.equal(C.store.pendingCount(), 0);
  for (const r of [...reps, D]) await r.stop();
});

// ---- (d) batching ------------------------------------------------------------------------------

test('(d) large outboxes are pushed in transactions of at most batchSize docs and maxBatchBytes', async () => {
  const w = makeWorld(4);
  const A = makeReplica(w, 'deva', { engine: { batchSize: 10, maxBatchBytes: 250000 } });
  const B = makeReplica(w, 'devb');
  const items = Array.from({ length: 95 }, (_, i) => ({ id: `b_${String(i).padStart(3, '0')}`, kind: 'book', title: `বই ${i}`, copies: 1 }));
  await A.store.putMany('records', items);
  const rng = mulberry32(44);
  for (let i = 0; i < 12; i++) await A.store.put('covers', { id: `b_${String(i).padStart(3, '0')}`, kind: 'cover', data: randomData(rng, 100000) });
  A.start();
  B.start();
  await w.sched.runUntil(() => allSynced(A, B) && B.store.all('records').length === 95 && B.store.all('covers').length === 12, { label: 'batched push' });
  const commits = w.server.stats.commits;
  const recordCommits = commits.filter((c) => c.paths[0].includes('/records/'));
  const coverCommits = commits.filter((c) => c.paths[0].includes('/covers/'));
  assert.equal(recordCommits.reduce((n, c) => n + c.writes, 0), 95);
  assert.ok(recordCommits.length >= 10, `expected >= 10 record transactions, got ${recordCommits.length}`);
  assert.ok(commits.every((c) => c.writes <= 10));
  assert.ok(coverCommits.length >= 6, `covers must be split by size, got ${coverCommits.length} transactions`);
  assert.ok(coverCommits.every((c) => c.bytes <= 250000 + 2048), JSON.stringify(coverCommits.map((c) => c.bytes)));
  assert.deepEqual(B.store.all('covers'), A.store.all('covers'));
  assert.equal(A.store.pendingCount(), 0);
  await A.stop();
  await B.stop();
});

// ---- (e) permission errors --------------------------------------------------------------------

test('(e) permission-denied becomes an error status with a message, then recovers', async () => {
  const w = makeWorld(5);
  const A = makeReplica(w, 'deva');
  await A.store.put('records', { id: 'b_1', kind: 'book', title: 'অপেক্ষা' });
  w.server.setRules(() => false);
  A.start();
  await w.sched.runUntil(() => A.state() === 'error', { label: 'error state' });
  const st = A.engine.getStatus();
  assert.match(st.error, /permission-denied/);
  assert.ok(st.error.length > 20);
  assert.equal(st.pending, 1);
  await w.sched.advance(5 * 60 * 1000); // keeps retrying quietly with backoff
  assert.equal(A.state(), 'error');
  assert.equal(A.store.pendingCount(), 1, 'nothing may leave the outbox while denied');

  w.server.setRules((req) => (req.op === 'list' || req.op === 'get' || req.op === 'create' || req.op === 'update') && req.auth?.uid === 'u1');
  await settle(w.sched, A.engine.syncNow(), 'syncNow');
  await w.sched.runUntil(() => A.state() === 'synced', { label: 'recovered' });
  assert.equal(A.engine.getStatus().error, null);
  assert.equal(serverRecords(w.server, 'u1', 'records')[0].title, 'অপেক্ষা');
  await A.stop();
});

test('(e) another account cannot read or write this library (rules)', async () => {
  const w = makeWorld(6);
  const owner = makeReplica(w, 'owner');
  await owner.store.put('records', { id: 'b_1', kind: 'book', title: 'গোপন' });
  owner.start();
  await w.sched.runUntil(() => allSynced(owner), { label: 'owner synced' });
  // signed in as u2 but pointed at u1's library
  const intruder = makeReplica(w, 'intruder', { uid: 'u1', authUid: 'u2' });
  await intruder.store.put('records', { id: 'b_1', title: 'হ্যাক' });
  intruder.start();
  await w.sched.runUntil(() => intruder.state() === 'error', { label: 'intruder denied' });
  await w.sched.advance(120000);
  assert.equal(intruder.store.get('records', 'b_1').title, 'হ্যাক', 'nothing pulled');
  assert.equal(serverRecords(w.server, 'u1', 'records')[0].title, 'গোপন', 'nothing written');
  await intruder.stop();
  await owner.stop();
});

// ---- (f) status transitions ---------------------------------------------------------------------

test('(f) status goes starting -> syncing -> synced -> offline -> synced', async () => {
  const w = makeWorld(7);
  const A = makeReplica(w, 'deva', { latency: 20 });
  await A.store.putMany('records', Array.from({ length: 5 }, (_, i) => ({ id: `b_${i}`, kind: 'book', title: `${i}` })));
  A.start();
  assert.equal(A.state(), 'starting');
  await w.sched.runUntil(() => A.state() === 'synced', { label: 'synced' });
  A.setOnline(false);
  await w.sched.runUntil(() => A.state() === 'offline', { label: 'offline' });
  await A.store.put('records', { id: 'b_offline', kind: 'book', title: 'অফলাইনে লেখা' });
  await w.sched.advance(30000);
  assert.equal(A.state(), 'offline');
  assert.equal(A.engine.getStatus().pending, 1, 'pending count visible while offline');
  A.setOnline(true);
  await w.sched.runUntil(() => A.state() === 'synced', { label: 'back online' });
  assert.deepEqual(A.states.slice(0, 4), ['starting', 'syncing', 'synced', 'offline']);
  assert.equal(A.states.at(-1), 'synced');
  assert.ok(serverRecords(w.server, 'u1', 'records').some((r) => r.id === 'b_offline'));
  await A.stop();
});

test('(f) a listener that drops to cache marks the engine offline even if navigator says online', async () => {
  const w = makeWorld(8);
  const A = makeReplica(w, 'deva');
  A.start();
  await w.sched.runUntil(() => allSynced(A), { label: 'synced' });
  w.server.setOnline(A.db, false); // Firestore lost the backend; isOnline() still true
  await w.sched.runUntil(() => A.state() === 'offline', { label: 'offline from cache' });
  w.server.setOnline(A.db, true);
  await w.sched.runUntil(() => A.state() === 'synced', { label: 'resynced' });
  await A.stop();
});

// ---- (g) edit during an in-flight push ------------------------------------------------------------

test('(g) a record edited while its push is in flight stays queued and is pushed again', async () => {
  const w = makeWorld(9);
  const A = makeReplica(w, 'deva', { latency: 15 });
  const B = makeReplica(w, 'devb');
  let edited = false;
  w.server.hooks.beforeCommit = async ({ client, writes }) => {
    if (client === 'deva' && !edited && writes.some((x) => x.path.endsWith('/b_1'))) {
      edited = true;
      await A.store.put('records', { id: 'b_1', title: 'উড়ন্ত অবস্থায় বদল' });
    }
  };
  A.start();
  B.start();
  await w.sched.runUntil(() => allSynced(A, B), { label: 'initial' });
  await A.store.put('records', { id: 'b_1', kind: 'book', title: 'প্রথম', copies: 1 });
  await w.sched.runUntil(() => edited && allSynced(A, B) && B.store.get('records', 'b_1')?.title === 'উড়ন্ত অবস্থায় বদল', { label: 'second push' });
  const b1Commits = w.server.stats.commits.filter((c) => c.paths.some((p) => p.endsWith('/b_1')));
  assert.equal(b1Commits.length, 2, 'pushed once with the old title, then again with the new one');
  assert.equal(serverRecords(w.server, 'u1', 'records')[0].title, 'উড়ন্ত অবস্থায় বদল');
  assert.equal(A.store.pendingCount(), 0);
  assert.deepEqual(A.store.all('records'), B.store.all('records'));
  await A.stop();
  await B.stop();
});

// ---- robustness ----------------------------------------------------------------------------------

test('garbage server documents are skipped or repaired, never fatal', async () => {
  const w = makeWorld(10);
  const A = makeReplica(w, 'deva');
  await A.store.put('records', { id: 'b_ok', kind: 'book', title: 'ঠিক আছে', copies: 1 });
  const srv = () => w.server.nextServerTime();
  const base = 'libraries/u1/records';
  w.server.rawSet(`${base}/g_wrongid`, { id: 'somebody_else', kind: 'book', title: 'x', _v: {}, _srv: srv() });
  w.server.rawSet(`${base}/g_nov`, { kind: 'book', title: 'স্ট্যাম্প নেই', _srv: srv() });
  w.server.rawSet(`${base}/g_junk`, {
    id: 'g_junk', kind: 42, title: 'অদ্ভুত', when: Timestamp.fromMillis(5000), weird: new Map(), nested: { n: [1, Timestamp.fromMillis(1)] },
    _v: 'not a map', _srv: srv(),
  });
  w.server.rawSet(`${base}/b_ok`, { id: 'b_ok', kind: 'book', title: 'পুরোনো', copies: 'many', _v: { title: 7, copies: '000000001.0000.zz' }, _srv: srv() });
  A.start();
  await w.sched.runUntil(() => allSynced(A), { label: 'synced despite garbage' });
  assert.equal(A.store.get('records', 'g_wrongid'), undefined);
  assert.deepEqual(A.store.get('records', 'g_nov'), { id: 'g_nov', kind: 'book', title: 'স্ট্যাম্প নেই', _v: {} });
  assert.deepEqual(A.store.get('records', 'g_junk'), { id: 'g_junk', title: 'অদ্ভুত', when: 5000, nested: { n: [1, 1] }, _v: {} });
  // b_ok: the local edit had real stamps, so it wins and is written back over the junk
  assert.equal(A.store.get('records', 'b_ok').title, 'ঠিক আছে');
  const fixed = serverRecords(w.server, 'u1', 'records').find((r) => r.id === 'b_ok');
  assert.equal(fixed.title, 'ঠিক আছে');
  assert.equal(fixed.copies, 1);
  assert.ok(A.logs.some((l) => l.level === 'warn' && l.text.includes('g_wrongid')));
  assert.equal(A.engine.getStatus().error, null);
  await A.stop();
});

test('a document the server refuses is isolated; the rest still syncs', async () => {
  const w = makeWorld(11);
  const A = makeReplica(w, 'deva', { engine: { batchSize: 50 } });
  const rng = mulberry32(5);
  await A.store.putMany('covers', [
    { id: 'b_1', kind: 'cover', data: randomData(rng, 1000) },
    { id: 'b_huge', kind: 'cover', data: randomData(rng, 1100000) }, // > 1 MiB Firestore limit
    { id: 'b_3', kind: 'cover', data: randomData(rng, 1000) },
  ]);
  await A.store.put('records', { id: 'b_1', kind: 'book', title: 'ঠিক' });
  A.start();
  await w.sched.runUntil(() => A.state() === 'error' && serverRecords(w.server, 'u1', 'covers').length === 2, { label: 'isolated' });
  assert.match(A.engine.getStatus().error, /b_huge/);
  assert.deepEqual(serverRecords(w.server, 'u1', 'covers').map((c) => c.id), ['b_1', 'b_3']);
  assert.equal(serverRecords(w.server, 'u1', 'records').length, 1);
  assert.deepEqual(A.store.outboxIds('covers'), ['b_huge'], 'the refused cover stays queued, never dropped');
  // the user replaces the cover with a smaller one: it goes through and the error clears
  await A.store.put('covers', { id: 'b_huge', data: randomData(rng, 5000) });
  await w.sched.runUntil(() => A.state() === 'synced', { label: 'fixed' });
  assert.equal(serverRecords(w.server, 'u1', 'covers').length, 3);
  await A.stop();
});

test('restart resumes from the saved watermark (incremental pull)', async () => {
  const w = makeWorld(12);
  const A = makeReplica(w, 'deva', { engine: { overlapMs: 100 } });
  const B = makeReplica(w, 'devb', { engine: { overlapMs: 100 } });
  const toB = () => w.server.stats.deliveredTo.devb || 0;
  await A.store.putMany('records', Array.from({ length: 50 }, (_, i) => ({ id: `b_${i}`, kind: 'book', title: `${i}` })));
  A.start();
  B.start();
  await w.sched.runUntil(() => allSynced(A, B) && B.store.all('records').length === 50, { label: 'first sync' });
  await w.sched.advance(10000);
  await A.store.put('records', { id: 'b_mark', kind: 'book', title: 'চিহ্ন' });
  await w.sched.runUntil(() => allSynced(A, B) && B.store.get('records', 'b_mark'), { label: 'mark' });
  const since = B.engine.debug().since.records;
  assert.ok(since > 0);
  assert.equal(B.store.metaSnapshot()['sync:u1:records:since'], since);
  await B.stop();
  await w.sched.advance(10000);
  await A.store.putMany('records', Array.from({ length: 5 }, (_, i) => ({ id: `b_new${i}`, kind: 'book', title: `নতুন ${i}` })));
  await w.sched.runUntil(() => allSynced(A) && A.store.pendingCount() === 0, { label: 'A pushed' });
  await w.sched.advance(1000);
  const delivered = toB();
  B.start();
  await w.sched.runUntil(() => allSynced(B) && B.store.all('records').length === 56, { label: 'B resumed' });
  // the 5 new documents plus b_mark, which sits inside the overlap window
  assert.equal(toB() - delivered, 6, 'only documents newer than the watermark (minus overlap) are downloaded');
  assert.ok(B.engine.debug().since.records > since);

  // fullResync forgets the watermark and reads everything again
  const before = toB();
  await settle(w.sched, B.engine.fullResync(), 'fullResync');
  assert.equal(toB() - before, 56);
  assert.equal(B.state(), 'synced');
  await A.stop();
  await B.stop();
});

test('fullResync recovers documents older than the watermark', async () => {
  const w = makeWorld(13);
  const A = makeReplica(w, 'deva', { engine: { overlapMs: 0 } });
  A.start();
  await A.store.put('records', { id: 'b_1', kind: 'book', title: 'এক' });
  await w.sched.runUntil(() => allSynced(A) && A.engine.debug().since.records > 0, { label: 'synced' });
  // restart so the listener's query starts at the saved watermark
  await A.stop();
  A.start();
  await w.sched.runUntil(() => allSynced(A), { label: 'restarted' });
  // a document that (somehow) carries an old server time is below the watermark
  w.server.rawSet('libraries/u1/records/b_old', { id: 'b_old', kind: 'book', title: 'পুরোনো', _v: { title: '0mh2k3x1a.0000.zz' }, _srv: Timestamp.fromMillis(1000) });
  await w.sched.advance(5000);
  assert.equal(A.store.get('records', 'b_old'), undefined);
  await settle(w.sched, A.engine.fullResync(), 'fullResync');
  assert.equal(A.store.get('records', 'b_old').title, 'পুরোনো');
  await A.stop();
});

test('failed pushes back off exponentially with jitter, capped at 60 s, and retry at once when back online', async () => {
  const w = makeWorld(14);
  const A = makeReplica(w, 'deva');
  const attempts = [];
  const realRun = w.server.fs.runTransaction;
  const fs = { ...w.server.fs, runTransaction: (...args) => { attempts.push(w.sched.now()); return realRun(...args); } };
  w.server.setRules((req) => req.op === 'list' && req.auth?.uid === 'u1'); // reads fine, writes denied
  await A.store.put('records', { id: 'b_1', kind: 'book', title: 'ক' });
  A.start({ fs });
  await w.sched.advance(20 * 60 * 1000);
  const gaps = attempts.slice(1).map((t, i) => t - attempts[i]);
  assert.ok(gaps.length >= 15, `expected many retries, got ${gaps.length}`);
  assert.ok(gaps.every((g) => g <= 60000 + 100), `gap above cap: ${Math.max(...gaps)}`);
  assert.ok(gaps.slice(0, 4).every((g) => g < 9000), `early retries should be quick: ${gaps.slice(0, 4)}`);
  assert.ok(gaps.slice(-5).every((g) => g >= 30000), `late retries should be near the cap: ${gaps.slice(-5)}`);
  assert.ok(new Set(gaps.slice(-5)).size > 1, 'jitter');
  // connectivity returns (after a fix): retry right away, not after the backoff
  w.server.setRules(() => true);
  const t0 = w.sched.now();
  A.setOnline(false);
  A.setOnline(true);
  await w.sched.runUntil(() => A.state() === 'synced', { label: 'retry on online', step: 5 });
  assert.ok(w.sched.now() - t0 < 1000, 'online event must trigger an immediate retry');
  await A.stop();
});

test('snapshots with pending writes are skipped and the next one is read in full', async () => {
  const w = makeWorld(15);
  w.server.setRules(() => true);
  const A = makeReplica(w, 'deva', { latency: 10 });
  A.start();
  await w.sched.runUntil(() => allSynced(A), { label: 'synced' });
  const ref = w.fs.doc(w.fs.collection(A.db, 'libraries', 'u1', 'records'), 'b_side');
  const writeDone = w.fs.setDoc(ref, { id: 'b_side', kind: 'book', title: 'পাশ থেকে', _v: { title: '0mh2k3x1a.0000.zz' }, _srv: Timestamp.fromMillis(w.sched.now() + 1) });
  await w.sched.advance(1);
  await settle(w.sched, writeDone, 'setDoc');
  await w.sched.runUntil(() => A.store.get('records', 'b_side')?.title === 'পাশ থেকে', { label: 'side write applied', timeout: 60000 });
  await A.stop();
});

test('a failing local store write is retried by resubscribing', async () => {
  const w = makeWorld(16);
  const A = makeReplica(w, 'deva');
  const B = makeReplica(w, 'devb');
  A.start();
  B.start();
  await w.sched.runUntil(() => allSynced(A, B), { label: 'initial' });
  let failures = 2;
  B.store.hooks.beforeApplyRemote = () => {
    if (failures > 0) {
      failures -= 1;
      throw new Error('QuotaExceededError (simulated)');
    }
  };
  await A.store.put('records', { id: 'b_1', kind: 'book', title: 'ক' });
  await w.sched.runUntil(() => B.state() === 'error', { label: 'error' });
  assert.match(B.engine.getStatus().error, /QuotaExceeded/);
  await w.sched.runUntil(() => B.store.get('records', 'b_1')?.title === 'ক' && allSynced(A, B), { label: 'recovered' });
  await A.stop();
  await B.stop();
});

test('a listener rejected mid-session reports the error and recovers', async () => {
  const w = makeWorld(17);
  const A = makeReplica(w, 'deva');
  const B = makeReplica(w, 'devb');
  A.start();
  B.start();
  await w.sched.runUntil(() => allSynced(A, B), { label: 'initial' });
  w.server.setRules(() => false);
  w.server.revalidate(); // Firestore re-checks active listeners after a rules change
  await A.store.put('records', { id: 'b_1', kind: 'book', title: 'ক' });
  await w.sched.runUntil(() => B.state() === 'error' && A.state() === 'error', { label: 'denied' });
  assert.match(B.engine.getStatus().error, /permission-denied/);
  w.server.setRules(libraryRules);
  await w.sched.runUntil(() => allSynced(A, B) && B.store.get('records', 'b_1')?.title === 'ক', { label: 'recovered', timeout: 5 * 60 * 1000 });
  await A.stop();
  await B.stop();
});

test('stop() during an in-flight push waits for it but never applies its result afterwards', async () => {
  const w = makeWorld(18);
  const A = makeReplica(w, 'deva', { latency: 50 });
  let release;
  w.server.hooks.beforeCommit = () => new Promise((resolve) => {
    release = resolve;
  });
  await A.store.put('records', { id: 'b_1', kind: 'book', title: 'ক' });
  A.start();
  await w.sched.runUntil(() => !!release, { label: 'push in flight' });
  const engine = A.engine;
  A.engine = null;
  let stopped = false;
  engine.stop().then(() => {
    stopped = true;
  });
  await w.sched.advance(1000);
  assert.equal(stopped, false, 'stop() waits for the in-flight transaction');
  const applied = A.store.stats.applyRemoteCalls;
  release();
  await w.sched.runUntil(() => stopped, { label: 'stopped' });
  assert.equal(A.store.stats.applyRemoteCalls, applied, 'no store writes after stop');
  assert.deepEqual(A.store.outboxIds('records'), ['b_1'], 'still queued: will be pushed (idempotently) next time');
  assert.equal(w.server.activeListeners(), 0);
  w.server.hooks.beforeCommit = null;
  A.start();
  await w.sched.runUntil(() => allSynced(A) && A.store.pendingCount() === 0, { label: 'restart pushes again' });
  await A.stop();
});

test('stop() gives up on a hung network call after stopTimeoutMs', async () => {
  const w = makeWorld(19);
  const A = makeReplica(w, 'deva', { engine: { stopTimeoutMs: 5000 } });
  w.server.hooks.beforeCommit = () => new Promise(() => {}); // never answers
  await A.store.put('records', { id: 'b_1', kind: 'book', title: 'ক' });
  A.start();
  await w.sched.advance(2000);
  const t0 = w.sched.now();
  await A.stop();
  assert.ok(w.sched.now() - t0 >= 5000 && w.sched.now() - t0 < 6000);
  assert.ok(A.logs.some((l) => l.text.includes('gave up')));
});

test('engine refuses bad wiring early and tolerates odd stores', async () => {
  const w = makeWorld(20);
  const clock = createClock({ deviceId: 'x', now: w.sched.now });
  const store = createMemoryStore({ clock });
  const db = w.server.connect({ uid: 'u1' });
  assert.throws(() => createSyncEngine({ fs: {}, db, uid: 'u1', store, clock }), /fs\.collection/);
  assert.throws(() => createSyncEngine({ fs: w.fs, db, uid: 'a/b', store, clock }), /uid/);
  assert.throws(() => createSyncEngine({ fs: w.fs, db, uid: 'u1', store: {}, clock }), /store\./);
  // a store whose outbox read throws: error status, no crash, no unhandled rejection
  const broken = { ...store, outboxList: async () => { throw new Error('disk on fire'); } };
  const e = createSyncEngine({ fs: w.fs, db, uid: 'u1', store: broken, clock, timers: w.sched, now: w.sched.now, random: w.rng, logger: captureLogger([]) });
  e.start();
  await w.sched.runUntil(() => e.getStatus().state === 'error', { label: 'error' });
  assert.match(e.getStatus().error, /disk on fire/);
  await settle(w.sched, e.syncNow(), 'syncNow never rejects');
  await settle(w.sched, e.stop(), 'stop');
});

test('merging in the engine matches mergeRecords for remote edits racing local ones', async () => {
  // A and B edit the same field while both offline; the higher stamp must win everywhere.
  const w = makeWorld(21);
  const A = makeReplica(w, 'deva');
  const B = makeReplica(w, 'devb');
  A.start();
  B.start();
  await A.store.put('records', { id: 'b_1', kind: 'book', title: 'শুরু' });
  await w.sched.runUntil(() => allSynced(A, B) && B.store.get('records', 'b_1'), { label: 'shared' });
  A.setOnline(false);
  B.setOnline(false);
  await w.sched.advance(1000);
  const ra = await A.store.put('records', { id: 'b_1', title: 'A-র শিরোনাম', notes: 'A' });
  await w.sched.advance(1000);
  const rb = await B.store.put('records', { id: 'b_1', title: 'B-র শিরোনাম' });
  A.setOnline(true);
  B.setOnline(true);
  await w.sched.runUntil(() => allSynced(A, B) && same(A.store.all('records'), B.store.all('records')), { label: 'converged' });
  const expected = mergeRecords(ra, rb);
  assert.deepEqual(A.store.get('records', 'b_1'), expected);
  assert.equal(expected.title, 'B-র শিরোনাম');
  assert.equal(expected.notes, 'A');
  await A.stop();
  await B.stop();
});

test('no unhandled promise rejections happened', () => {
  assert.deepEqual(unhandled, []);
});
