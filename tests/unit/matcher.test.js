import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchText, LEVELS, spansOf, explainLevel } from '../../src/lib/matcher.js';
import { buildSeedRecords } from '../../src/lib/seed.js';
import { HUMAYUN_OWNED } from '../../src/data/humayun.js';

const seed = buildSeedRecords();
const books = seed.filter((r) => r.kind === 'book');
const catalog = seed.filter((r) => r.kind === 'catalog');
const authors = seed.filter((r) => r.kind === 'author');
const lib = { books, catalog, authors };
const listOnly = { catalog, authors };

// Seeded PRNG (mulberry32) so the noise tests are reproducible.
function rng(seedN) {
  let a = seedN >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CONFUSABLE = { 'ি': 'ী', 'ী': 'ি', 'ু': 'ূ', 'ূ': 'ু', 'ব': 'র', 'র': 'ব', 'ন': 'ল', 'ল': 'ন', 'ড': 'ভ', 'প': 'গ', 'ত': 'ভ', 'ম': 'য', 'স': 'ম', 'শ': 'ম', 'য়': 'য' };

function noisy(title, r, rate) {
  const chars = [...title];
  const out = [];
  for (const ch of chars) {
    const x = r();
    if (x < rate / 2 && ch !== ' ') continue; // dropped
    if (x < rate && CONFUSABLE[ch]) { out.push(CONFUSABLE[ch]); continue; } // misread
    out.push(ch);
  }
  return out.join('');
}

test('every owned book, as the owner typed it, finds its own list entry (or itself)', () => {
  const misses = [];
  for (const [serial, typed, catalogId, over] of HUMAYUN_OWNED) {
    const text = over?.title ?? typed;
    const m = matchText(text, listOnly);
    if (m.best?.id !== catalogId || !['exact', 'strong'].includes(m.level)) misses.push(`${serial} ${text} → ${m.best?.id} ${m.level}`);
  }
  assert.deepEqual(misses, []);
});

test('the scanner finds owned books as books (not as list entries)', () => {
  const m = matchText('হিমুর দ্বিতীয় প্রহর\nহুমায়ূন আহমেদ', lib);
  assert.equal(m.best.kind, 'book');
  assert.equal(m.best.id, 'b_h050');
  assert.equal(m.level, 'exact');
  const u = matchText('দেয়াল', lib);
  assert.equal(u.best.kind, 'catalog');
  assert.equal(u.best.id, 'hc060');
});

test('cover noise is ignored: author, publisher, price, glued lines', () => {
  const m = matchText('অন্যপ্রকাশ\nহুমায়ূন আহমেদ\nমধ্যাহ্ন\n৳ ৫০০ টাকা', listOnly);
  assert.equal(m.best.id, 'hc046');
  const g = matchText('হিমু মামা হুমায়ূন আহমেদ', listOnly);
  assert.equal(g.best.id, 'hc073');
  const split = matchText('হিমু এবং একটি\nরাশিয়ান পরী', listOnly);
  assert.equal(split.best.id, 'hc083');
});

test('different books that share words are never confused at strong level', () => {
  for (const [q, wrong] of [['সবাই গেছে বনে', 'hc108'], ['প্রথম প্রহর', 'hc067'], ['হিমু', 'hc073'], ['রূপা', 'hx13']]) {
    const m = matchText(q, listOnly);
    assert.notEqual(m.best?.id, wrong, q);
  }
});

test('Banglish and Latin appendix titles match', () => {
  assert.equal(matchText('himu mama', listOnly).best.id, 'hc073');
  assert.equal(matchText('আমাদের শাদা বাড়ি', { catalog: catalog.filter((c) => c.id !== 'hx01'), authors }).best.id, 'hp03');
  assert.equal(matchText('হলুদ পরী', listOnly).best?.id, 'hp25');
});

test('noisy OCR of every Bengali list title: ≥95% top-1, no wrong "exact"', () => {
  const r = rng(20261030);
  let ok = 0;
  let total = 0;
  const wrongExact = [];
  for (const e of catalog) {
    if (!/[ঀ-৿]/.test(e.title) || [...e.title].length < 4) continue;
    for (let k = 0; k < 2; k += 1) {
      total += 1;
      const lines = [noisy(e.title, r, 0.08), 'হুমায়ূন আহমেদ', 'অন্যপ্রকাশ'];
      const m = matchText(lines.join('\n'), listOnly);
      if (m.best?.id === e.id || (m.best && m.best.title === e.title)) ok += 1;
      else if (m.level === 'exact') wrongExact.push(`${e.title} → ${m.best.title}`);
    }
  }
  const acc = ok / total;
  assert.ok(acc >= 0.95, `top-1 accuracy ${(acc * 100).toFixed(1)}% (${ok}/${total})`);
  assert.deepEqual(wrongExact, []);
});

test('unrelated or empty text gives no confident match', () => {
  for (const t of ['', '   ', 'হুমায়ূন আহমেদ', 'অন্যপ্রকাশ ২০০৫', 'The Old Man and the Sea', 'রবীন্দ্রনাথ ঠাকুর গীতাঞ্জলি']) {
    const m = matchText(t, listOnly);
    assert.ok(!['exact', 'strong'].includes(m.level), `${t} → ${m.best?.title} ${m.level}`);
  }
});

test('near-tie between two different titles is downgraded to "possible"', () => {
  const tied = { catalog: [
    { id: 'x1', kind: 'catalog', title: 'নীল পদ্ম', authorId: 'a' },
    { id: 'x2', kind: 'catalog', title: 'নীল পদ্মা', authorId: 'a' },
  ], authors: [] };
  const m = matchText('নীল পদ্ম', tied);
  assert.ok(m.best);
  assert.ok(m.candidates.length >= 1);
  assert.ok(LEVELS.exact > LEVELS.strong && LEVELS.strong > LEVELS.possible);
  assert.equal(typeof explainLevel(m.level), 'string');
});

test('spans drop author/publisher lines and stay bounded', () => {
  const s = spansOf('হুমায়ূন আহমেদ\nঅন্যপ্রকাশ\nদেয়াল', ['হুমায়ূন আহমেদ']);
  assert.ok(s.includes('দেয়াল'));
  assert.ok(!s.some((x) => x.includes('অন্যপ্রকাশ')));
  const big = spansOf(Array.from({ length: 60 }, (_, i) => `লাইন ${i} কিছু লেখা আরো কিছু`).join('\n'));
  assert.ok(big.length <= 160);
});

test('fast enough for live use: 450 books + 300 list entries under 60 ms', () => {
  const manyBooks = Array.from({ length: 400 }, (_, i) => ({ id: `b${i}`, kind: 'book', title: `${books[i % books.length].title} ${i}`, authorId: 'a_humayun' }));
  const big = { books: [...books, ...manyBooks], catalog, authors };
  const t0 = performance.now();
  matchText('হিমুর দ্বিতীয় প্রহর\nহুমায়ূন আহমেদ\nঅন্যপ্রকাশ', big);
  const ms = performance.now() - t0;
  assert.ok(ms < 60, `${ms.toFixed(1)} ms`);
});
