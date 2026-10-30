// Renders the PWA icons (PNG) from the lily SVG with headless Chromium.
// Run: node tools/make-icons.mjs
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { iconSvg } from '../src/ui/lily-svg.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = (...p) => join(root, 'icons', ...p);

await mkdir(out(), { recursive: true });
await writeFile(out('favicon.svg'), iconSvg({ size: 64, padding: 0.02 }));

const browser = await chromium.launch();
const page = await browser.newPage();
const shots = [
  ['icon-192.png', 192, {}],
  ['icon-512.png', 512, {}],
  ['maskable-512.png', 512, { maskable: true, padding: 0.12 }],
  ['apple-touch-icon.png', 180, { maskable: true, padding: 0.06 }],
  ['favicon-32.png', 32, { padding: 0.02 }],
];
for (const [name, size, opts] of shots) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${iconSvg({ size, ...opts })}</body></html>`);
  await page.screenshot({ path: out(name), omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
}
await browser.close();
console.log('icons written');
