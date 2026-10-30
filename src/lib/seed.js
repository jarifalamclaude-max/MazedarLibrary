// Deterministic seed: identical on every device, stamped with SEED_STAMP so any
// edit made anywhere always wins over it, and never pushed to the cloud.
import { SEED_STAMP } from './clock.js';
import {
  HUMAYUN_AUTHOR_ID, HUMAYUN_NAME, HUMAYUN_CATALOG, HUMAYUN_OWNED, SEED_VERSION, categoryForCatalogEntry,
} from '../data/humayun.js';

export { SEED_VERSION };

// 30 Oct 2026 (UTC): when the owner's list was entered. Seeds keep the owner's order.
const SEEDED_AT = Date.UTC(2026, 9, 30);

const tidy = (s) => String(s).normalize('NFC').trim().replace(/\s+/g, ' ');

function stamped(rec) {
  const _v = {};
  for (const k of Object.keys(rec)) if (k !== 'id' && k !== 'kind') _v[k] = SEED_STAMP;
  return { ...rec, _v };
}

export function buildSeedRecords() {
  const out = [];
  out.push(stamped({ id: HUMAYUN_AUTHOR_ID, kind: 'author', name: HUMAYUN_NAME, note: '', deleted: false }));

  const byId = new Map();
  for (const e of HUMAYUN_CATALOG) {
    byId.set(e.id, e);
    out.push(stamped({
      id: e.id,
      kind: 'catalog',
      authorId: HUMAYUN_AUTHOR_ID,
      title: tidy(e.title),
      group: e.group,
      year: e.year,
      yearDisputed: e.yearDisputed,
      note: e.note,
      order: e.order,
      deleted: false,
    }));
  }

  for (const [serial, typed, catalogId, over = {}] of HUMAYUN_OWNED) {
    const entry = byId.get(catalogId);
    out.push(stamped({
      id: `b_h${String(serial).padStart(3, '0')}`,
      kind: 'book',
      title: tidy(over.title ?? typed),
      authorId: HUMAYUN_AUTHOR_ID,
      category: over.category ?? categoryForCatalogEntry(entry),
      publisher: '',
      isbn: '',
      copies: 1,
      notes: '',
      favorite: false,
      readStatus: '',
      catalogId,
      serial,
      originalEntry: typed,
      addedVia: 'seed',
      hasCover: false,
      createdAt: SEEDED_AT + serial,
      deleted: false,
      deletedAt: null,
    }));
  }
  return out;
}
