import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClock, encodeStamp, parseStamp, randomId, SEED_STAMP } from '../../src/lib/clock.js';
import { mulberry32 } from '../helpers/fake-firestore.js';

const MAX_C = 36 ** 4 - 1;
const T0 = Date.UTC(2026, 9, 30);

// Physical clock that wanders: forwards, backwards, frozen, big jumps.
function wanderingTime(rng, start = T0) {
  let t = start;
  return () => {
    const r = rng();
    if (r < 0.3) t += Math.floor(rng() * 5);
    else if (r < 0.5) t -= Math.floor(rng() * 50);
    else if (r < 0.55) t += Math.floor(rng() * 1e7);
    else if (r < 0.6) t -= Math.floor(rng() * 1e7);
    return t;
  };
}

test('stamps from one clock strictly increase however the physical clock moves', () => {
  const rng = mulberry32(11);
  const clock = createClock({ deviceId: 'dev1', now: wanderingTime(rng) });
  let prev = '';
  for (let i = 0; i < 20000; i++) {
    const s = clock.now();
    assert.ok(s > prev, `stamp ${i} ${s} not after ${prev}`);
    prev = s;
  }
});

test('after observe(s) the next stamp is greater than s', () => {
  const rng = mulberry32(12);
  const a = createClock({ deviceId: 'a', now: wanderingTime(rng) });
  const b = createClock({ deviceId: 'b', now: wanderingTime(rng, T0 + 3600e3) });
  for (let i = 0; i < 5000; i++) {
    const [from, to] = rng() < 0.5 ? [a, b] : [b, a];
    const s = from.now();
    to.observe(s);
    const next = to.now();
    assert.ok(next > s, `${next} should sort after observed ${s}`);
  }
});

test('observing an older stamp never moves the clock back', () => {
  const clock = createClock({ deviceId: 'x', now: () => T0 });
  const s1 = clock.now();
  clock.observe(encodeStamp(T0 - 1000, 5, 'old'));
  clock.observe(SEED_STAMP);
  const s2 = clock.now();
  assert.ok(s2 > s1);
  assert.deepEqual(parseStamp(s2), { l: T0, c: 1, device: 'x' });
});

test('string order equals (time, counter, device) order', () => {
  const rng = mulberry32(13);
  const pick = () => ({
    l: Math.floor(rng() * 36 ** 9),
    c: Math.floor(rng() * 36 ** 4),
    d: randomFrom(rng, ['a', 'b', 'zz', 'k3j9x0qa', 'seed']),
  });
  for (let i = 0; i < 5000; i++) {
    const x = pick();
    const y = rng() < 0.3 ? { ...x, c: rng() < 0.5 ? x.c : Math.floor(rng() * 36 ** 4) } : pick();
    const sx = encodeStamp(x.l, x.c, x.d);
    const sy = encodeStamp(y.l, y.c, y.d);
    const tuple = x.l !== y.l ? Math.sign(x.l - y.l) : x.c !== y.c ? Math.sign(x.c - y.c) : x.d === y.d ? 0 : x.d < y.d ? -1 : 1;
    const str = sx === sy ? 0 : sx < sy ? -1 : 1;
    assert.equal(str, tuple, `${sx} vs ${sy}`);
    assert.deepEqual(parseStamp(sx), { l: x.l, c: x.c, device: x.d });
  }
});

test('two devices at the same instant never mint equal stamps', () => {
  const a = createClock({ deviceId: 'aa', now: () => T0 });
  const b = createClock({ deviceId: 'ab', now: () => T0 });
  const seen = new Set();
  for (let i = 0; i < 1000; i++) {
    for (const s of [a.now(), b.now()]) {
      assert.ok(!seen.has(s));
      seen.add(s);
    }
  }
});

test('SEED_STAMP sorts before every stamp a real clock can produce', () => {
  assert.deepEqual(parseStamp(SEED_STAMP), { l: 1, c: 0, device: 'seed' });
  const c = createClock({ deviceId: 'dev', now: () => 2 });
  assert.ok(c.now() > SEED_STAMP);
  const real = createClock({ deviceId: 'dev', now: () => T0 });
  assert.ok(real.now() > SEED_STAMP);
});

test('counter overflow keeps stamps ordered (regression)', () => {
  const clock = createClock({ deviceId: 'dev', now: () => 1000, state: { l: 1000, c: MAX_C - 2 } });
  let prev = encodeStamp(1000, MAX_C - 2, 'dev');
  for (let i = 0; i < 10; i++) {
    const s = clock.now();
    assert.ok(s > prev, `${s} should sort after ${prev}`);
    assert.match(s, /^[0-9a-z]{9}\.[0-9a-z]{4}\.dev$/);
    prev = s;
  }
});

test('observe ignores garbage and stamps outside the format range', () => {
  const clock = createClock({ deviceId: 'dev', now: () => T0 });
  const before = clock.state();
  for (const junk of [undefined, null, 42, {}, '', 'nonsense', '...', 'zz', 'abc.def', 'zzzzzzzzzz.0000.x', '000000001.zzzzz.x', 'zzzzzzzzz.0000.x']) {
    clock.observe(junk);
  }
  assert.deepEqual(clock.state(), before);
  assert.ok(clock.now() < 'zzzzzzzzz');
});

test('a clock resumed from saved state continues after its last stamp', () => {
  let saved = null;
  let saves = 0;
  const frozen = () => T0;
  const a = createClock({ deviceId: 'dev', now: frozen, save: (s) => { saved = s; saves += 1; } });
  let last = '';
  for (let i = 0; i < 50; i++) last = a.now();
  assert.equal(saves, 50);
  const resumed = createClock({ deviceId: 'dev', now: () => T0 - 5000, state: saved });
  assert.ok(resumed.now() > last);
});

test('deviceId must be lowercase alphanumeric', () => {
  for (const bad of ['', 'A', 'a-b', 'a.b', 'a b', undefined]) {
    assert.throws(() => createClock({ deviceId: bad }), /deviceId/);
  }
  assert.equal(createClock({ deviceId: 'k3j9x0qa' }).deviceId, 'k3j9x0qa');
});

test('randomId has the requested length and alphabet', () => {
  for (let i = 0; i < 100; i++) assert.match(randomId(16), /^[0-9a-z]{16}$/);
  assert.match(randomId(), /^[0-9a-z]{8}$/);
});

function randomFrom(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}
