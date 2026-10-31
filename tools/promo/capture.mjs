// Captures the real app, screen by screen, for the promo video.
// Run inside the Firebase emulators (for the two-phone scene):
//   npx -y firebase-tools@15.34.0 emulators:exec --only auth,firestore --project demo-mazedar 'node tools/promo/capture.mjs OUT_DIR'
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, launch, ROOT } from '../../tests/e2e/helpers.mjs';

const OUT = process.argv[2] || join(ROOT, '.tmp/promo');
mkdirSync(OUT, { recursive: true });
const meta = {};
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'bn-BD', timezoneId: 'Asia/Dhaka' };

async function ready(page, hash) {
  await page.goto(`${env.base}${hash}`);
  await page.waitForSelector('#app .page, #app .scanner', { timeout: 20000 });
  await page.waitForFunction(() => !document.getElementById('splash'));
  await page.waitForTimeout(600);
}
/** Screenshot; pop-up messages are hidden unless the scene is about one. */
async function shot(page, name, { toasts = false } = {}) {
  await page.evaluate((show) => {
    let s = document.getElementById('promo-hide-toasts');
    if (!s) {
      s = document.createElement('style');
      s.id = 'promo-hide-toasts';
      document.head.appendChild(s);
    }
    s.textContent = show ? '' : '.toasts{display:none!important}';
    // keep only the message the scene is about (not the backup reminder etc.)
    for (const el of document.querySelectorAll('.toast')) {
      el.style.display = /ব্যাকআপ|আলাদা বই হিসেবে|লগইন হয়েছে/.test(el.textContent) ? 'none' : '';
    }
  }, toasts);
  await page.screenshot({ path: join(OUT, `${name}.png`) });
}
/** Centre of an element in screenshot pixels (DPR 2). */
async function centre(page, selector) {
  const b = await page.locator(selector).first().boundingBox();
  return { x: Math.round((b.x + b.width / 2) * 2), y: Math.round((b.y + b.height / 2) * 2) };
}

// ---- a realistic cover for the camera scenes
const fontCss = readFileSync(join(ROOT, 'assets/fonts/fonts.css'), 'utf8').replace(/url\(\.\//g, `url(file://${ROOT}/assets/fonts/`);
async function cameraFeed(name, { title, author, bg }) {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 720, height: 1280 } });
  await p.setContent(`<html><head><style>${fontCss}
    body{margin:0;width:720px;height:1280px;display:grid;place-items:center;
      background:radial-gradient(900px 700px at 30% 20%, #e9d6bf, #b08d68 70%, #8c6a49)}
    .c{width:430px;height:640px;background:${bg};color:#fff;border-radius:6px 12px 12px 6px;
      box-shadow:0 30px 60px rgba(40,20,10,.45), inset 10px 0 0 rgba(255,255,255,.12);
      display:flex;flex-direction:column;justify-content:space-between;align-items:center;padding:70px 30px 50px;box-sizing:border-box;text-align:center;transform:rotate(-2deg)}
    h1{font-family:'Tiro Bangla';font-weight:400;font-size:62px;line-height:1.25;margin:0;text-shadow:0 2px 0 rgba(0,0,0,.15)}
    .a{font-family:'Hind Siliguri';font-size:32px;font-weight:600}
    .p{font-family:'Hind Siliguri';font-size:22px;opacity:.85;margin-top:10px}</style></head>
    <body><div class="c"><h1>${title}</h1><div><div class="a">${author}</div><div class="p">অন্যপ্রকাশ</div></div></div></body></html>`);
  await p.waitForTimeout(500);
  const png = join(OUT, `${name}-cover.png`);
  await p.screenshot({ path: png });
  await b.close();
  const y4m = join(OUT, `${name}.y4m`);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-loop', '1', '-i', png, '-t', '3', '-r', '10', '-pix_fmt', 'yuv420p', y4m]);
  return y4m;
}

let env = await launch();

// ---- home, Humayun folder, missing list, search
{
  const ctx = await env.browser.newContext(PHONE);
  const page = await ctx.newPage();
  // mark the listed duplicate as two separate books so the home page is clean for the video
  await ready(page, '#/dupes');
  await page.click('button:has-text("এগুলো আলাদা বই")');
  await ready(page, '#/');
  await shot(page, 'home');
  await page.screenshot({ path: join(OUT, 'home-full.png'), fullPage: true });
  await ready(page, '#/a/a_humayun');
  await shot(page, 'humayun');
  meta.counter = await centre(page, '.feature');
  await ready(page, '#/a/a_humayun/missing');
  await page.locator('.missing-item:has-text("দেয়াল")').scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, -300));
  await page.waitForTimeout(400);
  await shot(page, 'missing');
  meta.gotIt = await centre(page, '.missing-item:has-text("দেয়াল") button:has-text("পেয়েছি")');
  await page.locator('.missing-item:has-text("দেয়াল") button:has-text("পেয়েছি")').click();
  await page.waitForTimeout(260);
  await shot(page, 'missing-after', { toasts: true });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(1600);
  await shot(page, 'missing-after-top', { toasts: true });
  await ready(page, '#/');
  const typed = 'himu';
  for (let i = 1; i <= typed.length; i += 1) {
    await page.fill('.searchbar input', typed.slice(0, i));
    await page.waitForTimeout(450);
    await shot(page, `search-${i}`);
  }
  await page.fill('.searchbar input', '');
  await ctx.close();
}

// ---- dark mode
{
  const ctx = await env.browser.newContext({ ...PHONE, colorScheme: 'dark' });
  const page = await ctx.newPage();
  await ready(page, '#/b/b_h050');
  await shot(page, 'dark-book');
  await ready(page, '#/a/a_humayun');
  await shot(page, 'dark-humayun');
  await ctx.close();
}
await env.close();

// ---- scanner with a camera pointed at a real-looking cover
{
  const y4m = await cameraFeed('scan', { title: 'হিমুর দ্বিতীয়<br>প্রহর', author: 'হুমায়ূন আহমেদ', bg: 'linear-gradient(160deg,#6a1b9a,#ad1457)' });
  env = await launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-video-capture=${y4m}`] });
  const ctx = await env.browser.newContext({ ...PHONE, permissions: ['camera'] });
  const page = await ctx.newPage();
  await ready(page, '#/scan?mode=search');
  await page.waitForSelector('.shutter:not([disabled])', { timeout: 20000 });
  await page.waitForTimeout(1500);
  await shot(page, 'scan-live');
  meta.shutter = await centre(page, '.shutter');
  await page.click('.shutter');
  await page.waitForSelector('.reading', { timeout: 5000 }).catch(() => {});
  await shot(page, 'scan-reading');
  await page.waitForSelector('.result-big', { timeout: 120000 });
  await page.waitForTimeout(500);
  await shot(page, 'scan-result');
  await ctx.close();
  await env.close();
}

// ---- two phones, one account (real sync through the Firebase emulators)
if (process.env.FIRESTORE_EMULATOR_HOST) {
  const [host, port] = process.env.FIRESTORE_EMULATOR_HOST.split(':');
  const cfg = {
    apiKey: 'demo-key', authDomain: 'demo-mazedar.firebaseapp.com', projectId: 'demo-mazedar', appId: '1:1234:web:abcd',
    emulators: { auth: `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099'}`, firestore: { host, port: Number(port) } },
  };
  env = await launch();
  const phone = async () => {
    const ctx = await env.browser.newContext(PHONE);
    await ctx.addInitScript((c) => localStorage.setItem('mazedar:firebaseConfig', JSON.stringify(c)), cfg);
    return { ctx, page: await ctx.newPage() };
  };
  const signIn = async (page, create) => {
    await ready(page, '#/settings');
    await page.waitForSelector('input[type=email]', { timeout: 20000 });
    await page.fill('input[type=email]', 'mazeda@example.com');
    await page.fill('input[autocomplete=current-password]', 'lily-123456');
    await page.click(create ? 'button:has-text("নতুন অ্যাকাউন্ট খুলুন")' : 'button[type=submit]:has-text("লগইন")');
    await ready(page, '#/');
    await page.waitForSelector('.sync.ok', { timeout: 30000 });
  };
  const A = await phone();
  const B = await phone();
  await signIn(A.page, true);
  await signIn(B.page, false);
  for (const p of [A.page, B.page]) {
    await ready(p, '#/dupes');
    await p.click('button:has-text("এগুলো আলাদা বই")').catch(() => {});
  }
  await ready(B.page, '#/');
  await B.page.evaluate(() => window.scrollTo(0, document.querySelector('.authors').getBoundingClientRect().top + window.scrollY - 220));
  await B.page.waitForSelector('.sync.ok', { timeout: 30000 });
  await B.page.waitForTimeout(500);
  await shot(B.page, 'sync-b-before');
  await ready(A.page, '#/new');
  await A.page.waitForSelector('.sheet input.book-font');
  await A.page.fill('.sheet input.book-font', 'সাতকাহন');
  await A.page.selectOption('.sheet select', '__new');
  await A.page.fill('.sheet input[placeholder="যেমন: সমরেশ মজুমদার"]', 'সমরেশ মজুমদার');
  await A.page.waitForTimeout(300);
  await shot(A.page, 'sync-a-form');
  await A.page.click('.sheet button[type=submit]');
  await A.page.waitForTimeout(1200);
  await shot(A.page, 'sync-a-added', { toasts: true });
  await B.page.waitForSelector('.author-card:has-text("সমরেশ মজুমদার")', { timeout: 30000 });
  await B.page.waitForSelector('.sync.ok', { timeout: 30000 });
  await B.page.waitForTimeout(400);
  await shot(B.page, 'sync-b-after');
  await A.ctx.close();
  await B.ctx.close();
  await env.close();
} else {
  console.warn('no emulator: skipping the two-phone scene');
}

writeFileSync(join(OUT, 'meta.json'), JSON.stringify(meta, null, 2));
console.log('captured to', OUT, meta);
