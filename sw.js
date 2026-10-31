// মাজেদার লাইব্রেরি — service worker (generated from tools/sw.template.js by
// tools/build-sw.mjs; edit the template, not sw.js).
//
// - The app shell is precached per version, so the app opens with no network.
// - OCR engine files and language data are cached the first time they are used
//   (only the engine variant the phone needs is downloaded) and survive updates.
// - config.js is served from cache and refreshed in the background (new config: next start).
// - Cross-origin requests (Firebase, Gemini) are never intercepted.
const VERSION = 'd16b8a6d2a4f';
const PRECACHE = [
  "assets/fonts/fonts.css",
  "assets/fonts/galada-bengali-400-normal.woff2",
  "assets/fonts/galada-latin-400-normal.woff2",
  "assets/fonts/hind-siliguri-bengali-400-normal.woff2",
  "assets/fonts/hind-siliguri-bengali-500-normal.woff2",
  "assets/fonts/hind-siliguri-bengali-600-normal.woff2",
  "assets/fonts/hind-siliguri-bengali-700-normal.woff2",
  "assets/fonts/hind-siliguri-latin-400-normal.woff2",
  "assets/fonts/hind-siliguri-latin-500-normal.woff2",
  "assets/fonts/hind-siliguri-latin-600-normal.woff2",
  "assets/fonts/hind-siliguri-latin-700-normal.woff2",
  "assets/fonts/tiro-bangla-bengali-400-normal.woff2",
  "assets/fonts/tiro-bangla-latin-400-normal.woff2",
  "icons/apple-touch-icon.png",
  "icons/favicon-32.png",
  "icons/favicon.svg",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/maskable-512.png",
  "index.html",
  "manifest.webmanifest",
  "src/app.js",
  "src/data/humayun.js",
  "src/lib/bangla.js",
  "src/lib/camera.js",
  "src/lib/clock.js",
  "src/lib/cloud.js",
  "src/lib/gemini.js",
  "src/lib/matcher.js",
  "src/lib/merge.js",
  "src/lib/ocr.js",
  "src/lib/replica.js",
  "src/lib/seed.js",
  "src/lib/store.js",
  "src/lib/sync.js",
  "src/ui/author.js",
  "src/ui/book.js",
  "src/ui/core.js",
  "src/ui/data.js",
  "src/ui/home.js",
  "src/ui/install.js",
  "src/ui/lily-svg.js",
  "src/ui/scan.js",
  "src/ui/settings.js",
  "src/ui/styles.css",
  "src/ui/sync-pill.js",
  "src/ui/welcome.js",
  "vendor/firebase.js",
  "vendor/preact-htm.js",
  "vendor/qrcode.js",
  "vendor/tesseract/tesseract.esm.min.js",
  "vendor/tesseract/worker.min.js"
];
const SHELL = `mazedar-shell-${VERSION}`;
const RUNTIME = 'mazedar-runtime-v1';
const FRESH_IN_BACKGROUND = new Set(['config.js']);
const RUNTIME_PREFIXES = ['vendor/', 'assets/', 'icons/'];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    await cache.addAll(PRECACHE.map((u) => new Request(u, { cache: 'reload' })));
    const rt = await caches.open(RUNTIME);
    try {
      const res = await fetch(new Request('config.js', { cache: 'reload' }));
      if (res.ok) await rt.put('config.js', res);
    } catch { /* offline during install: fine */ }
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('mazedar-shell-') && k !== SHELL).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

function scopedPath(url) {
  const scope = new URL(self.registration.scope);
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return null;
  return decodeURIComponent(url.pathname.slice(scope.pathname.length));
}

async function fromShell(path) {
  const cache = await caches.open(SHELL);
  return cache.match(path || 'index.html');
}

async function cacheFirst(request, path) {
  const hit = (await fromShell(path)) || (await (await caches.open(RUNTIME)).match(request, { ignoreSearch: true }));
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok && RUNTIME_PREFIXES.some((p) => path.startsWith(p))) {
    const copy = res.clone();
    caches.open(RUNTIME).then((c) => c.put(request, copy)).catch(() => {});
  }
  return res;
}

// config.js: answer from the cache at once and refresh it in the background, so
// a stalled network (e.g. a crowded book fair) can never hold the app on a
// blank page. A changed config takes effect from the next start.
async function staleWhileRevalidate(request, path) {
  const rt = await caches.open(RUNTIME);
  const cached = await rt.match(path);
  const refresh = fetch(request, { cache: 'no-cache' }).then(async (res) => {
    if (res.ok) await rt.put(path, res.clone());
    return res;
  });
  if (cached) {
    refresh.catch(() => {});
    return cached;
  }
  const fallback = () => new Response('window.MAZEDAR_CONFIG = window.MAZEDAR_CONFIG || { firebase: null };', { headers: { 'Content-Type': 'text/javascript; charset=utf-8' } });
  return Promise.race([refresh, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 4000))]).catch(fallback);
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  const path = scopedPath(url);
  if (path === null) return;
  if (request.mode === 'navigate') {
    event.respondWith(fromShell('index.html').then((r) => r || fetch(request)));
    return;
  }
  if (FRESH_IN_BACKGROUND.has(path)) {
    event.respondWith(staleWhileRevalidate(request, path));
    return;
  }
  event.respondWith(cacheFirst(request, path));
});
