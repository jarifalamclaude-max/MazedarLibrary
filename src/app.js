// মাজেদার লাইব্রেরি — app entry: open the local library, seed it, start cloud
// sync (if set up), render the UI and keep the offline service worker fresh.
import { html, render, useState, useEffect } from '../vendor/preact-htm.js';
import { ctx, useRoute, ModalHost, Toasts, Icon, toast } from './ui/core.js';
import { openStore } from './lib/store.js';
import { buildSeedRecords, SEED_VERSION } from './lib/seed.js';
import { createCloud } from './lib/cloud.js';
import { useLib, getLib } from './ui/data.js';
import { maybeShowWelcome } from './ui/welcome.js';
import { HomePage } from './ui/home.js';
import { AuthorPage } from './ui/author.js';
import { BookPage, NewBookRoute } from './ui/book.js';
import { ScanPage } from './ui/scan.js';
import { SettingsPage, TrashPage, DupesPage, SetupPage, PrintPage } from './ui/settings.js';

globalThis.MAZEDAR_VERSION = '1.0.0';

function Nav({ route }) {
  const p = route.parts[0] || '';
  const home = !p || p === 'a' || p === 'b' || p === 'dupes';
  return html`<nav class="nav" aria-label="প্রধান মেনু"><div class="nav-inner">
    <a href="#/" class=${home ? 'on' : ''} aria-current=${home ? 'page' : undefined}><${Icon} name="home" /><span>লাইব্রেরি</span></a>
    <a href="#/scan?mode=search" class="scan"><span class="ring"><${Icon} name="camera" /></span><span>স্ক্যান</span></a>
    <a href="#/settings" class=${p === 'settings' || p === 'trash' ? 'on' : ''}><${Icon} name="settings" /><span>সেটিংস</span></a>
  </div></nav>`;
}

function App() {
  const route = useRoute();
  const lib = useLib();
  const [cloudState, setCloudState] = useState(ctx.cloud.state);
  useEffect(() => {
    ctx.onCloud = setCloudState;
    setCloudState(ctx.cloud.state);
  }, []);
  useEffect(() => { window.scrollTo(0, 0); }, [route.parts[0], route.parts[1]]);

  const [a, b, c] = route.parts;
  let page;
  if (a === 'a' && b) page = html`<${AuthorPage} lib=${lib} id=${b} tab=${c || 'books'} query=${route.query} />`;
  else if (a === 'b' && b) page = html`<${BookPage} lib=${lib} id=${b} />`;
  else if (a === 'new') page = html`<${NewBookRoute} lib=${lib} query=${route.query} />`;
  else if (a === 'scan') page = html`<${ScanPage} query=${route.query} />`;
  else if (a === 'settings') page = html`<${SettingsPage} lib=${lib} cloudState=${cloudState} query=${route.query} />`;
  else if (a === 'trash') page = html`<${TrashPage} lib=${lib} />`;
  else if (a === 'dupes') page = html`<${DupesPage} lib=${lib} />`;
  else if (a === 'setup') page = html`<${SetupPage} query=${route.query} />`;
  else if (a === 'print') page = html`<${PrintPage} lib=${lib} />`;
  else page = html`<${HomePage} lib=${lib} cloudState=${cloudState} />`;

  const bare = a === 'scan' || a === 'print';
  return html`
    <div class="app" key=${`${a || 'home'}/${b || ''}`}>${page}</div>
    ${!bare && html`<${Nav} route=${route} />`}
    <${ModalHost} />
    <${Toasts} />`;
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const local = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  if (location.protocol !== 'https:' && !local) return;
  if (local && !/[?&]sw=1/.test(location.search) && !globalThis.MAZEDAR_CONFIG?.enableSwLocally) return;
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    reloading = true;
    location.reload();
  });
  navigator.serviceWorker.register('./sw.js').then((reg) => {
    const offer = (worker) => toast('নতুন সংস্করণ এসেছে 🌸', {
      ms: 20000,
      action: { label: 'হালনাগাদ করুন', run: () => worker.postMessage('skip-waiting') },
    });
    if (reg.waiting && hadController) offer(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) offer(w);
      });
    });
    globalThis.mazedarCheckUpdate = () => reg.update().then(() => {
      if (!reg.waiting && !reg.installing) toast('সর্বশেষ সংস্করণই চলছে ✓', { type: 'ok' });
    }).catch(() => toast('এখন যাচাই করা গেল না — ইন্টারনেট আছে কি?'));
    setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
  }).catch((e) => console.warn('service worker', e));
}

function applyTheme() {
  try {
    const t = JSON.parse(localStorage.getItem('mazedar:pref:theme') || '"system"');
    if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  } catch { /* ignore */ }
}

function fatal(e) {
  const root = document.getElementById('app');
  document.getElementById('splash')?.remove();
  const msg = String(e?.message || e);
  const privateMode = /indexeddb|quota|security|denied/i.test(msg);
  root.innerHTML = `<div class="empty" style="padding-top:80px"><h3>লাইব্রেরি খোলা যাচ্ছে না</h3>
    <p>${privateMode ? 'এই ব্রাউজারে তথ্য রাখার অনুমতি নেই (প্রাইভেট/ইনকগনিটো মোড?)। সাধারণ মোডে খুলুন।' : 'একটু পরে আবার চেষ্টা করুন।'}</p>
    <p class="faint">${msg.replace(/[<>&]/g, '')}</p><button class="btn primary" onclick="location.reload()">আবার চেষ্টা</button></div>`;
}

// No silent failures: anything that slips through shows up as a message.
function surfaceErrors() {
  let last = 0;
  const show = (msg) => {
    if (Date.now() - last < 3000) return;
    last = Date.now();
    toast(`কিছু একটা ঠিকমতো হয়নি: ${String(msg || '').slice(0, 140)}`, { type: 'err', ms: 6000 });
  };
  window.addEventListener('unhandledrejection', (e) => {
    console.error(e.reason);
    show(e.reason?.message || e.reason);
  });
  window.addEventListener('error', (e) => {
    if (!e.message || /ResizeObserver/.test(e.message)) return;
    show(e.message);
  });
}

async function boot() {
  applyTheme();
  surfaceErrors();
  const store = await openStore();
  ctx.store = store;
  await store.seedIfNeeded(buildSeedRecords(), SEED_VERSION);
  ctx.cloud = createCloud({
    store,
    onChange: (s) => ctx.onCloud?.(s),
    reseed: () => store.seedIfNeeded(buildSeedRecords(), SEED_VERSION),
  });
  render(html`<${App} />`, document.getElementById('app'));
  document.getElementById('splash')?.remove();
  // (automated browsers skip the tour unless ?welcome=1, so tests see the app itself)
  const wantWelcome = !navigator.webdriver || /[?&]welcome=1/.test(location.search);
  if (wantWelcome && !/^#\/(setup|scan|print)/.test(location.hash)) setTimeout(() => maybeShowWelcome(getLib()), 600);
  ctx.cloud.start();
  registerServiceWorker();
  store.autoSnapshotIfDue().catch(() => {});

  // Ask the browser to keep the library even when the phone runs low on space.
  setTimeout(async () => {
    try {
      if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
    } catch { /* not supported */ }
  }, 4000);

  // Gentle reminder to keep a backup file when there is no cloud copy.
  setTimeout(async () => {
    if (ctx.cloud.state.configured) return;
    const last = (await store.getMeta('lastExportAt')) || 0;
    const nudged = (await store.getMeta('lastBackupNudge')) || 0;
    const month = 30 * 24 * 3600 * 1000;
    if (Date.now() - last > month && Date.now() - nudged > 7 * 24 * 3600 * 1000 && (await store.pendingCount()) > 0) {
      await store.setMeta('lastBackupNudge', Date.now());
      toast('তথ্য শুধু এই ফোনে আছে — একটা ব্যাকআপ ফাইল রেখে দিন', { action: { label: 'ব্যাকআপ', run: () => { location.hash = '#/settings'; } }, ms: 9000 });
    }
  }, 6000);
}

boot().catch(fatal);
