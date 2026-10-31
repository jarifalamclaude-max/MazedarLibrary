import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyChanges, canonical, isDataField, maxStamp, mergeRecords, recordsEqual, sanitize, stampOf,
} from '../../src/lib/merge.js';
import { SEED_STAMP } from '../../src/lib/clock.js';
import { mulberry32 } from '../helpers/fake-firestore.js';

// The merge is defined over JSON values (what IndexedDB, Firestore and backup
// files carry). The generators deliberately include equal stamps with different
// values, unstamped fields, stamps without values, conflicting kinds and
// transport junk, because those are the cases that break naive merges.
const FIELDS = ['title', 'notes', 'copies', 'favorite', 'deleted', 'meta', 'list'];
const VALUES = [
  'নন্দিত নরকে', 'হিমু', 'Himu', '', 'a', 0, 1, 2, -1, 3.5, true, false, null,
  { a: 1, b: [1, 2] }, { b: [1, 2], a: 1 }, [1, 'x'], ['x', 1], { nested: { deep: 'হ' } },
];
const STAMPS = [SEED_STAMP, '0mh2k3x1a.0000.aa', '0mh2k3x1a.0000.bb', '0mh2k3x1a.0001.aa', '0mh2k3x1b.0000.aa', '0mh2k3x1b.0000.cc'];
const KINDS = [undefined, undefined, 'book', 'book', 'author'];
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
const json = (v) => JSON.parse(JSON.stringify(v));

function randomRecord(rng, id = 'r1') {
  const rec = { id, _v: {} };
  const kind = pick(rng, KINDS);
  if (kind !== undefined) rec.kind = kind;
  for (const f of FIELDS) {
    if (rng() < 0.45) continue;
    rec[f] = json(pick(rng, VALUES));
    if (rng() < 0.85) rec._v[f] = pick(rng, STAMPS);
  }
  if (rng() < 0.15) rec._v.ghost = pick(rng, STAMPS); // stamp without a value
  if (rng() < 0.1) rec._srv = { seconds: 5 }; // transport metadata
  if (rng() < 0.1) rec.notes = undefined;
  if (rng() < 0.05) rec._v.copies = 7; // non-string stamp
  return rec;
}

const eq = (a, b, msg) => assert.equal(canonical(a), canonical(b), msg);

test('merge is commutative', () => {
  const rng = mulberry32(21);
  for (let i = 0; i < 4000; i++) {
    const a = randomRecord(rng);
    const b = randomRecord(rng);
    eq(mergeRecords(a, b), mergeRecords(b, a), JSON.stringify({ a, b }));
  }
});

test('merge is associative', () => {
  const rng = mulberry32(22);
  for (let i = 0; i < 4000; i++) {
    const a = randomRecord(rng);
    const b = randomRecord(rng);
    const c = randomRecord(rng);
    eq(mergeRecords(mergeRecords(a, b), c), mergeRecords(a, mergeRecords(b, c)), JSON.stringify({ a, b, c }));
  }
});

test('merge is idempotent', () => {
  const rng = mulberry32(23);
  for (let i = 0; i < 4000; i++) {
    const a = randomRecord(rng);
    const b = randomRecord(rng);
    eq(mergeRecords(a, a), sanitize(a));
    const ab = mergeRecords(a, b);
    eq(mergeRecords(ab, b), ab);
    eq(mergeRecords(ab, a), ab);
    eq(mergeRecords(ab, ab), ab);
  }
});

test('merge only depends on the sanitized copies', () => {
  const rng = mulberry32(24);
  for (let i = 0; i < 3000; i++) {
    const a = randomRecord(rng);
    const b = randomRecord(rng);
    eq(mergeRecords(a, b), mergeRecords(sanitize(a), sanitize(b)));
  }
});

test('folding many versions in any order converges', () => {
  const rng = mulberry32(25);
  for (let i = 0; i < 400; i++) {
    const versions = Array.from({ length: 2 + Math.floor(rng() * 6) }, () => randomRecord(rng));
    const ref = versions.reduce((acc, v) => mergeRecords(acc, v), undefined);
    for (let k = 0; k < 5; k++) {
      const shuffled = [...versions].sort(() => rng() - 0.5);
      eq(shuffled.reduce((acc, v) => mergeRecords(acc, v), undefined), ref);
    }
  }
});

test('each field keeps the value with the greatest stamp (last writer wins)', () => {
  const rng = mulberry32(26);
  for (let i = 0; i < 3000; i++) {
    const a = randomRecord(rng);
    const b = randomRecord(rng);
    const m = mergeRecords(a, b);
    const sa = sanitize(a);
    const sb = sanitize(b);
    for (const f of new Set([...Object.keys(sa), ...Object.keys(sb)])) {
      if (!isDataField(f)) continue;
      const best = stampOf(sa, f) > stampOf(sb, f) ? sa : stampOf(sb, f) > stampOf(sa, f) ? sb : null;
      assert.ok(f in m, `field ${f} lost`);
      if (best) {
        eq(m[f], best[f], `field ${f}`);
        assert.equal(stampOf(m, f), stampOf(best, f));
      } else {
        // same stamp on both sides: one of the two values, chosen by content
        assert.ok(canonical(m[f]) === canonical(sa[f] ?? null) || canonical(m[f]) === canonical(sb[f] ?? null) || !(f in sa) || !(f in sb));
      }
    }
    for (const f of Object.keys(m._v)) assert.ok(f in m, `stamp without value for ${f}`);
  }
});

test('a newer edit on one field never overwrites a concurrent edit on another', () => {
  const base = { id: 'b', kind: 'book', title: 'ক', notes: 'x', _v: { title: SEED_STAMP, notes: SEED_STAMP } };
  const onA = applyChanges(base, { title: 'খ' }, '0mh2k3x1a.0000.aa');
  const onB = applyChanges(base, { notes: 'y' }, '0mh2k3x1a.0000.bb');
  const m = mergeRecords(onA, onB);
  assert.equal(m.title, 'খ');
  assert.equal(m.notes, 'y');
  eq(m, mergeRecords(onB, onA));
});

test('conflicting kinds resolve the same way in both orders (regression)', () => {
  const a = { id: 'x', kind: 'book', title: 'A', _v: { title: 's1' } };
  const b = { id: 'x', kind: 'author', title: 'B', _v: { title: 's2' } };
  assert.equal(mergeRecords(a, b).kind, mergeRecords(b, a).kind);
  assert.equal(mergeRecords(a, { id: 'x', _v: {} }).kind, 'book');
  assert.equal(mergeRecords({ id: 'x', _v: {} }, a).kind, 'book');
});

test('a stamp without a value cannot erase a field (regression)', () => {
  const local = { id: 'b1', kind: 'book', title: 'নন্দিত নরকে', _v: { title: '0mh2k3x1a.0000.aa' } };
  const corrupt = { id: 'b1', kind: 'book', _v: { title: '0mh2k3x9z.0000.zz' } };
  assert.equal(mergeRecords(local, corrupt).title, 'নন্দিত নরকে');
  assert.equal(mergeRecords(corrupt, local).title, 'নন্দিত নরকে');
});

test('merge handles missing sides and refuses mismatched ids', () => {
  const a = { id: 'x', title: 't', _v: { title: 's' }, _srv: 1 };
  eq(mergeRecords(a, null), sanitize(a));
  eq(mergeRecords(undefined, a), sanitize(a));
  assert.equal(mergeRecords(null, undefined), undefined);
  assert.throws(() => mergeRecords(a, { id: 'y', _v: {} }), /id mismatch/);
});

test('merge does not share or mutate its inputs', () => {
  const a = { id: 'x', meta: { n: 1 }, _v: { meta: 's2' } };
  const b = { id: 'x', meta: { n: 2 }, _v: { meta: 's1' } };
  const snapshot = JSON.stringify([a, b]);
  const m = mergeRecords(a, b);
  m.meta.n = 99;
  assert.equal(JSON.stringify([a, b]), snapshot);
});

test('sanitize drops _srv, other transport keys, undefined values and orphan stamps', () => {
  const s = sanitize({
    id: 'b1', kind: 'book', title: 'ক', gone: undefined, _srv: { seconds: 1 }, _tmp: 1,
    _v: { title: 's1', gone: 's2', ghost: 's3', bad: 5 }, bad: 'v',
  });
  assert.deepEqual(s, { id: 'b1', kind: 'book', title: 'ক', bad: 'v', _v: { title: 's1' } });
  assert.deepEqual(sanitize({ id: 'x' }), { id: 'x', _v: {} });
  assert.equal(sanitize(undefined), undefined);
});

test('recordsEqual ignores key order and transport keys but not stamps', () => {
  const a = { id: 'x', kind: 'book', title: 'ক', meta: { a: 1, b: 2 }, _v: { title: 's1', meta: 's1' } };
  const b = { _v: { meta: 's1', title: 's1' }, meta: { b: 2, a: 1 }, title: 'ক', kind: 'book', id: 'x', _srv: 9 };
  assert.ok(recordsEqual(a, b));
  assert.ok(!recordsEqual(a, { ...b, _v: { meta: 's1', title: 's2' } }));
  assert.ok(!recordsEqual(a, { ...b, title: 'খ' }));
  assert.ok(recordsEqual(undefined, undefined));
});

test('applyChanges stamps exactly the changed fields', () => {
  const prev = { id: 'b1', kind: 'book', title: 'ক', copies: 1, notes: '', _v: { title: 's1', copies: 's1', notes: 's1' } };
  const frozen = JSON.stringify(prev);
  const next = applyChanges(prev, { id: 'b1', title: 'ক', copies: 2, notes: undefined, favorite: true, _v: { x: 'evil' }, _srv: 1, kind: 'author' }, 's9');
  assert.equal(JSON.stringify(prev), frozen, 'prev must not be mutated');
  assert.deepEqual(next, {
    id: 'b1', kind: 'book', title: 'ক', copies: 2, notes: null, favorite: true,
    _v: { title: 's1', copies: 's9', notes: 's9', favorite: 's9' },
  });
});

test('applyChanges creates new records and requires an id', () => {
  const rec = applyChanges(undefined, { id: 'b_new', kind: 'book', title: 'হিমু' }, 's1');
  assert.deepEqual(sanitize(rec), { id: 'b_new', kind: 'book', title: 'হিমু', _v: { title: 's1' } });
  const viaBase = applyChanges(null, { title: 't' }, 's2', { id: 'b2', kind: 'book' });
  assert.equal(viaBase.id, 'b2');
  assert.equal(viaBase.kind, 'book');
  assert.throws(() => applyChanges(undefined, { title: 'x' }, 's1'), /missing id/);
});

test('an edit always beats the seed, whatever the merge order', () => {
  const rng = mulberry32(27);
  for (let i = 0; i < 1000; i++) {
    const seed = { id: 'b_h001', kind: 'book', title: 'নন্দিত নরকে', favorite: false, _v: { title: SEED_STAMP, favorite: SEED_STAMP } };
    const stamp = pick(rng, STAMPS.slice(1));
    const edited = applyChanges(seed, { favorite: true }, stamp);
    const m = rng() < 0.5 ? mergeRecords(seed, edited) : mergeRecords(edited, seed);
    assert.equal(m.favorite, true);
    assert.equal(m._v.favorite, stamp);
    assert.equal(m._v.title, SEED_STAMP);
  }
});

test('maxStamp finds the newest stamp', () => {
  assert.equal(maxStamp({ id: 'x', _v: { a: 's1', b: 's3', c: 's2' } }), 's3');
  assert.equal(maxStamp({ id: 'x', _v: {} }), '');
  assert.equal(maxStamp(undefined), '');
});

test('canonical is key-order independent JSON', () => {
  assert.equal(canonical({ b: 1, a: [1, { d: 2, c: 3 }] }), '{"a":[1,{"c":3,"d":2}],"b":1}');
  assert.equal(canonical({ a: undefined, b: null }), '{"b":null}');
  assert.equal(canonical(undefined), '');
});
