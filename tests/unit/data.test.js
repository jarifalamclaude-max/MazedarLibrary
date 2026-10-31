// Library-level rules (src/ui/data.js + store.js) that protect the data.
import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../../src/lib/store.js';
import { buildSeedRecords, SEED_VERSION } from '../../src/lib/seed.js';
import { encodeStamp } from '../../src/lib/clock.js';
import { mergeRecords } from '../../src/lib/merge.js';
import { ctx } from '../../src/ui/core.js';
import { derive, trashRecord, restoreRecord, addAuthor, authorIdFor, searchLibrary, purgeRecord } from '../../src/ui/data.js';

let n = 0;
async function lib() {
  const store = await openStore({ dbName: `data-${process.pid}-${(n += 1)}` });
  await store.seedIfNeeded(buildSeedRecords(), SEED_VERSION);
  ctx.store = store;
  return store;
}
const L = (store) => derive(store.records);

test('restoring one book from a deleted folder brings the whole folder (and its counter) back', async () => {
  const s = await lib();
  await trashRecord(L(s), s.records.get('a_humayun'));
  assert.equal(L(s).books.length, 0);
  await restoreRecord(L(s), s.records.get('b_h001'));
  const after = L(s);
  assert.equal(after.books.length, 113);
  assert.equal(after.stats.get('a_humayun').remaining, 124);
  assert.equal(after.trash.length, 0);
  s.close();
});

test('restoring a folder never brings back what was deleted forever', async () => {
  const s = await lib();
  await trashRecord(L(s), s.records.get('a_humayun'));
  await purgeRecord(s.records.get('b_h002'));
  await restoreRecord(L(s), s.records.get('a_humayun'));
  const after = L(s);
  assert.equal(after.books.length, 112);
  assert.ok(!after.books.some((b) => b.id === 'b_h002'));
  s.close();
});

test('a purged record is hidden even if another phone restored it at the same time', async () => {
  const s = await lib();
  await s.put('records', { id: 'b_h003', deleted: false, purged: true });
  const l = L(s);
  assert.ok(!l.books.some((b) => b.id === 'b_h003'));
  assert.ok(!l.trash.some((b) => b.id === 'b_h003'));
  s.close();
});

test('a book added to a folder that the other phone deleted goes to trash, not to the totals', async () => {
  const s = await lib();
  await s.put('records', { id: 'b_late', kind: 'book', title: 'নতুন', authorId: 'a_humayun', deleted: false });
  await s.put('records', { id: 'a_humayun', deleted: true });
  const l = L(s);
  assert.equal(l.totals.books, 0);
  assert.ok(l.trash.some((r) => r.id === 'b_late'));
  s.close();
});

test('the same new author added on two phones is one folder (same id)', async () => {
  const s = await lib();
  const a = await addAuthor(L(s), 'সমরেশ  মজুমদার');
  assert.equal(a.id, authorIdFor('সমরেশ মজুমদার'));
  assert.equal(authorIdFor('সমরেশ মজুমদার'), authorIdFor('সমরেশ মজুমদার '));
  const again = await addAuthor(L(s), 'সমরেশ মজুমদার');
  assert.equal(again.id, a.id);
  s.close();
});

test('ISBN typed in Bengali digits is found by an ASCII search and vice versa', async () => {
  const s = await lib();
  await s.put('records', { id: 'b_h004', isbn: '৯৭৮-৯৮৪-৫০২-০৪৫-৬' });
  const r = searchLibrary(L(s), '9789845020456');
  assert.equal(r.books[0]?.book.id, 'b_h004');
  s.close();
});

test('snapshot restore only undoes what happened after the snapshot time', async () => {
  const s = await lib();
  await s.put('records', { id: 'b_h005', notes: 'আগের নোট' });
  await new Promise((r) => setTimeout(r, 5));
  const snapId = await s.snapshot('test');
  const snapTs = (await s.listSnapshots()).find((x) => x.id === snapId).ts;
  await new Promise((r) => setTimeout(r, 5));
  // The other phone's book, created BEFORE the snapshot, arrives only now.
  const early = encodeStamp(snapTs - 60000, 0, 'otherphone');
  const fields = { kind: 'book', title: 'অন্য ফোনের বই', authorId: 'a_humayun', deleted: false };
  await s.applyRemote('records', [{ id: 'b_other', ...fields, _v: Object.fromEntries(Object.keys(fields).map((k) => [k, early])) }]);
  // Local mistakes after the snapshot:
  await s.put('records', { id: 'b_h005', notes: 'ভুল করে বদলানো' });
  await s.put('records', { id: 'b_h006', deleted: true, purged: true });
  await s.put('records', { id: 'b_mine', kind: 'book', title: 'পরে যোগ করা', authorId: 'a_humayun', deleted: false });
  await s.restoreSnapshot(snapId);
  const l = L(s);
  assert.equal(s.records.get('b_h005').notes, 'আগের নোট', 'later edit undone');
  assert.ok(l.books.some((b) => b.id === 'b_h006'), 'later "delete forever" undone');
  assert.ok(l.books.some((b) => b.id === 'b_other'), "the other phone's earlier book is kept");
  assert.ok(!l.books.some((b) => b.id === 'b_mine'), 'a book added after the snapshot goes to trash');
  s.close();
});

test('importing data stamped by a clock that runs ahead still lets the next local edit win', async () => {
  const s = await lib();
  const future = encodeStamp(Date.now() + 2 * 3600 * 1000, 0, 'fastclock');
  const rec = mergeRecords(s.records.get('b_h007'), { id: 'b_h007', notes: 'আমদানি', _v: { notes: future } });
  await s.importAll({ format: 'mazedar-library-backup', version: 1, records: [rec], covers: [] });
  await s.put('records', { id: 'b_h007', notes: 'নিজের সম্পাদনা' });
  assert.equal(s.records.get('b_h007').notes, 'নিজের সম্পাদনা');
  s.close();
});
