// Cloud sync glue: lazy-loads Firebase, keeps the shared account signed in,
// binds this device's library to that account and runs the sync engine.
// Without a Firebase config the app simply stays in local mode.
import { createSyncEngine } from './sync.js';

const LS_CONFIG = 'mazedar:firebaseConfig';
const CONFIG_KEYS = ['apiKey', 'authDomain', 'projectId', 'storageBucket', 'messagingSenderId', 'appId'];

/** Firebase web config from config.js (preferred) or this device's settings. */
export function readConfig() {
  const fromFile = globalThis.MAZEDAR_CONFIG?.firebase;
  if (fromFile?.apiKey && fromFile?.projectId) return { ...fromFile, source: 'file' };
  try {
    const c = JSON.parse(localStorage.getItem(LS_CONFIG) || 'null');
    if (c?.apiKey && c?.projectId) return { ...c, source: 'device' };
  } catch { /* ignore */ }
  return null;
}

export function saveConfig(cfg) {
  const clean = {};
  for (const k of CONFIG_KEYS) if (cfg[k]) clean[k] = String(cfg[k]);
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
  const clean = {};
  for (const k of CONFIG_KEYS) if (cfg[k]) clean[k] = cfg[k];
  const base = location.href.split('#')[0];
  return `${base}#/setup?c=${b64urlEncode(JSON.stringify(clean))}`;
}

export function decodeSetupParam(c) {
  return parseConfigText(b64urlDecode(c));
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
  'auth/operation-not-allowed': 'Firebase-এ Email/Password সাইন-ইন চালু করা হয়নি (সেটআপ গাইড দেখুন)',
  'auth/api-key-not-valid.-please-pass-a-valid-api-key.': 'Firebase কনফিগারেশনের apiKey ভুল',
  'auth/invalid-api-key': 'Firebase কনফিগারেশনের apiKey ভুল',
  'auth/unauthorized-domain': 'এই ওয়েবসাইটের ঠিকানা Firebase-এ অনুমোদিত নয় (Authorized domains-এ যোগ করুন)',
};

export function authErrorText(e) {
  return AUTH_ERRORS[e?.code] || e?.message || String(e);
}

/**
 * @param {{ store: object, onChange: (state: object) => void, reseed?: () => Promise<unknown> }} opts
 */
export function createCloud({ store, onChange, reseed }) {
  let fb = null;
  let app = null;
  let auth = null;
  let db = null;
  let engine = null;
  let unsubAuth = null;
  let unsubStatus = null;
  let state = {
    configured: !!readConfig(),
    phase: 'off', // off | loading | signed-out | busy | signed-in | needs-switch | error
    user: null,
    sync: null,
    error: null,
  };

  const set = (patch) => {
    state = { ...state, ...patch };
    onChange?.(state);
  };

  async function startEngine(uid) {
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
      uid,
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
    if (engine) {
      const e = engine;
      engine = null;
      await e.stop().catch(() => {});
    }
  }

  async function onUser(user) {
    if (!user) {
      await stopEngine();
      set({ phase: 'signed-out', user: null, sync: null });
      return;
    }
    const info = { uid: user.uid, email: user.email };
    const bound = await store.getMeta('boundUid');
    if (bound && bound !== user.uid) {
      await stopEngine();
      set({ phase: 'needs-switch', user: info });
      return;
    }
    if (!bound) await store.setMeta('boundUid', user.uid);
    await store.setMeta('boundEmail', user.email || '');
    set({ phase: 'signed-in', user: info, error: null });
    await startEngine(user.uid);
  }

  return {
    get state() { return state; },

    async start() {
      const cfg = readConfig();
      if (!cfg) {
        set({ configured: false, phase: 'off' });
        return;
      }
      set({ configured: true, phase: 'loading', error: null });
      try {
        fb = await import('../../vendor/firebase.js');
        const { source, emulators, ...firebaseConfig } = cfg;
        app = fb.getApps().find((a) => a.name === 'mazedar') || fb.initializeApp(firebaseConfig, 'mazedar');
        auth = fb.initializeAuth(app, { persistence: [fb.indexedDBLocalPersistence, fb.browserLocalPersistence] });
        db = fb.initializeFirestore(app, { localCache: fb.memoryLocalCache(), ignoreUndefinedProperties: true });
        if (emulators?.auth) fb.connectAuthEmulator(auth, emulators.auth, { disableWarnings: true });
        if (emulators?.firestore) fb.connectFirestoreEmulator(db, emulators.firestore.host, emulators.firestore.port);
        unsubAuth = fb.onAuthStateChanged(auth, (u) => { onUser(u).catch((e) => set({ phase: 'error', error: String(e?.message || e) })); });
      } catch (e) {
        set({ phase: 'error', error: `Firebase চালু করা যায়নি: ${e?.message || e}` });
      }
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
      await stopEngine();
      if (auth) await fb.signOut(auth);
    },

    /** This device holds another account's library: wipe it (after a snapshot) and continue. */
    async confirmSwitch() {
      const user = state.user;
      if (!user) return;
      await stopEngine();
      await store.wipe();
      await reseed?.();
      await store.setMeta('boundUid', user.uid);
      await store.setMeta('boundEmail', user.email || '');
      set({ phase: 'signed-in', error: null });
      await startEngine(user.uid);
    },

    async syncNow() {
      await engine?.syncNow();
    },

    async fullResync() {
      await engine?.fullResync();
    },

    async destroy() {
      unsubAuth?.();
      await stopEngine();
      if (app) await fb.deleteApp(app).catch(() => {});
      app = null;
    },
  };
}
