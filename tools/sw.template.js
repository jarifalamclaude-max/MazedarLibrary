// মাজেদার লাইব্রেরি — service worker (generated from tools/sw.template.js by
// tools/build-sw.mjs; edit the template, not sw.js).
//
// - The app shell is precached per version, so the app opens with no network.
// - OCR engine files and language data are cached the first time they are used
//   (only the engine variant the phone needs is downloaded) and survive updates.
// - config.js is network-first so a newly pasted Firebase config is picked up.
// - Cross-origin requests (Firebase, Gemini) are never intercepted.
const VERSION = '__VERSION__';
const PRECACHE = __PRECACHE__;
const SHELL = `mazedar-shell-${VERSION}`;
const RUNTIME = 'mazedar-runtime-v1';
const NETWORK_FIRST = new Set(['config.js']);
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

async function networkFirst(request, path) {
  const rt = await caches.open(RUNTIME);
  try {
    const res = await fetch(request, { cache: 'no-cache' });
    if (res.ok) await rt.put(path, res.clone());
    return res;
  } catch (e) {
    const hit = await rt.match(path);
    if (hit) return hit;
    throw e;
  }
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
  if (NETWORK_FIRST.has(path)) {
    event.respondWith(networkFirst(request, path));
    return;
  }
  event.respondWith(cacheFirst(request, path));
});
