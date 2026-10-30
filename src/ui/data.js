// Derived views of the library (pure, recomputed when the store changes) and
// the user actions that edit it. Nothing is ever hard-deleted: delete = trash,
// "delete forever" = hidden tombstone, so no device can resurrect or lose data.
import { sortKey, searchKey, searchScore, similarity, SEARCH_THRESHOLD } from '../lib/bangla.js';
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
  for (const r of records.values()) {
    if (r.kind === 'settings') {
      settings = { ...DEFAULT_SETTINGS, ...r };
      continue;
    }
    if (r.deleted) {
      if (!r.purged && (r.kind === 'book' || r.kind === 'author' || r.kind === 'catalog')) trash.push(r);
      continue;
    }
    if (r.kind === 'author') authors.push(r);
    else if (r.kind === 'book') books.push(r);
    else if (r.kind === 'catalog') catalog.push(r);
  }

  const authorById = new Map(authors.map((a) => [a.id, a]));
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
      b.isbn && q.replace(/[^0-9xX]/g, '').length >= 6 && b.isbn.replace(/[^0-9xX]/g, '').includes(q.replace(/[^0-9xX]/g, '')) ? 1 : 0,
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
  return put({ id: newId('a'), kind: 'author', name: clean, note: '', deleted: false, createdAt: Date.now() });
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
  const items = [{ id: rec.id, deleted: false, deletedAt: null, purged: false, deletedWith: null }];
  if (rec.kind === 'author') {
    for (const r of lib.records.values()) {
      if (r.deleted && r.deletedWith === rec.id) items.push({ id: r.id, deleted: false, deletedAt: null, purged: false, deletedWith: null });
    }
  } else if (rec.authorId) {
    const author = lib.records.get(rec.authorId);
    if (author?.deleted) items.push({ id: author.id, deleted: false, deletedAt: null, purged: false });
  }
  await ctx.store.putMany('records', items);
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
