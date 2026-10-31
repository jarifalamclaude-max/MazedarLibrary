// "Use it as an app" hints: iPhone/iPad (Add to Home Screen) and Android (install prompt).
import { html, useState, useEffect, Icon } from './core.js';

const DISMISS_KEY = 'mazedar:installHintDismissed';
let deferredPrompt = null;
const promptSubs = new Set();

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // show our own button instead of the browser's mini-bar
    deferredPrompt = e;
    promptSubs.forEach((f) => f(e));
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    promptSubs.forEach((f) => f(null));
  });
}

export function isIOS() {
  const ua = navigator.userAgent || '';
  return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

export function isStandalone() {
  return navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
}

function dismissed() {
  try { return localStorage.getItem(DISMISS_KEY) === '1'; } catch { return false; }
}

/** Shown on the home page until the app is installed (or the hint is dismissed). */
export function InstallHint() {
  const [prompt, setPrompt] = useState(deferredPrompt);
  const [hidden, setHidden] = useState(() => dismissed() || isStandalone());
  useEffect(() => {
    promptSubs.add(setPrompt);
    return () => promptSubs.delete(setPrompt);
  }, []);
  if (hidden) return null;
  const close = () => {
    try { localStorage.setItem(DISMISS_KEY, '1'); } catch { /* ignore */ }
    setHidden(true);
  };

  if (isIOS()) {
    return html`<div class="notice info install-hint" role="note">
      <${Icon} name="download" />
      <div class="grow">
        <b>আইফোনে অ্যাপ হিসেবে রাখুন:</b> Safari-র Share বোতাম <span class="share-glyph" aria-hidden="true">⬆︎</span> চাপুন →
        <b>Add to Home Screen</b> → <b>Add</b>। এরপর হোম স্ক্রিনের লিলি আইকন থেকেই খুলবেন — পুরো স্ক্রিনে, ইন্টারনেট ছাড়াও।
        <div class="faint" style="margin-top:4px">আইফোনে Safari আর হোম-স্ক্রিন অ্যাপের তথ্য আলাদা থাকে, তাই আগে অ্যাপ হিসেবে যোগ করে সেখান থেকেই ব্যবহার করুন (ক্লাউড সিঙ্ক চালু থাকলে দুই জায়গাতেই সব থাকবে)।</div>
      </div>
      <button class="icon-btn" onClick=${close} aria-label="বন্ধ করুন"><${Icon} name="close" /></button>
    </div>`;
  }

  if (prompt) {
    return html`<div class="notice info install-hint" role="note">
      <${Icon} name="download" />
      <div class="grow"><b>অ্যাপ হিসেবে ইনস্টল করুন</b> — হোম স্ক্রিনে লিলি আইকন, পুরো স্ক্রিনে খুলবে, ইন্টারনেট ছাড়াও চলবে।</div>
      <button class="btn primary sm" onClick=${async () => {
        prompt.prompt();
        try { await prompt.userChoice; } catch { /* ignore */ }
        deferredPrompt = null;
        setPrompt(null);
      }}>ইনস্টল</button>
      <button class="icon-btn" onClick=${close} aria-label="বন্ধ করুন"><${Icon} name="close" /></button>
    </div>`;
  }
  return null;
}
