// Bengali text utilities: display cleanup, match keys, dictionary collation,
// Banglish transliteration and fuzzy similarity. Pure functions: no DOM, no
// Intl/ICU dependence, identical results in Node and every browser.

const ZWJ = '\u{200D}';
const HASANTA = '\u{09CD}';
const NUKTA = '\u{09BC}';
const DROP_ALWAYS = new Set(['\u{200B}', '\u{200C}', '\u{FEFF}', '\u{00AD}', '\u{2060}']);

/** Unicode NFC of any value (null/undefined -> ''). */
export function nfc(s) {
  return String(s ?? '').normalize('NFC');
}

// ZWNJ/ZWJ only change glyph shaping; the one ZWJ that carries meaning is in
// "র + ZWJ + ্" (র‍্য, the ya-phala written after র), so that one is kept.
function stripJoiners(s, keepRaZwj) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (DROP_ALWAYS.has(c)) continue;
    if (c === ZWJ && !(keepRaZwj && s[i - 1] === 'র' && s[i + 1] === HASANTA)) continue;
    out += c;
  }
  return out;
}

/**
 * Display-safe cleanup of a title or name: NFC, invisible characters removed
 * (except the ZWJ of র‍্য), whitespace collapsed, trailing . , । dropped.
 * @param {string} s
 * @returns {string}
 */
export function cleanTitle(s) {
  return stripJoiners(nfc(s), true)
    .replace(/\s+/g, ' ')
    .replace(/[\s.,।॥]+$/u, '')
    .trim();
}

/** ASCII digits -> Bengali digits. @param {string|number} x */
export function toBnDigits(x) {
  return String(x ?? '').replace(/[0-9]/g, (d) => String.fromCharCode(0x09E6 + d.charCodeAt(0) - 48));
}

/** Bengali digits -> ASCII digits. @param {string} s */
export function toAsciiDigits(s) {
  return String(s ?? '').replace(/[\u{09E6}-\u{09EF}]/gu, (d) => String.fromCharCode(48 + d.charCodeAt(0) - 0x09E6));
}

// Spelling variants that Bengali readers treat as the same word.
const KEY_FOLD = new Map([
  [NUKTA, ''], [HASANTA, ''], ['ঁ', ''], ['ঃ', ''], ['ৗ', ''],
  ['ী', 'ি'], ['ূ', 'ু'], ['ঈ', 'ই'], ['ঊ', 'উ'], ['ৄ', 'ৃ'], ['ৠ', 'ঋ'],
  ['ণ', 'ন'], ['ষ', 'শ'], ['স', 'শ'], ['ৎ', 'ত'], ['ঙ', 'ং'], ['ৰ', 'র'], ['ৱ', 'ব'],
]);
const KEY_CHAR = /[\p{L}\p{M}\p{Nd}]/u;

function stripLatinMarks(s) {
  // NFD+NFC round trip keeps Bengali intact (ো recomposes; nukta letters stay split).
  return s.normalize('NFD').replace(/[\u{0300}-\u{036F}]/gu, '').normalize('NFC');
}

/**
 * Aggressive match key: spelling variants folded (ী/ি, ূ/ু, ণ/ন, শ/ষ/স, ৎ/ত,
 * ঙ/ং, nukta, hasanta, ঁ ঃ), Bengali digits as ASCII, Latin lowercased without
 * accents, spaces and punctuation removed.
 * @param {string} s
 * @returns {string}
 */
export function searchKey(s) {
  const t = stripLatinMarks(toAsciiDigits(stripJoiners(nfc(s), false)).toLowerCase());
  let out = '';
  for (const ch of t) {
    const f = KEY_FOLD.get(ch);
    if (f !== undefined) out += f;
    else if (KEY_CHAR.test(ch)) out += ch;
  }
  return out;
}

const WORD_SPLIT = /[^\p{L}\p{M}\p{Nd}\u{200C}\u{200D}]+/u;

/**
 * Words of a string (split on spaces and punctuation), each as its searchKey.
 * @param {string} s
 * @returns {string[]}
 */
export function tokens(s) {
  return nfc(s).split(WORD_SPLIT).map(searchKey).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Collation (Bangla Academy dictionary order), computed here so the order is
// the same on every device regardless of the browser's ICU data.
//
// Primary key: one weight per letter; every consonant is followed by a "vowel
// slot" weight: bare (inherent vowel) < া < ি < ী < ু < ূ < ৃ < ে < ৈ < ো < ৌ <
// hasanta (conjunct). ং ঃ ঁ only go into the secondary key. Digit runs compare
// numerically and sort before letters; Bengali sorts before Latin.

const COL_VOWELS = ['অ', 'আ', 'ই', 'ঈ', 'উ', 'ঊ', 'ঋ', 'ৠ', 'ঌ', 'ৡ', 'এ', 'ঐ', 'ও', 'ঔ'];
const COL_CONS = [
  'ক', 'খ', 'গ', 'ঘ', 'ঙ', 'চ', 'ছ', 'জ', 'ঝ', 'ঞ', 'ট', 'ঠ', 'ড', `ড${NUKTA}`, 'ঢ', `ঢ${NUKTA}`, 'ণ',
  'ত', 'ৎ', 'থ', 'দ', 'ধ', 'ন', 'প', 'ফ', 'ব', 'ভ', 'ম', 'য', `য${NUKTA}`, 'র', 'ল', 'শ', 'ষ', 'স', 'হ',
];
const COL_SLOTS = ['', 'া', 'ি', 'ী', 'ু', 'ূ', 'ৃ', 'ৄ', 'ে', 'ৈ', 'ো', 'ৌ', HASANTA];
const COL_MARKS = new Map([['ং', 1], ['ঃ', 2], ['ঁ', 3]]);
const W_SEP = '\u0001';
const W_SPACE = '\u0002';
const W_NUM = '\u0003';
const W_OTHER = '\u{0F00}';
const chr = (n) => String.fromCharCode(n);
const VOWEL_W = new Map(COL_VOWELS.map((c, i) => [c, chr(0x100 + i)]));
const CONS_W = new Map(COL_CONS.map((c, i) => [c, chr(0x140 + i)]));
const SLOT_W = new Map(COL_SLOTS.map((c, i) => [c, chr(0x10 + i)]));
const COL_ALIAS = new Map([['ৰ', 'র'], ['ৱ', 'ব']]);

function digitValue(c) {
  const n = c.charCodeAt(0);
  if (n >= 48 && n <= 57) return n - 48;
  if (n >= 0x09E6 && n <= 0x09EF) return n - 0x09E6;
  return -1;
}

function collationParts(s) {
  const chars = Array.from(stripLatinMarks(stripJoiners(nfc(s), false).toLowerCase()));
  let prim = '';
  const marks = [];
  let gap = false;
  const unit = (w) => {
    if (gap && prim) { prim += W_SPACE; marks.push(0); }
    gap = false;
    prim += w;
    marks.push(0);
  };
  for (let i = 0; i < chars.length; i++) {
    const c = COL_ALIAS.get(chars[i]) || chars[i];
    if (digitValue(c) >= 0) {
      let digits = '';
      while (i < chars.length && digitValue(chars[i]) >= 0) digits += digitValue(chars[i++]);
      i--;
      digits = digits.replace(/^0+(?=\d)/, '');
      unit(W_NUM + chr(0x30 + Math.min(digits.length, 0x7000)) + digits);
    } else if (VOWEL_W.has(c)) {
      unit(VOWEL_W.get(c));
    } else if (CONS_W.has(c)) {
      const withNukta = chars[i + 1] === NUKTA ? c + NUKTA : c;
      if (withNukta !== c) i++;
      unit(CONS_W.get(withNukta) || CONS_W.get(c));
      if (c === 'ৎ') continue;
      const next = chars[i + 1];
      if (next !== undefined && next !== '' && SLOT_W.has(next)) {
        prim += SLOT_W.get(next);
        i++;
      } else {
        prim += SLOT_W.get('');
      }
    } else if (COL_MARKS.has(c)) {
      if (marks.length) marks[marks.length - 1] = marks[marks.length - 1] * 4 + COL_MARKS.get(c);
    } else if (c >= 'a' && c <= 'z') {
      unit(chr(0x200 + c.charCodeAt(0) - 97));
    } else if (/[\p{L}\p{N}]/u.test(c)) {
      unit(W_OTHER + c);
    } else if (!/[\p{M}ঽ]/u.test(c)) {
      gap = true; // spaces and punctuation separate words; stray signs are ignored
    }
  }
  return { prim, sec: marks.map((m) => chr(0x30 + m)).join('') };
}

/**
 * A string whose plain `<` order is Bengali dictionary order (ties broken by
 * the NFC text, so the order is total). Usable as an IndexedDB index key.
 * @param {string} s
 * @returns {string}
 */
export function sortKey(s) {
  const { prim, sec } = collationParts(s);
  return prim + W_SEP + sec + W_SEP + nfc(s);
}

const sortKeyCache = new Map();
function cachedSortKey(s) {
  const k = String(s ?? '');
  let v = sortKeyCache.get(k);
  if (v === undefined) {
    if (sortKeyCache.size > 20000) sortKeyCache.clear();
    v = sortKey(k);
    sortKeyCache.set(k, v);
  }
  return v;
}

/**
 * Comparator for Array.prototype.sort in Bengali dictionary order.
 * @returns {number} negative, 0 or positive
 */
export function compareBn(a, b) {
  const x = cachedSortKey(a);
  const y = cachedSortKey(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Transliteration (Bengali -> Banglish) and a phonetic key for matching the
// many ways people spell Bengali in Latin letters.

const TR_CONS = new Map([
  ['ক', 'k'], ['খ', 'kh'], ['গ', 'g'], ['ঘ', 'gh'], ['ঙ', 'ng'], ['চ', 'ch'], ['ছ', 'chh'], ['জ', 'j'],
  ['ঝ', 'jh'], ['ঞ', 'n'], ['ট', 't'], ['ঠ', 'th'], ['ড', 'd'], [`ড${NUKTA}`, 'r'], ['ঢ', 'dh'],
  [`ঢ${NUKTA}`, 'rh'], ['ণ', 'n'], ['ত', 't'], ['ৎ', 't'], ['থ', 'th'], ['দ', 'd'], ['ধ', 'dh'], ['ন', 'n'],
  ['প', 'p'], ['ফ', 'f'], ['ব', 'b'], ['ভ', 'bh'], ['ম', 'm'], ['য', 'j'], [`য${NUKTA}`, 'y'], ['র', 'r'],
  ['ৰ', 'r'], ['ল', 'l'], ['শ', 'sh'], ['ষ', 'sh'], ['স', 's'], ['হ', 'h'], ['ৱ', 'w'],
]);
const TR_VOWEL = new Map([
  ['অ', 'o'], ['আ', 'a'], ['ই', 'i'], ['ঈ', 'i'], ['উ', 'u'], ['ঊ', 'u'], ['ঋ', 'ri'], ['ৠ', 'ri'],
  ['ঌ', 'li'], ['এ', 'e'], ['ঐ', 'oi'], ['ও', 'o'], ['ঔ', 'ou'],
]);
const TR_SIGN = new Map([
  ['া', 'a'], ['ি', 'i'], ['ী', 'i'], ['ু', 'u'], ['ূ', 'u'], ['ৃ', 'ri'], ['ৄ', 'ri'], ['ে', 'e'],
  ['ৈ', 'oi'], ['ো', 'o'], ['ৌ', 'ou'],
]);
const TR_MARK = new Map([['ং', 'ng'], ['ঃ', ''], ['ঁ', '']]);

// Split a Bengali word into units: { v } for an independent vowel, or
// { cons: [letters], sign } for a consonant cluster with its vowel sign.
function bnUnits(chars) {
  const units = [];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (TR_VOWEL.has(c)) { units.push({ v: TR_VOWEL.get(c) }); continue; }
    if (TR_MARK.has(c)) { if (units.length) (units[units.length - 1].tail ??= []).push(TR_MARK.get(c)); continue; }
    if (!TR_CONS.has(c)) continue;
    const cons = [];
    for (;;) {
      let letter = chars[i];
      if (chars[i + 1] === NUKTA) { letter += NUKTA; i++; }
      // র‍্য: the ZWJ marks ya-phala on র (র‍্যাব = ryab), not reph + য (সূর্য = surjo).
      if (letter === 'র' && chars[i + 1] === ZWJ) { letter = 'র' + ZWJ; i++; }
      cons.push(letter);
      if (chars[i + 1] === HASANTA && TR_CONS.has(chars[i + 2])) { i += 2; continue; }
      if (chars[i + 1] === HASANTA) i++;
      break;
    }
    const u = { cons, sign: null };
    if (TR_SIGN.has(chars[i + 1])) u.sign = TR_SIGN.get(chars[++i]);
    units.push(u);
  }
  return units;
}

function clusterLatin(cons, wordStart) {
  let out = '';
  for (let k = 0; k < cons.length; k++) {
    const c = cons[k];
    const prev = cons[k - 1];
    if (c === 'ষ' && prev === 'ক') { out = out.slice(0, -1) + (wordStart && k === 1 ? 'kh' : 'kkh'); continue; }
    if (c === 'ঞ' && prev === 'জ') { out = out.slice(0, -1) + 'gy'; continue; }
    if (k > 0 && c === 'য') { out += prev === 'র' ? 'j' : 'y'; continue; }
    if (k > 0 && c === 'ব' && prev !== 'ম' && prev !== 'ব') continue; // ব-ফলা is silent
    if (c === 'ঙ' && /^[কখগঘ]/.test(cons[k + 1] || '')) { out += 'n'; continue; }
    out += TR_CONS.get(c) ?? TR_CONS.get(c[0]) ?? '';
  }
  return out;
}

// Inherent-vowel ("o") rules: kept word-initially, after conjuncts and before
// conjuncts; dropped word-finally and in the common V-C-CV pattern (বাদশাহ ->
// badshah, জোছনা -> jochna, আহমেদ -> ahmed).
function inherentVowel(units, i) {
  const u = units[i];
  const last = units.length - 1;
  const conj = u.cons.length > 1;
  if (i === last) return conj ? 'o' : '';
  if (i === 0 || conj) return 'o';
  const prev = units[i - 1];
  const next = units[i + 1];
  if (next.cons && next.cons.length > 1) return 'o';
  const nextBareFinal = i + 1 === last && next.cons && !next.sign;
  if ((prev.v || prev.sign) && !nextBareFinal) return '';
  if (prev.cons && !prev.sign && prev.out === 'o' && i - 1 > 0) return '';
  return 'o';
}

function translitWord(word) {
  const units = bnUnits(Array.from(word));
  let out = '';
  units.forEach((u, i) => {
    if (u.v) u.out = u.v;
    else {
      u.out = u.sign ?? inherentVowel(units, i);
      out += clusterLatin(u.cons, i === 0);
    }
    out += u.out + (u.tail ? u.tail.join('') : '');
  });
  return out;
}

const BN_RUN = /[\u{0980}-\u{09FF}\u{200D}]+/gu;

/**
 * Bengali -> lowercase Latin (Banglish), e.g. 'শঙ্খনীল কারাগার' -> 'shonkhonil karagar'.
 * Latin text passes through lowercased; Bengali digits become ASCII.
 * @param {string} s
 * @returns {string}
 */
export function translit(s) {
  const t = toAsciiDigits(stripJoiners(nfc(s), true));
  return stripLatinMarks(t.replace(BN_RUN, (w) => translitWord(w))).toLowerCase();
}

const PH_STEPS = [
  [/x/g, 'ks'], [/q/g, 'k'], [/z/g, 'j'], [/v/g, 'bh'], [/w/g, 'o'], [/ph/g, 'f'],
  [/k+(?:sh|kh)/g, 'k'], [/chh?/g, 's'], [/sh/g, 's'], [/ts/g, 's'], [/c/g, 's'],
  [/([kgjtdbr])h/g, '$1'], [/ng(?=[kg])/g, 'n'],
  [/ee/g, 'i'], [/oo/g, 'u'], [/o/g, 'a'], [/y$/, 'i'], [/y/g, ''], [/(.)\1+/g, '$1'],
];

function phonWord(w) {
  let s = w.replace(/[^a-z0-9]/g, '');
  for (const [re, to] of PH_STEPS) s = s.replace(re, to);
  // A word-final a/o is the (often unwritten) inherent vowel.
  if (s.length >= 3 && s.endsWith('a')) s = s.slice(0, -1);
  return s;
}

/** Phonetic keys of the words of a Latin or Bengali string. @returns {string[]} */
export function phoneticWords(s) {
  return translit(s).split(/[^a-z0-9]+/).map(phonWord).filter(Boolean);
}

/**
 * Spelling-robust key for Banglish and Bengali alike: 'jochna', 'josna',
 * 'jyotsna' and 'জোছনা' share a key. Words are joined without spaces.
 * @param {string} s
 * @returns {string}
 */
export function phoneticKey(s) {
  return phoneticWords(s).join('');
}

// ---------------------------------------------------------------------------
// Fuzzy similarity. Strings are compared with a weighted edit distance over
// their match keys: a vowel sign weighs half a letter, look-alike and
// sound-alike letters substitute cheaply, and every word has to find a
// counterpart in the other string, so different titles that share most of
// their words ('শুভ্র গেছে বনে' / 'সবাই গেছে বনে') stay clearly apart.

const BN_SIGNS = new Set(['া', 'ি', 'ু', 'ৃ', 'ে', 'ৈ', 'ো', 'ৌ']);
const BN_IND = new Set(['অ', 'আ', 'ই', 'উ', 'ঋ', 'ঌ', 'এ', 'ঐ', 'ও', 'ঔ']);
const VOWEL_GROUP = new Map([
  ['অ', 'o'], ['আ', 'a'], ['া', 'a'], ['ই', 'i'], ['ি', 'i'], ['উ', 'u'], ['ু', 'u'], ['ঋ', 'r'], ['ৃ', 'r'],
  ['এ', 'e'], ['ে', 'e'], ['ঐ', 'y'], ['ৈ', 'y'], ['ও', 'o'], ['ো', 'o'], ['ঔ', 'w'], ['ৌ', 'w'],
]);
// Cheap substitutions: aspirated/plain, dental/retroflex, same sound (জ/য,
// র/ড়), letters Bengali OCR confuses, and their Banglish counterparts.
const NEAR_PAIRS = [
  'কখ', 'গঘ', 'চছ', 'জঝ', 'টঠ', 'ডঢ', 'তথ', 'দধ', 'পফ', 'বভ', 'তট', 'থঠ', 'দড', 'ধঢ', 'জয', 'রড',
  'বর', 'ভত', 'মশ', 'যশ', 'খথ', 'ধব', 'পগ', 'ঘয', 'ংন', 'ংম', 'td', 'kg', 'pb', 'pf', 'bf', 'sj', 'rl', 'nm', 'dr',
];
const NEAR = new Set(NEAR_PAIRS.flatMap((p) => {
  const [a, b] = Array.from(p);
  return [a + b, b + a];
}));

function charInfo(c) {
  if (BN_SIGNS.has(c)) return { w: 0.5, kind: 'S', vg: VOWEL_GROUP.get(c) };
  if (BN_IND.has(c)) return { w: 1, kind: 'V', vg: VOWEL_GROUP.get(c) };
  if ('aeiou'.includes(c)) return { w: 0.5, kind: 'L' };
  if (c === 'ং' || c === 'h') return { w: 0.5, kind: 'C' };
  return { w: 1, kind: 'C' };
}

function computeSub(a, b, A, B) {
  if (A.kind === 'S' && B.kind === 'S') return 0.35;
  if (A.kind === 'L' && B.kind === 'L') return 0.3;
  const vowelA = A.kind === 'S' || A.kind === 'V';
  const vowelB = B.kind === 'S' || B.kind === 'V';
  if (vowelA && vowelB) return A.vg === B.vg ? 0.25 : 0.5;
  if (A.kind === 'C' && B.kind === 'C' && NEAR.has(a + b)) return 0.5;
  return Math.max(A.w, B.w);
}

const CH_ID = new Map();
const CH_CHAR = [];
const CH_INFO = [];
const SUB_TABLE = new Float32Array(256 * 256).fill(-1);

function chId(c) {
  let id = CH_ID.get(c);
  if (id === undefined) {
    id = CH_CHAR.length;
    CH_ID.set(c, id);
    CH_CHAR.push(c);
    CH_INFO.push(charInfo(c));
  }
  return id;
}

function subCost(x, y) {
  if (x === y) return 0;
  if (x < 256 && y < 256) {
    const k = (x << 8) | y;
    let v = SUB_TABLE[k];
    if (v < 0) v = SUB_TABLE[k] = computeSub(CH_CHAR[x], CH_CHAR[y], CH_INFO[x], CH_INFO[y]);
    return v;
  }
  return computeSub(CH_CHAR[x], CH_CHAR[y], CH_INFO[x], CH_INFO[y]);
}

/** A string prepared for edit distance: char ids, indel weights, total weight. */
function seq(str) {
  const chars = Array.from(str);
  const ids = new Int32Array(chars.length);
  const w = new Float32Array(chars.length);
  // A Bengali vowel sign or ং cannot begin or end a matched stretch.
  const mid = new Uint8Array(chars.length + 1);
  let sum = 0;
  for (let i = 0; i < chars.length; i++) {
    ids[i] = chId(chars[i]);
    w[i] = CH_INFO[ids[i]].w;
    mid[i] = CH_INFO[ids[i]].kind === 'S' || chars[i] === 'ং' ? 1 : 0;
    sum += w[i];
  }
  return { str, ids, w, mid, sum };
}

let rowA = new Float64Array(64);
let rowB = new Float64Array(64);
let rowC = new Float64Array(64);

/**
 * Weighted optimal-string-alignment distance between prepared strings. With
 * `free`, `a` is aligned against the best-matching substring of `b` that
 * starts and ends on a letter boundary.
 */
function editDistance(a, b, transCost, free) {
  const n = a.ids.length;
  const m = b.ids.length;
  if (rowA.length <= m) {
    const size = Math.max(m + 1, rowA.length * 2);
    rowA = new Float64Array(size);
    rowB = new Float64Array(size);
    rowC = new Float64Array(size);
  }
  let p2 = rowA;
  let p1 = rowB;
  let cur = rowC;
  p1[0] = 0;
  for (let j = 1; j <= m; j++) p1[j] = free && !b.mid[j] ? 0 : p1[j - 1] + b.w[j - 1];
  for (let i = 1; i <= n; i++) {
    const ai = a.ids[i - 1];
    const wa = a.w[i - 1];
    cur[0] = p1[0] + wa;
    for (let j = 1; j <= m; j++) {
      const bj = b.ids[j - 1];
      let v = p1[j - 1] + subCost(ai, bj);
      const del = p1[j] + wa;
      if (del < v) v = del;
      const ins = cur[j - 1] + b.w[j - 1];
      if (ins < v) v = ins;
      if (i > 1 && j > 1 && ai !== bj && ai === b.ids[j - 2] && a.ids[i - 2] === bj) {
        const t = p2[j - 2] + transCost;
        if (t < v) v = t;
      }
      cur[j] = v;
    }
    const t = p2;
    p2 = p1;
    p1 = cur;
    cur = t;
  }
  if (!free) return p1[m];
  let best = Infinity;
  for (let j = 0; j <= m; j++) if (p1[j] < best && !b.mid[j]) best = p1[j];
  return best;
}

// Consonant skeleton (vowel signs and Latin vowels dropped): catches
// misspellings that swap letters around a vowel (দিত্বিয় / দ্বিতীয়).
const SKELETON_DROP = /[ািুৃেৈোৌংaeiou]/gu;

function space(words) {
  const toks = words.map((wd) => {
    const t = seq(wd);
    const sk = wd.replace(SKELETON_DROP, '');
    t.skel = Array.from(sk).length >= 3 ? seq(sk) : null;
    return t;
  });
  const all = seq(words.join(''));
  all.skel = seq(all.str.replace(SKELETON_DROP, ''));
  return { all, toks, key: all.str };
}

const LETTER_NAMES = {
  a: 'এ', b: 'বি', c: 'সি', d: 'ডি', e: 'ই', f: 'এফ', g: 'জি', h: 'এইচ', i: 'আই', j: 'জে', k: 'কে', l: 'এল', m: 'এম',
  n: 'এন', o: 'ও', p: 'পি', q: 'কিউ', r: 'আর', s: 'এস', t: 'টি', u: 'ইউ', v: 'ভি', w: 'ডাবলিউ', x: 'এক্স', y: 'ওয়াই', z: 'জেড',
};

// 'PhD' inside a Bengali title is read the Bengali way: পিএইচডি.
function expandAcronyms(s) {
  return s.replace(/[A-Za-z][A-Za-z.]*/g, (m) => {
    const letters = m.replace(/\./g, '');
    const upper = letters.replace(/[^A-Z]/g, '').length;
    if (letters.length > 6 || !(upper === letters.length || upper >= 2)) return m;
    return Array.from(letters.toLowerCase(), (c) => LETTER_NAMES[c]).join('');
  });
}

const ORDINALS = new Map(['প্রথম', 'দ্বিতীয়', 'তৃতীয়', 'চতুর্থ', 'পঞ্চম', 'ষষ্ঠ', 'সপ্তম', 'অষ্টম', 'নবম', 'দশম']
  .map((w, i) => [searchKey(w), i + 1]));

function numbersOf(words) {
  const out = new Set();
  for (const w of words) {
    if (/^\d+$/.test(w)) out.add(Number(w));
    else if (ORDINALS.has(w)) out.add(ORDINALS.get(w));
  }
  return out;
}

// Two-generation cache: entries used on every call (library titles) survive,
// one-off strings (OCR spans, queries) age out.
let featNew = new Map();
let featOld = new Map();
const FEATURE_CACHE = 4000;

/**
 * Precomputed comparison data for a string (cached). Exposed for matcher.js.
 * @param {string} s
 */
export function textFeatures(s) {
  const raw = String(s ?? '');
  let f = featNew.get(raw);
  if (f) return f;
  f = featOld.get(raw);
  if (!f) {
    const n = stripLatinMarks(nfc(raw));
    const hasBn = /[\u{0980}-\u{09FF}]/u.test(n);
    const hasLat = /[a-z]/i.test(n);
    let bnWords = null;
    if (!hasLat) bnWords = tokens(raw);
    else if (hasBn) {
      const expanded = expandAcronyms(n);
      if (!/[a-z]/i.test(expanded)) bnWords = tokens(expanded);
    }
    f = {
      raw,
      key: searchKey(raw),
      script: hasBn ? (hasLat ? 'mixed' : 'bn') : hasLat ? 'latn' : 'none',
      bn: bnWords && space(bnWords),
      ph: null,
      nums: numbersOf(tokens(raw)),
    };
  }
  if (featNew.size >= FEATURE_CACHE) {
    featOld = featNew;
    featNew = new Map();
  }
  featNew.set(raw, f);
  return f;
}

function phSpace(f) {
  if (!f.ph) f.ph = space(phoneticWords(f.raw));
  return f.ph;
}

const SHORT_KEY = 3;          // keys this short ('নি', 'ভয়', 'কবি') only match exactly
const WORD_MATCH = 0.5;       // a word scoring below this has no counterpart
const SHORT_WORD_MATCH = 0.65; // ...stricter for words of <= 4 letter weights
const MISSING_WORD_CAP = 0.7; // ...and then the strings cannot be the same title
const NUMBER_CAP = 0.6;       // different volume/part numbers: different books
const CROSS_SCRIPT_CAP = 0.95; // Banglish vs Bengali is never a certain match
const SHORT_WORD = 4;
const AND_WORDS = new Set(['এবং', 'ও', 'ebang', 'a', 'and']);

function wordScore(t, all) {
  if (all.str.includes(t.str)) return 1;
  let sc = 1 - editDistance(t, all, 1, true) / t.sum;
  if (sc < 0.9 && t.skel) {
    sc = Math.max(sc, 0.9 * (1 - editDistance(t.skel, all.skel, 0.5, true) / t.skel.sum));
  }
  return sc;
}

function coverage(A, B) {
  let got = 0;
  let total = 0;
  let miss = false;
  const bHasAnd = B.toks.some((x) => AND_WORDS.has(x.str));
  for (const t of A.toks) {
    total += t.sum;
    let sc = bHasAnd && AND_WORDS.has(t.str) ? 1 : wordScore(t, B.all);
    if (sc < (t.sum <= SHORT_WORD ? SHORT_WORD_MATCH : WORD_MATCH)) {
      if (t.sum >= 1.5) miss = true;
      sc = 0;
    }
    got += sc * t.sum;
  }
  return { cov: total ? got / total : 0, miss };
}

function spaceSimilarity(A, B) {
  if (!A.key || !B.key) return 0;
  if (A.key === B.key) return 1;
  if (Math.min(A.all.ids.length, B.all.ids.length) <= SHORT_KEY) return 0;
  const charSim = Math.max(0, 1 - editDistance(A.all, B.all, 1, false) / Math.max(A.all.sum, B.all.sum));
  const ab = coverage(A, B);
  const ba = coverage(B, A);
  // Mostly the weaker direction, so one title contained in a longer one scores low.
  const words = (2 * Math.min(ab.cov, ba.cov) + Math.max(ab.cov, ba.cov)) / 3;
  const s = 0.75 * words + 0.25 * charSim;
  return ab.miss || ba.miss ? Math.min(s, MISSING_WORD_CAP) : s;
}

function sameSet(a, b) {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/**
 * similarity() on precomputed textFeatures (lets matcher.js reuse features).
 * @returns {number} 0..1
 */
export function featureSimilarity(A, B) {
  if (!A.key || !B.key) return 0;
  if (A.key === B.key) return 1;
  let s = A.bn && B.bn ? spaceSimilarity(A.bn, B.bn) : 0;
  if (A.script !== 'bn' || B.script !== 'bn') {
    s = Math.max(s, Math.min(CROSS_SCRIPT_CAP, spaceSimilarity(phSpace(A), phSpace(B))));
  }
  if (A.nums.size && B.nums.size && !sameSet(A.nums, B.nums)) s = Math.min(s, NUMBER_CAP);
  return Math.round(s * 1000) / 1000;
}

/**
 * How likely two titles name the same book, 0..1, symmetric. Spelling
 * variants and spacing differences score >= 0.85; different books that share
 * words stay below 0.75. Bengali vs Banglish is compared phonetically (at
 * most 0.95). Keys of 3 letters or fewer must match exactly.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function similarity(a, b) {
  return featureSimilarity(textFeatures(a), textFeatures(b));
}

/** Minimum searchScore worth showing; searchScore returns 0 below it. */
export const SEARCH_THRESHOLD = 0.35;

function prefixScore(q, t, scale) {
  if (!q.key || !t.key) return 0;
  if (q.key === t.key) return scale;
  if (t.key.startsWith(q.key)) return scale * (0.9 + 0.08 * (q.key.length / t.key.length));
  const words = t.toks.map((x) => x.str);
  if (q.toks.every((w) => words.some((x) => x.startsWith(w)))) return scale * 0.85;
  if (q.key.length >= 2 && t.key.includes(q.key)) return scale * 0.75;
  return 0;
}

function fuzzyScore(q, t) {
  if (q.all.ids.length < 3 || !t.key) return 0;
  const sc = 1 - editDistance(q.all, t.all, 1, true) / q.all.sum;
  return sc >= 0.7 ? 0.35 + (sc - 0.7) : 0;
}

/**
 * Search-as-you-type relevance of `text` for a (possibly partial, Banglish or
 * misspelt) `query`: 1 exact, ~0.9 prefix, 0.85 word prefixes, 0.75
 * substring, lower for phonetic and fuzzy matches; 0 below SEARCH_THRESHOLD.
 * @param {string} query
 * @param {string} text
 * @returns {number}
 */
export function searchScore(query, text) {
  const q = textFeatures(query);
  const t = textFeatures(text);
  if (!q.key || !t.key) return 0;
  let best = 0;
  if (q.bn && t.bn) best = prefixScore(q.bn, t.bn, 1);
  if (best < 0.85) {
    const qp = phSpace(q);
    const tp = phSpace(t);
    if (qp.key.length >= 2) best = Math.max(best, prefixScore(qp, tp, 0.85));
    if (best < SEARCH_THRESHOLD) {
      if (q.bn && t.bn) best = Math.max(best, fuzzyScore(q.bn, t.bn));
      best = Math.max(best, 0.9 * fuzzyScore(qp, tp));
    }
  }
  best = Math.round(best * 1000) / 1000;
  return best >= SEARCH_THRESHOLD ? best : 0;
}
