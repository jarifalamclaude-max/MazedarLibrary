// IndexedDB LocalStore (src/lib/store.js) under fake-indexeddb.
import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../../src/lib/store.js';
import { buildSeedRecords, SEED_VERSION } from '../../src/lib/seed.js';
import { SEED_STAMP } from '../../src/lib/clock.js';
import { mergeRecords } from '../../src/lib/merge.js';

let dbSeq = 0;
const fresh = () => openStore({ dbName: `test-${process.pid}-${(dbSeq += 1)}` });
const tick = () => new Promise((r) => setTimeout(r, 5));

test('seeds once: 1 author + 236 list entries + 113 books, nothing queued for upload', async () => {
  const s = await fresh();
  assert.equal(await s.seedIfNeeded(buildSeedRecords(), SEED_VERSION), true);
  const kinds = {};
  for (const r of s.records.values()) kinds[r.kind] = (kinds[r.kind] || 0) + 1;
  assert.deepEqual(kinds, { author: 1, catalog: 236, book: 113 });
  assert.equal(await s.pendingCount(), 0);
  assert.equal(await s.seedIfNeeded(buildSeedRecords(), SEED_VERSION), false);
  const b = s.records.get('b_h012');
  assert.equal(b.title, 'মাতাল হাওয়া');
  assert.equal(b.originalEntry, 'মাতাল হওয়া');
  assert.equal(b._v.title, SEED_STAMP);
  s.close();
});

test('a local edit is stamped, stored, queued and announced', async () => {
  const s = await fresh();
  await s.seedIfNeeded(buildSeedRecords(), SEED_VERSION);
  const seen = [];
  let local = 0;
  s.subscribe(({ ids }) => seen.push(...ids));
  s.onLocalWrite(() => { local += 1; });
  const r = await s.put('records', { id: 'b_h001', favorite: true });
  await tick();
  assert.equal(r.favorite, true);
  assert.ok(r._v.favorite > SEED_STAMP);
  assert.equal(r._v.title, SEED_STAMP, 'untouched fields keep their stamps');
  assert.deepEqual(await s.outboxList('records', 10), ['b_h001']);
  assert.ok(seen.includes('b_h001'));
  assert.equal(local, 1);
  // Same value again: no new stamp, nothing new queued.
  const again = await s.put('records', { id: 'b_h001', favorite: true });
  assert.equal(again._v.favorite, r._v.favorite);
  assert.equal(await s.pendingCount(), 1);
  s.close();
});

test('applyRemote: server ack clears the outbox, older data never overwrites newer', async () => {
  const s = await fresh();
  await s.seedIfNeeded(buildSeedRecords(), SEED_VERSION);
  const mine = await s.put('records', { id: 'b_h002', notes: 'আমার নোট' });
  // An older remote edit of another field merges in; our newer field stays and stays queued.
  const olderRemote = { ...mine, publisher: 'অন্যপ্রকাশ', notes: 'পুরোনো', _v: { ...mine._v, publisher: '0000000ff.0000.other', notes: '0000000ff.0000.other' } };
  await s.applyRemote('records', [olderRemote]);
  const merged = s.records.get('b_h002');
  assert.equal(merged.notes, 'আমার নোট');
  assert.equal(merged.publisher, 'অন্যপ্রকাশ');
  assert.deepEqual(await s.outboxList('records', 10), ['b_h002']);
  // The server now holds everything we hold (what a push transaction writes): dequeued.
  await s.applyRemote('records', [mergeRecords(olderRemote, merged)]);
  assert.equal(await s.pendingCount(), 0);
  s.close();
});

test('concurrent puts on one record are all kept (serialised read-merge-write)', async () => {
  const s = await fresh();
  await s.seedIfNeeded(buildSeedRecords(), SEED_VERSION);
  await Promise.all([
    s.put('records', { id: 'b_h003', notes: 'ক' }),
    s.put('records', { id: 'b_h003', publisher: 'খ' }),
    s.put('records', { id: 'b_h003', copies: 3 }),
  ]);
  const r = s.records.get('b_h003');
  assert.equal(r.notes, 'ক');
  assert.equal(r.publisher, 'খ');
  assert.equal(r.copies, 3);
  s.close();
});

test('stamps keep increasing after the store is reopened', async () => {
  const name = `test-${process.pid}-reopen`;
  const a = await openStore({ dbName: name });
  const first = await a.put('records', { id: 'x_1', kind: 'book', title: 'ক' });
  a.close();
  const b = await openStore({ dbName: name });
  assert.equal(b.records.get('x_1').title, 'ক');
  const second = await b.put('records', { id: 'x_1', title: 'খ' });
  assert.ok(second._v.title > first._v.title);
  assert.equal(b.deviceId, a.deviceId);
  b.close();
});

test('snapshot restore brings back old values as new edits and trashes later additions', async () => {
  const s = await fresh();
  await s.seedIfNeeded(buildSeedRecords(), SEED_VERSION);
  await s.put('records', { id: 'b_h004', notes: 'আগে' });
  const snapId = await s.snapshot('test');
  await s.put('records', { id: 'b_h004', notes: 'পরে' });
  await s.put('records', { id: 'b_new', kind: 'book', title: 'নতুন', authorId: 'a_humayun', deleted: false });
  const n = await s.restoreSnapshot(snapId);
  assert.ok(n >= 2);
  assert.equal(s.records.get('b_h004').notes, 'আগে');
  assert.equal(s.records.get('b_new').deleted, true);
  const snaps = await s.listSnapshots();
  assert.ok(snaps.length >= 2, 'a safety snapshot was taken before restoring');
  s.close();
});

test('backup export/import round-trips into another device without losing newer edits', async () => {
  const a = await fresh();
  await a.seedIfNeeded(buildSeedRecords(), SEED_VERSION);
  await a.put('records', { id: 'b_h005', favorite: true });
  await a.put('records', { id: 'a_x', kind: 'author', name: 'সমরেশ মজুমদার', deleted: false });
  await a.setCover('b_h005', 'data:image/jpeg;base64,AAAA');
  const file = JSON.parse(JSON.stringify(await a.exportAll()));

  const b = await fresh();
  await b.seedIfNeeded(buildSeedRecords(), SEED_VERSION);
  await b.put('records', { id: 'b_h006', notes: 'বি-তে নতুন' });
  const res = await b.importAll(file);
  assert.equal(res.added, 1);
  assert.ok(res.updated >= 1);
  assert.equal(b.records.get('b_h005').favorite, true);
  assert.equal(b.records.get('a_x').name, 'সমরেশ মজুমদার');
  assert.equal(b.records.get('b_h006').notes, 'বি-তে নতুন');
  assert.equal(await b.getCover('b_h005'), 'data:image/jpeg;base64,AAAA');
  await assert.rejects(() => b.importAll({ hello: 1 }), /ব্যাকআপ/);
  a.close();
  b.close();
});

test('covers: set, read, remove', async () => {
  const s = await fresh();
  await s.put('records', { id: 'b_c', kind: 'book', title: 'ক', hasCover: false });
  await s.setCover('b_c', 'data:image/jpeg;base64,BBBB');
  assert.equal(s.records.get('b_c').hasCover, true);
  assert.equal(await s.getCover('b_c'), 'data:image/jpeg;base64,BBBB');
  await s.setCover('b_c', null);
  assert.equal(s.records.get('b_c').hasCover, false);
  assert.equal(await s.getCover('b_c'), null);
  s.close();
});

test('wipe clears the library (after a snapshot) and seeding works again', async () => {
  const s = await fresh();
  await s.seedIfNeeded(buildSeedRecords(), SEED_VERSION);
  await s.put('records', { id: 'b_h007', notes: 'x' });
  await s.wipe();
  assert.equal(s.records.size, 0);
  assert.equal(await s.pendingCount(), 0);
  assert.ok((await s.listSnapshots()).some((x) => x.reason.includes('অ্যাকাউন্ট')));
  assert.equal(await s.seedIfNeeded(buildSeedRecords(), SEED_VERSION), true);
  assert.equal(s.records.size, 350);
  s.close();
});

test('enqueueAll queues every real edit (books and covers), never untouched seed data', async () => {
  const s = await fresh();
  await s.seedIfNeeded(buildSeedRecords(), SEED_VERSION);
  assert.equal(s.localChangeCount(), 0);
  await s.put('records', { id: 'b_h001', favorite: true });
  await s.put('records', { id: 'b_new', kind: 'book', title: 'সাতকাহন', authorId: 'a_x' });
  await s.setCover('b_new', 'data:image/jpeg;base64,AAAA');
  assert.equal(s.localChangeCount(), 2);
  // Pretend all of it reached the old library: the outbox is empty again.
  for (const coll of ['records', 'covers']) {
    const ids = await s.outboxList(coll, 1000);
    await s.applyRemote(coll, (await s.getManyRaw(coll, ids)).map((r) => ({ ...r, _srv: 1 })));
  }
  assert.equal(await s.pendingCount(), 0);
  let announced = 0;
  s.onLocalWrite(() => { announced += 1; });
  assert.equal(await s.enqueueAll(), 3);
  assert.equal(announced, 1);
  assert.deepEqual((await s.outboxList('records', 1000)).sort(), ['b_h001', 'b_new']);
  assert.deepEqual(await s.outboxList('covers', 1000), ['b_new']);
  s.close();
});
