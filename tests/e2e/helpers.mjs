// Shared Playwright helpers for the browser tests.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { startServer } from '../../tools/serve.mjs';

const require = createRequire(import.meta.url);
export const { chromium } = require('playwright');
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let portSeq = 8800 + Math.floor((process.pid % 100) * 3);

export async function launch({ args = [] } = {}) {
  const port = (portSeq += 1);
  const server = await startServer({ port, root: ROOT });
  const browser = await chromium.launch({ args });
  return {
    base: `http://127.0.0.1:${port}/`,
    browser,
    async close() {
      await browser.close();
      await new Promise((ok) => server.close(ok));
    },
  };
}

/** A phone-sized browser context; collects console errors and page errors. */
export async function phone(browser, opts = {}) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    locale: 'bn-BD',
    ...opts,
  });
  const errors = [];
  context.on('page', (p) => watch(p, errors));
  const page = await context.newPage();
  return { context, page, errors };
}

function watch(page, errors) {
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    const t = m.text();
    // tesseract's wasm core prints harmless "Parameter not found" warnings on stderr
    if (m.type() === 'error' && !/favicon|Failed to load resource: net::ERR_INTERNET_DISCONNECTED|Parameter not found/.test(t)) errors.push(`console: ${t}`);
  });
}

export async function openApp(page, base, hash = '#/') {
  await page.goto(`${base}${hash}`);
  await page.waitForSelector('#app .page', { timeout: 20000 });
  await page.waitForFunction(() => !document.getElementById('splash'));
}

export const bnDigits = (n) => String(n).replace(/[0-9]/g, (d) => '০১২৩৪৫৬৭৮৯'[d]);
