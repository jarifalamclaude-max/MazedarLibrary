// Turn a typed query or noisy OCR output into ranked book / ideal-list
// candidates. Pure: runs in Node and the browser.
import { textFeatures, featureSimilarity, cleanTitle, similarity, searchKey } from './bangla.js';

/** Score thresholds. Same-book variants score >= 0.85; distinct titles stay < 0.76. */
export const LEVELS = { exact: 0.93, strong: 0.82, possible: 0.6 };

const NOISE = /(প্রকাশ|প্রকাশনী|প্রকাশন|প্রকাশক|পাবলিকেশন|পাবলিশার্স|publication|publisher|prokash|টাকা|৳|মূল্য|দাম|\btk\b|সংস্করণ|মুদ্রণ|isbn|www\.|\.com|বেস্টসেলার|bestseller|অনুবাদ\s*:|প্রচ্ছদ)/i;
const LETTER = /[ঀ-৿A-Za-z]/;
const MAX_SPANS = 160;
const AMBIGUOUS_GAP = 0.04;
// A title found only inside a fragment of a line is never certain: the rest of
// the line may be a garbled part of a longer title ("হিমু" inside a misread
// "হিমু রিমান্ডে"). Fragment-only matches therefore top out at "possible".
const WINDOW_PENALTY = 0.8;

function isAuthorLine(line, authorFeatures) {
  const f = textFeatures(line);
  return authorFeatures.some((a) => featureSimilarity(f, a) >= 0.8);
}

/** Remove an author's name glued onto a line ("হিমু মামা হুমায়ূন আহমেদ" → "হিমু মামা"). */
function stripAuthors(line, authorTokenKeys) {
  const toks = line.split(' ');
  const keys = toks.map((t) => searchKey(t));
  for (const name of authorTokenKeys) {
    if (!name.length) continue;
    for (let i = 0; i + name.length <= keys.length; i += 1) {
      if (name.every((k, j) => k && k === keys[i + j])) {
        toks.splice(i, name.length);
        keys.splice(i, name.length);
        i -= 1;
      }
    }
  }
  return toks.join(' ');
}

/**
 * Candidate title spans. `primary`: whole lines (author names removed),
 * adjacent-line joins and the whole text. `windows`: word runs inside lines.
 */
export function spanSets(text, authorNames = []) {
  const names = authorNames.filter(Boolean);
  const authorFeatures = names.map((n) => textFeatures(n));
  const authorTokenKeys = names.map((n) => cleanTitle(n).split(' ').map((t) => searchKey(t)));
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((l) => cleanTitle(l))
    .filter((l) => LETTER.test(l));
  const kept = lines
    .filter((l) => !isAuthorLine(l, authorFeatures))
    .map((l) => cleanTitle(stripAuthors(l, authorTokenKeys)))
    .filter((l) => LETTER.test(l));
  const useful = kept.filter((l) => !NOISE.test(l));
  const noisy = kept.filter((l) => NOISE.test(l)); // publisher/price lines: fragments only
  const primary = new Set();
  const windows = new Set();
  const ok = (c) => c && LETTER.test(c) && c.length <= 140;
  const addP = (x) => { const c = cleanTitle(x); if (ok(c)) primary.add(c); };
  useful.forEach((l, i) => {
    addP(l);
    if (i + 1 < useful.length) addP(`${l} ${useful[i + 1]}`);
    if (i + 2 < useful.length) addP(`${l} ${useful[i + 1]} ${useful[i + 2]}`);
  });
  if (useful.length > 1) addP(useful.join(' '));
  // Word windows inside each line (OCR often glues title + noise together).
  for (const l of [...useful, ...noisy]) {
    const toks = l.split(' ');
    if (toks.length < 2) continue;
    for (let a = 0; a < toks.length; a += 1) {
      for (let b = a + 1; b <= Math.min(toks.length, a + 9); b += 1) {
        if (b - a === toks.length) continue;
        const w = cleanTitle(toks.slice(a, b).join(' '));
        if (ok(w) && !primary.has(w) && !isAuthorLine(w, authorFeatures)) windows.add(w);
      }
    }
  }
  const p = [...primary].slice(0, MAX_SPANS);
  return { primary: p, windows: [...windows].slice(0, Math.max(0, MAX_SPANS - p.length)) };
}

/** All candidate spans (primary first). */
export function spansOf(text, authorNames = []) {
  const { primary, windows } = spanSets(text, authorNames);
  return [...primary, ...windows];
}

function keyLen(f) {
  return f.key.length;
}

function bestSpanScore(titleF, spanFs, penalty = 1) {
  const L = keyLen(titleF);
  let best = 0;
  for (const s of spanFs) {
    const l = keyLen(s);
    if (L <= 3 ? l !== L : l < L * 0.55 || l > L * 1.8 + 2) continue; // cheap length gate
    const sc = featureSimilarity(s, titleF);
    if (sc > best) {
      best = sc;
      if (best >= 1) break;
    }
  }
  return best * penalty;
}

function scoreTitle(title, spans) {
  const f = textFeatures(title);
  const p = bestSpanScore(f, spans.primary);
  if (p >= 1) return 1;
  return Math.max(p, bestSpanScore(f, spans.windows, WINDOW_PENALTY));
}

export function levelOf(score) {
  if (score >= LEVELS.exact) return 'exact';
  if (score >= LEVELS.strong) return 'strong';
  if (score >= LEVELS.possible) return 'possible';
  return 'none';
}

/**
 * Rank the library's books and not-yet-owned ideal-list entries against text.
 * A book and the list entry it is linked to are one candidate (the book).
 * @param {string} text  typed query or OCR output (multi-line, noisy)
 * @param {{books?: object[], catalog?: object[], authors?: object[]}} lib
 * @param {{limit?: number}} [opts]
 * @returns {{candidates: {kind:'book'|'catalog', id:string, title:string, authorName:string, score:number, catalogId?:string|null}[],
 *   best: object|null, level: 'exact'|'strong'|'possible'|'none'}}
 */
export function matchText(text, { books = [], catalog = [], authors = [] } = {}, { limit = 5 } = {}) {
  const authorName = new Map(authors.map((a) => [a.id, a.name]));
  const sets = spanSets(text, authors.filter((a) => !a.deleted).map((a) => a.name));
  if (!sets.primary.length && !sets.windows.length) return { candidates: [], best: null, level: 'none' };
  const spans = { primary: sets.primary.map((x) => textFeatures(x)), windows: sets.windows.map((x) => textFeatures(x)) };

  const linked = new Set();
  const cands = [];
  for (const b of books) {
    if (!b || b.deleted || !b.title) continue;
    if (b.catalogId) linked.add(b.catalogId);
    cands.push({ kind: 'book', id: b.id, title: b.title, authorName: authorName.get(b.authorId) || '', catalogId: b.catalogId || null, score: scoreTitle(b.title, spans) });
  }
  for (const e of catalog) {
    if (!e || e.deleted || !e.title || linked.has(e.id)) continue;
    cands.push({ kind: 'catalog', id: e.id, title: e.title, authorName: authorName.get(e.authorId) || '', score: scoreTitle(e.title, spans) });
  }
  // Ties: the longer title explains more of the text; then books before list entries.
  cands.sort((a, b) => b.score - a.score || searchKey(b.title).length - searchKey(a.title).length
    || (a.kind === b.kind ? 0 : a.kind === 'book' ? -1 : 1) || (a.title < b.title ? -1 : 1));
  const candidates = cands.filter((c) => c.score >= LEVELS.possible * 0.85).slice(0, limit);
  const top = candidates[0] && candidates[0].score >= LEVELS.possible ? candidates[0] : null;
  let level = top ? levelOf(top.score) : 'none';
  // Two different titles nearly tied: never claim certainty, let the user pick.
  if (top && level !== 'possible') {
    const topKey = searchKey(top.title);
    // A rival that is only part of the winning title ("হিমু" inside "হিমু মামা") is no rival.
    const rival = candidates.find((c) => c !== top && similarity(c.title, top.title) < LEVELS.strong && !topKey.includes(searchKey(c.title)));
    if (rival && rival.score >= LEVELS.strong && top.score - rival.score < AMBIGUOUS_GAP) level = 'possible';
  }
  return { candidates, best: top, level };
}

const EXPLAIN = {
  exact: 'হুবহু মিলেছে',
  strong: 'প্রায় নিশ্চিতভাবে মিলেছে',
  possible: 'মিল থাকতে পারে — দেখে নিন',
  none: 'কিছুই মেলেনি',
};

export function explainLevel(level) {
  return EXPLAIN[level] || EXPLAIN.none;
}
