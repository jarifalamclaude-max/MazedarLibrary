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
    <h3>ক্লাউড সিঙ্ক সেটআপ</h3>
    <p class="muted" style="margin-top:0">Firebase কনসোল থেকে পাওয়া <b>firebaseConfig</b> অংশটুকু এখানে পেস্ট করুন। ধাপগুলো <a href=${GUIDE_URL} target="_blank" rel="noopener">সেটআপ গাইডে</a> আছে।</p>
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
  const link = makeSetupLink(cfg);
  openSheet((close) => html`<div>
    <h3>অন্য ফোন যুক্ত করুন</h3>
    <p class="muted" style="margin-top:0">অন্য ফোনের ক্যামেরা দিয়ে এই QR কোডটি স্ক্যান করুন (অথবা লিংকটি পাঠান)। খুললে একই ইমেইল ও পাসওয়ার্ড দিয়ে লগইন করবেন — তারপর দুই ফোনেই একসাথে একই লাইব্রেরি।</p>
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
    <p class="muted" style="margin:0">দুজনেই <b>একই ইমেইল ও পাসওয়ার্ড</b> দিয়ে লগইন করবেন — তাহলে দুই ফোনে একসাথে একই লাইব্রেরি দেখা ও বদলানো যাবে।</p>
    <label class="field" style="margin:0"><span>ইমেইল</span><input class="input" type="email" autocomplete="username" value=${email} onInput=${(e) => setEmail(e.target.value)} /></label>
    <label class="field" style="margin:0"><span>পাসওয়ার্ড</span>
      <div class="row"><input class="input grow" type=${show ? 'text' : 'password'} autocomplete="current-password" value=${pw} onInput=${(e) => setPw(e.target.value)} />
      <button type="button" class="icon-btn" onClick=${() => setShow(!show)} aria-label="পাসওয়ার্ড দেখান"><${Icon} name=${show ? 'eyeOff' : 'eye'} /></button></div>
    </label>
    ${state.error && html`<${Notice} kind="err" icon="alert">${state.error}<//>`}
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

function CloudSection({ state }) {
  const cloud = ctx.cloud;
  const cfg = readConfig();
  const s = state || {};
  const sync = s.sync || {};
  let body;
  if (!s.configured || s.phase === 'off') {
    body = html`<div class="stack">
      <${Notice} kind="info" icon="storage">এখন সব তথ্য <b>শুধু এই ফোনে</b> আছে (ইন্টারনেট ছাড়াই চলে)। দুই ফোনে একই অ্যাকাউন্টে একসাথে ব্যবহার করতে আর তথ্য চিরদিন নিরাপদ রাখতে ক্লাউড সিঙ্ক চালু করুন।<//>
      <div class="btn-row">
        <button class="btn primary" onClick=${openConfigSheet}><${Icon} name="cloud" /> ক্লাউড সিঙ্ক সেটআপ</button>
        <a class="btn ghost" href=${GUIDE_URL} target="_blank" rel="noopener"><${Icon} name="info" /> গাইড</a>
      </div>
    </div>`;
  } else if (s.phase === 'loading') {
    body = html`<p class="muted"><${Icon} name="refresh" className="spin" size=${16} /> ক্লাউডের সাথে সংযোগ হচ্ছে…</p>`;
  } else if (s.phase === 'signed-out' || s.phase === 'busy') {
    body = html`<${LoginForm} cloud=${cloud} state=${s} />`;
  } else if (s.phase === 'needs-switch') {
    body = html`<div class="stack">
      <${Notice} kind="warn" icon="alert">এই ফোনের লাইব্রেরি অন্য একটি অ্যাকাউন্টের সাথে যুক্ত ছিল। <b>${s.user?.email}</b> অ্যাকাউন্টে যেতে হলে এই ফোনের তথ্য সরিয়ে নতুন অ্যাকাউন্টের তথ্য আনা হবে (আগে স্বয়ংক্রিয় ব্যাকআপ রাখা হবে)।<//>
      <div class="btn-row">
        <button class="btn ghost" onClick=${() => cloud.signOut()}>সাইন আউট</button>
        <button class="btn danger" onClick=${async () => {
          const ok = await confirmDialog({ title: 'নিশ্চিত?', body: 'চাইলে আগে “ব্যাকআপ ফাইল নামান” দিয়ে একটা কপি রেখে দিন।', ok: 'হ্যাঁ, বদলান', danger: true });
          if (ok) await cloud.confirmSwitch();
        }}>অ্যাকাউন্ট বদলান</button>
      </div>
    </div>`;
  } else if (s.phase === 'error') {
    body = html`<div class="stack"><${Notice} kind="err" icon="alert">${s.error}<//>
      <div class="btn-row"><button class="btn soft" onClick=${() => location.reload()}><${Icon} name="refresh" /> আবার চেষ্টা</button>
      ${cfg?.source === 'device' && html`<button class="btn ghost" onClick=${() => { clearConfig(); location.reload(); }}>সেটআপ মুছুন</button>`}</div></div>`;
  } else {
    const st = sync.state;
    body = html`<div class="stack">
      <div class="row"><span class="ic" style="width:38px;height:38px;border-radius:12px;display:grid;place-items:center;background:var(--leaf-soft);color:var(--leaf)"><${Icon} name="user" /></span>
        <div class="grow"><b>${s.user?.email}</b><div class="faint">এই অ্যাকাউন্টে লগইন করা</div></div></div>
      <${Notice} kind=${st === 'synced' ? 'ok' : st === 'error' ? 'err' : st === 'offline' ? 'warn' : 'info'} icon=${st === 'synced' ? 'cloud' : st === 'offline' ? 'cloudOff' : st === 'error' ? 'alert' : 'refresh'}>
        ${st === 'synced' && html`<b>সব তথ্য ক্লাউডে নিরাপদ।</b> ${sync.lastSyncedAt ? `শেষ সিঙ্ক ${ago(sync.lastSyncedAt)}।` : ''}`}
        ${st === 'syncing' && html`সিঙ্ক হচ্ছে…${sync.pending ? ` (${bn(sync.pending)}টি বাকি)` : ''}`}
        ${st === 'starting' && 'সিঙ্ক শুরু হচ্ছে…'}
        ${st === 'offline' && html`<b>ইন্টারনেট নেই।</b> ${sync.pending ? `${bn(sync.pending)}টি পরিবর্তন এই ফোনে জমা আছে — ইন্টারনেট এলেই নিজে থেকে ক্লাউডে যাবে।` : 'সব পরিবর্তন আগেই ক্লাউডে পৌঁছেছে।'}`}
        ${st === 'error' && html`<b>সিঙ্কে সমস্যা:</b> ${sync.error}${/permission/i.test(sync.error || '') ? ' — Firestore rules ঠিকমতো বসানো হয়েছে কি না দেখুন (গাইড দেখুন)।' : ''}`}
      <//>
      <div class="btn-row">
        <button class="btn soft" onClick=${() => cloud.syncNow().then(() => toast('সিঙ্ক করা হলো', { type: 'ok' })).catch((e) => toast(e.message, { type: 'err' }))}><${Icon} name="refresh" /> এখনই সিঙ্ক</button>
        <button class="btn soft" onClick=${openLinkDevice}><${Icon} name="qr" /> অন্য ফোন যুক্ত করুন</button>
      </div>
      <div class="btn-row">
        <button class="btn ghost" onClick=${async () => {
          const ok = await confirmDialog({ title: 'সাইন আউট করবেন?', body: 'এই ফোনের তথ্য থাকবে; আবার লগইন করলে সিঙ্ক চলবে।', ok: 'সাইন আউট' });
          if (ok) await cloud.signOut();
        }}><${Icon} name="logout" /> সাইন আউট</button>
        <button class="btn ghost" onClick=${() => cloud.fullResync().then(() => toast('পুরো লাইব্রেরি আবার মিলিয়ে নেওয়া হচ্ছে'))}>পুরো সিঙ্ক</button>
      </div>
    </div>`;
  }
  return html`<section class="set-group" id="cloud"><h3><${Icon} name="cloud" /> ক্লাউড সিঙ্ক (দুই ফোনে একসাথে)</h3><div class="card pad">${body}</div></section>`;
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
        <p>এই ফোনে <b>মাজেদার লাইব্রেরি</b>-র ক্লাউড সিঙ্ক চালু হবে (প্রজেক্ট: ${cfg.projectId})। তারপর একই ইমেইল-পাসওয়ার্ড দিয়ে লগইন করবেন।</p>
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
