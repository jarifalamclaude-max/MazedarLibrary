// Renders compose.html frame by frame (deterministic timeline) into JPEG frames.
// Usage: node tools/promo/render.mjs FRAMES_DIR [fps] [onlyTimes,comma,separated]
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch, ROOT } from '../../tests/e2e/helpers.mjs';

const dir = process.argv[2] || join(ROOT, '.tmp/promo/frames');
const fps = Number(process.argv[3] || 30);
const only = process.argv[4] ? process.argv[4].split(',').map(Number) : null;
mkdirSync(dir, { recursive: true });
const meta = JSON.parse(readFileSync(join(ROOT, '.tmp/promo/shots/meta.json'), 'utf8'));

const env = await launch();
const ctx = await env.browser.newContext({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 });
await ctx.addInitScript((m) => { window.PROMO_META = m; }, meta);
const page = await ctx.newPage();
page.on('pageerror', (e) => console.error('pageerror', e.message));
await page.goto(`${env.base}tools/promo/compose.html`);
await page.evaluate(() => window.imagesReady());
const duration = await page.evaluate(() => window.DURATION);
const times = only || Array.from({ length: Math.round(duration * fps) }, (_, f) => f / fps);
let n = 0;
for (const t of times) {
  await page.evaluate((x) => window.render(x), t);
  const name = only ? `t${t.toFixed(2)}` : String(n).padStart(5, '0');
  await page.screenshot({ path: join(dir, `${name}.jpg`), type: 'jpeg', quality: 92 });
  n += 1;
  if (!only && n % 150 === 0) console.log(`${n}/${times.length} frames`);
}
await env.close();
console.log(`rendered ${n} frames to ${dir}`);
