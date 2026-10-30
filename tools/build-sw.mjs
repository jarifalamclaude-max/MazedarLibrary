// Generates sw.js: the precache list of the app shell plus a content hash, so
// every change to the app produces a new service worker (and the in-app
// "নতুন সংস্করণ" prompt). Run: node tools/build-sw.mjs
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await walk(rel)));
    else out.push(rel);
  }
  return out;
}

const files = [
  'index.html',
  'manifest.webmanifest',
  ...(await walk('src')).filter((f) => /\.(js|css)$/.test(f)),
  ...(await walk('assets')),
  ...(await walk('icons')),
  'vendor/preact-htm.js',
  'vendor/firebase.js',
  'vendor/qrcode.js',
  'vendor/tesseract/tesseract.esm.min.js',
  'vendor/tesseract/worker.min.js',
].map((f) => relative(root, join(root, f)).split('\\').join('/')).sort();

const hash = createHash('sha256');
for (const f of files) {
  hash.update(f);
  hash.update(await readFile(join(root, f)));
}
const version = hash.digest('hex').slice(0, 12);
const template = await readFile(join(root, 'tools/sw.template.js'), 'utf8');
const sw = template
  .replace('__VERSION__', version)
  .replace('__PRECACHE__', JSON.stringify(files, null, 2));
await writeFile(join(root, 'sw.js'), sw);
console.log(`sw.js: ${files.length} files, version ${version}`);
