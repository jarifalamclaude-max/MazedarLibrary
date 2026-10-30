// The one rule behind LocalStore.applyRemote, shared by the IndexedDB store and
// the in-memory test store so both behave identically.
//
// A record that arrives from the server (or a backup) is merged into the local
// copy. The id may leave the outbox only when the incoming copy already holds
// everything the merged local copy holds; otherwise this device has newer
// fields the server lacks and the id must stay queued. Nothing is stamped here.

import { mergeRecords, recordsEqual } from './merge.js';

/**
 * Plan how to apply one incoming record to the local copy.
 *
 * @param {object|undefined|null} localRecord  the stored record, if any
 * @param {object} incomingRecord              copy from the server or a backup
 * @returns {{ next: object, changed: boolean, outbox: 'remove'|'keep' }}
 *   `next` is the record to store, `changed` says whether it differs from the
 *   local copy (write it and emit a change), `outbox` whether the id may be
 *   dropped from the outbox ('remove') or must be queued ('keep').
 */
export function planApplyRemote(localRecord, incomingRecord) {
  if (!incomingRecord || typeof incomingRecord.id !== 'string' || !incomingRecord.id) {
    throw new TypeError('planApplyRemote: incoming record needs a string id');
  }
  const local = localRecord || undefined;
  const next = mergeRecords(local, incomingRecord);
  const changed = !local || !recordsEqual(local, next);
  const outbox = recordsEqual(next, incomingRecord) ? 'remove' : 'keep';
  return { next, changed, outbox };
}
