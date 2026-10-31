// End-to-end tests of the real app in Chromium (phone viewport).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, phone, openApp, bnDigits } from './helpers.mjs';
import { sortKey } from '../../src/lib/bangla.js';

let env;
before(async () => { env = await launch(); });
after(async () => { await env.close(); });

async function counter(page) {
  const txt = await page.locator('.feature .need').first().innerText();
  return txt.replace(/\s+/g, ' ').trim();
}

test('seeds 113 owned books and the 236-title ideal list; counter says 124 still needed', async () => {
  const { context, page, errors } = await phone(env.browser);
  await openApp(page, env.base);
  assert.match(await page.locator('.hero .big').innerText(), new RegExp(`${bnDigits(113)}টি বই`));
  assert.equal(await counter(page), `সব পেতে আরো লাগবে ${bnDigits(124)}টি`);
  await page.click('.feature');
  await page.waitForSelector('.tabs');
  const tabs = (await page.locator('.tabs .tab').allInnerTexts()).map((t) => t.replace(/\s+/g, ' '));
  assert.deepEqual(tabs, [`আমার বই ${bnDigits(113)}টি`, `সংগ্রহে নেই ${bnDigits(124)}টি`, `সম্পূর্ণ তালিকা ${bnDigits(236)}টি`]);
  assert.equal(await page.locator('.book-list .book').count(), 113);
  assert.deepEqual(errors, []);
  await context.close();
});

test('author folder sorts in Bengali dictionary order (অ → হ and হ → অ)', async () => {
  const { context, page, errors } = await phone(env.browser);
  await openApp(page, env.base, '#/a/a_humayun');
  const titles = await page.locator('.book-list .book .t').allInnerTexts();
  const sorted = [...titles].sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0));
  assert.deepEqual(titles, sorted);
  assert.ok(titles[0].startsWith('অ'), `first title should start with অ, got ${titles[0]}`);
  await page.selectOption('.toolbar select', 'za');
  const rev = await page.locator('.book-list .book .t').allInnerTexts();
  assert.deepEqual(rev, [...sorted].reverse());
  await page.selectOption('.toolbar select', 'serial');
  const serial = await page.locator('.book-list .book .t').allInnerTexts();
  assert.equal(serial[0], 'ইমা');
  assert.equal(serial[1], 'আমাদের শাদা বাড়ি');
  assert.deepEqual(errors, []);
  await context.close();
});

test('search finds books typed in Bengali and in Banglish', async () => {
  const { context, page, errors } = await phone(env.browser);
  await openApp(page, env.base);
  const search = async (q) => {
    await page.fill('.searchbar input', q);
    await page.waitForTimeout(400);
    return page.locator('.book-list .book .t').allInnerTexts();
  };
  const himu = await search('হিমু');
  assert.ok(himu.length >= 15, `হিমু → ${himu.length}`);
  assert.ok(himu.includes('হিমু মামা'));
  const himuLatin = await search('himu');
  assert.ok(himuLatin.includes('হিমু মামা'), 'Banglish himu');
  const misir = await search('misir ali');
  assert.ok(misir.some((t) => t.includes('মিসির')), 'Banglish misir ali');
  const josna = await search('jochona');
  assert.ok(josna.some((t) => t.includes('জোছনা')), 'Banglish jochona');
  const variant = await search('মধ্যদুপুর');
  assert.ok(variant.includes('হিমুর মধ্য দুপুর'), 'spacing variant');
  await page.fill('.searchbar input', 'দেয়াল');
  await page.waitForTimeout(400);
  assert.ok(await page.locator('.missing-item', { hasText: 'দেয়াল' }).count(), 'unowned title listed under সংগ্রহে নেই');
  assert.deepEqual(errors, []);
  await context.close();
});

test('add author + book, edit it, delete to trash and restore; data survives reload', async () => {
  const { context, page, errors } = await phone(env.browser);
  await openApp(page, env.base);
  await page.click('.author-card.add');
  await page.fill('.sheet input', 'সমরেশ মজুমদার');
  await page.click('.sheet button[type=submit]');
  await page.waitForSelector('.topbar h1:has-text("সমরেশ মজুমদার")');
  await page.click('.fab');
  await page.fill('.sheet input.book-font', 'সাতকাহন');
  await page.click('.sheet button[type=submit]');
  await page.waitForSelector('.book-list .book:has-text("সাতকাহন")');
  await page.click('.book-list .book:has-text("সাতকাহন")');
  await page.click('button:has-text("সম্পাদনা")');
  await page.fill('.sheet input[list=cat-suggestions]', 'উপন্যাস');
  await page.click('.sheet button[type=submit]');
  await page.waitForSelector('.badge:has-text("উপন্যাস")');
  await page.reload();
  await page.waitForSelector('.badge:has-text("উপন্যাস")');
  await page.click('button:has-text("মুছে ফেলুন")');
  await page.click('.sheet .btn.danger');
  await page.waitForSelector('.topbar h1:has-text("সমরেশ মজুমদার")');
  assert.equal(await page.locator('.book-list .book:has-text("সাতকাহন")').count(), 0);
  await page.goto(`${env.base}#/trash`);
  await page.waitForSelector('.book:has-text("সাতকাহন")');
  await page.click('.book:has-text("সাতকাহন") button:has-text("ফেরত")');
  await page.goto(`${env.base}#/`);
  await page.waitForSelector('.author-card:has-text("সমরেশ মজুমদার")');
  assert.match(await page.locator('.author-card:has-text("সমরেশ মজুমদার") .ct').innerText(), new RegExp(`${bnDigits(1)}টি বই`));
  assert.deepEqual(errors, []);
  await context.close();
});

test('“পেয়েছি” lowers the countdown; a newly found title raises it', async () => {
  const { context, page, errors } = await phone(env.browser);
  await openApp(page, env.base, '#/a/a_humayun/missing');
  await page.locator('.missing-item:has-text("দেয়াল") button:has-text("পেয়েছি")').click();
  await page.waitForFunction(() => document.querySelector('.feature .need')?.innerText.includes('১২৩'));
  await page.click('button:has-text("নতুন নাম")');
  await page.fill('.sheet input.book-font', 'একজন নতুন বই');
  await page.click('.sheet button[type=submit]');
  await page.waitForFunction(() => document.querySelector('.feature .need')?.innerText.includes('১২৪'));
  const tabs = await page.locator('.tabs .tab').allInnerTexts();
  assert.match(tabs[2].replace(/\s+/g, ' '), new RegExp(bnDigits(237)));
  assert.deepEqual(errors, []);
  await context.close();
});

test('the duplicate (তারা তিন জন / তারা তিনজন) is flagged and can be merged into 2 copies', async () => {
  const { context, page, errors } = await phone(env.browser);
  await openApp(page, env.base, '#/dupes');
  await page.waitForSelector('.card:has-text("তারা তিন জন")');
  await page.click('button:has-text("এক করুন")');
  await page.waitForSelector('.empty');
  await page.goto(`${env.base}#/b/b_h016`);
  await page.waitForSelector('.badge:has-text("২ কপি")');
  await page.goto(`${env.base}#/`);
  await page.waitForSelector('.hero');
  assert.match(await page.locator('.hero .big').innerText(), new RegExp(`${bnDigits(112)}টি বই`));
  assert.equal(await counter(page), `সব পেতে আরো লাগবে ${bnDigits(124)}টি`);
  assert.deepEqual(errors, []);
  await context.close();
});

test('backup file round-trips into a fresh phone', async () => {
  const a = await phone(env.browser, { acceptDownloads: true });
  await openApp(a.page, env.base, '#/b/b_h001');
  await a.page.click('button:has-text("প্রিয়")');
  await a.page.goto(`${env.base}#/settings`);
  const [download] = await Promise.all([
    a.page.waitForEvent('download'),
    a.page.click('button:has-text("ব্যাকআপ ফাইল নামান")'),
  ]);
  const path = await download.path();
  const b = await phone(env.browser);
  await openApp(b.page, env.base, '#/settings');
  await b.page.setInputFiles('input[type=file][accept*=json]', path);
  await b.page.click('.sheet .btn.primary');
  await b.page.waitForSelector('.toast:has-text("ব্যাকআপ আনা হয়েছে")');
  await b.page.goto(`${env.base}#/b/b_h001`);
  await b.page.waitForSelector('.btn.primary:has-text("প্রিয়")');
  assert.deepEqual([...a.errors, ...b.errors], []);
  await a.context.close();
  await b.context.close();
});

test('opens with no network after the first visit (service worker)', async () => {
  const { context, page, errors } = await phone(env.browser);
  await page.goto(`${env.base}?sw=1#/`);
  await page.waitForSelector('#app .page');
  // installed (shell precached) and activated; activation claims this page
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 30000 });
  await context.setOffline(true);
  await page.reload();
  await page.waitForSelector('#app .hero', { timeout: 20000 });
  assert.match(await page.locator('.hero .big').innerText(), /টি বই/);
  await page.goto(`${env.base}?sw=1#/a/a_humayun`);
  await page.waitForSelector('.book-list .book');
  await context.setOffline(false);
  assert.deepEqual(errors.filter((e) => !/ERR_INTERNET_DISCONNECTED|net::/.test(e)), []);
  await context.close();
});
