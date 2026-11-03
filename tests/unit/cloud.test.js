// Pure parts of the cloud glue (src/lib/cloud.js): where the config comes
// from, how Google sign-in can run on this device, and who may use a library.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};
let host = 'jarifalamclaude-max.github.io';
Object.defineProperty(globalThis, 'location', {
  configurable: true,
  get: () => ({ hostname: host, protocol: 'https:', href: `https://${host}/MazedarLibrary/` }),
});

const { readConfig, googleSignInMode, canUseLibrary, normEmail, isEmail, parseConfigText } = await import('../../src/lib/cloud.js');

const CFG = { apiKey: 'AIzaX', authDomain: 'mazedar-lib.firebaseapp.com', projectId: 'mazedar-lib', appId: '1:2:web:3' };

beforeEach(() => {
  mem.clear();
  delete globalThis.MAZEDAR_CONFIG;
  host = 'jarifalamclaude-max.github.io';
});

test('config: config.js first, then this device, then the remembered Firebase Hosting config', () => {
  assert.equal(readConfig(), null);
  localStorage.setItem('mazedar:hostingConfig', JSON.stringify({ ...CFG, projectId: 'hosted' }));
  assert.equal(readConfig().source, 'hosting');
  localStorage.setItem('mazedar:firebaseConfig', JSON.stringify(CFG));
  assert.equal(readConfig().source, 'device');
  globalThis.MAZEDAR_CONFIG = { firebase: { ...CFG, projectId: 'file' } };
  assert.deepEqual([readConfig().source, readConfig().projectId], ['file', 'file']);
});

test('on the project\'s own Firebase address, sign-in pages come from the same origin', () => {
  globalThis.MAZEDAR_CONFIG = { firebase: CFG };
  assert.equal(readConfig().authDomain, 'mazedar-lib.firebaseapp.com');
  host = 'mazedar-lib.web.app';
  assert.equal(readConfig().authDomain, 'mazedar-lib.web.app');
  host = 'mazedar-lib.firebaseapp.com';
  assert.equal(readConfig().authDomain, 'mazedar-lib.firebaseapp.com');
  host = 'other-project.web.app';
  assert.equal(readConfig().authDomain, 'mazedar-lib.firebaseapp.com');
});

test('Google sign-in mode per device', () => {
  const cfg = { ...CFG, authDomain: 'mazedar-lib.web.app' };
  const env = (o) => ({ hostname: 'mazedar-lib.web.app', standalone: false, ios: false, ...o });
  assert.equal(googleSignInMode(cfg, env({})), 'popup');
  assert.equal(googleSignInMode(cfg, env({ standalone: true, ios: true })), 'redirect');
  assert.equal(googleSignInMode(cfg, env({ standalone: true })), 'redirect');
  const gh = env({ hostname: 'jarifalamclaude-max.github.io' });
  assert.equal(googleSignInMode(cfg, gh), 'popup');
  assert.equal(googleSignInMode(cfg, { ...gh, ios: true }), 'popup', 'Safari tab: popup works');
  assert.equal(googleSignInMode(cfg, { ...gh, standalone: true }), 'popup', 'installed Android app');
  assert.equal(googleSignInMode(cfg, { ...gh, standalone: true, ios: true }), 'unavailable', 'iPhone home-screen app on another address');
  assert.equal(googleSignInMode(null, env({})), 'unavailable');
});

test('who may use a library', () => {
  const meta = { owner: 'u1', members: ['jarif@gmail.com'] };
  assert.equal(canUseLibrary(meta, { uid: 'u1', email: 'x@y.com', verified: false }), true);
  assert.equal(canUseLibrary(meta, { uid: 'u2', email: 'jarif@gmail.com', verified: true }), true);
  assert.equal(canUseLibrary(meta, { uid: 'u2', email: 'jarif@gmail.com', verified: false }), false);
  assert.equal(canUseLibrary(meta, { uid: 'u3', email: 'other@gmail.com', verified: true }), false);
  assert.equal(canUseLibrary(null, { uid: 'u1' }), false);
});

test('email helpers and config parsing', () => {
  assert.equal(normEmail('  Jarif@Gmail.COM '), 'jarif@gmail.com');
  assert.ok(isEmail('mazeda@gmail.com'));
  for (const bad of ['', 'mazeda', 'a@b', 'a b@gmail.com', '@gmail.com']) assert.equal(isEmail(bad), false, bad);
  const cfg = parseConfigText('const firebaseConfig = {\n apiKey: "AIzaX",\n projectId: "p1",\n appId: "1:2:web:3" };');
  assert.equal(cfg.authDomain, 'p1.firebaseapp.com');
  assert.throws(() => parseConfigText('{ apiKey: "x" }'));
});
