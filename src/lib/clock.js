// Hybrid logical clock. Every field edit gets a stamp; stamps compare as plain
// strings, so "newer edit wins" is a string comparison everywhere (local store,
// cloud sync, backup import).
//
// Stamp format: <millis base36, 9 chars>.<counter base36, 4 chars>.<deviceId>
// e.g. "0mh2k3x1a.0000.k3j9x0qa". Fixed-width parts keep lexicographic order equal
// to (time, counter, device) order, and the device id makes ties impossible.

export const SEED_STAMP = '000000001.0000.seed'; // older than every real edit

const L_WIDTH = 9;
const C_WIDTH = 4;
// Largest values that still fit the fixed-width fields (wider ones would break
// the string ordering).
const MAX_L = 36 ** L_WIDTH - 1;
const MAX_C = 36 ** C_WIDTH - 1;

export function encodeStamp(l, c, deviceId) {
  return `${l.toString(36).padStart(L_WIDTH, '0')}.${c.toString(36).padStart(C_WIDTH, '0')}.${deviceId}`;
}

export function parseStamp(stamp) {
  if (typeof stamp !== 'string') return null;
  const [l, c, ...rest] = stamp.split('.');
  if (!l || !c || !rest.length) return null;
  const li = parseInt(l, 36);
  const ci = parseInt(c, 36);
  if (!Number.isFinite(li) || !Number.isFinite(ci)) return null;
  return { l: li, c: ci, device: rest.join('.') };
}

export function randomId(len = 8) {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
  const bytes = new Uint8Array(len);
  globalThis.crypto.getRandomValues(bytes);
  let s = '';
  for (const b of bytes) s += alphabet[b % 36];
  return s;
}

/**
 * @param {object} opts
 * @param {string} opts.deviceId  stable per-device id ([0-9a-z]+)
 * @param {() => number} [opts.now]  physical clock (ms)
 * @param {{l:number,c:number}|null} [opts.state]  persisted state to resume from
 * @param {(state:{l:number,c:number}) => void} [opts.save]  called after every change
 */
export function createClock({ deviceId, now = () => Date.now(), state = null, save = () => {} }) {
  if (!/^[0-9a-z]+$/.test(deviceId || '')) throw new Error('clock: deviceId must be [0-9a-z]+');
  let l = state?.l || 0;
  let c = state?.c || 0;

  return {
    deviceId,
    /** A new stamp, strictly greater than every stamp issued or observed so far. */
    now() {
      const pt = Math.floor(now());
      if (pt > l && pt <= MAX_L) {
        l = pt;
        c = 0;
      } else if (c < MAX_C) {
        c += 1;
      } else {
        // Counter exhausted within one millisecond: move logical time ahead.
        l += 1;
        c = 0;
      }
      save({ l, c });
      return encodeStamp(l, c, deviceId);
    },
    /** Fold in a stamp seen from elsewhere so our next stamp sorts after it. */
    observe(stamp) {
      const p = parseStamp(stamp);
      // Out-of-range parts cannot come from a real clock; adopting them would
      // push this clock past what the stamp format can order.
      if (!p || p.l > MAX_L - 1 || p.c > MAX_C) return;
      if (p.l > l) {
        l = p.l;
        c = p.c;
      } else if (p.l === l && p.c > c) {
        c = p.c;
      } else {
        return;
      }
      save({ l, c });
    },
    state() {
      return { l, c };
    },
  };
}
