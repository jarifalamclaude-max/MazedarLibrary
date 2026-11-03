// First-launch welcome: a short, warm tour shown once per device.
import { html, useState, Icon, Lily, bn, openSheet, navigate } from './core.js';

const KEY = 'mazedar:welcomed';

const SLIDES = [
  {
    art: 'lily',
    title: 'মাজেদার লাইব্রেরিতে স্বাগতম 🌷',
    body: (lib) => html`<p>তোমার বইগুলোর জন্য একটা ছোট্ট বাগান। আগের তালিকার <b>${bn(lib.totals.books)}টি বই</b> এর মধ্যেই সাজিয়ে রাখা আছে — লেখকের নামের ফোল্ডারে।</p>`,
  },
  {
    art: 'sparkle',
    title: 'হুমায়ূন আহমেদের হিসাব',
    body: (lib) => {
      const st = lib.stats.get('a_humayun');
      return html`<p>সম্পূর্ণ তালিকার কোনগুলো আছে আর <b>সব পেতে আরো কয়টি লাগবে</b> — সবসময় গুনে দেখাবে${st ? html` (এখন <b>${bn(st.remaining)}টি</b> বাকি)` : ''}। নতুন বই পেলে “পেয়েছি” চাপলেই হলো, লিলি ফুলটাও একটু একটু করে ফুটবে।</p>`;
    },
  },
  {
    art: 'camera',
    title: 'ক্যামেরা ধরলেই চিনে ফেলবে',
    body: () => html`<p>বইয়ের মলাট ক্যামেরার সামনে ধরো — বলে দেবে বইটা আছে কি না, অথবা নামসহ যোগ করে দেবে। বইমেলায় ইন্টারনেট না থাকলেও চলবে। খুঁজতে পারো বাংলায় বা Banglish-এ (যেমন <i>himu</i>)।</p>`,
  },
  {
    art: 'cloud',
    title: 'তথ্য কখনো হারাবে না',
    body: () => html`<p>সব তথ্য ফোনে থাকে, আর Google দিয়ে লগইন করলে ক্লাউডেও থাকে — দুই ফোনে একসাথে একই লাইব্রেরি দেখা ও বদলানো যায়। কিছু মুছলেও আগে ট্র্যাশে যায় — ফেরত আনা যায়।</p>`,
  },
];

function Welcome({ lib, close }) {
  const [i, setI] = useState(0);
  const s = SLIDES[i];
  const last = i === SLIDES.length - 1;
  const done = () => {
    try { localStorage.setItem(KEY, '1'); } catch { /* ignore */ }
    close();
  };
  return html`<div class="center" style="padding:4px 4px 0">
    <div style="height:130px;display:grid;place-items:center">
      ${s.art === 'lily' ? html`<${Lily} size=${128} />` : html`<div style="width:96px;height:96px;border-radius:30px;display:grid;place-items:center;background:var(--rose-soft);color:var(--rose)"><${Icon} name=${s.art} size=${48} /></div>`}
    </div>
    <h3 style="font-size:22px;margin:8px 0 6px">${s.title}</h3>
    <div class="muted" style="font-size:16px;line-height:1.7;min-height:118px">${s.body(lib)}</div>
    <div class="row" style="justify-content:center;gap:6px;margin:6px 0 16px" aria-hidden="true">
      ${SLIDES.map((_, j) => html`<span style=${`width:${j === i ? 22 : 8}px;height:8px;border-radius:99px;background:${j === i ? 'var(--rose)' : 'var(--line-2)'};transition:width .2s`} />`)}
    </div>
    <div class="btn-row">
      ${last
        ? html`<button class="btn ghost" onClick=${() => { done(); navigate('/settings'); }}><${Icon} name="cloud" /> লগইন / সিঙ্ক</button>
               <button class="btn primary" onClick=${done}>শুরু করি 🌸</button>`
        : html`<button class="btn ghost" onClick=${done}>বাদ দিন</button>
               <button class="btn primary" onClick=${() => setI(i + 1)}>পরের</button>`}
    </div>
  </div>`;
}

export function maybeShowWelcome(lib) {
  try {
    if (localStorage.getItem(KEY)) return;
  } catch {
    return;
  }
  openSheet((close) => html`<${Welcome} lib=${lib} close=${close} />`, {
    onClose: () => { try { localStorage.setItem(KEY, '1'); } catch { /* ignore */ } },
  });
}
