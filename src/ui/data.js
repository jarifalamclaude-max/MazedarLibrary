// Derived views of the library (pure, recomputed when the store changes) and
// the user actions that edit it. Nothing is ever hard-deleted: delete = trash,
// "delete forever" = hidden tombstone, so no device can resurrect or lose data.
import { sortKey, searchKey, searchScore, similarity, toAsciiDigits, SEARCH_THRESHOLD } from '../lib/bangla.js';
import { LEVELS } from '../lib/matcher.js';
import { newId } from '../lib/store.js';
import { HUMAYUN_AUTHOR_ID, HUMAYUN_GROUPS, categoryForCatalogEntry } from '../data/humayun.js';
import { ctx, useStoreVersion } from './core.js';

export { HUMAYUN_AUTHOR_ID, categoryForCatalogEntry };

let libCache = { v: -1, lib: null };
/** Derived library for the current store version (computed once per change). */
export function getLib() {
  const v = ctx.store.version;
  if (libCache.v !== v || !libCache.lib) libCache = { v, lib: derive(ctx.store.records) };
  return libCache.lib;
}

/** Hook: the derived library, re-rendering on every store change. */
export function useLib() {
  useStoreVersion();
  return getLib();
}

export const LATER_GROUP = { id: 'g14', name: 'পরে যোগ করা', label: 'নতুন', order: 14 };
export const GROUPS = [...HUMAYUN_GROUPS, LATER_GROUP];
export const groupById = new Map(GROUPS.map((g) => [g.id, g]));

export const DEFAULT_SETTINGS = { geminiApiKey: '', geminiModel: '', autoSaveExact: false, scanEngine: 'auto' };

const SK = new Map();
export function sortKeyOf(s) {
  const str = s || '';
  let k = SK.get(str);
  if (k === undefined) {
    k = sortKey(str);
    if (SK.size > 5000) SK.clear();
    SK.set(str, k);
  }
  return k;
}

export const byTitle = (a, b) => (sortKeyOf(a.title) < sortKeyOf(b.title) ? -1 : sortKeyOf(a.title) > sortKeyOf(b.title) ? 1 : 0);
export const byName = (a, b) => (sortKeyOf(a.name) < sortKeyOf(b.name) ? -1 : sortKeyOf(a.name) > sortKeyOf(b.name) ? 1 : 0);

/** Everything the screens need, derived from the raw record map. */
export function derive(records) {
  const authors = [];
  const books = [];
  const catalog = [];
  const trash = [];
  let settings = { ...DEFAULT_SETTINGS };
  const looseBooks = [];
  const looseCatalog = [];
  for (const r of records.values()) {
    if (r.kind === 'settings') {
      settings = { ...DEFAULT_SETTINGS, ...r };
      continue;
    }
    if (r.purged) continue; // deleted forever: hidden everywhere, kept only as a tombstone
    if (r.deleted) {
      if (r.kind === 'book' || r.kind === 'author' || r.kind === 'catalog') trash.push(r);
      continue;
    }
    if (r.kind === 'author') authors.push(r);
    else if (r.kind === 'book') looseBooks.push(r);
    else if (r.kind === 'catalog') looseCatalog.push(r);
  }

  const authorById = new Map(authors.map((a) => [a.id, a]));
  // A book or list entry whose folder was deleted (e.g. on the other phone while
  // this one added to it offline) belongs with its folder in the trash.
  const folderDeleted = (r) => records.get(r.authorId)?.deleted === true;
  for (const r of looseBooks) (folderDeleted(r) ? trash : books).push(r);
  for (const r of looseCatalog) (folderDeleted(r) ? trash : catalog).push(r);
  const booksByAuthor = new Map();
  for (const b of books) {
    if (!booksByAuthor.has(b.authorId)) booksByAuthor.set(b.authorId, []);
    booksByAuthor.get(b.authorId).push(b);
  }
  const catalogByAuthor = new Map();
  const catalogById = new Map();
  for (const e of catalog) {
    catalogById.set(e.id, e);
    if (!catalogByAuthor.has(e.authorId)) catalogByAuthor.set(e.authorId, []);
    catalogByAuthor.get(e.authorId).push(e);
  }
  const ownedByCatalog = new Map();
  for (const b of books) {
    if (b.catalogId && catalogById.has(b.catalogId)) {
      if (!ownedByCatalog.has(b.catalogId)) ownedByCatalog.set(b.catalogId, []);
      ownedByCatalog.get(b.catalogId).push(b);
    }
  }

  const stats = new Map();
  for (const a of authors) {
    const own = booksByAuthor.get(a.id) || [];
    const cat = catalogByAuthor.get(a.id) || [];
    const owned = cat.filter((e) => ownedByCatalog.has(e.id)).length;
    stats.set(a.id, {
      books: own.length,
      copies: own.reduce((n, b) => n + (Number(b.copies) > 0 ? Number(b.copies) : 1), 0),
      catalogTotal: cat.length,
      catalogOwned: owned,
      remaining: cat.length - owned,
      lastAdded: own.reduce((m, b) => Math.max(m, b.createdAt || 0), 0),
    });
  }

  // Likely duplicates: same author and (same ideal-list entry or same title key).
  const dupes = [];
  const seenPair = new Set();
  for (const [authorId, list] of booksByAuthor) {
    const groups = new Map();
    for (const b of list) {
      for (const key of [b.catalogId ? `c:${b.catalogId}` : null, `k:${searchKey(b.title)}`]) {
        if (!key || key === 'k:') continue;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(b);
      }
    }
    for (const g of groups.values()) {
      for (let i = 0; i < g.length; i += 1) {
        for (let j = i + 1; j < g.length; j += 1) {
          const [x, y] = [g[i], g[j]].sort((p, q) => (p.id < q.id ? -1 : 1));
          const pk = `${x.id}|${y.id}`;
          if (seenPair.has(pk)) continue;
          seenPair.add(pk);
          if ((x.notDuplicateOf || []).includes(y.id) || (y.notDuplicateOf || []).includes(x.id)) continue;
          dupes.push({ a: x, b: y, authorId });
        }
      }
    }
  }

  const totals = {
    books: books.length,
    copies: books.reduce((n, b) => n + (Number(b.copies) > 0 ? Number(b.copies) : 1), 0),
    authors: authors.length,
    favorites: books.filter((b) => b.favorite).length,
    read: books.filter((b) => b.readStatus === 'read').length,
  };

  return {
    authors, books, catalog, trash, settings, authorById, booksByAuthor, catalogByAuthor, catalogById,
    ownedByCatalog, stats, dupes, totals, records,
  };
}

/** ISBNs compared as plain digits (Bengali digits and hyphens allowed in either). */
export function isbnDigits(s) {
  return toAsciiDigits(String(s || '')).replace(/[^0-9xX]/g, '').toUpperCase();
}

function isbnMatches(isbn, q) {
  const a = isbnDigits(isbn);
  const b = isbnDigits(q);
  return !!a && b.length >= 6 && a.includes(b);
}

/** Global search across books, authors and not-yet-owned ideal-list entries. */
export function searchLibrary(lib, query) {
  const q = (query || '').trim();
  if (!q) return null;
  const books = [];
  for (const b of lib.books) {
    const author = lib.authorById.get(b.authorId);
    const s = Math.max(
      searchScore(q, b.title),
      b.originalEntry ? searchScore(q, b.originalEntry) * 0.95 : 0,
      author ? searchScore(q, author.name) * 0.85 : 0,
      b.category ? searchScore(q, b.category) * 0.7 : 0,
      b.publisher ? searchScore(q, b.publisher) * 0.7 : 0,
      b.notes ? searchScore(q, b.notes) * 0.6 : 0,
      isbnMatches(b.isbn, q) ? 1 : 0,
    );
    if (s >= SEARCH_THRESHOLD) books.push({ book: b, author, score: s });
  }
  books.sort((x, y) => y.score - x.score || byTitle(x.book, y.book));
  const authors = lib.authors
    .map((a) => ({ author: a, score: searchScore(q, a.name) }))
    .filter((x) => x.score >= SEARCH_THRESHOLD)
    .sort((x, y) => y.score - x.score);
  const missing = [];
  for (const e of lib.catalog) {
    if (lib.ownedByCatalog.has(e.id)) continue;
    const s = searchScore(q, e.title);
    if (s >= SEARCH_THRESHOLD) missing.push({ entry: e, author: lib.authorById.get(e.authorId), score: s });
  }
  missing.sort((x, y) => y.score - x.score);
  return { books: books.slice(0, 80), authors: authors.slice(0, 12), missing: missing.slice(0, 30) };
}

/** Books by the same author that look like the same title (for duplicate warnings). */
export function findSimilarBooks(lib, { authorId, title, catalogId, excludeId }) {
  const t = (title || '').trim();
  if (!t) return [];
  const out = [];
  for (const b of lib.books) {
    if (b.id === excludeId) continue;
    const sameCatalog = catalogId && b.catalogId === catalogId;
    const s = similarity(t, b.title);
    if (sameCatalog || (b.authorId === authorId && s >= LEVELS.strong) || s >= LEVELS.exact) out.push({ book: b, score: sameCatalog ? 1 : s });
  }
  return out.sort((x, y) => y.score - x.score).slice(0, 3);
}

/** Best not-yet-linked ideal-list entry for a title (so the countdown stays exact). */
export function suggestCatalog(lib, authorId, title, { includeOwned = false } = {}) {
  const t = (title || '').trim();
  const entries = lib.catalogByAuthor.get(authorId) || [];
  if (!t || !entries.length) return null;
  let best = null;
  for (const e of entries) {
    if (!includeOwned && lib.ownedByCatalog.has(e.id)) continue;
    const s = similarity(t, e.title);
    if (!best || s > best.score) best = { entry: e, score: s };
  }
  if (!best || best.score < LEVELS.possible) return null;
  best.level = best.score >= LEVELS.exact ? 'exact' : best.score >= LEVELS.strong ? 'strong' : 'possible';
  return best;
}

export function findAuthorByName(lib, name) {
  const k = searchKey(name || '');
  if (!k) return null;
  return lib.authors.find((a) => searchKey(a.name) === k) || null;
}

// ---------------------------------------------------------------- actions
const put = (changes) => ctx.store.put('records', changes);

function hash36(s) {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    h1 = Math.imul(h1 ^ c, 16777619);
    h2 = Math.imul(h2 ^ c, 2246822519);
  }
  return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36);
}

/** Same name → same id on every phone, so a folder created on both phones offline merges into one. */
export function authorIdFor(name) {
  return `a_${hash36(searchKey(name))}`;
}

export async function addAuthor(lib, name) {
  const clean = (name || '').normalize('NFC').trim().replace(/\s+/g, ' ');
  if (!clean) throw new Error('লেখকের নাম লিখুন');
  const existing = findAuthorByName(lib, clean);
  if (existing) return existing;
  const trashed = lib.trash.find((r) => r.kind === 'author' && searchKey(r.name) === searchKey(clean));
  if (trashed) {
    await restoreRecord(lib, trashed);
    return trashed;
  }
  let id = authorIdFor(clean);
  const prior = lib.records.get(id);
  if (prior && !prior.deleted && !prior.purged) id = newId('a'); // that id belongs to a since-renamed folder
  return put({ id, kind: 'author', name: clean, note: '', deleted: false, purged: false, deletedWith: null, createdAt: Date.now() });
}

export async function addBook(fields) {
  const title = (fields.title || '').normalize('NFC').trim().replace(/\s+/g, ' ');
  if (!title) throw new Error('বইয়ের নাম লিখুন');
  if (!fields.authorId) throw new Error('লেখক বেছে নিন');
  return put({
    id: newId('b'),
    kind: 'book',
    category: '',
    publisher: '',
    isbn: '',
    copies: 1,
    notes: '',
    favorite: false,
    readStatus: '',
    catalogId: null,
    serial: null,
    originalEntry: '',
    addedVia: 'manual',
    hasCover: false,
    createdAt: Date.now(),
    deleted: false,
    deletedAt: null,
    ...fields,
    title,
  });
}

export function updateRecord(id, changes) {
  return put({ id, ...changes });
}

export async function trashRecord(lib, rec) {
  const now = Date.now();
  if (rec.kind === 'author') {
    const own = lib.booksByAuthor.get(rec.id) || [];
    const cat = lib.catalogByAuthor.get(rec.id) || [];
    await ctx.store.putMany('records', [
      { id: rec.id, deleted: true, deletedAt: now },
      ...own.map((b) => ({ id: b.id, deleted: true, deletedAt: now, deletedWith: rec.id })),
      ...cat.map((e) => ({ id: e.id, deleted: true, deletedAt: now, deletedWith: rec.id })),
    ]);
    return;
  }
  await put({ id: rec.id, deleted: true, deletedAt: now, deletedWith: null });
}

export async function restoreRecord(lib, rec) {
  const items = new Map();
  const add = (r) => items.set(r.id, { id: r.id, deleted: false, deletedAt: null, purged: false, deletedWith: null });
  add(rec);
  // Restoring anything from a deleted folder brings the whole folder back
  // (except what was deleted forever), so its counter and list come back too.
  const author = rec.kind === 'author' ? rec : rec.authorId ? lib.records.get(rec.authorId) : null;
  if (author && (author.deleted || rec === author)) {
    add(author);
    for (const r of lib.records.values()) {
      if (r.deleted && !r.purged && r.deletedWith === author.id) add(r);
    }
  }
  await ctx.store.putMany('records', [...items.values()]);
}

export function purgeRecord(rec) {
  return put({ id: rec.id, purged: true });
}

export async function addCatalogEntry({ authorId, title, group = '', year = null, note = '' }) {
  const t = (title || '').normalize('NFC').trim().replace(/\s+/g, ' ');
  if (!t) throw new Error('বইয়ের নাম লিখুন');
  return put({
    id: newId('c'), kind: 'catalog', authorId, title: t, group, year, yearDisputed: false, note, order: Date.now(), deleted: false,
  });
}

export function acquireEntry(entry, extra = {}) {
  return addBook({
    title: entry.title,
    authorId: entry.authorId,
    catalogId: entry.id,
    category: categoryForCatalogEntry(entry),
    ...extra,
  });
}

export function updateSettings(changes) {
  return put({ id: 'settings', kind: 'settings', ...changes });
}
