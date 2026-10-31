// The service worker must precache every file the app shell needs, or the app
// will not open offline. Fails when sw.js is stale (run `npm run build:sw`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(import.meta.url), '..', '..', '..');

function walk(dir) {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`]));
}

test('sw.js precaches the whole app shell and nothing missing', () => {
  const sw = readFileSync(join(root, 'sw.js'), 'utf8');
  const list = JSON.parse(sw.match(/const PRECACHE = (\[[\s\S]*?\]);/)[1]);
  const need = [
    'index.html', 'manifest.webmanifest',
    ...walk('src').filter((f) => /\.(js|css)$/.test(f)),
    ...walk('assets'), ...walk('icons'),
    'vendor/preact-htm.js', 'vendor/firebase.js', 'vendor/qrcode.js',
    'vendor/tesseract/tesseract.esm.min.js', 'vendor/tesseract/worker.min.js',
  ].map((f) => relative(root, join(root, f)).split('\\').join('/'));
  const missing = need.filter((f) => !list.includes(f));
  assert.deepEqual(missing, [], 'sw.js is stale — run `npm run build:sw`');
  const gone = list.filter((f) => !existsSync(join(root, f)));
  assert.deepEqual(gone, [], 'sw.js lists files that do not exist');
});
