// মাজেদার লাইব্রেরি — service worker (generated from tools/sw.template.js by
// tools/build-sw.mjs; edit the template, not sw.js).
//
// - The app shell is precached per version, so the app opens with no network.
// - OCR engine files and language data are cached the first time they are used
//   (only the engine variant the phone needs is downloaded) and survive updates.
// - config.js is served from cache and refreshed in the background (new config: next start).
// - Cross-origin requests (Firebase, Gemini) are never intercepted.
const VERSION = '__VERSION__';
const PRECACHE = __PRECACHE__;
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
