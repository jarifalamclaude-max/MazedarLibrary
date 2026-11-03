// Two phones, one account, real Firebase Auth + Firestore emulators.
// Run via:  bash tests/e2e/run-sync.sh   (starts the emulators, then this file)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, phone, openApp } from './helpers.mjs';

const RUN = !!process.env.FIRESTORE_EMULATOR_HOST;
const [fsHost, fsPort] = (process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080').split(':');
const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';
const CONFIG = {
  apiKey: 'demo-key',
  authDomain: 'demo-mazedar.firebaseapp.com',
  projectId: 'demo-mazedar',
  appId: '1:1234:web:abcd',
  emulators: { auth: `http://${authHost}`, firestore: { host: fsHost, port: Number(fsPort) } },
};
const EMAIL = `mazeda${process.pid}@example.com`;
const PASSWORD = 'lily-123456';

let env;
before(async () => { if (RUN) env = await launch(); });
after(async () => { await env?.close(); });

async function device(name) {
  const d = await phone(env.browser);
  await d.context.addInitScript((cfg) => localStorage.setItem('mazedar:firebaseConfig', JSON.stringify(cfg)), CONFIG);
  await d.context.route('https://apis.google.com/**', (r) => r.abort()); // Google's sign-in helper (unreachable here)
  d.name = name;
  return d;
}

async function waitSynced(page) {
  await page.waitForSelector('.sync.ok', { timeout: 30000 });
}

async function signIn(page, base, { create = false } = {}) {
  await openApp(page, base, '#/settings');
  await page.click('summary:has-text("ইমেইল-পাসওয়ার্ড")', { timeout: 20000 });
  await page.waitForSelector('input[type=email]', { timeout: 20000 });
  await page.fill('input[type=email]', EMAIL);
  await page.fill('input[autocomplete=current-password]', PASSWORD);
  await page.click(create ? 'button:has-text("নতুন অ্যাকাউন্ট খুলুন")' : 'button[type=submit]:has-text("লগইন")');
  await page.goto(`${base}#/`);
  await waitSynced(page);
}

async function bookTitles(page, authorId) {
  await page.goto(`${env.base}#/a/${authorId}`);
  await page.waitForSelector('.page');
  return page.locator('.book-list .book .t').allInnerTexts();
}

test('two phones on one account stay in sync, including offline edits on both', { skip: !RUN && 'needs the Firebase emulators (bash tests/e2e/run-sync.sh)' }, async () => {
  const A = await device('A');
  const B = await device('B');
  await signIn(A.page, env.base, { create: true });
  await signIn(B.page, env.base);

  // A adds an author and a book; it shows up on B.
  await A.page.click('.author-card.add');
  await A.page.fill('.sheet input', 'সমরেশ মজুমদার');
  await A.page.click('.sheet button[type=submit]');
  await A.page.waitForSelector('.topbar h1:has-text("সমরেশ মজুমদার")');
  const authorId = A.page.url().split('#/a/')[1];
  await A.page.click('.fab');
  await A.page.fill('.sheet input.book-font', 'সাতকাহন');
  await A.page.click('.sheet button[type=submit]');
  await A.page.waitForSelector('.book-list .book:has-text("সাতকাহন")');
  await B.page.goto(`${env.base}#/a/${authorId}`);
  await B.page.waitForSelector('.book-list .book:has-text("সাতকাহন")', { timeout: 20000 });

  // A seed book edited on A appears on B (seeds are shared without ever being uploaded).
  await A.page.goto(`${env.base}#/b/b_h031`);
  await A.page.click('button:has-text("প্রিয়")');
  await B.page.goto(`${env.base}#/b/b_h031`);
  await B.page.waitForSelector('.btn.primary:has-text("প্রিয়")', { timeout: 20000 });

  // Both phones offline, each edits a different field of the same book.
  await A.context.setOffline(true);
  await B.context.setOffline(true);
  await A.page.goto(`${env.base}#/b/b_h031`);
  await A.page.click('.seg button:has-text("পড়া শেষ")');
  await A.page.goto(`${env.base}#/`);
  await A.page.waitForSelector('.sync.off', { timeout: 20000 });
  assert.match(await A.page.locator('.sync').innerText(), /অফলাইন/);
  await B.page.goto(`${env.base}#/b/b_h031`);
  await B.page.click('button:has-text("সম্পাদনা")');
  await B.page.click('summary');
  await B.page.fill('.sheet input[placeholder="যেমন: অন্যপ্রকাশ"]', 'অন্যপ্রকাশ');
  await B.page.click('.sheet button[type=submit]');
  // Both back online: both edits survive on both phones.
  await A.context.setOffline(false);
  await B.context.setOffline(false);
  for (const d of [A, B]) {
    await d.page.goto(`${env.base}#/b/b_h031`);
    await d.page.waitForSelector('.seg button.on:has-text("পড়া শেষ")', { timeout: 30000 });
    await d.page.waitForSelector('dd:has-text("অন্যপ্রকাশ")', { timeout: 30000 });
  }

  // Delete on B disappears on A; restore on A comes back on B.
  await B.page.goto(`${env.base}#/a/${authorId}`);
  await B.page.click('.book-list .book:has-text("সাতকাহন")');
  await B.page.click('button:has-text("মুছে ফেলুন")');
  await B.page.click('.sheet .btn.danger');
  await A.page.goto(`${env.base}#/a/${authorId}`);
  await A.page.waitForFunction(() => ![...document.querySelectorAll('.book .t')].some((e) => e.textContent.includes('সাতকাহন')), null, { timeout: 20000 });
  await A.page.goto(`${env.base}#/trash`);
  await A.page.click('.book:has-text("সাতকাহন") button:has-text("ফেরত")');
  const onB = await (async () => {
    for (let i = 0; i < 40; i += 1) {
      const t = await bookTitles(B.page, authorId);
      if (t.includes('সাতকাহন')) return t;
      await B.page.waitForTimeout(500);
    }
    return [];
  })();
  assert.ok(onB.includes('সাতকাহন'));

  // Same counters on both phones.
  for (const d of [A, B]) {
    await d.page.goto(`${env.base}#/`);
    await waitSynced(d.page);
  }
  const need = await Promise.all([A, B].map((d) => d.page.locator('.feature .need').innerText()));
  assert.equal(need[0], need[1]);
  // A 400 on documents:commit is a transaction that lost a race with the other
  // phone (both pushed the same book at once); it is retried, as the converged
  // state above shows, so the browser's log line for it is expected.
  const expected = /net::|ERR_INTERNET_DISCONNECTED|ERR_FAILED|WebChannelConnection|Could not reach Cloud Firestore|400 POST \S+documents:commit|apis\.google\.com/;
  assert.deepEqual([...A.errors, ...B.errors].filter((e) => !expected.test(e)), []);
  await A.context.close();
  await B.context.close();
});
