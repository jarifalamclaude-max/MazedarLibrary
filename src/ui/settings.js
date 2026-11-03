import {
  html, useState, useEffect, useMemo, useRef, ctx, bn, bnDate, bnDateTime, ago, navigate, Icon, Lily, Cover, Empty, TopBar, Notice,
  openSheet, toast, confirmDialog, downloadFile, usePref,
} from './core.js';
import {
  useLib, byTitle, byName, updateSettings, updateRecord, restoreRecord, purgeRecord, trashRecord, groupById,
} from './data.js';
import { readConfig, saveConfig, clearConfig, parseConfigText, makeSetupLink, decodeSetupParam, authErrorText } from '../lib/cloud.js';
import { testKey, listModels } from '../lib/gemini.js';
import { warmupOffline, checkOfflineReady } from '../lib/ocr.js';
import qrcode from '../../vendor/qrcode.js';

const GUIDE_URL = 'https://github.com/jarifalamclaude-max/MazedarLibrary/blob/main/docs/SETUP.md';
const READ_LABEL = { '': 'পড়া হয়নি', reading: 'পড়ছি', read: 'পড়া শেষ' };

// ---------------------------------------------------------------- cloud
function openConfigSheet() {
  let text = '';
  openSheet((close) => html`<div>
    <h3>ক্লাউড সেটআপ (একবারই)</h3>
    <p class="muted" style="margin-top:0">Firebase কনসোল থেকে পাওয়া <b>firebaseConfig</b> অংশটুকু এখানে পেস্ট করুন। অ্যাপটি Firebase-এর নিজের ঠিকানায় (<b>…web.app</b>) খুললে এটা লাগে না — সব নিজে থেকেই হয়। ধাপগুলো <a href=${GUIDE_URL} target="_blank" rel="noopener">সেটআপ গাইডে</a> আছে।</p>
    <textarea class="textarea" style="min-height:160px;font-family:ui-monospace,monospace;font-size:13px" placeholder=${'const firebaseConfig = {\n  apiKey: "…",\n  authDomain: "…",\n  projectId: "…",\n  …\n};'}
      onInput=${(e) => { text = e.target.value; }} />
    <div class="btn-row" style="margin-top:12px">
      <button class="btn ghost" onClick=${close}>বাতিল</button>
      <button class="btn primary" onClick=${() => {
        try {
          saveConfig(parseConfigText(text));
          toast('সেটআপ সংরক্ষণ হলো — অ্যাপ নতুন করে চালু হচ্ছে…', { type: 'ok' });
          setTimeout(() => location.reload(), 700);
        } catch (e) {
          toast(e.message, { type: 'err' });
        }
      }}><${Icon} name="check" /> সংরক্ষণ</button>
    </div>
  </div>`);
}

function QrCode({ text }) {
  const svg = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  }, [text]);
  return html`<div class="qr" dangerouslySetInnerHTML=${{ __html: svg }} />`;
}

function openLinkDevice() {
  const cfg = readConfig();
  if (!cfg) return;
  // On Firebase Hosting the address alone is enough; elsewhere the link carries the (public) config.
  const link = cfg.source === 'hosting' ? location.href.split('#')[0] : makeSetupLink(cfg);
  openSheet((close) => html`<div>
    <h3>অন্য ফোনে খুলুন</h3>
    <p class="muted" style="margin-top:0">অন্য ফোনের ক্যামেরা দিয়ে এই QR কোডটি স্ক্যান করুন (অথবা লিংকটি পাঠান)। খুলে <b>Google দিয়ে লগইন</b> করলেই হবে — নিজের লাইব্রেরি, বা আপনি যোগ করে দিলে আপনার লাইব্রেরিই দেখাবে।</p>
    <${QrCode} text=${link} />
    <div class="code" style="margin:8px 0">${link}</div>
    <div class="btn-row">
      <button class="btn soft" onClick=${async () => {
        try { await navigator.clipboard.writeText(link); toast('লিংক কপি হয়েছে', { type: 'ok' }); } catch { toast('কপি করা গেল না — হাতে কপি করুন'); }
      }}><${Icon} name="copy" /> লিংক কপি</button>
      ${navigator.share && html`<button class="btn soft" onClick=${() => navigator.share({ title: 'মাজেদার লাইব্রেরি', url: link }).catch(() => {})}><${Icon} name="link" /> শেয়ার</button>`}
      <button class="btn ghost" onClick=${close}>বন্ধ</button>
    </div>
  </div>`);
}

const GoogleG = () => html`<svg class="g-logo" viewBox="0 0 48 48" aria-hidden="true" width="20" height="20">
  <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
  <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
  <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
  <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
</svg>`;

function GoogleButton({ cloud, state }) {
  const busy = state.phase === 'busy';
  return html`<button class="btn google" disabled=${busy || state.googleMode === 'unavailable'} onClick=${() => {
    // No await before this call: Safari only allows the Google window straight from a tap.
    cloud.signInWithGoogle().catch(() => {});
  }}>${busy ? html`<${Icon} name="refresh" className="spin" />` : html`<${GoogleG} />`} Google দিয়ে লগইন</button>`;
}

function LoginForm({ cloud, state }) {
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [show, setShow] = useState(false);
  const busy = state.phase === 'busy';
  const go = async (kind) => {
    if (!email.trim() || !pw) return toast('ইমেইল আর পাসওয়ার্ড লিখুন', { type: 'err' });
    try {
      if (kind === 'up') await cloud.signUp(email, pw);
      else await cloud.signIn(email, pw);
      toast('লগইন হয়েছে — সিঙ্ক শুরু হচ্ছে 🌸', { type: 'ok' });
    } catch (e) {
      toast(authErrorText(e), { type: 'err' });
    }
  };
  return html`<form onSubmit=${(e) => { e.preventDefault(); go('in'); }} class="stack">
    <p class="muted" style="margin:0">এভাবে দুজনেই <b>একই ইমেইল ও পাসওয়ার্ড</b> দিয়ে লগইন করবেন। (Firebase-এ Email/Password চালু থাকতে হবে।)</p>
    <label class="field" style="margin:0"><span>ইমেইল</span><input class="input" type="email" autocomplete="username" value=${email} onInput=${(e) => setEmail(e.target.value)} /></label>
    <label class="field" style="margin:0"><span>পাসওয়ার্ড</span>
      <div class="row"><input class="input grow" type=${show ? 'text' : 'password'} autocomplete="current-password" value=${pw} onInput=${(e) => setPw(e.target.value)} />
      <button type="button" class="icon-btn" onClick=${() => setShow(!show)} aria-label="পাসওয়ার্ড দেখান"><${Icon} name=${show ? 'eyeOff' : 'eye'} /></button></div>
    </label>
    <div class="btn-row">
      <button class="btn primary" type="submit" disabled=${busy}><${Icon} name="user" /> লগইন</button>
      <button class="btn soft" type="button" disabled=${busy} onClick=${() => go('up')}>নতুন অ্যাকাউন্ট খুলুন</button>
    </div>
    <button type="button" class="btn ghost sm" onClick=${async () => {
      if (!email.trim()) return toast('আগে ইমেইল লিখুন', { type: 'err' });
      try { await cloud.resetPassword(email); toast('পাসওয়ার্ড বদলানোর ইমেইল পাঠানো হয়েছে', { type: 'ok' }); } catch (e) { toast(authErrorText(e), { type: 'err' }); }
    }}>পাসওয়ার্ড ভুলে গেছি</button>
  </form>`;
}

function SignInPanel({ cloud, state }) {
  const cfg = readConfig();
  const unavailable = state.googleMode === 'unavailable';
  return html`<div class="stack">
    <p class="muted" style="margin:0">নিজের <b>Google অ্যাকাউন্ট</b> দিয়ে লগইন করুন — কোনো পাসওয়ার্ড মনে রাখতে হবে না। দুজনের দুই অ্যাকাউন্ট হলে লাইব্রেরির মালিক এখানেই অন্যজনের Gmail যোগ করে দেবেন, তারপর দুই ফোনে একই লাইব্রেরি।</p>
    <${GoogleButton} cloud=${cloud} state=${state} />
    ${unavailable && html`<${Notice} kind="warn" icon="alert">iPhone-এর হোম-স্ক্রিন অ্যাপে এই ঠিকানা থেকে Google লগইন করা যায় না (iOS-এর নিয়ম)।
      ${cfg?.projectId ? html` অ্যাপটি <b>https://${cfg.projectId}.web.app</b> ঠিকানা থেকে Safari-তে খুলে হোম-স্ক্রিনে যোগ করুন — সেখানে Google লগইন চলে।` : ''} অথবা নিচের ইমেইল-পাসওয়ার্ড ব্যবহার করুন।<//>`}
    ${state.error && html`<${Notice} kind="err" icon="alert">${state.error}<//>`}
    <details class="more-login" open=${unavailable}>
      <summary>ইমেইল-পাসওয়ার্ড দিয়ে লগইন</summary>
      <${LoginForm} cloud=${cloud} state=${state} />
    </details>
  </div>`;
}

/** Joining another library: what happens to the books already on this phone? */
async function chooseJoin(cloud, invite) {
  const local = ctx.store.localChangeCount?.() || 0;
  let replace = false;
  if (local > 0) {
    replace = await new Promise((resolve) => {
      let settled = false;
      const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
      openSheet((close) => html`<div>
        <h3>এই ফোনের বইগুলো?</h3>
        <p class="muted" style="margin-top:0">এই ফোনে নিজে যোগ করা বা বদলানো <b>${bn(local)}টি</b> জিনিস আছে। ${invite.ownerName || invite.ownerEmail}-এর লাইব্রেরিতে যোগ দেওয়ার সময় এগুলো—</p>
        <div class="stack">
          <button class="btn primary" onClick=${() => { finish(false); close(); }}>ওই লাইব্রেরিতে মিশিয়ে দিন</button>
          <button class="btn soft" onClick=${() => { finish(true); close(); }}>বাদ দিন (আগে ব্যাকআপ রাখা হবে)</button>
          <button class="btn ghost" onClick=${() => { finish(null); close(); }}>বাতিল</button>
        </div>
      </div>`, { className: 'dialog', onClose: () => finish(null) });
    });
    if (replace === null) return;
  }
  try {
    await cloud.joinLibrary(invite.id, { replace });
    toast(`${invite.ownerName || invite.ownerEmail}-এর লাইব্রেরিতে যোগ দিয়েছেন 🌸`, { type: 'ok' });
  } catch (e) {
    toast(authErrorText(e), { type: 'err' });
  }
}

function InviteList({ cloud, invites }) {
  return html`<div class="stack">
    ${invites.map((inv) => html`<div class="invite" key=${inv.id}>
      <span class="ic"><${Lily} size=${34} /></span>
      <div class="grow"><b>${inv.ownerName || inv.ownerEmail}-এর লাইব্রেরি</b>${inv.ownerName && html`<div class="faint">${inv.ownerEmail}</div>`}</div>
      <button class="btn primary sm" onClick=${() => chooseJoin(cloud, inv)}>যোগ দিন</button>
    </div>`)}
  </div>`;
}

function ShareSection({ cloud, state }) {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const lib = state.library || {};
  const members = lib.members || [];
  const add = async (e) => {
    e.preventDefault();
    if (!email.trim()) return;
    setBusy(true);
    try {
      await cloud.addMember(email);
      toast(`${email.trim()} যোগ হয়েছে — উনি Google দিয়ে লগইন করলেই এই লাইব্রেরি পাবেন`, { type: 'ok', ms: 6000 });
      setEmail('');
    } catch (err) {
      toast(err.message, { type: 'err' });
    } finally {
      setBusy(false);
    }
  };
  return html`<div class="share stack">
    <b><${Icon} name="heart" size=${16} /> লাইব্রেরি শেয়ার</b>
    <p class="muted" style="margin:0">যাদের Gmail এখানে যোগ করবেন, তারা নিজের ফোনে <b>Google দিয়ে লগইন</b> করলেই এই লাইব্রেরি দেখতে ও বদলাতে পারবেন — একসাথে, দুই ফোনে।</p>
    ${members.length > 0 && html`<div class="members">${members.map((m) => html`<div class="member" key=${m}>
      <${Icon} name="user" size=${16} /><span class="grow">${m}</span>
      <button class="icon-btn" aria-label=${`${m} বাদ দিন`} onClick=${async () => {
        const ok = await confirmDialog({ title: 'বাদ দেবেন?', body: `${m} আর এই লাইব্রেরি দেখতে বা বদলাতে পারবেন না (ওনার ফোনে যা আছে তা থাকবে)।`, ok: 'বাদ দিন', danger: true });
        if (!ok) return;
        try { await cloud.removeMember(m); toast('বাদ দেওয়া হলো'); } catch (err) { toast(err.message, { type: 'err' }); }
      }}><${Icon} name="close" /></button>
    </div>`)}</div>`}
    ${state.shareError && html`<${Notice} kind="warn" icon="alert">শেয়ার এখন কাজ করছে না: ${state.shareError}<//>`}
    <form class="row" onSubmit=${add}>
      <input class="input grow" type="email" inputmode="email" autocomplete="off" placeholder="যেমন: name@gmail.com" value=${email} onInput=${(e) => setEmail(e.target.value)} aria-label="যাকে যোগ করবেন তার Gmail" />
      <button class="btn soft" type="submit" disabled=${busy || !email.trim()}><${Icon} name=${busy ? 'refresh' : 'plus'} className=${busy ? 'spin' : ''} /> যোগ</button>
    </form>
  </div>`;
}

function CloudSection({ state }) {
  const cloud = ctx.cloud;
  const cfg = readConfig();
  const s = state || {};
  const sync = s.sync || {};
  let body;
  if (!s.configured || s.phase === 'off') {
    body = html`<div class="stack">
      <${Notice} kind="info" icon="storage">এখন সব তথ্য <b>শুধু এই ফোনে</b> আছে (ইন্টারনেট ছাড়াই চলে)। Google দিয়ে লগইন করে দুই ফোনে একসাথে ব্যবহার করতে আর তথ্য ক্লাউডে নিরাপদ রাখতে একবার ক্লাউড সেটআপ লাগবে (প্রায় ৫ মিনিট, ফ্রি)।<//>
      <div class="btn-row">
        <button class="btn primary" onClick=${openConfigSheet}><${Icon} name="cloud" /> ক্লাউড সেটআপ</button>
        <a class="btn ghost" href=${GUIDE_URL} target="_blank" rel="noopener"><${Icon} name="info" /> গাইড</a>
      </div>
    </div>`;
  } else if (s.phase === 'loading' || s.phase === 'resolving') {
    body = html`<p class="muted"><${Icon} name="refresh" className="spin" size=${16} /> ${s.phase === 'loading' ? 'ক্লাউডের সাথে সংযোগ হচ্ছে…' : 'আপনার লাইব্রেরি খোঁজা হচ্ছে…'}</p>`;
  } else if (s.phase === 'signed-out' || s.phase === 'busy') {
    body = html`<${SignInPanel} cloud=${cloud} state=${s} />`;
  } else if (s.phase === 'invite') {
    body = html`<div class="stack">
      <p style="margin:0"><b>${s.user?.email}</b> দিয়ে লগইন হয়েছে। আপনাকে এই লাইব্রেরিতে যোগ করা হয়েছে:</p>
      <${InviteList} cloud=${cloud} invites=${s.invites || []} />
      ${s.error && html`<${Notice} kind="err" icon="alert">${s.error}<//>`}
      <div class="btn-row">
        <button class="btn ghost" onClick=${() => cloud.useOwnLibrary().catch((e) => toast(authErrorText(e), { type: 'err' }))}>না, আমার নিজের আলাদা লাইব্রেরি</button>
        <button class="btn ghost" onClick=${() => cloud.signOut()}>সাইন আউট</button>
      </div>
    </div>`;
  } else if (s.phase === 'needs-switch') {
    body = html`<div class="stack">
      <${Notice} kind="warn" icon="alert">এই ফোনের লাইব্রেরি অন্য একটি অ্যাকাউন্টের সাথে যুক্ত, যেটা <b>${s.user?.email}</b> দেখতে পারে না। কী করবেন?<//>
      <button class="btn primary" onClick=${async () => {
        const ok = await confirmDialog({ title: 'বইগুলো নতুন অ্যাকাউন্টে নেবেন?', body: `এই ফোনের সব বই ${s.user?.email}-এর লাইব্রেরিতে মিশিয়ে দেওয়া হবে। আগের অ্যাকাউন্টের ক্লাউড কপি যেমন ছিল তেমনই থাকবে।`, ok: 'হ্যাঁ, নিয়ে যান' });
        if (ok) await cloud.confirmSwitch({ keep: true });
      }}>এই ফোনের বই এই অ্যাকাউন্টে নিয়ে যান</button>
      <div class="btn-row">
        <button class="btn ghost" onClick=${() => cloud.signOut()}>সাইন আউট</button>
        <button class="btn danger" onClick=${async () => {
          const ok = await confirmDialog({ title: 'এই ফোন খালি করে শুরু করবেন?', body: 'এই ফোনের তথ্য সরিয়ে নতুন অ্যাকাউন্টের তথ্য আনা হবে (আগে স্বয়ংক্রিয় ব্যাকআপ রাখা হবে)। চাইলে আগে “ব্যাকআপ ফাইল নামান” দিয়ে একটা কপি রেখে দিন।', ok: 'হ্যাঁ, খালি করুন', danger: true });
          if (ok) await cloud.confirmSwitch();
        }}>খালি করে শুরু</button>
      </div>
    </div>`;
  } else if (s.phase === 'removed') {
    body = html`<div class="stack">
      <${Notice} kind="warn" icon="alert">এই লাইব্রেরিতে <b>${s.user?.email}</b>-এর প্রবেশাধিকার আর নেই (মালিক সরিয়ে দিয়েছেন)। এই ফোনে সব বই যেমন ছিল তেমনই আছে।<//>
      <div class="btn-row">
        <button class="btn primary" onClick=${() => cloud.useOwnLibrary().then(() => toast('এখন থেকে এটা আপনার নিজের লাইব্রেরি', { type: 'ok' }), (e) => toast(authErrorText(e), { type: 'err' }))}>নিজের লাইব্রেরি হিসেবে রাখুন</button>
        <button class="btn ghost" onClick=${() => cloud.signOut()}>সাইন আউট</button>
      </div>
    </div>`;
  } else if (s.phase === 'error') {
    body = html`<div class="stack"><${Notice} kind="err" icon="alert">${s.error}<//>
      <div class="btn-row"><button class="btn soft" onClick=${() => location.reload()}><${Icon} name="refresh" /> আবার চেষ্টা</button>
      ${cfg?.source === 'device' && html`<button class="btn ghost" onClick=${() => { clearConfig(); location.reload(); }}>সেটআপ মুছুন</button>`}</div></div>`;
  } else {
    const st = sync.state;
    const lib = s.library || {};
    const google = s.user?.provider === 'google.com';
    body = html`<div class="stack">
      <div class="row"><span class="ic" style="width:38px;height:38px;border-radius:12px;display:grid;place-items:center;background:var(--leaf-soft);color:var(--leaf)">${google ? html`<${GoogleG} />` : html`<${Icon} name="user" />`}</span>
        <div class="grow"><b>${s.user?.name || s.user?.email}</b><div class="faint">${s.user?.name ? `${s.user.email} · ` : ''}${google ? 'Google' : 'ইমেইল'} অ্যাকাউন্টে লগইন করা</div></div></div>
      <div class="lib-line">${lib.own
        ? html`<${Icon} name="folder" size=${16} /> <span>আপনার নিজের লাইব্রেরি${lib.members?.length ? html` · <b>${bn(lib.members.length)}</b> জনের সাথে শেয়ার করা` : ''}</span>`
        : html`<${Icon} name="heart" size=${16} /> <span><b>${lib.ownerName || lib.ownerEmail || 'অন্যজনের'}</b>-এর লাইব্রেরি — আপনাকে যোগ করা হয়েছে</span>`}</div>
      <${Notice} kind=${st === 'synced' ? 'ok' : st === 'error' ? 'err' : st === 'offline' ? 'warn' : 'info'} icon=${st === 'synced' ? 'cloud' : st === 'offline' ? 'cloudOff' : st === 'error' ? 'alert' : 'refresh'}>
        ${st === 'synced' && html`<b>সব তথ্য ক্লাউডে নিরাপদ।</b> ${sync.lastSyncedAt ? `শেষ সিঙ্ক ${ago(sync.lastSyncedAt)}।` : ''}`}
        ${st === 'syncing' && html`সিঙ্ক হচ্ছে…${sync.pending ? ` (${bn(sync.pending)}টি বাকি)` : ''}`}
        ${(st === 'starting' || !st) && 'সিঙ্ক শুরু হচ্ছে…'}
        ${st === 'offline' && html`<b>ইন্টারনেট নেই।</b> ${sync.pending ? `${bn(sync.pending)}টি পরিবর্তন এই ফোনে জমা আছে — ইন্টারনেট এলেই নিজে থেকে ক্লাউডে যাবে।` : 'সব পরিবর্তন আগেই ক্লাউডে পৌঁছেছে।'}`}
        ${st === 'error' && html`<b>সিঙ্কে সমস্যা:</b> ${sync.error}${/permission/i.test(sync.error || '') ? ' — Firestore rules হালনাগাদ করা হয়েছে কি না দেখুন (গাইড দেখুন)।' : ''}`}
      <//>
      <div class="btn-row">
        <button class="btn soft" onClick=${() => cloud.syncNow().then(() => toast('সিঙ্ক করা হলো', { type: 'ok' })).catch((e) => toast(e.message, { type: 'err' }))}><${Icon} name="refresh" /> এখনই সিঙ্ক</button>
        <button class="btn soft" onClick=${openLinkDevice}><${Icon} name="qr" /> অন্য ফোনে খুলুন</button>
      </div>
      ${lib.own && html`<${ShareSection} cloud=${cloud} state=${s} />`}
      ${lib.own && s.invites?.length > 0 && html`<div class="stack"><b>আপনাকে যেসব লাইব্রেরিতে যোগ করা হয়েছে</b><${InviteList} cloud=${cloud} invites=${s.invites} /></div>`}
      <div class="btn-row">
        <button class="btn ghost" onClick=${async () => {
          const ok = await confirmDialog({ title: 'সাইন আউট করবেন?', body: 'এই ফোনের তথ্য থাকবে; আবার লগইন করলে সিঙ্ক চলবে।', ok: 'সাইন আউট' });
          if (ok) await cloud.signOut();
        }}><${Icon} name="logout" /> সাইন আউট</button>
        <button class="btn ghost" onClick=${() => cloud.fullResync().then(() => toast('পুরো লাইব্রেরি আবার মিলিয়ে নেওয়া হচ্ছে'))}>পুরো সিঙ্ক</button>
        ${lib.own && s.user?.verified && html`<button class="btn ghost" onClick=${() => cloud.checkInvites().then(
          (list) => { if (!list.length) toast('আপনার Gmail কোনো লাইব্রেরিতে যোগ করা নেই'); },
          (e) => toast(authErrorText(e), { type: 'err' }),
        )}>শেয়ার করা লাইব্রেরি খুঁজুন</button>`}
      </div>
    </div>`;
  }
  return html`<section class="set-group" id="cloud"><h3><${Icon} name="cloud" /> অ্যাকাউন্ট ও ক্লাউড (দুই ফোনে একসাথে)</h3><div class="card pad">${body}</div></section>`;
}

// ---------------------------------------------------------------- gemini
function GeminiSection({ settings, focus }) {
  const [key, setKey] = useState(settings.geminiApiKey || '');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [models, setModels] = useState(null);
  const ref = useRef();
  useEffect(() => { if (focus) ref.current?.scrollIntoView({ block: 'center' }); }, [focus]);
  useEffect(() => { setKey(settings.geminiApiKey || ''); }, [settings.geminiApiKey]);

  const test = async () => {
    const k = key.trim();
    if (!k) return toast('API key লিখুন', { type: 'err' });
    setBusy(true);
    try {
      const r = await testKey(k);
      if (!r.ok) throw Object.assign(new Error(r.error?.message || r.error || 'কাজ করছে না'), { code: r.error?.code });
      await updateSettings({ geminiApiKey: k, geminiModel: settings.geminiModel && settings.geminiModelPinned ? settings.geminiModel : r.model || '' });
      toast(`অনলাইন স্ক্যানার চালু হয়েছে ✓ (${r.model})`, { type: 'ok' });
      listModels(k).then(setModels).catch(() => {});
    } catch (e) {
      const msg = e.code === 'bad-key' ? 'API key-টি সঠিক নয়' : e.code === 'offline' ? 'ইন্টারনেট সংযোগ নেই' : e.code === 'quota' ? 'আজকের ফ্রি সীমা শেষ — পরে চেষ্টা করুন' : e.message;
      toast(`পরীক্ষা ব্যর্থ: ${msg}`, { type: 'err' });
    } finally {
      setBusy(false);
    }
  };

  return html`<section class="set-group" id="gemini" ref=${ref}><h3><${Icon} name="sparkle" /> অনলাইন স্ক্যানার (Gemini)</h3>
    <div class="card pad stack">
      <p class="muted" style="margin:0">ইন্টারনেট থাকলে Google Gemini দিয়ে বইয়ের মলাট পড়া হবে — নকশাদার বাংলা লেখাও প্রায় নির্ভুলভাবে পড়ে। এর জন্য একটি <b>ফ্রি API key</b> লাগবে: <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a> → “Create API key”। ইন্টারনেট না থাকলে ফোনের অফলাইন স্ক্যানার কাজ করবে।</p>
      <label class="field" style="margin:0"><span>API key</span>
        <div class="row"><input class="input grow" type=${show ? 'text' : 'password'} value=${key} onInput=${(e) => setKey(e.target.value)} placeholder="AIza…" autocomplete="off" spellcheck="false" />
        <button type="button" class="icon-btn" onClick=${() => setShow(!show)} aria-label="দেখান"><${Icon} name=${show ? 'eyeOff' : 'eye'} /></button></div>
      </label>
      ${settings.geminiApiKey && html`<div class="faint">চালু আছে ✓ ${settings.geminiModel ? `· মডেল: ${settings.geminiModel}` : ''} · দুই ফোনেই কাজ করবে</div>`}
      <div class="btn-row">
        <button class="btn primary" onClick=${test} disabled=${busy}><${Icon} name=${busy ? 'refresh' : 'check'} className=${busy ? 'spin' : ''} /> পরীক্ষা করে চালু করুন</button>
        ${settings.geminiApiKey && html`<button class="btn ghost" onClick=${async () => { await updateSettings({ geminiApiKey: '', geminiModel: '' }); setKey(''); toast('অনলাইন স্ক্যানার বন্ধ'); }}>বন্ধ করুন</button>`}
      </div>
      ${models && models.length > 0 && html`<label class="field" style="margin:0"><span>মডেল (সাধারণত স্বয়ংক্রিয়ই সবচেয়ে ভালো)</span>
        <select class="select" style="width:100%" value=${settings.geminiModelPinned ? settings.geminiModel : ''} onChange=${(e) => updateSettings(e.target.value ? { geminiModel: e.target.value, geminiModelPinned: true } : { geminiModelPinned: false })}>
          <option value="">স্বয়ংক্রিয় (${settings.geminiModel || '—'})</option>
          ${models.filter((m) => /gemini/i.test(m.name) && (m.methods || []).includes('generateContent')).map((m) => html`<option value=${m.name}>${m.displayName || m.name}</option>`)}
        </select></label>`}
      <label class="switch"><input type="checkbox" checked=${settings.scanEngine === 'offline'} onChange=${(e) => updateSettings({ scanEngine: e.target.checked ? 'offline' : 'auto' })} />
        <span>সবসময় অফলাইন স্ক্যানার ব্যবহার করুন</span></label>
    </div>
  </section>`;
}

function OfflineScannerSection() {
  const [ready, setReady] = useState(false);
  const [prog, setProg] = useState(null);
  useEffect(() => { checkOfflineReady().then(setReady); }, []);
  const run = async () => {
    setProg('শুরু হচ্ছে…');
    try {
      await warmupOffline({ onProgress: (p) => setProg(typeof p === 'string' ? p : p?.status ? `${p.status} ${p.progress ? bn(Math.round(p.progress * 100)) + '%' : ''}` : '…') });
      const ok = await checkOfflineReady();
      setReady(ok);
      toast(ok ? 'অফলাইন স্ক্যানার প্রস্তুত ✓' : 'স্ক্যানার চলছে, তবে অফলাইনের জন্য পুরোপুরি জমা হয়নি — অ্যাপটি একবার বন্ধ করে খুলে আবার চেষ্টা করুন', { type: ok ? 'ok' : '' });
    } catch (e) {
      toast(`ডাউনলোড হয়নি: ${e?.message || e}`, { type: 'err' });
    } finally {
      setProg(null);
    }
  };
  return html`<div class="set-item">
    <span class="ic"><${Icon} name="wifiOff" /></span>
    <span class="tx"><b>অফলাইন স্ক্যানার</b><small>${ready ? 'প্রস্তুত ✓ — ইন্টারনেট ছাড়াই মলাট পড়তে পারবে' : 'একবার ইন্টারনেটে প্রস্তুত করে নিন (প্রায় ৮ MB)'}</small>
    ${prog && html`<small style="display:block;color:var(--lilac)">${prog}</small>`}</span>
    <button class="btn soft sm" onClick=${run} disabled=${!!prog}>${ready ? 'আবার' : 'প্রস্তুত করুন'}</button>
  </div>`;
}

// ---------------------------------------------------------------- backup
function csvCell(v) {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // never let a spreadsheet run a cell as a formula
  return /[",\n']/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function exportCsv(lib) {
  const rows = [['শিরোনাম', 'লেখক', 'ধরন', 'প্রকাশনী', 'ISBN', 'কপি', 'পড়ার অবস্থা', 'প্রিয়', 'নোট', 'সম্পূর্ণ তালিকায় নাম', 'যোগের তারিখ']];
  const books = [...lib.books].sort((a, b) => byName(lib.authorById.get(a.authorId) || { name: '' }, lib.authorById.get(b.authorId) || { name: '' }) || byTitle(a, b));
  for (const b of books) {
    rows.push([b.title, lib.authorById.get(b.authorId)?.name || '', b.category, b.publisher, b.isbn, b.copies || 1, READ_LABEL[b.readStatus || ''],
      b.favorite ? 'হ্যাঁ' : '', b.notes, b.catalogId ? lib.catalogById.get(b.catalogId)?.title || '' : '', bnDate(b.createdAt)]);
  }
  const text = `﻿${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}`;
  downloadFile(`mazedar-library-${new Date().toISOString().slice(0, 10)}.csv`, text, 'text/csv;charset=utf-8');
}

async function exportJson(includeCovers) {
  const data = await ctx.store.exportAll({ includeCovers });
  downloadFile(`mazedar-library-backup-${new Date().toISOString().slice(0, 10)}${includeCovers ? '' : '-no-covers'}.json`, JSON.stringify(data), 'application/json');
  await ctx.store.setMeta('lastExportAt', Date.now());
  toast('ব্যাকআপ ফাইল নামানো হয়েছে — নিরাপদ জায়গায় রেখে দিন', { type: 'ok' });
}

function openSnapshots() {
  openSheet((close) => html`<${SnapshotList} close=${close} />`);
}

function SnapshotList({ close }) {
  const [list, setList] = useState(null);
  useEffect(() => { ctx.store.listSnapshots().then(setList); }, []);
  return html`<div>
    <h3>স্বয়ংক্রিয় ব্যাকআপ</h3>
    <p class="muted" style="margin-top:0">এই ফোন প্রতিদিন আর বড় কোনো পরিবর্তনের আগে নিজে থেকেই লাইব্রেরির একটা কপি রাখে (শেষ ১৫টি)। ভুল করে কিছু হারালে এখান থেকে আগের অবস্থায় ফেরা যাবে।</p>
    ${!list ? html`<p class="faint">লোড হচ্ছে…</p>` : !list.length ? html`<p class="faint">এখনো কোনো ব্যাকআপ নেই।</p>` : list.map((s) => html`<div class="set-item" key=${s.id}>
      <span class="ic"><${Icon} name="history" /></span>
      <span class="tx"><b>${bnDateTime(s.ts)}</b><small>${s.reason} · ${bn(s.count)}টি রেকর্ড</small></span>
      <button class="btn soft sm" onClick=${async () => {
        const ok = await confirmDialog({ title: 'এই অবস্থায় ফিরে যাবেন?', body: `${bnDateTime(s.ts)}-এর পরে করা পরিবর্তনগুলো উল্টে যাবে (তার আগে বর্তমান অবস্থারও ব্যাকআপ রাখা হবে)।`, ok: 'ফিরে যান' });
        if (!ok) return;
        const n = await ctx.store.restoreSnapshot(s.id);
        close();
        toast(`আগের অবস্থায় ফেরানো হয়েছে (${bn(n)}টি পরিবর্তন)`, { type: 'ok' });
      }}>ফিরে যান</button>
    </div>`)}
    <button class="btn ghost block" style="margin-top:12px" onClick=${close}>বন্ধ</button>
  </div>`;
}

function BackupSection({ lib }) {
  const fileRef = useRef();
  const [persisted, setPersisted] = useState(null);
  const [lastExport, setLastExport] = useState(null);
  useEffect(() => {
    navigator.storage?.persisted?.().then(setPersisted).catch(() => {});
    ctx.store.getMeta('lastExportAt').then(setLastExport);
  }, []);
  const importFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const ok = await confirmDialog({ title: 'ব্যাকআপ থেকে তথ্য আনবেন?', body: 'ফাইলের তথ্য এই লাইব্রেরির সাথে মেলানো হবে — নতুন করা কোনো পরিবর্তন হারাবে না।', ok: 'আনুন' });
      if (!ok) return;
      const r = await ctx.store.importAll(data);
      toast(`ব্যাকআপ আনা হয়েছে: ${bn(r.added)}টি নতুন, ${bn(r.updated)}টি হালনাগাদ`, { type: 'ok' });
    } catch (err) {
      toast(err.message || 'ফাইলটি পড়া যায়নি', { type: 'err' });
    }
  };
  return html`<section class="set-group"><h3><${Icon} name="storage" /> ব্যাকআপ ও নিরাপত্তা</h3>
    <div class="card">
      <button class="set-item" onClick=${() => exportJson(true)}><span class="ic"><${Icon} name="download" /></span>
        <span class="tx"><b>ব্যাকআপ ফাইল নামান</b><small>${lastExport ? `শেষবার: ${bnDate(lastExport)}` : 'সব বই, তালিকা ও কভারের ছবিসহ একটি ফাইল'}</small></span></button>
      <button class="set-item" onClick=${() => exportJson(false)}><span class="ic"><${Icon} name="download" /></span>
        <span class="tx"><b>ছোট ব্যাকআপ (ছবি ছাড়া)</b><small>শুধু তথ্য — হোয়াটসঅ্যাপ/ইমেইলে পাঠানো সহজ</small></span></button>
      <input ref=${fileRef} type="file" accept="application/json,.json" class="sr-only" onChange=${importFile} />
      <button class="set-item" onClick=${() => fileRef.current.click()}><span class="ic"><${Icon} name="upload" /></span>
        <span class="tx"><b>ব্যাকআপ থেকে তথ্য আনুন</b><small>আগের ফাইল থেকে — কিছুই মুছে যাবে না, শুধু মিলিয়ে নেবে</small></span></button>
      <button class="set-item" onClick=${() => exportCsv(lib)}><span class="ic"><${Icon} name="list" /></span>
        <span class="tx"><b>এক্সেল (CSV) ফাইল</b><small>সব বইয়ের তালিকা স্প্রেডশিটে</small></span></button>
      <a class="set-item" href="#/print"><span class="ic"><${Icon} name="print" /></span>
        <span class="tx"><b>প্রিন্ট / PDF</b><small>লেখক অনুযায়ী সাজানো সুন্দর তালিকা</small></span></a>
      <button class="set-item" onClick=${openSnapshots}><span class="ic"><${Icon} name="history" /></span>
        <span class="tx"><b>স্বয়ংক্রিয় ব্যাকআপ</b><small>প্রতিদিন নিজে থেকে রাখা কপি — আগের অবস্থায় ফেরা</small></span></button>
      <a class="set-item" href="#/trash"><span class="ic"><${Icon} name="trash" /></span>
        <span class="tx"><b>মুছে ফেলা জিনিস</b><small>${lib.trash.length ? `${bn(lib.trash.length)}টি — ফেরত আনা যাবে` : 'খালি'}</small></span></a>
      ${lib.dupes.length > 0 && html`<a class="set-item" href="#/dupes"><span class="ic" style="background:var(--gold-soft);color:var(--gold)"><${Icon} name="alert" /></span>
        <span class="tx"><b>দুবার থাকা বই</b><small>${bn(lib.dupes.length)}টি জোড়া দেখে নিন</small></span></a>`}
      <div class="set-item"><span class="ic"><${Icon} name="storage" /></span>
        <span class="tx"><b>স্থায়ী স্টোরেজ</b><small>${persisted ? 'চালু ✓ — ফোনের জায়গা কমলেও ব্রাউজার এই তথ্য মুছবে না' : 'চালু করলে জায়গা কমলেও ব্রাউজার তথ্য মুছবে না'}</small></span>
        ${!persisted && html`<button class="btn soft sm" onClick=${async () => {
          const ok = await navigator.storage?.persist?.();
          setPersisted(!!ok);
          toast(ok ? 'স্থায়ী স্টোরেজ চালু হয়েছে ✓' : 'ব্রাউজার অনুমতি দেয়নি — অ্যাপটি হোম স্ক্রিনে ইনস্টল করে আবার চেষ্টা করুন', { type: ok ? 'ok' : '' });
        }}>চালু করুন</button>`}
      </div>
    </div>
  </section>`;
}

// ---------------------------------------------------------------- page
export function SettingsPage({ lib, cloudState, query }) {
  const [theme, setTheme] = usePref('theme', 'system');
  useEffect(() => {
    if (theme === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
  }, [theme]);
  const s = lib.settings;
  return html`<div class="page">
    <${TopBar} title="সেটিংস" />
    <div style="height:14px" />
    <${CloudSection} state=${cloudState} />
    <${GeminiSection} settings=${s} focus=${query.focus === 'gemini'} />

    <section class="set-group"><h3><${Icon} name="camera" /> স্ক্যানার</h3>
      <div class="card">
        <${OfflineScannerSection} />
        <label class="set-item switch" style="cursor:pointer">
          <span class="ic"><${Icon} name="flash" /></span>
          <span class="tx"><b>নিশ্চিত হলে সরাসরি যোগ</b><small>“যোগ করুন” মোডে তালিকার নামের সাথে হুবহু মিললে ফর্ম ছাড়াই যোগ হবে (ফিরিয়ে নেওয়া যাবে)</small></span>
          <input type="checkbox" checked=${!!s.autoSaveExact} onChange=${(e) => updateSettings({ autoSaveExact: e.target.checked })} />
        </label>
      </div>
    </section>

    <${BackupSection} lib=${lib} />

    <section class="set-group"><h3><${Icon} name="moon" /> দেখতে কেমন</h3>
      <div class="card pad"><div class="seg">
        ${[['system', 'ফোনের মতো'], ['light', 'হালকা'], ['dark', 'গাঢ়']].map(([v, l]) => html`<button class=${theme === v ? 'on' : ''} onClick=${() => setTheme(v)}>${l}</button>`)}
      </div></div>
    </section>

    <section class="set-group"><h3><${Icon} name="heart" /> সম্পর্কে</h3>
      <div class="card pad center">
        <${Lily} size=${90} />
        <div class="brand-name" style="font-size:30px">মাজেদার <b>লাইব্রেরি</b></div>
        <p class="muted" style="margin:4px 0 10px">বইয়ের জন্য একটা ছোট্ট বাগান 🌷</p>
        <a class="btn soft sm" href="docs/promo/mazedar-library-promo.mp4" target="_blank" rel="noopener" style="margin-bottom:12px">🎬 প্রোমো ভিডিও দেখুন</a>
        <p class="faint" style="margin:0">হুমায়ূন আহমেদের সম্পূর্ণ তালিকা: দেওয়া PDF-এর ২১৯টি নাম + সংগ্রহে থাকা আরো ১৭টি। সব তথ্য বদলানো যায়।</p>
        <p class="faint">সংস্করণ ${bn(globalThis.MAZEDAR_VERSION || '১.০.০')} · <a href="https://github.com/jarifalamclaude-max/MazedarLibrary" target="_blank" rel="noopener">GitHub</a></p>
        <button class="btn ghost sm" onClick=${() => globalThis.mazedarCheckUpdate?.()}><${Icon} name="refresh" /> নতুন সংস্করণ আছে কি না দেখুন</button>
      </div>
    </section>
  </div>`;
}

// ---------------------------------------------------------------- trash
export function TrashPage({ lib }) {
  const items = [...lib.trash].sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0));
  const label = (r) => (r.kind === 'author' ? 'লেখক' : r.kind === 'catalog' ? 'তালিকার নাম' : 'বই');
  return html`<div class="page">
    <${TopBar} title="মুছে ফেলা জিনিস" backTo="/settings"
      right=${items.length > 0 && html`<button class="btn ghost sm" onClick=${async () => {
        const ok = await confirmDialog({ title: 'সব চিরতরে মুছবেন?', body: `${bn(items.length)}টি জিনিস আর ফেরত আনা যাবে না।`, ok: 'চিরতরে মুছুন', danger: true });
        if (ok) await ctx.store.putMany('records', items.map((r) => ({ id: r.id, purged: true })));
      }}>সব খালি</button>`} />
    ${!items.length ? html`<${Empty} title="কিছুই মুছে ফেলা হয়নি"><p>মুছে ফেলা বই, লেখক বা তালিকার নাম এখানে থাকে — চাইলে ফেরত আনা যায়।</p><//>`
      : html`<div class="book-list" style="margin-top:14px">${items.map((r) => html`<div class="book" key=${r.id}>
        ${r.kind === 'book' ? html`<${Cover} book=${r} />` : html`<span class="check"><${Icon} name=${r.kind === 'author' ? 'folder' : 'list'} /></span>`}
        <div class="grow"><div class="t">${r.title || r.name}</div>
          <div class="m"><span>${label(r)}</span>${r.kind !== 'author' && html`<span>${lib.records.get(r.authorId)?.name || ''}</span>`}<span>${ago(r.deletedAt)}</span></div></div>
        <div class="side">
          <button class="btn soft sm" onClick=${() => restoreRecord(lib, r).then(() => toast('ফেরত আনা হয়েছে 🌸', { type: 'ok' }))}><${Icon} name="undo" /> ফেরত</button>
          <button class="icon-btn" aria-label="চিরতরে মুছুন" onClick=${async () => {
            const ok = await confirmDialog({ title: 'চিরতরে মুছবেন?', body: `“${r.title || r.name}” আর ফেরত আনা যাবে না।`, ok: 'মুছুন', danger: true });
            if (ok) await purgeRecord(r);
          }}><${Icon} name="trash" /></button>
        </div>
      </div>`)}</div>`}
  </div>`;
}

// ---------------------------------------------------------------- duplicates
export function DupesPage({ lib }) {
  return html`<div class="page">
    <${TopBar} title="দুবার থাকা বই" />
    ${!lib.dupes.length ? html`<${Empty} title="কোনো বই দুবার নেই 🌸" />` : html`<div style="margin-top:14px">
      <p class="muted">একই লেখকের একই নামের (বা সম্পূর্ণ তালিকার একই নামের সাথে যুক্ত) দুটি বই পাওয়া গেছে। একই বইয়ের দুটি কপি হলে “এক করুন” চাপুন — কপির সংখ্যা ২ হবে।</p>
      ${lib.dupes.map(({ a, b }) => html`<div class="card pad" key=${a.id + b.id} style="margin-bottom:12px">
        ${[a, b].map((x) => html`<a class="book" href=${`#/b/${x.id}`} style="margin-bottom:6px"><${Cover} book=${x} /><div class="grow"><div class="t">${x.title}</div>
          <div class="m">${x.serial ? html`<span>প্রথম তালিকার ${bn(x.serial)} নম্বর</span>` : ''}<span>${bn(x.copies || 1)} কপি</span><span>${bnDate(x.createdAt)}</span></div></div></a>`)}
        <div class="btn-row" style="margin-top:8px">
          <button class="btn primary sm" onClick=${async () => {
            const keep = (a.serial ?? 1e9) <= (b.serial ?? 1e9) ? a : b;
            const drop = keep === a ? b : a;
            await updateRecord(keep.id, {
              copies: (Number(keep.copies) || 1) + (Number(drop.copies) || 1),
              notes: [keep.notes, drop.notes].filter(Boolean).join('\n'),
              catalogId: keep.catalogId || drop.catalogId || null, // keep the list link so the countdown stays right
            });
            await trashRecord(lib, drop);
            toast(`এক করা হলো — “${keep.title}” এখন ${bn((Number(keep.copies) || 1) + (Number(drop.copies) || 1))} কপি`, { type: 'ok' });
          }}>এক করুন (কপি যোগ)</button>
          <button class="btn ghost sm" onClick=${async () => {
            await ctx.store.putMany('records', [
              { id: a.id, notDuplicateOf: [...new Set([...(a.notDuplicateOf || []), b.id])] },
              { id: b.id, notDuplicateOf: [...new Set([...(b.notDuplicateOf || []), a.id])] },
            ]);
            toast('ঠিক আছে — এগুলো আলাদা বই হিসেবে থাকল');
          }}>এগুলো আলাদা বই</button>
        </div>
      </div>`)}
    </div>`}
  </div>`;
}

// ---------------------------------------------------------------- setup link
export function SetupPage({ query }) {
  let cfg = null;
  let err = null;
  try { cfg = decodeSetupParam(query.c || ''); } catch (e) { err = e.message; }
  return html`<div class="page">
    <${TopBar} title="ক্লাউড সেটআপ" backTo="/" />
    <div class="card pad" style="margin-top:16px">
      ${err ? html`<${Notice} kind="err" icon="alert">লিংকটি ঠিক নেই: ${err}<//>` : html`<div class="stack center">
        <${Lily} size=${100} />
        <p>এই ফোনে <b>মাজেদার লাইব্রেরি</b>-র ক্লাউড সিঙ্ক চালু হবে (প্রজেক্ট: ${cfg.projectId})। তারপর Google দিয়ে লগইন করবেন।</p>
        <button class="btn primary" onClick=${() => { saveConfig(cfg); navigate('/settings', { replace: true }); location.reload(); }}><${Icon} name="check" /> চালু করুন</button>
      </div>`}
    </div>
  </div>`;
}

// ---------------------------------------------------------------- print
export function PrintPage({ lib }) {
  const authors = [...lib.authors].sort(byName);
  return html`<div class="print-page">
    <div class="no-print row" style="margin-bottom:14px">
      <button class="btn ghost sm" onClick=${() => history.back()}><${Icon} name="back" /> ফিরে যান</button>
      <button class="btn primary sm" onClick=${() => print()}><${Icon} name="print" /> প্রিন্ট / PDF</button>
    </div>
    <h1>মাজেদার লাইব্রেরি</h1>
    <p style="margin:2px 0 0;color:#666">${bnDate(Date.now())} · মোট ${bn(lib.totals.books)}টি বই · ${bn(lib.totals.authors)}জন লেখক</p>
    ${authors.map((a) => {
      const books = [...(lib.booksByAuthor.get(a.id) || [])].sort(byTitle);
      const st = lib.stats.get(a.id);
      return html`<section key=${a.id}>
        <h2>${a.name} <small style="font-size:14px;color:#888">(${bn(books.length)}টি${st.catalogTotal ? ` · আরো লাগবে ${bn(st.remaining)}টি` : ''})</small></h2>
        <ol>${books.map((b) => html`<li>${b.title}${(Number(b.copies) || 1) > 1 ? ` (${bn(b.copies)} কপি)` : ''}</li>`)}</ol>
      </section>`;
    })}
  </div>`;
}

export { groupById };
