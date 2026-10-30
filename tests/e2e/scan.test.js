// Scanner end to end: a rendered book cover is fed to Chromium as the phone
// camera; the app reads it with the offline OCR and must recognise the book.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, launch, phone, openApp, ROOT } from './helpers.mjs';

const dir = mkdtempSync(join(tmpdir(), 'mazedar-scan-'));
const fontCss = readFileSync(join(ROOT, 'assets/fonts/fonts.css'), 'utf8').replace(/url\(\.\//g, `url(file://${ROOT}/assets/fonts/`);

async function renderCover(file, { title, author, bg = '#7b1fa2', fg = '#fff' }) {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 720, height: 1280 } });
  await p.setContent(`<html><head><style>${fontCss}
    body{margin:0;width:720px;height:1280px;background:#d9d2c5;display:grid;place-items:center}
    .c{width:430px;height:640px;background:${bg};color:${fg};border-radius:8px;box-shadow:0 20px 40px rgba(0,0,0,.35);
       display:flex;flex-direction:column;justify-content:space-between;align-items:center;padding:60px 30px;box-sizing:border-box;text-align:center}
    h1{font-family:'Tiro Bangla';font-weight:400;font-size:60px;line-height:1.25;margin:0}
    p{font-family:'Hind Siliguri';font-size:30px;margin:0}</style></head>
    <body><div class="c"><h1>${title}</h1><p>${author}</p></div></body></html>`);
  await p.waitForTimeout(400);
  const png = `${file}.png`;
  await p.screenshot({ path: png });
  await b.close();
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-loop', '1', '-i', png, '-t', '2', '-r', '10', '-pix_fmt', 'yuv420p', `${file}.y4m`]);
  return `${file}.y4m`;
}

let owned;
let unowned;
before(async () => {
  owned = await renderCover(join(dir, 'owned'), { title: 'হিমুর দ্বিতীয়<br>প্রহর', author: 'হুমায়ূন আহমেদ' });
  unowned = await renderCover(join(dir, 'unowned'), { title: 'দেয়াল', author: 'হুমায়ূন আহমেদ', bg: '#1b5e20' });
});

async function scanWith(video, hash) {
  const env = await launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-video-capture=${video}`] });
  const d = await phone(env.browser, { permissions: ['camera'] });
  await openApp(d.page, env.base, hash);
  await d.page.waitForSelector('.shutter:not([disabled])', { timeout: 20000 });
  await d.page.waitForTimeout(1200);
  await d.page.click('.shutter');
  return { env, d };
}

after(() => {});

test('search mode: an owned book held up to the camera is found ("হ্যাঁ! আছে")', { timeout: 180000 }, async () => {
  const { env, d } = await scanWith(owned, '#/scan?mode=search');
  await d.page.waitForSelector('.result-big', { timeout: 120000 });
  const verdict = await d.page.locator('.result-big').innerText();
  const card = await d.page.locator('.sheet .book .t').first().innerText().catch(() => '');
  assert.match(verdict, /সংগ্রহে আছে/, `verdict: ${verdict}`);
  assert.equal(card, 'হিমুর দ্বিতীয় প্রহর');
  assert.deepEqual(d.errors, []);
  await env.close();
});

test('add mode: an unowned list title opens the form pre-filled and linked to the list', { timeout: 180000 }, async () => {
  const { env, d } = await scanWith(unowned, '#/scan?mode=add');
  await d.page.waitForSelector('.sheet input.book-font', { timeout: 120000 });
  assert.equal(await d.page.inputValue('.sheet input.book-font'), 'দেয়াল');
  await d.page.waitForSelector('.sheet .badge:has-text("যুক্ত")');
  await d.page.click('.sheet button[type=submit]');
  await d.page.waitForSelector('.toast:has-text("যোগ হলো")', { timeout: 10000 });
  await d.page.goto(`${env.base}#/a/a_humayun`);
  await d.page.waitForSelector('.feature .need');
  assert.match(await d.page.locator('.feature .need').innerText(), /১২৩/);
  assert.deepEqual(d.errors, []);
  await env.close();
});
