// Shared UI kit: app context, router, formatting, icons, lily artwork,
// sheets/dialogs/toasts and small reusable components.
import { html, useState, useEffect, useRef, useMemo, useCallback } from '../../vendor/preact-htm.js';

export { html, useState, useEffect, useRef, useMemo, useCallback };

/** Filled in by app.js at boot: { store, cloud, ... } */
export const ctx = {};

// ---------------------------------------------------------------- formatting
const BN_DIGITS = '০১২৩৪৫৬৭৮৯';
export const bn = (x) => String(x ?? '').replace(/[0-9]/g, (d) => BN_DIGITS[d]);
const MONTHS = ['জানুয়ারি', 'ফেব্রুয়ারি', 'মার্চ', 'এপ্রিল', 'মে', 'জুন', 'জুলাই', 'আগস্ট', 'সেপ্টেম্বর', 'অক্টোবর', 'নভেম্বর', 'ডিসেম্বর'];

export function bnDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return `${bn(d.getDate())} ${MONTHS[d.getMonth()]} ${bn(d.getFullYear())}`;
}

export function bnDateTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const h = d.getHours();
  const part = h < 5 ? 'রাত' : h < 12 ? 'সকাল' : h < 15 ? 'দুপুর' : h < 18 ? 'বিকেল' : h < 20 ? 'সন্ধ্যা' : 'রাত';
  const hh = ((h + 11) % 12) + 1;
  return `${bnDate(ms)}, ${part} ${bn(hh)}:${bn(String(d.getMinutes()).padStart(2, '0'))}`;
}

export function ago(ms) {
  if (!ms) return '';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 45) return 'এইমাত্র';
  const m = Math.round(s / 60);
  if (m < 60) return `${bn(m)} মিনিট আগে`;
  const h = Math.round(m / 60);
  if (h < 24) return `${bn(h)} ঘণ্টা আগে`;
  const d = Math.round(h / 24);
  if (d === 1) return 'গতকাল';
  if (d < 30) return `${bn(d)} দিন আগে`;
  return bnDate(ms);
}

export function greeting(date = new Date()) {
  const h = date.getHours();
  if (h >= 5 && h < 12) return 'শুভ সকাল';
  if (h >= 12 && h < 16) return 'শুভ দুপুর';
  if (h >= 16 && h < 18) return 'শুভ বিকেল';
  if (h >= 18 && h < 20) return 'শুভ সন্ধ্যা';
  return 'শুভ রাত্রি';
}

const MARKS = /[ঁ-ঃ়া-্ৗ‌‍]/;
/** First user-perceived character (Bengali grapheme cluster), for monograms. */
export function firstGrapheme(s) {
  const str = String(s || '').trim();
  if (!str) return '';
  try {
    const seg = new Intl.Segmenter('bn', { granularity: 'grapheme' });
    for (const { segment } of seg.segment(str)) return segment;
  } catch { /* fallback below */ }
  let out = str[0];
  for (let i = 1; i < str.length; i += 1) {
    const ch = str[i];
    if (MARKS.test(ch) || out.endsWith('্')) out += ch;
    else break;
  }
  return out;
}

export function hashStr(s) {
  let h = 2166136261;
  for (const ch of String(s)) h = Math.imul(h ^ ch.codePointAt(0), 16777619);
  return h >>> 0;
}

const COVER_GRADIENTS = [
  ['#f48fb1', '#c2185b'], ['#ce93d8', '#7b1fa2'], ['#f8bbd0', '#ad5389'], ['#b39ddb', '#5e35b1'],
  ['#f6a5c0', '#e2477b'], ['#ffcc80', '#e0784a'], ['#a5d6a7', '#3f8a5c'], ['#90caf9', '#6a5acd'],
  ['#f3a683', '#cf6a87'], ['#e1bee7', '#9c4f96'], ['#c5e1a5', '#5b9a68'], ['#ffab91', '#c2557a'],
];
export function coverColors(seed) {
  return COVER_GRADIENTS[hashStr(seed) % COVER_GRADIENTS.length];
}

// ---------------------------------------------------------------- router
export function parseHash(hash = location.hash) {
  const raw = (hash || '').replace(/^#/, '') || '/';
  const [path, qs = ''] = raw.split('?');
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  return { path, parts, query: Object.fromEntries(new URLSearchParams(qs)) };
}

export function useRoute() {
  const [route, setRoute] = useState(parseHash());
  useEffect(() => {
    const on = () => setRoute(parseHash());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

let navDepth = 0;
export function navigate(path, { replace = false } = {}) {
  const target = path.startsWith('#') ? path : `#${path}`;
  if (replace) {
    history.replaceState(null, '', target);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else {
    navDepth += 1;
    location.hash = target;
  }
}

export function goBack(fallback = '/') {
  if (navDepth > 0) {
    navDepth -= 1;
    history.back();
  } else {
    navigate(fallback, { replace: true });
  }
}

// ---------------------------------------------------------------- icons
const P = {
  home: 'M3 11.5 12 4l9 7.5M5 10v10h5v-6h4v6h5V10',
  camera: 'M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4',
  settings: 'M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1M15 4v4M9 10v4M17 16v4',
  plus: 'M12 5v14M5 12h14',
  back: 'M15 18l-6-6 6-6',
  close: 'M6 6l12 12M18 6 6 18',
  edit: 'M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6',
  heart: 'M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.7A4 4 0 0 1 19 10c0 5.6-7 10-7 10z',
  check: 'M5 12.5l4.5 4.5L19 7',
  cloud: 'M7 18h10a4 4 0 0 0 .6-7.96A6 6 0 0 0 6.1 11.6 3.3 3.3 0 0 0 7 18z',
  cloudOff: 'M7 18h10M6.1 11.6A3.3 3.3 0 0 0 7 18M9 6.3A6 6 0 0 1 17.6 10a4 4 0 0 1 2.3 6.6M3 3l18 18',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
  book: 'M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5v-15zM5 19.5A1.5 1.5 0 0 0 6.5 21H19v-3',
  sort: 'M7 4v16M3.5 16.5 7 20l3.5-3.5M17 20V4M13.5 7.5 17 4l3.5 3.5',
  flash: 'M13 2 4 14h7l-1 8 9-12h-7z',
  image: 'M4 5h16v14H4zM8.5 11a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM20 15l-5-5-9 9',
  download: 'M12 4v12M7 11l5 5 5-5M5 20h14',
  upload: 'M12 20V8M7 13l5-5 5 5M5 4h14',
  qr: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 14h2v2M14 18h2v2M18 18h2v2',
  more: 'M12 6h.01M12 12h.01M12 18h.01',
  alert: 'M12 3 22 20H2L12 3zM12 10v4M12 17h.01',
  info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 11v6M12 7h.01',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
  list: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z',
  logout: 'M15 4h4v16h-4M10 16l-4-4 4-4M6 12h10',
  undo: 'M9 14 4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3',
  eye: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  eyeOff: 'M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4M6.6 6.6A17 17 0 0 0 2 12s3.6 7 10 7a9.6 9.6 0 0 0 4.4-1M9.9 9.9a3 3 0 0 0 4.2 4.2',
  print: 'M7 9V3h10v6M7 17H4v-7h16v7h-3M7 14h10v7H7z',
  folder: 'M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z',
  storage: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  moon: 'M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z',
  history: 'M3 12a9 9 0 1 0 3-6.7M3 4v5h5M12 7v5l3 3',
  barcode: 'M4 5v14M7 5v14M10 5v14M14 5v14M17 5v14M20 5v14',
  wifiOff: 'M2 8.8a15 15 0 0 1 4.2-2.6M10.7 5.1A15 15 0 0 1 22 8.8M5 12.6a10 10 0 0 1 4.4-2.4M14.6 10.3a10 10 0 0 1 4.4 2.3M8.5 16.4a5 5 0 0 1 7 0M12 20h.01M3 3l18 18',
};

export function Icon({ name, size, className = '', label }) {
  const d = P[name] || P.info;
  const filled = name === 'heart-fill';
  return html`<svg class=${className} width=${size} height=${size} viewBox="0 0 24 24" fill=${filled ? 'currentColor' : 'none'}
    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
    aria-hidden=${label ? undefined : 'true'} role=${label ? 'img' : undefined} aria-label=${label}>
    <path d=${filled ? P.heart : d} />
  </svg>`;
}

// ---------------------------------------------------------------- lily artwork
let gradSeq = 0;
const PETAL = 'M0 2 C -12 -10, -17 -30, -3.5 -52 Q 0 -57, 3.5 -52 C 17 -30, 12 -10, 0 2 Z';
const PETAL_BACK = 'M0 2 C -10 -12, -14 -30, -3 -48 Q 0 -52, 3 -48 C 14 -30, 10 -12, 0 2 Z';

/**
 * A stargazer-style lily seen from the front. `open` (0..1) closes the petals
 * toward a bud, used by the collection "bloom" meter.
 */
export function Lily({ size = 120, open = 1, className = '', tone = 'pink' }) {
  const id = useMemo(() => `lg${(gradSeq += 1)}`, []);
  const o = Math.max(0, Math.min(1, open));
  const s = 0.5 + 0.5 * o;
  const front = tone === 'white' ? ['#ffffff', '#fff3f7', '#f7c6d8'] : ['#fff6fa', '#ffc4da', '#e34f86'];
  const back = tone === 'white' ? ['#ffffff', '#fbe9f0', '#f0b7cb'] : ['#fff9fb', '#ffd9e7', '#ee86ab'];
  const spots = [[-3, -16], [2.5, -21], [-1.5, -27], [3, -11], [-4, -23]];
  return html`<svg class=${className} width=${size} height=${size} viewBox="-62 -62 124 124" aria-hidden="true">
    <defs>
      <linearGradient id=${`${id}f`} x1="0" y1="0" x2="0" y2="-54" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color=${front[2]} /><stop offset="0.45" stop-color=${front[1]} /><stop offset="1" stop-color=${front[0]} />
      </linearGradient>
      <linearGradient id=${`${id}b`} x1="0" y1="0" x2="0" y2="-50" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color=${back[2]} /><stop offset="0.5" stop-color=${back[1]} /><stop offset="1" stop-color=${back[0]} />
      </linearGradient>
    </defs>
    ${[30, 150, 270].map((a) => html`<path d=${PETAL_BACK} fill=${`url(#${id}b)`} stroke="#e98fb2" stroke-width="0.6"
      transform=${`rotate(${a}) scale(${(s * 0.94).toFixed(3)})`} />`)}
    ${[90, 210, 330].map((a) => html`<g transform=${`rotate(${a}) scale(${s.toFixed(3)})`}>
      <path d=${PETAL} fill=${`url(#${id}f)`} stroke="#e47ba2" stroke-width="0.7" />
      <path d="M0 0 L0 -44" stroke="#f4a3c1" stroke-width="1" fill="none" opacity="0.8" />
      ${spots.map(([x, y]) => html`<ellipse cx=${x} cy=${y} rx="1" ry="1.5" fill="#c2306a" opacity="0.55" />`)}
    </g>`)}
    <g opacity=${(0.35 + 0.65 * o).toFixed(2)}>
      ${[15, 75, 135, 195, 255, 315].map((a) => html`<g transform=${`rotate(${a})`}>
        <path d=${`M0 0 Q 2 -12 0 ${-22 * s}`} stroke="#c9d98b" stroke-width="1.3" fill="none" />
        <ellipse cx="0" cy=${-23 * s} rx="2" ry="4" fill="#c8742a" />
      </g>`)}
    </g>
    <circle r="4.2" fill="#a9cf86" />
    <circle r="2" fill="#e9f3cf" />
  </svg>`;
}

/** Progress ring with a lily that opens as the collection grows. */
export function LilyBloom({ value = 0, size = 104, label }) {
  const v = Math.max(0, Math.min(1, value || 0));
  const C = 2 * Math.PI * 54;
  const id = useMemo(() => `bl${(gradSeq += 1)}`, []);
  const inner = Math.round(size * 0.78);
  return html`<div class="bloom" style=${`width:${size}px;height:${size}px`} role="img" aria-label=${label}>
    <svg viewBox="0 0 120 120">
      <defs><linearGradient id=${id} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="var(--leaf-2)" /><stop offset="1" stop-color="var(--leaf)" /></linearGradient></defs>
      <circle cx="60" cy="60" r="54" fill="none" stroke="var(--surface-3)" stroke-width="7" />
      <circle cx="60" cy="60" r="54" fill="none" stroke=${`url(#${id})`} stroke-width="7" stroke-linecap="round"
        stroke-dasharray=${C.toFixed(1)} stroke-dashoffset=${(C * (1 - v)).toFixed(1)} transform="rotate(-90 60 60)"
        style="transition: stroke-dashoffset .8s ease" />
    </svg>
    <div style=${`position:absolute;left:${(size - inner) / 2}px;top:${(size - inner) / 2}px;width:${inner}px;height:${inner}px`}>
      <${Lily} size=${inner} open=${0.25 + 0.75 * v} />
    </div>
  </div>`;
}

const AVATAR = [['#fde3ed', '#d6457c'], ['#efe7fb', '#8a68c8'], ['#e2f2e7', '#3f8a5c'], ['#fbefd6', '#c47f12'], ['#e3eefc', '#4a6fc1'], ['#fde8df', '#c2553a']];
/** Five-petal flower with the author's initial. */
export function FlowerAvatar({ name, size = 46 }) {
  const [bg, fg] = AVATAR[hashStr(name) % AVATAR.length];
  return html`<svg class="avatar" width=${size} height=${size} viewBox="-30 -30 60 60" aria-hidden="true">
    ${[0, 72, 144, 216, 288].map((a) => html`<ellipse cx="0" cy="-15" rx="10.5" ry="15" fill=${bg} stroke=${fg} stroke-opacity="0.25" transform=${`rotate(${a})`} />`)}
    <circle r="13" fill=${fg} />
    <text x="0" y="1" text-anchor="middle" dominant-baseline="middle" fill="#fff" font-size="14" font-family="Tiro Bangla, serif">${firstGrapheme(name)}</text>
  </svg>`;
}

export function Petals({ count = 9 }) {
  const items = useMemo(() => Array.from({ length: count }, (_, i) => ({
    left: `${(i * 37 + 11) % 100}%`, delay: `${(i * 1.7) % 9}s`, dur: `${7 + ((i * 3) % 6)}s`, scale: 0.6 + ((i * 7) % 5) / 10,
  })), [count]);
  return html`<div class="petals" aria-hidden="true">${items.map((p) => html`<i class="petal"
    style=${`left:${p.left};animation-delay:${p.delay};animation-duration:${p.dur};transform:scale(${p.scale})`} />`)}</div>`;
}

/** A small celebration of petals from a point (e.g. after adding a book). */
export function burst(x = innerWidth / 2, y = innerHeight / 2) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const host = document.createElement('div');
  host.className = 'bloom-burst';
  const colors = ['#ffd1e2', '#f6a9c5', '#e9d5ff', '#ffffff', '#ffc9b3'];
  for (let i = 0; i < 18; i += 1) {
    const p = document.createElement('i');
    const ang = (i / 18) * Math.PI * 2;
    const dist = 70 + (i % 5) * 22;
    p.style.left = `${x}px`;
    p.style.top = `${y}px`;
    p.style.background = colors[i % colors.length];
    p.style.setProperty('--dx', `${Math.cos(ang) * dist}px`);
    p.style.setProperty('--dy', `${Math.sin(ang) * dist + 60}px`);
    p.style.setProperty('--rot', `${(i % 2 ? 1 : -1) * (120 + i * 20)}deg`);
    host.appendChild(p);
  }
  document.body.appendChild(host);
  setTimeout(() => host.remove(), 1300);
}

// ---------------------------------------------------------------- covers
/** Book cover: the saved photo if there is one, otherwise a generated pastel cover. */
export function Cover({ book, large = false }) {
  const [src, setSrc] = useState(null);
  useEffect(() => {
    let alive = true;
    setSrc(null);
    if (book?.hasCover && ctx.store) ctx.store.getCover(book.id).then((d) => alive && setSrc(d));
    return () => { alive = false; };
  }, [book?.id, book?.hasCover, book?._v?.hasCover]);
  const [a, b] = coverColors(book?.title || '');
  return html`<div class=${`cover${large ? ' lg' : ''}`} style=${src ? '' : `background:linear-gradient(150deg, ${a}, ${b})`} aria-hidden="true">
    ${src ? html`<img src=${src} alt="" loading="lazy" />` : html`<span>${firstGrapheme(book?.title)}</span>
      <svg class="mini-lily" viewBox="-30 -30 60 60">${[0, 60, 120, 180, 240, 300].map((r) => html`<ellipse cx="0" cy="-14" rx="6" ry="14" fill="#fff" opacity="0.85" transform=${`rotate(${r})`} />`)}<circle r="4" fill="#ffd27a" /></svg>`}
  </div>`;
}

// ---------------------------------------------------------------- toasts
let toastSeq = 0;
let toasts = [];
const toastSubs = new Set();
const emitToasts = () => toastSubs.forEach((f) => f(toasts));

export function toast(text, { type = '', action = null, ms = 3800 } = {}) {
  const t = { id: (toastSeq += 1), text, type, action };
  toasts = [...toasts.slice(-2), t];
  emitToasts();
  setTimeout(() => dismissToast(t.id), action ? Math.max(ms, 6000) : ms);
  return t.id;
}

export function dismissToast(id) {
  toasts = toasts.filter((t) => t.id !== id);
  emitToasts();
}

export function Toasts() {
  const [list, setList] = useState(toasts);
  useEffect(() => {
    toastSubs.add(setList);
    return () => toastSubs.delete(setList);
  }, []);
  return html`<div class="toasts" role="status" aria-live="polite">
    ${list.map((t) => html`<div class=${`toast ${t.type}`} key=${t.id}>
      <span>${t.text}</span>
      ${t.action && html`<button onClick=${() => { t.action.run(); dismissToast(t.id); }}>${t.action.label}</button>`}
    </div>`)}
  </div>`;
}

// ---------------------------------------------------------------- modals
let modalSeq = 0;
let modals = [];
const modalSubs = new Set();
const emitModals = () => modalSubs.forEach((f) => f(modals));

/** Render `render(close)` in a bottom sheet. Returns a close function. */
export function openSheet(render, { className = '', onClose } = {}) {
  const id = (modalSeq += 1);
  const close = () => {
    modals = modals.filter((m) => m.id !== id);
    emitModals();
    onClose?.();
  };
  modals = [...modals, { id, render, className, close }];
  emitModals();
  return close;
}

export function ModalHost() {
  const [list, setList] = useState(modals);
  useEffect(() => {
    modalSubs.add(setList);
    const onKey = (e) => {
      if (e.key === 'Escape' && modals.length) modals[modals.length - 1].close();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      modalSubs.delete(setList);
      window.removeEventListener('keydown', onKey);
    };
  }, []);
  useEffect(() => {
    document.documentElement.style.overflow = list.length ? 'hidden' : '';
  }, [list.length]);
  return list.map((m) => html`<div class="scrim" key=${m.id} onClick=${(e) => { if (e.target === e.currentTarget) m.close(); }}>
    <div class=${`sheet ${m.className}`} role="dialog" aria-modal="true">
      <div class="grab" />
      ${m.render(m.close)}
    </div>
  </div>`);
}

/** Promise<boolean> confirmation dialog. */
export function confirmDialog({ title, body = '', ok = 'হ্যাঁ', cancel = 'না', danger = false }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const close = openSheet((closeSelf) => html`<div>
      <h3>${title}</h3>
      ${body && html`<p class="muted" style="margin-top:0">${body}</p>`}
      <div class="btn-row" style="margin-top:16px">
        <button class="btn ghost" onClick=${() => { finish(false); closeSelf(); }}>${cancel}</button>
        <button class=${`btn ${danger ? 'danger' : 'primary'}`} onClick=${() => { finish(true); closeSelf(); }} autofocus>${ok}</button>
      </div>
    </div>`, { className: 'dialog', onClose: () => finish(false) });
    void close;
  });
}

// ---------------------------------------------------------------- misc components
export function TopBar({ title, bookTitle = false, back = true, backTo = '/', right = null }) {
  return html`<header class="topbar">
    ${back && html`<button class="icon-btn" onClick=${() => goBack(backTo)} aria-label="ফিরে যান"><${Icon} name="back" /></button>`}
    <h1 class=${`title${bookTitle ? ' title-book' : ''}`}>${title}</h1>
    ${right}
  </header>`;
}

export function Empty({ title, children, art = true }) {
  return html`<div class="empty">
    ${art && html`<div class="art"><${Lily} size=${130} /></div>`}
    <h3>${title}</h3>
    ${children && html`<div>${children}</div>`}
  </div>`;
}

export function Notice({ kind = 'info', icon = 'info', children }) {
  return html`<div class=${`notice ${kind}`}><${Icon} name=${icon} /><div>${children}</div></div>`;
}

/** Re-render when the store changes; returns the store version. */
export function useStoreVersion() {
  const [v, setV] = useState(ctx.store?.version || 0);
  useEffect(() => ctx.store.subscribe(({ version }) => setV(version)), []);
  return v;
}

export function useDebounced(value, ms = 150) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Persisted UI preference (localStorage, per device). */
export function usePref(key, initial) {
  const k = `mazedar:pref:${key}`;
  const [v, setV] = useState(() => {
    try {
      const raw = localStorage.getItem(k);
      return raw == null ? initial : JSON.parse(raw);
    } catch {
      return initial;
    }
  });
  const set = useCallback((nv) => {
    setV(nv);
    try { localStorage.setItem(k, JSON.stringify(nv)); } catch { /* ignore */ }
  }, [k]);
  return [v, set];
}

export function downloadFile(name, content, type = 'application/json') {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
