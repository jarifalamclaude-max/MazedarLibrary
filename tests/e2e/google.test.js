// Google login and sharing, two phones, real Firebase Auth + Firestore emulators.
// Run via:  bash tests/e2e/run-sync.sh
//
// Google's sign-in window needs apis.google.com, which a test machine cannot
// reach, so the test signs in with a Google credential the Auth emulator
// accepts (signInWithCredential); everything after that — finding the library,
// invitations, joining, syncing, removing a member — is the app's real path.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, phone, openApp } from './helpers.mjs';

const RUN = !!process.env.FIRESTORE_EMULATOR_HOST;
const [fsHost, fsPort] = (process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080').split(':');
const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';
const HOSTING = 'http://127.0.0.1:5005/';
const CONFIG = {
  apiKey: 'demo-key',
  authDomain: 'demo-mazedar.firebaseapp.com',
  projectId: 'demo-mazedar',
  appId: '1:1234:web:abcd',
  emulators: { auth: `http://${authHost}`, firestore: { host: fsHost, port: Number(fsPort) } },
};
const OWNER = { sub: `mazeda-${process.pid}`, email: `mazeda${process.pid}@gmail.com`, name: 'Mazeda' };
const MEMBER = { sub: `jarif-${process.pid}`, email: `jarif${process.pid}@gmail.com`, name: 'Jarif' };

let env;
before(async () => { if (RUN) env = await launch(); });
after(async () => { await env?.close(); });

async function device(name, { config = CONFIG, ...opts } = {}) {
  const d = await phone(env.browser, opts);
  if (config) await d.context.addInitScript((cfg) => localStorage.setItem('mazedar:firebaseConfig', JSON.stringify(cfg)), config);
  await d.context.route('https://apis.google.com/**', (r) => r.abort());
  d.name = name;
  return d;
}

/** Sign in as a Google account on the app's own Firebase instance (emulator credential). */
async function googleSignIn(page, who) {
  await page.waitForSelector('button.google:not([disabled])', { timeout: 20000 });
  await page.evaluate(async (w) => {
    const fb = await import('/vendor/firebase.js');
    const app = fb.getApps().find((a) => a.name === 'mazedar');
    const auth = fb.initializeAuth(app, { persistence: [fb.indexedDBLocalPersistence, fb.browserLocalPersistence] });
    const cred = fb.GoogleAuthProvider.credential(JSON.stringify({ sub: w.sub, email: w.email, email_verified: true, name: w.name }));
    await fb.signInWithCredential(auth, cred);
  }, who);
}

const expected = /net::|ERR_INTERNET_DISCONNECTED|ERR_FAILED|WebChannelConnection|Could not reach Cloud Firestore|400 POST \S+documents:commit|apis\.google\.com/;

test('Google login: the owner shares the library with a second Google account, then removes it', { skip: !RUN && 'needs the Firebase emulators (bash tests/e2e/run-sync.sh)' }, async () => {
  const O = await device('owner');
  const J = await device('member');
  const base = env.base;

  // The owner's first Google login on a fresh phone: their own library.
  await openApp(O.page, base, '#/settings');
  assert.match(await O.page.locator('button.google').innerText(), /Google দিয়ে লগইন/);
  await googleSignIn(O.page, OWNER);
  await O.page.waitForSelector('.lib-line:has-text("আপনার নিজের লাইব্রেরি")', { timeout: 20000 });
  assert.match(await O.page.locator('#cloud').innerText(), new RegExp(OWNER.email));
  await O.page.goto(`${base}#/b/b_h031`);
  await O.page.click('button:has-text("প্রিয়")');

  // Share with the member's Gmail.
  await O.page.goto(`${base}#/settings`);
  await O.page.fill('.share input[type=email]', `  ${MEMBER.email.toUpperCase()} `);
  await O.page.click('.share button[type=submit]');
  await O.page.waitForSelector(`.member:has-text("${MEMBER.email}")`, { timeout: 20000 });
  await O.page.waitForSelector('.lib-line:has-text("১")');

  // The member logs in with their own Google account and is offered the library.
  await openApp(J.page, base, '#/settings');
  await googleSignIn(J.page, MEMBER);
  await J.page.waitForSelector('.invite:has-text("Mazeda")', { timeout: 20000 });
  await J.page.click('.invite button:has-text("যোগ দিন")');
  await J.page.waitForSelector('.lib-line:has-text("Mazeda")', { timeout: 20000 });
  assert.equal(await J.page.locator('.share').count(), 0, 'members do not manage sharing');

  // Changes flow both ways.
  await J.page.goto(`${base}#/b/b_h031`);
  await J.page.waitForSelector('.btn.primary:has-text("প্রিয়")', { timeout: 20000 });
  await J.page.click('.seg button:has-text("পড়া শেষ")');
  await O.page.goto(`${base}#/b/b_h031`);
  await O.page.waitForSelector('.seg button.on:has-text("পড়া শেষ")', { timeout: 20000 });
  await O.page.goto(`${base}#/`);
  await O.page.waitForSelector('.sync.ok', { timeout: 30000 });

  // The member's phone keeps the same library after a restart (works offline too).
  await J.page.reload();
  await J.page.goto(`${base}#/settings`);
  await J.page.waitForSelector('.lib-line:has-text("Mazeda")', { timeout: 20000 });

  // The owner removes the member: their phone notices, keeps every book, and can carry on alone.
  await O.page.goto(`${base}#/settings`);
  await O.page.click(`.member:has-text("${MEMBER.email}") button`);
  await O.page.click('.sheet .btn.danger');
  await O.page.waitForFunction(() => !document.querySelector('.member'), null, { timeout: 20000 });
  await J.page.waitForSelector('#cloud :text("প্রবেশাধিকার আর নেই")', { timeout: 30000 });
  await J.page.click('button:has-text("নিজের লাইব্রেরি হিসেবে রাখুন")');
  await J.page.waitForSelector('.lib-line:has-text("আপনার নিজের লাইব্রেরি")', { timeout: 20000 });
  await J.page.goto(`${base}#/b/b_h031`);
  await J.page.waitForSelector('.seg button.on:has-text("পড়া শেষ")');
  await J.page.click('.seg button:has-text("পড়ছি")');
  await J.page.goto(`${base}#/`);
  await J.page.waitForSelector('.sync.ok', { timeout: 30000 });
  // ...and that edit stays out of the owner's library.
  await O.page.goto(`${base}#/b/b_h031`);
  await O.page.waitForTimeout(1500);
  assert.equal(await O.page.locator('.seg button.on').innerText(), 'পড়া শেষ');

  assert.deepEqual([...O.errors, ...J.errors].filter((e) => !expected.test(e)), []);
  await O.context.close();
  await J.context.close();
});

test('on Firebase Hosting a fresh phone needs no setup: it finds the project by itself', { skip: !RUN && 'needs the Firebase emulators (bash tests/e2e/run-sync.sh)' }, async (t) => {
  const reachable = await fetch(`${HOSTING}__/firebase/init.json`).then((r) => r.ok, () => false);
  if (!reachable) return t.skip('hosting emulator not running');
  const P = await device('fresh', { config: null, serviceWorkers: 'block' });
  // A custom domain says so in config.js; *.web.app / *.firebaseapp.com need nothing at all.
  await P.context.route('**/config.js', (r) => r.fulfill({ contentType: 'text/javascript', body: 'window.MAZEDAR_CONFIG = { firebase: null, hosting: true };' }));
  await openApp(P.page, HOSTING, '#/settings');
  await P.page.waitForSelector('button.google', { timeout: 20000 });
  const saved = await P.page.evaluate(() => JSON.parse(localStorage.getItem('mazedar:hostingConfig')));
  assert.equal(saved.projectId, 'demo-mazedar');
  await P.context.close();
});
