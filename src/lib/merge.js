// Field-level last-writer-wins merge for synced records.
//
// A record is a plain JSON object:
//   { id, kind, ...fields, _v: { [field]: stamp } }
// `id` and `kind` never change. Every other field carries the stamp of the edit
// that last set it. Merging two copies of a record keeps, per field, the value
// with the greater stamp. The merge is commutative, associative and idempotent,
// so every device converges to the same record no matter the order in which
// edits arrive, and an edit to one field never overwrites a concurrent edit to
// a different field. Deletion is just the `deleted` field, so it merges too.
//
// Keys starting with "_" other than "_v" are transport metadata (e.g. the
// server timestamp "_srv") and are dropped by the merge.

const FIXED = new Set(['id', 'kind', '_v']);

export function isDataField(key) {
  return !FIXED.has(key) && !key.startsWith('_');
}

export function stampOf(rec, field) {
  return (rec && rec._v && typeof rec._v[field] === 'string' && rec._v[field]) || '';
}

function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

/** Deterministic JSON (sorted keys) used for equality and tie-breaks. */
export function canonical(v) {
  if (v === undefined) return '';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
}

/** Remove undefined values and transport metadata; returns a fresh object. */
export function sanitize(rec) {
  if (!rec) return rec;
  const out = { id: rec.id };
  if (rec.kind !== undefined) out.kind = rec.kind;
  const v = {};
  for (const [k, val] of Object.entries(rec)) {
    if (!isDataField(k) || val === undefined) continue;
    out[k] = clone(val);
    const s = stampOf(rec, k);
    if (s) v[k] = s;
  }
  out._v = v;
  return out;
}

// `kind` never changes, but if two copies ever disagree (corrupt data) both
// argument orders must pick the same one, or replicas never converge.
function mergeKind(ka, kb) {
  if (ka == null || kb == null || ka === kb) return ka ?? kb;
  return canonical(ka) >= canonical(kb) ? ka : kb;
}

/** Merge two versions of the same record. Either side may be null/undefined. */
export function mergeRecords(a, b) {
  if (!a && !b) return a ?? b;
  if (!a) return sanitize(b);
  if (!b) return sanitize(a);
  if (a.id !== b.id) throw new Error(`mergeRecords: id mismatch ${a.id} vs ${b.id}`);
  const out = { id: a.id };
  const kind = mergeKind(a.kind, b.kind);
  if (kind !== undefined) out.kind = kind;
  const v = {};
  const fields = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const f of fields) {
    if (!isDataField(f)) continue;
    // A stamp without a value (corrupt copy) must not erase the other side's
    // value; sanitize() drops such stamps too.
    const sa = a[f] === undefined ? '' : stampOf(a, f);
    const sb = b[f] === undefined ? '' : stampOf(b, f);
    let winA;
    if (sa !== sb) winA = sa > sb;
    else winA = canonical(a[f]) >= canonical(b[f]); // same stamp: pick deterministically
    const w = winA ? a : b;
    if (w[f] !== undefined) out[f] = clone(w[f]);
    const s = winA ? sa : sb;
    if (s && w[f] !== undefined) v[f] = s;
  }
  out._v = v;
  return out;
}

export function recordsEqual(a, b) {
  return canonical(sanitize(a)) === canonical(sanitize(b));
}

/** Highest stamp anywhere in the record ('' if none). */
export function maxStamp(rec) {
  let m = '';
  for (const s of Object.values((rec && rec._v) || {})) if (s > m) m = s;
  return m;
}

/**
 * Apply an edit: every data field in `changes` whose value differs from `prev`
 * gets `stamp`. Returns the new record (prev is not mutated). Fields set to
 * `undefined` in `changes` are stored as null so the removal can sync.
 */
export function applyChanges(prev, changes, stamp, base = {}) {
  const next = prev ? sanitize(prev) : { id: changes.id ?? base.id, kind: changes.kind ?? base.kind, _v: {} };
  if (!next.id) throw new Error('applyChanges: missing id');
  for (const [k, raw] of Object.entries(changes)) {
    if (!isDataField(k)) continue;
    const val = raw === undefined ? null : raw;
    if (prev && k in prev && canonical(prev[k]) === canonical(val)) continue;
    next[k] = clone(val);
    next._v[k] = stamp;
  }
  return next;
}
