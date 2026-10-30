// Bengali text utilities: display cleanup, match keys, dictionary collation,
// Banglish transliteration and fuzzy similarity. Pure functions: no DOM, no
// Intl/ICU dependence, identical results in Node and every browser.

const ZWJ = '‍';
const HASANTA = '্';
const NUKTA = '়';
const DROP_ALWAYS = new Set(['​', '‌', '﻿', '­', '⁠']);

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
  return String(s ?? '').replace(/[০-৯]/g, (d) => String.fromCharCode(48 + d.charCodeAt(0) - 0x09E6));
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
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').normalize('NFC');
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

const WORD_SPLIT = /[^\p{L}\p{M}\p{Nd}‌‍]+/u;

/**
 * Words of a string (split on spaces and punctuation), each as its searchKey.
 * @param {string} s
 * @returns {string[]}
 */
export function tokens(s) {
  return nfc(s).split(WORD_SPLIT).map(searchKey).filter(Boolean);
}
