// Cloud sync glue: lazy-loads Firebase, signs in (Google, or email/password),
// works out which library this account uses — its own, or one somebody shared
// with it — binds this device's copy to that library and runs the sync engine.
// Without a Firebase config the app simply stays in local mode.
//
// Libraries live at libraries/{libId}. libId is the owner's uid, so libraries
// made before sharing existed keep working unchanged. The library document
// itself holds { owner, ownerEmail, ownerName, members: [email...] }; the
// security rules (firebase/firestore.rules) let the owner and the listed,
// Google-verified emails read and write the books under it.
import { createSyncEngine } from './sync.js';

const LS_CONFIG = 'mazedar:firebaseConfig';
const LS_HOSTING = 'mazedar:hostingConfig';
const SS_REDIRECT = 'mazedar:googleRedirect';
const CONFIG_KEYS = ['apiKey', 'authDomain', 'projectId', 'storageBucket', 'messagingSenderId', 'appId'];
export const MAX_MEMBERS = 10;
const NET_TIMEOUT_MS = 15000;

function lsGet(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; }
}
function lsSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
}

/**
 * On the project's own Firebase Hosting address the sign-in helper pages are
 * served from the app's origin, so use that origin as authDomain: Google
 * sign-in then never needs third-party storage (this is what makes it work in
 * an iPhone home-screen app and in Safari).
 */
function adaptAuthDomain(cfg, hostname = globalThis.location?.hostname) {
  if (hostname && cfg.projectId && (hostname === `${cfg.projectId}.web.app` || hostname === `${cfg.projectId}.firebaseapp.com`)) {
    return { ...cfg, authDomain: hostname };
  }
  return cfg;
}

/** Firebase web config from config.js, this device's settings, or Firebase Hosting (in that order). */
export function readConfig() {
  const fromFile = globalThis.MAZEDAR_CONFIG?.firebase;
  if (fromFile?.apiKey && fromFile?.projectId) return adaptAuthDomain({ ...fromFile, source: 'file' });
  const dev = lsGet(LS_CONFIG);
  if (dev?.apiKey && dev?.projectId) return adaptAuthDomain({ ...dev, source: 'device' });
  const hosted = lsGet(LS_HOSTING);
  if (hosted?.apiKey && hosted?.projectId) return adaptAuthDomain({ ...hosted, source: 'hosting' });
  return null;
}

function cleanConfig(cfg) {
  const clean = {};
  for (const k of CONFIG_KEYS) if (cfg[k]) clean[k] = String(cfg[k]);
  return clean;
}

/**
 * Only ask where the answer can exist: Firebase's own addresses, or a custom
 * domain whose config.js says `hosting: true` (elsewhere, e.g. GitHub Pages,
 * the request would just be a 404 on every start).
 */
function mayBeFirebaseHosting(hostname = globalThis.location?.hostname || '') {
  return /\.(web\.app|firebaseapp\.com)$/.test(hostname) || globalThis.MAZEDAR_CONFIG?.hosting === true;
}

/**
 * When the app is served by Firebase Hosting, the project's web config is
 * published at /__/firebase/init.json — so a fresh phone needs no setup at all.
 * The answer is remembered for offline starts.
 */
export async function discoverHostingConfig({ timeoutMs = 5000 } = {}) {
  if (typeof fetch !== 'function' || !/^https?:$/.test(globalThis.location?.protocol || '')) return null;
  if (!mayBeFirebaseHosting()) return null;
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = setTimeout(() => ctl?.abort(), timeoutMs);
  try {
    const res = await fetch('/__/firebase/init.json', { cache: 'no-store', signal: ctl?.signal, credentials: 'omit' });
    if (!res.ok || !/json/.test(res.headers.get('content-type') || '')) return null;
    const cfg = cleanConfig(await res.json());
    if (!cfg.apiKey || !cfg.projectId) return null;
    if (!cfg.authDomain) cfg.authDomain = `${cfg.projectId}.firebaseapp.com`;
    lsSet(LS_HOSTING, cfg);
    return cfg;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function saveConfig(cfg) {
  const clean = cleanConfig(cfg);
  if (cfg.emulators) clean.emulators = cfg.emulators;
  localStorage.setItem(LS_CONFIG, JSON.stringify(clean));
}

export function clearConfig() {
  localStorage.removeItem(LS_CONFIG);
}

/**
 * Accepts the snippet Firebase shows ("const firebaseConfig = { apiKey: ... }")
 * or plain JSON, and returns a config object.
 */
export function parseConfigText(text) {
  const cfg = {};
  for (const k of CONFIG_KEYS) {
    const m = String(text).match(new RegExp(`["']?${k}["']?\\s*:\\s*["'\`]([^"'\`]+)["'\`]`));
    if (m) cfg[k] = m[1].trim();
  }
  if (!cfg.apiKey || !cfg.projectId || !cfg.appId) {
    throw new Error('কনফিগারেশনে apiKey, projectId, appId পাওয়া যায়নি — Firebase থেকে পুরো অংশটা কপি করুন');
  }
  if (!cfg.authDomain) cfg.authDomain = `${cfg.projectId}.firebaseapp.com`;
  return cfg;
}

function b64urlEncode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

/** A link that configures another device in one tap (the config is not a secret). */
export function makeSetupLink(cfg) {
  const base = location.href.split('#')[0];
  return `${base}#/setup?c=${b64urlEncode(JSON.stringify(cleanConfig(cfg)))}`;
}

export function decodeSetupParam(c) {
  return parseConfigText(b64urlDecode(c));
}

export function normEmail(e) {
  return String(e || '').trim().toLowerCase();
}

export function isEmail(e) {
  return /^[^@\s]+@[^@\s]+\.[^@\s.]{2,}$/.test(normEmail(e));
}

function browserEnv() {
  const nav = globalThis.navigator || {};
  const ua = nav.userAgent || '';
  return {
    hostname: globalThis.location?.hostname || '',
    standalone: nav.standalone === true || !!globalThis.matchMedia?.('(display-mode: standalone)')?.matches,
    ios: /iPad|iPhone|iPod/.test(ua) || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1),
  };
}

/**
 * How Google sign-in can run here:
 *  - 'redirect': installed app on the project's own Firebase address (works everywhere, incl. iPhone).
 *  - 'popup': a normal browser tab, or an installed Android app.
 *  - 'unavailable': an iPhone home-screen app opened from another address (e.g. GitHub Pages);
 *    iOS cuts the popup off from the app there, so Google sign-in cannot finish.
 */
export function googleSignInMode(cfg, env = browserEnv()) {
  if (!cfg) return 'unavailable';
  const sameOrigin = !!cfg.authDomain && env.hostname === cfg.authDomain;
  if (env.standalone && sameOrigin) return 'redirect';
  if (env.standalone && env.ios) return 'unavailable';
  return 'popup';
}

const AUTH_ERRORS = {
  'auth/invalid-email': 'ইমেইল ঠিকানাটি সঠিক নয়',
  'auth/user-not-found': 'ইমেইল বা পাসওয়ার্ড ভুল',
  'auth/wrong-password': 'ইমেইল বা পাসওয়ার্ড ভুল',
  'auth/invalid-credential': 'ইমেইল বা পাসওয়ার্ড ভুল',
  'auth/invalid-login-credentials': 'ইমেইল বা পাসওয়ার্ড ভুল',
  'auth/email-already-in-use': 'এই ইমেইলে আগেই অ্যাকাউন্ট খোলা আছে — লগইন করুন',
  'auth/weak-password': 'পাসওয়ার্ড কমপক্ষে ৬ অক্ষরের হতে হবে',
  'auth/missing-password': 'পাসওয়ার্ড লিখুন',
  'auth/network-request-failed': 'ইন্টারনেট সংযোগ পাওয়া যাচ্ছে না',
  'auth/too-many-requests': 'অনেকবার চেষ্টা হয়েছে — কিছুক্ষণ পরে আবার চেষ্টা করুন',
  'auth/operation-not-allowed': 'Firebase-এ এই লগইন পদ্ধতি চালু করা হয়নি (সেটআপ গাইডের ধাপ ২ দেখুন)',
  'auth/api-key-not-valid.-please-pass-a-valid-api-key.': 'Firebase কনফিগারেশনের apiKey ভুল',
  'auth/invalid-api-key': 'Firebase কনফিগারেশনের apiKey ভুল',
  'auth/unauthorized-domain': 'এই ওয়েবসাইটের ঠিকানা Firebase-এ অনুমোদিত নয় (Authentication → Settings → Authorized domains-এ যোগ করুন)',
  'auth/popup-blocked': 'ব্রাউজার Google-এর জানালাটা আটকে দিয়েছে — আবার চাপুন, অথবা পপ-আপ চালু করুন',
  'auth/account-exists-with-different-credential': 'এই ইমেইলে আগে পাসওয়ার্ড দিয়ে অ্যাকাউন্ট খোলা হয়েছিল — ইমেইল-পাসওয়ার্ড দিয়ে লগইন করুন',
  'auth/web-storage-unsupported': 'এই ব্রাউজারে লগইন তথ্য রাখা যাচ্ছে না (প্রাইভেট মোড বন্ধ করে চেষ্টা করুন)',
  'auth/internal-error': 'Google লগইনে সমস্যা হয়েছে — আবার চেষ্টা করুন',
  'permission-denied': 'অনুমতি নেই — Firebase-এর নিয়ম (rules) হালনাগাদ করা হয়েছে কি না দেখুন',
  unavailable: 'ইন্টারনেট সংযোগ পাওয়া যাচ্ছে না',
  timeout: 'ইন্টারনেট সংযোগ পাওয়া যাচ্ছে না — পরে আবার চেষ্টা করুন',
};

export function authErrorText(e) {
  return AUTH_ERRORS[e?.code] || e?.message || String(e);
}

const SILENT_AUTH = new Set(['auth/popup-closed-by-user', 'auth/cancelled-popup-request', 'auth/user-cancelled', 'auth/redirect-cancelled-by-user']);

function withTimeout(promise, ms = NET_TIMEOUT_MS) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error('timeout'), { code: 'timeout' })), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/** True if this signed-in account may use the library described by `meta`. */
export function canUseLibrary(meta, user) {
  if (!meta || !user) return false;
  if (meta.owner === user.uid) return true;
  return !!user.verified && !!user.email && Array.isArray(meta.members) && meta.members.includes(user.email);
}

/**
 * @param {{ store: object, onChange: (state: object) => void, reseed?: () => Promise<unknown> }} opts
 */
export function createCloud({ store, onChange, reseed }) {
  let fb = null;
  let app = null;
  let auth = null;
  let db = null;
  let cfg = null;
  let engine = null;
  let unsubAuth = null;
  let unsubStatus = null;
  let unsubLib = null;
  let userGen = 0; // bumps on every auth change, so stale async work can tell it lost
  let resolverWarm = false;
  const initial = readConfig();
  let state = {
    configured: !!initial,
    configSource: initial?.source || null,
    // off | loading | signed-out | busy | resolving | invite | signed-in | needs-switch | removed | error
    phase: 'off',
    googleMode: googleSignInMode(initial),
    user: null, // { uid, email, name, verified, provider }
    library: null, // { id, own, ownerEmail, ownerName, members[] }
    invites: [], // [{ id, ownerEmail, ownerName }]
    sync: null,
    error: null,
    shareError: null,
  };

  const set = (patch) => {
    state = { ...state, ...patch };
    onChange?.(state);
  };

  // ---- sync engine -----------------------------------------------------------
  async function startEngine(libId) {
    await stopEngine();
    engine = createSyncEngine({
      fs: {
        collection: fb.collection,
        doc: fb.doc,
        query: fb.query,
        where: fb.where,
        onSnapshot: fb.onSnapshot,
        runTransaction: fb.runTransaction,
        serverTimestamp: fb.serverTimestamp,
        Timestamp: fb.Timestamp,
      },
      db,
      uid: libId,
      store,
      clock: store.clock,
      subscribeOnline: (cb) => {
        window.addEventListener('online', cb);
        return () => window.removeEventListener('online', cb);
      },
    });
    unsubStatus = engine.onStatus((s) => set({ sync: s }));
    set({ sync: engine.getStatus() });
    // The engine subscribes to store.onLocalWrite itself and reports problems via status.
    Promise.resolve(engine.start()).catch((e) => set({ sync: { ...engine?.getStatus?.(), state: 'error', error: String(e?.message || e) } }));
  }

  async function stopEngine() {
    unsubStatus?.();
    unsubStatus = null;
    unsubLib?.();
    unsubLib = null;
    if (engine) {
      const e = engine;
      engine = null;
      await e.stop().catch(() => {});
    }
  }

  // ---- library documents -------------------------------------------------------
  const libRef = (id) => fb.doc(db, 'libraries', id);

  function libFromDoc(id, data, user) {
    return {
      id,
      own: id === user?.uid,
      ownerEmail: data?.ownerEmail || (id === user?.uid ? user.email : ''),
      ownerName: data?.ownerName || (id === user?.uid ? user.name : ''),
      members: Array.isArray(data?.members) ? data.members : [],
    };
  }

  /** Make sure the signed-in owner's library document exists and names them. */
  async function ensureOwnMeta(user) {
    const ref = libRef(user.uid);
    await withTimeout(fb.runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists()) {
        tx.set(ref, { owner: user.uid, ownerEmail: user.email, ownerName: user.name, members: [], createdAt: fb.serverTimestamp() });
      } else {
        const d = snap.data();
        if (d.ownerEmail !== user.email || d.ownerName !== user.name) tx.update(ref, { ownerEmail: user.email, ownerName: user.name });
      }
    }));
  }

  /** Libraries whose owner added this account's (Google-verified) email. */
  async function findInvites(user) {
    if (!user?.email || !user.verified) return [];
    const q = fb.query(fb.collection(db, 'libraries'), fb.where('members', 'array-contains', user.email));
    const snap = await withTimeout(fb.getDocs(q));
    return snap.docs
      .filter((d) => d.id !== user.uid)
      .map((d) => ({ id: d.id, ownerEmail: d.data().ownerEmail || '', ownerName: d.data().ownerName || '' }));
  }

  async function readLibMeta(id) {
    const snap = await withTimeout(fb.getDoc(libRef(id)));
    return snap.exists() ? snap.data() : null;
  }

  /** Keep the library card (owner, members) live, and notice if access is taken away. */
  function watchLibrary(libId, user, gen) {
    unsubLib?.();
    unsubLib = fb.onSnapshot(libRef(libId), (snap) => {
      if (gen !== userGen) return;
      set({ library: libFromDoc(libId, snap.exists() ? snap.data() : null, user) });
    }, (err) => {
      if (gen !== userGen) return;
      if (libId !== user.uid && err?.code === 'permission-denied') {
        // The owner removed this account. Everything stays on this device.
        stopEngine().then(() => set({ phase: 'removed', sync: null }));
      }
    });
  }

  // ---- binding this device to a library ---------------------------------------------
  async function boundLibrary() {
    return (await store.getMeta('boundLibrary')) || (await store.getMeta('boundUid')) || null;
  }

  async function useLibrary(libId, user, gen) {
    if (gen !== userGen) return;
    set({ phase: 'signed-in', error: null, invites: [], library: libFromDoc(libId, null, user) });
    await startEngine(libId);
    if (gen !== userGen) return;
    watchLibrary(libId, user, gen);
    if (libId === user.uid) {
      ensureOwnMeta(user).then(
        () => set({ shareError: null }),
        (e) => set({ shareError: authErrorText(e) }),
      );
    }
  }

  /**
   * Point this device at `libId`. `replace` wipes this device's copy first (a
   * snapshot is kept); otherwise everything here is merged into that library.
   */
  async function bindLibrary(libId, user, gen, { replace = false } = {}) {
    const prev = await boundLibrary();
    await stopEngine();
    if (replace) {
      await store.wipe();
      await reseed?.();
    } else if (prev && prev !== libId) {
      await store.enqueueAll();
    }
    await store.setMeta('boundLibrary', libId);
    await store.setMeta('boundUser', user.uid);
    await store.setMeta('boundEmail', user.email || '');
    if (libId === user.uid) await store.setMeta('boundUid', user.uid);
    await useLibrary(libId, user, gen);
  }

  /** A device that has never synced (or was just cleared): own library, or a shared one? */
  async function resolveFresh(user, gen) {
    set({ phase: 'resolving', error: null });
    let invites = [];
    try {
      invites = await findInvites(user);
    } catch {
      // Offline or older rules: carry on with the account's own library; the
      // settings page can look for shared libraries again later.
    }
    if (gen !== userGen) return;
    if (invites.length) {
      set({ phase: 'invite', invites });
      return;
    }
    await bindLibrary(user.uid, user, gen);
  }

  async function onUser(fbUser) {
    const gen = ++userGen;
    if (!fbUser) {
      await stopEngine();
      if (gen !== userGen) return;
      set({ phase: 'signed-out', user: null, sync: null, library: null, invites: [], shareError: null });
      warmGoogle();
      return;
    }
    const user = {
      uid: fbUser.uid,
      email: normEmail(fbUser.email),
      name: fbUser.displayName || '',
      verified: !!fbUser.emailVerified,
      provider: fbUser.providerData?.[0]?.providerId || 'password',
    };
    set({ user, error: null });
    const bound = await boundLibrary();
    const boundUser = (await store.getMeta('boundUser')) || (await store.getMeta('boundUid')) || null;
    if (gen !== userGen) return;
    if (!bound) return resolveFresh(user, gen);
    // Same account as last time (works offline): carry on.
    if (bound === user.uid || boundUser === user.uid) return useLibrary(bound, user, gen);
    // Another account on a device that holds a library: fine if it is a member too.
    set({ phase: 'resolving' });
    let meta = null;
    try { meta = await readLibMeta(bound); } catch { /* no access, or offline */ }
    if (gen !== userGen) return;
    if (canUseLibrary(meta, user)) {
      await store.setMeta('boundUser', user.uid);
      return useLibrary(bound, user, gen);
    }
    await stopEngine();
    set({ phase: 'needs-switch' });
  }

  /** Prepare Google sign-in early (loads its helper frame) and finish a redirect sign-in. */
  function warmGoogle() {
    if (!auth || !fb || resolverWarm || state.googleMode === 'unavailable') return;
    resolverWarm = true;
    let redirecting = false;
    try { redirecting = sessionStorage.getItem(SS_REDIRECT) === '1'; sessionStorage.removeItem(SS_REDIRECT); } catch { /* ignore */ }
    if (redirecting) set({ phase: 'busy' });
    fb.getRedirectResult(auth, fb.browserPopupRedirectResolver).then((res) => {
      if (redirecting && !res && state.phase === 'busy') set({ phase: 'signed-out' });
    }, (e) => {
      resolverWarm = false;
      if (redirecting || !SILENT_AUTH.has(e?.code)) {
        if (state.phase === 'busy' || state.phase === 'signed-out') set({ phase: 'signed-out', error: redirecting ? authErrorText(e) : state.error });
      }
    });
  }

  const requireUser = () => {
    if (!state.user) throw new Error('not signed in');
    return state.user;
  };

  return {
    get state() { return state; },

    async start() {
      cfg = readConfig();
      if (!cfg) {
        const hosted = await discoverHostingConfig();
        if (hosted) cfg = readConfig();
      } else if (cfg.source === 'hosting') {
        discoverHostingConfig().catch(() => {}); // refresh the remembered copy for next time
      }
      if (!cfg) {
        set({ configured: false, configSource: null, phase: 'off' });
        return;
      }
      set({ configured: true, configSource: cfg.source, googleMode: googleSignInMode(cfg), phase: 'loading', error: null });
      try {
        fb = await import('../../vendor/firebase.js');
        const { source, emulators, ...firebaseConfig } = cfg;
        app = fb.getApps().find((a) => a.name === 'mazedar') || fb.initializeApp(firebaseConfig, 'mazedar');
        // No popupRedirectResolver here: with one, Firebase loads Google's helper
        // frame on every start on phones, which slows offline starts. It is
        // loaded only while signed out (warmGoogle).
        auth = fb.initializeAuth(app, { persistence: [fb.indexedDBLocalPersistence, fb.browserLocalPersistence] });
        db = fb.initializeFirestore(app, { localCache: fb.memoryLocalCache(), ignoreUndefinedProperties: true });
        if (emulators?.auth) fb.connectAuthEmulator(auth, emulators.auth, { disableWarnings: true });
        if (emulators?.firestore) fb.connectFirestoreEmulator(db, emulators.firestore.host, emulators.firestore.port);
        unsubAuth = fb.onAuthStateChanged(auth, (u) => { onUser(u).catch((e) => set({ phase: 'error', error: authErrorText(e) })); });
      } catch (e) {
        set({ phase: 'error', error: `Firebase চালু করা যায়নি: ${e?.message || e}` });
      }
    },

    /**
     * Google sign-in. Call it straight from the tap handler (no awaits before
     * it), or Safari treats the Google window as an unwanted popup.
     */
    signInWithGoogle() {
      if (!auth) return Promise.reject(new Error('not ready'));
      if (state.googleMode === 'unavailable') {
        const e = Object.assign(new Error('google-unavailable'), { code: 'google-unavailable' });
        set({ error: 'এই ঠিকানা থেকে iPhone-এর হোম-স্ক্রিন অ্যাপে Google লগইন হয় না — সেটআপ গাইড দেখুন' });
        return Promise.reject(e);
      }
      const provider = new fb.GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      const prevPhase = state.phase;
      let p;
      if (state.googleMode === 'redirect') {
        try { sessionStorage.setItem(SS_REDIRECT, '1'); } catch { /* ignore */ }
        p = fb.signInWithRedirect(auth, provider, fb.browserPopupRedirectResolver);
      } else {
        p = fb.signInWithPopup(auth, provider, fb.browserPopupRedirectResolver);
      }
      set({ phase: 'busy', error: null });
      return p.then(() => undefined, (e) => {
        if (state.phase === 'busy') set({ phase: prevPhase === 'busy' ? 'signed-out' : prevPhase, error: SILENT_AUTH.has(e?.code) ? null : authErrorText(e) });
        if (!SILENT_AUTH.has(e?.code)) throw e;
      });
    },

    async signIn(email, password) {
      set({ phase: 'busy', error: null });
      try {
        await fb.signInWithEmailAndPassword(auth, email.trim(), password);
      } catch (e) {
        set({ phase: 'signed-out', error: authErrorText(e) });
        throw e;
      }
    },

    async signUp(email, password) {
      set({ phase: 'busy', error: null });
      try {
        await fb.createUserWithEmailAndPassword(auth, email.trim(), password);
      } catch (e) {
        set({ phase: 'signed-out', error: authErrorText(e) });
        throw e;
      }
    },

    async resetPassword(email) {
      await fb.sendPasswordResetEmail(auth, email.trim());
    },

    async signOut() {
      userGen++;
      await stopEngine();
      if (auth) await fb.signOut(auth);
    },

    /**
     * This device holds a library this account cannot use. `keep`: take this
     * device's books along into the account's library; otherwise clear the
     * device first (a snapshot is kept) and start over.
     */
    async confirmSwitch({ keep = false } = {}) {
      const user = requireUser();
      const gen = ++userGen;
      await stopEngine();
      if (!keep) {
        await store.wipe();
        await reseed?.();
      }
      if (gen !== userGen) return;
      await resolveFresh(user, gen);
    },

    /** Join a library shared with this account. `replace` drops this device's own books first. */
    async joinLibrary(libId, { replace = false } = {}) {
      const user = requireUser();
      const gen = ++userGen;
      set({ phase: 'busy', error: null });
      try {
        const meta = await readLibMeta(libId);
        if (!canUseLibrary(meta, user)) throw Object.assign(new Error('permission'), { code: 'permission-denied' });
      } catch (e) {
        set({ phase: state.library ? 'signed-in' : 'invite', error: authErrorText(e) });
        throw e;
      }
      await bindLibrary(libId, user, gen, { replace });
    },

    /** Use (or go back to) this account's own library; this device's books are merged into it. */
    async useOwnLibrary({ replace = false } = {}) {
      const user = requireUser();
      const gen = ++userGen;
      await bindLibrary(user.uid, user, gen, { replace });
    },

    /** Look again for libraries shared with this account (settings page). */
    async checkInvites() {
      const user = requireUser();
      const invites = (await findInvites(user)).filter((i) => i.id !== state.library?.id);
      set({ invites });
      return invites;
    },

    /** Owner only: let another Google account (by its Gmail address) use this library. */
    async addMember(email) {
      const user = requireUser();
      const e = normEmail(email);
      if (!isEmail(e)) throw new Error('ইমেইল ঠিকানাটি সঠিক নয়');
      if (e === user.email) throw new Error('এটা তো আপনার নিজের ইমেইল');
      if (state.library?.id !== user.uid) throw new Error('শুধু লাইব্রেরির মালিক অন্যকে যোগ করতে পারেন');
      const members = state.library?.members || [];
      if (members.includes(e)) return;
      if (members.length >= MAX_MEMBERS) throw new Error(`সর্বোচ্চ ${MAX_MEMBERS} জনকে যোগ করা যায়`);
      try {
        await ensureOwnMeta(user);
        await withTimeout(fb.updateDoc(libRef(user.uid), { members: fb.arrayUnion(e) }));
      } catch (err) {
        throw new Error(authErrorText(err));
      }
    },

    async removeMember(email) {
      const user = requireUser();
      if (state.library?.id !== user.uid) throw new Error('শুধু লাইব্রেরির মালিক বাদ দিতে পারেন');
      try {
        await withTimeout(fb.updateDoc(libRef(user.uid), { members: fb.arrayRemove(normEmail(email)) }));
      } catch (err) {
        throw new Error(authErrorText(err));
      }
    },

    async syncNow() {
      await engine?.syncNow();
    },

    async fullResync() {
      await engine?.fullResync();
    },

    async destroy() {
      userGen++;
      unsubAuth?.();
      await stopEngine();
      if (app) await fb.deleteApp(app).catch(() => {});
      app = null;
    },
  };
}
