import {
  html, useState, useEffect, useRef, useMemo, ctx, bn, navigate, goBack, Icon, Lily, Cover, Notice, toast, burst,
} from './core.js';
import { useLib, getLib, updateRecord, acquireEntry, updateSettings, findSimilarBooks } from './data.js';

// Current derived library without subscribing (used inside async callbacks).
const useLibNow = getLib;
import { openBookEditor } from './book.js';
import { openCamera, imageFileToCanvas, canvasToJpegDataUrl, detectBarcodes } from '../lib/camera.js';
import { ocrOffline, warmupOffline } from '../lib/ocr.js';
import { readCover } from '../lib/gemini.js';
import { matchText } from '../lib/matcher.js';
import { similarity } from '../lib/bangla.js';

const clean = (s) => String(s || '').normalize('NFC').trim().replace(/\s+/g, ' ');
const NOISE = /প্রকাশ|প্রকাশনী|প্রকাশন|টাকা|মূল্য|সংস্করণ|www|\.com|isbn/i;

/** Book-shaped guide box in viewport ratios. */
function guideRect() {
  const vw = innerWidth;
  const vh = innerHeight;
  const h = Math.min(vh * 0.56, (vw * 0.8) / 0.68);
  const w = h * 0.68;
  const x = (vw - w) / 2;
  const y = Math.max(96, (vh - h) / 2 - 36);
  return { px: { x, y, w, h }, ratio: { x: x / vw, y: y / vh, w: w / vw, h: h / vh } };
}

function guessTitle(lines, lib) {
  const names = lib.authors.map((a) => a.name);
  const cands = (lines || [])
    .map((l) => ({ text: clean(l.text), conf: Number(l.confidence) || 50 }))
    .filter((l) => /[ঀ-৿A-Za-z]{2,}/.test(l.text) && l.text.length <= 90 && !NOISE.test(l.text))
    .filter((l) => !names.some((n) => similarity(l.text, n) >= 0.8));
  cands.sort((a, b) => b.conf * Math.min(b.text.length, 24) - a.conf * Math.min(a.text.length, 24));
  return cands[0]?.text || '';
}

function guessAuthor(read, lib) {
  const texts = read.author ? [read.author] : (read.lines || []).map((l) => clean(l.text)).filter(Boolean);
  let best = null;
  for (const a of lib.authors) {
    for (const t of texts) {
      const s = similarity(t, a.name);
      if (!best || s > best.s) best = { a, s };
    }
  }
  if (best && best.s >= 0.8) return { authorId: best.a.id, authorName: best.a.name };
  return read.author ? { authorName: clean(read.author) } : {};
}

const online = () => (typeof navigator === 'undefined' ? true : navigator.onLine !== false);

export function ScanPage({ query }) {
  const lib = useLib();
  const settings = lib.settings;
  const [mode, setMode] = useState(query.mode === 'add' ? 'add' : 'search');
  const [phase, setPhase] = useState('starting'); // starting | live | reading | result | nocam
  const [camErr, setCamErr] = useState(null);
  const [torch, setTorch] = useState(false);
  const [progress, setProgress] = useState('');
  const [warm, setWarm] = useState(null);
  const [result, setResult] = useState(null);
  const [preferOffline, setPreferOffline] = useState(settings.scanEngine === 'offline');
  const videoRef = useRef(null);
  const camRef = useRef(null);
  const fileRef = useRef(null);
  const abortRef = useRef(null);
  const [guide, setGuide] = useState(guideRect);

  const canOnline = !!settings.geminiApiKey && online();
  const useOnline = canOnline && !preferOffline;

  async function startCam() {
    if (camRef.current) return;
    setCamErr(null);
    try {
      camRef.current = await openCamera(videoRef.current, { facingMode: 'environment' });
      setPhase((p) => (p === 'starting' || p === 'nocam' ? 'live' : p));
    } catch (e) {
      camRef.current = null;
      setCamErr(e);
      setPhase('nocam');
    }
  }

  function stopCam() {
    try { camRef.current?.stop(); } catch { /* ignore */ }
    camRef.current = null;
    setTorch(false);
  }

  useEffect(() => {
    startCam();
    const onResize = () => setGuide(guideRect());
    const onVis = () => (document.hidden ? stopCam() : startCam());
    window.addEventListener('resize', onResize);
    document.addEventListener('visibilitychange', onVis);
    warmupOffline({ onProgress: (p) => setWarm(p) }).then(() => setWarm({ done: true })).catch(() => setWarm({ failed: true }));
    return () => {
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVis);
      abortRef.current?.abort();
      stopCam();
    };
  }, []);

  async function processCanvas(canvas, { forceOnline = false } = {}) {
    setPhase('reading');
    setResult(null);
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    const thumb = canvasToJpegDataUrl(canvas, 900, 0.82);
    let read = null;
    let source = 'offline';
    let onlineError = null;
    try {
      if (useOnline || forceOnline) {
        setProgress('অনলাইনে নাম পড়া হচ্ছে…');
        try {
          const r = await readCover(canvasToJpegDataUrl(canvas, 1280, 0.88), { apiKey: settings.geminiApiKey, model: settings.geminiModel || undefined, signal: ac.signal });
          if (r.model && r.model !== settings.geminiModel) updateSettings({ geminiModel: r.model }).catch(() => {});
          if (clean(r.title)) {
            read = { title: clean(r.title), author: clean(r.author), lines: [r.title, r.author, ...(r.otherLines || [])].filter(Boolean).map((t) => ({ text: t, confidence: 95 })) };
            source = 'online';
          }
        } catch (e) {
          if (ac.signal.aborted) return;
          onlineError = e;
        }
      }
      if (!read) {
        setProgress('ফোনেই নাম পড়া হচ্ছে…');
        const o = await ocrOffline(canvas, { signal: ac.signal, onProgress: (p) => setProgress(typeof p === 'string' ? p : `ফোনেই নাম পড়া হচ্ছে… ${p?.progress ? bn(Math.round(p.progress * 100)) + '%' : ''}`) });
        read = { title: '', author: '', lines: o.lines || [], text: o.text || '' };
      }
      if (ac.signal.aborted) return;

      const fresh = useLibNow();
      const text = source === 'online' ? read.title : read.text || read.lines.map((l) => l.text).join('\n');
      let m = matchText(text, { books: fresh.books, catalog: fresh.catalog, authors: fresh.authors }, { limit: 5 });

      let isbn = '';
      try {
        const codes = await detectBarcodes(canvas);
        isbn = (codes.map((c) => String(c.rawValue || '').replace(/[^0-9Xx]/g, '')).find((v) => v.length === 13 || v.length === 10)) || '';
      } catch { /* no barcode support */ }
      if (isbn) {
        const hit = fresh.books.find((b) => b.isbn && b.isbn.replace(/[^0-9Xx]/g, '') === isbn);
        if (hit) {
          const author = fresh.authorById.get(hit.authorId);
          m = { level: 'exact', best: { kind: 'book', id: hit.id, title: hit.title, authorName: author?.name || '', score: 1, viaIsbn: true }, candidates: [] };
        }
      }

      const author = guessAuthor(read, fresh);
      const titleGuess = read.title || guessTitle(read.lines, fresh);
      const res = { source, read, match: m, author, titleGuess, thumb, isbn, onlineError, canvas };
      setResult(res);
      setPhase('result');

      if (mode === 'add') afterReadForAdd(res, fresh);
    } catch (e) {
      if (ac.signal.aborted) return;
      toast(`পড়া যায়নি: ${e?.message || e}`, { type: 'err' });
      setPhase(camRef.current ? 'live' : 'nocam');
    }
  }

  function afterReadForAdd(res, fresh) {
    const { match: m } = res;
    const sure = m.best && (m.level === 'exact' || m.level === 'strong');
    if (sure && m.best.kind === 'book') return; // the result card offers copy/duplicate choices
    if (sure && m.best.kind === 'catalog' && settings.autoSaveExact && m.level === 'exact') {
      const entry = fresh.catalogById.get(m.best.id);
      if (entry) {
        acquireEntry(entry, { addedVia: 'scan' }).then(async (book) => {
          await ctx.store.setCover(book.id, res.thumb);
          burst();
          toast(`“${entry.title}” সরাসরি যোগ হলো 🌸`, { type: 'ok', action: { label: 'ফিরিয়ে নিন', run: () => updateRecord(book.id, { deleted: true, deletedAt: Date.now(), purged: true }) } });
          again();
        });
        return;
      }
    }
    openAddEditor(res, fresh);
  }

  function openAddEditor(res, fresh = useLibNow()) {
    const { match: m } = res;
    const sure = m.best && (m.level === 'exact' || m.level === 'strong');
    const entry = sure && m.best.kind === 'catalog' ? fresh.catalogById.get(m.best.id) : null;
    openBookEditor(fresh, {
      title: entry ? entry.title : res.titleGuess,
      catalogId: entry ? entry.id : null,
      authorId: entry ? entry.authorId : res.author.authorId || query.author || '',
      authorName: entry || res.author.authorId ? '' : res.author.authorName || '',
      isbn: res.isbn || '',
      coverDataUrl: res.thumb,
      addedVia: 'scan',
      onSaved: () => again(),
    });
  }

  function again() {
    setResult(null);
    setPhase(camRef.current ? 'live' : 'nocam');
    if (!camRef.current) startCam();
  }

  const shoot = () => {
    const cam = camRef.current;
    if (!cam) return;
    try {
      const canvas = cam.capture(guide.ratio);
      processCanvas(canvas);
    } catch (e) {
      toast(`ছবি নেওয়া যায়নি: ${e?.message || e}`, { type: 'err' });
    }
  };

  const pickFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const canvas = await imageFileToCanvas(file, 2000);
      processCanvas(canvas);
    } catch (err) {
      toast(`ছবিটি খোলা যায়নি: ${err?.message || err}`, { type: 'err' });
    }
  };

  const toggleTorch = async () => {
    try {
      await camRef.current?.setTorch(!torch);
      setTorch(!torch);
    } catch { toast('এই ফোনে টর্চ চালু করা যাচ্ছে না'); }
  };

  const camMessage = camErr && ({
    permission: 'ক্যামেরা ব্যবহারের অনুমতি দেওয়া হয়নি। ব্রাউজারের সেটিংসে অনুমতি দিন, অথবা নিচের বোতামে ছবি তুলুন।',
    'no-camera': 'এই ডিভাইসে ক্যামেরা পাওয়া যায়নি। ছবি বেছে নিয়ে স্ক্যান করুন।',
    insecure: 'নিরাপদ (https) ঠিকানা ছাড়া ক্যামেরা চালু হয় না।',
    busy: 'ক্যামেরা অন্য কোনো অ্যাপ ব্যবহার করছে।',
  }[camErr.code] || 'ক্যামেরা চালু করা গেল না। ছবি বেছে নিয়ে স্ক্যান করুন।');

  return html`<div class="scanner">
    <video ref=${videoRef} playsinline muted autoplay style=${phase === 'nocam' ? 'display:none' : ''}></video>
    ${result?.thumb && phase !== 'live' && html`<img class="frozen" src=${result.thumb} alt="" style="object-fit:contain;background:#120a10" />`}

    <div class="top">
      <button class="icon-btn" onClick=${() => goBack('/')} aria-label="বন্ধ করুন"><${Icon} name="close" /></button>
      <div class="modes" role="tablist" aria-label="স্ক্যানের ধরন">
        <button class=${mode === 'search' ? 'on' : ''} onClick=${() => setMode('search')} role="tab"><${Icon} name="search" size=${15} /> খুঁজুন</button>
        <button class=${mode === 'add' ? 'on' : ''} onClick=${() => setMode('add')} role="tab"><${Icon} name="plus" size=${15} /> যোগ করুন</button>
      </div>
      <span style="width:42px" />
    </div>
    <div style="text-align:center;position:relative;z-index:3">
      <button class="engine-pill" onClick=${() => {
        if (!settings.geminiApiKey) { navigate('/settings?focus=gemini'); return; }
        setPreferOffline(!preferOffline);
      }}>
        <${Icon} name=${useOnline ? 'sparkle' : 'wifiOff'} />
        ${useOnline ? 'অনলাইন স্ক্যানার (বেশি নির্ভুল)' : settings.geminiApiKey ? (online() ? 'অফলাইন স্ক্যানার · অনলাইনে নিতে চাপুন' : 'অফলাইন স্ক্যানার (ইন্টারনেট নেই)') : 'অফলাইন স্ক্যানার · অনলাইন চালু করুন'}
      </button>
    </div>

    ${(phase === 'live' || phase === 'starting') && html`<div>
      <div class="guide" style=${`left:${guide.px.x}px;top:${guide.px.y}px;width:${guide.px.w}px;height:${guide.px.h}px`} />
      <div class="tip" style=${`top:${guide.px.y + guide.px.h + 14}px`}>
        ${mode === 'search' ? 'বইয়ের সামনের মলাট ফ্রেমের ভেতরে ধরুন, তারপর বোতাম চাপুন' : 'যে বইটি যোগ করবেন তার মলাট ফ্রেমে ধরুন'}
        ${!useOnline && warm && !warm.done && !warm.failed && html`<div class="faint" style="color:#ffd6e6;margin-top:4px">অফলাইন স্ক্যানার প্রস্তুত হচ্ছে…</div>`}
      </div>
    </div>`}

    ${phase === 'nocam' && html`<div class="reading" style="background:transparent">
      <div style="max-width:340px;padding:20px">
        <div class="lily-spin" style="animation:none"><${Lily} size=${110} tone="white" /></div>
        <p>${camMessage}</p>
        <button class="btn primary" onClick=${() => fileRef.current.click()}><${Icon} name="camera" /> ছবি তুলুন / বেছে নিন</button>
      </div>
    </div>`}

    ${phase === 'reading' && html`<div class="reading">
      <div>
        <div class="lily-spin"><${Lily} size=${110} tone="white" /></div>
        <div style="font-size:17px">${progress || 'পড়া হচ্ছে…'}</div>
        <button class="btn ghost sm" style="margin-top:14px;color:#fff;border-color:rgba(255,255,255,.4)" onClick=${() => { abortRef.current?.abort(); again(); }}>বাতিল</button>
      </div>
    </div>`}

    <input ref=${fileRef} type="file" accept="image/*" capture="environment" class="sr-only" onChange=${pickFile} />

    ${(phase === 'live' || phase === 'starting') && html`<div class="bottom">
      <button class="icon-btn" onClick=${() => fileRef.current.click()} aria-label="গ্যালারি থেকে ছবি"><${Icon} name="image" /></button>
      <button class="shutter" onClick=${shoot} aria-label="ছবি তুলুন" disabled=${phase !== 'live'}><${Icon} name=${mode === 'search' ? 'search' : 'plus'} /></button>
      ${camRef.current?.hasTorch
        ? html`<button class="icon-btn" onClick=${toggleTorch} aria-label="টর্চ" style=${torch ? 'background:#ffd27a;color:#3a2136' : ''}><${Icon} name="flash" /></button>`
        : html`<span style="width:52px" />`}
    </div>`}

    ${phase === 'result' && result && html`<div class="scrim" style="z-index:5" onClick=${(e) => { if (e.target === e.currentTarget) again(); }}>
      <div class="sheet" role="dialog" aria-modal="true" style="color:var(--ink)">
        <div class="grab" />
        <${ResultView} result=${result} mode=${mode} again=${again} onAdd=${() => openAddEditor(result)}
          canOnline=${canOnline && result.source === 'offline'} retryOnline=${() => processCanvas(result.canvas, { forceOnline: true })} />
      </div>
    </div>`}
  </div>`;
}

function ResultView({ result, mode, again, onAdd, canOnline, retryOnline }) {
  const lib = useLib();
  const { match: m, source, read, onlineError } = result;
  const sure = m.best && (m.level === 'exact' || m.level === 'strong');
  const bestBook = sure && m.best.kind === 'book' ? lib.records.get(m.best.id) : null;
  const bestEntry = sure && m.best.kind === 'catalog' ? lib.catalogById.get(m.best.id) : null;
  const entryOwner = bestEntry ? lib.authorById.get(bestEntry.authorId) : null;
  const candidates = useMemo(() => (m.candidates || []).slice(0, 5), [m]);
  const readText = source === 'online'
    ? [read.title, read.author].filter(Boolean).join(' — ')
    : (read.text || read.lines.map((l) => l.text).join('\n')).trim();

  const engineNote = html`<div class="faint" style="margin-top:10px">
    ${source === 'online' ? 'অনলাইন স্ক্যানার দিয়ে পড়া' : 'ফোনের অফলাইন স্ক্যানার দিয়ে পড়া'}
    ${onlineError && html` · অনলাইন স্ক্যানার কাজ করেনি (${errorText(onlineError)})`}
  </div>`;

  const readBox = readText && html`<details style="margin-top:10px"><summary class="faint" style="cursor:pointer">যা পড়া গেছে</summary>
    <div class="read-text" style="margin-top:6px">${readText}</div></details>`;

  const pickCandidate = (c) => {
    if (c.kind === 'book') navigate(`/b/${c.id}`);
    else navigate(`/a/${lib.catalogById.get(c.id)?.authorId}/missing?focus=${c.id}`);
  };

  const candidateList = html`<div style="margin-top:6px">${candidates.map((c, i) => {
    const owned = c.kind === 'book' || lib.ownedByCatalog.has(c.id);
    return html`<button class=${`candidate${i === 0 ? ' best' : ''}`} onClick=${() => pickCandidate(c)}>
      <span class=${`check${owned ? ' on' : ''}`}><${Icon} name=${owned ? 'check' : 'book'} /></span>
      <span class="grow"><span class="t">${c.title}</span><br /><span class="faint">${c.authorName || ''} · ${owned ? 'সংগ্রহে আছে' : 'সংগ্রহে নেই'}</span></span>
    </button>`;
  })}</div>`;

  if (mode === 'add') {
    if (bestBook) {
      const author = lib.authorById.get(bestBook.authorId);
      return html`<div>
        <div class="result-big maybe"><${Icon} name="alert" /> এই বইটি আগে থেকেই আছে</div>
        <div class="book"><${Cover} book=${bestBook} /><div class="grow"><div class="t">${bestBook.title}</div><div class="m">${author?.name || ''}${(bestBook.copies || 1) > 1 ? ` · ${bn(bestBook.copies)} কপি` : ''}</div></div></div>
        <div class="stack" style="margin-top:14px">
          <button class="btn primary block" onClick=${async () => { await updateRecord(bestBook.id, { copies: (Number(bestBook.copies) || 1) + 1 }); toast(`এখন ${bn((Number(bestBook.copies) || 1) + 1)} কপি`, { type: 'ok' }); again(); }}>
            <${Icon} name="plus" /> নতুন কপি — সংখ্যা ১ বাড়ান</button>
          <button class="btn soft block" onClick=${onAdd}>না, এটা অন্য বই — নতুন হিসেবে যোগ করুন</button>
          <button class="btn ghost block" onClick=${again}><${Icon} name="camera" /> আরেকটি বই স্ক্যান করুন</button>
        </div>
        ${engineNote}${readBox}
      </div>`;
    }
    return html`<div>
      <div class="result-big"><${Icon} name="book" /> নাম পড়া হয়েছে</div>
      <button class="btn primary block" onClick=${onAdd}><${Icon} name="plus" /> যোগ করার ফর্ম খুলুন</button>
      <button class="btn ghost block" style="margin-top:8px" onClick=${again}><${Icon} name="camera" /> আবার স্ক্যান করুন</button>
      ${engineNote}${readBox}
    </div>`;
  }

  // search mode
  if (bestBook) {
    const author = lib.authorById.get(bestBook.authorId);
    return html`<div>
      <div class="result-big yes"><${Icon} name="check" /> হ্যাঁ! বইটি আপনার সংগ্রহে আছে</div>
      <a class="book" href=${`#/b/${bestBook.id}`}><${Cover} book=${bestBook} /><div class="grow"><div class="t">${bestBook.title}</div>
        <div class="m">${author?.name || ''}${bestBook.category ? ` · ${bestBook.category}` : ''}${(bestBook.copies || 1) > 1 ? ` · ${bn(bestBook.copies)} কপি` : ''}${m.best.viaIsbn ? ' · ISBN মিলেছে' : ''}</div></div></a>
      ${m.level === 'strong' && candidates.length > 1 && html`<p class="faint">নিশ্চিত না হলে নিচের অন্যগুলোও দেখুন:</p>${candidateList}`}
      <div class="btn-row" style="margin-top:14px">
        <a class="btn soft" href=${`#/b/${bestBook.id}`}>বইটি দেখুন</a>
        <button class="btn primary" onClick=${again}><${Icon} name="camera" /> আরেকটি স্ক্যান</button>
      </div>
      ${engineNote}${readBox}
    </div>`;
  }
  if (bestEntry) {
    return html`<div>
      <div class="result-big no"><${Icon} name="close" /> বইটি এখনো আপনার কাছে নেই</div>
      <${Notice} kind="info" icon="list">${entryOwner?.name || ''}-এর সম্পূর্ণ তালিকায় আছে: <b style="font-family:var(--font-book)">${bestEntry.title}</b><//>
      <div class="btn-row" style="margin-top:14px">
        <button class="btn primary" onClick=${async (ev) => {
          const book = await acquireEntry(bestEntry, { addedVia: 'scan' });
          await ctx.store.setCover(book.id, result.thumb);
          burst();
          toast(`“${bestEntry.title}” সংগ্রহে যোগ হলো 🌸`, { type: 'ok', action: { label: 'ফিরিয়ে নিন', run: () => updateRecord(book.id, { deleted: true, deletedAt: Date.now(), purged: true }) } });
          again();
        }}><${Icon} name="plus" /> কিনেছি — সংগ্রহে যোগ করুন</button>
        <button class="btn ghost" onClick=${again}><${Icon} name="camera" /> আরেকটি স্ক্যান</button>
      </div>
      ${engineNote}${readBox}
    </div>`;
  }
  if (candidates.length && m.level === 'possible') {
    return html`<div>
      <div class="result-big maybe"><${Icon} name="info" /> নিশ্চিত হওয়া যাচ্ছে না — এর মধ্যে কোনটি?</div>
      ${candidateList}
      ${canOnline && html`<button class="btn soft block" onClick=${retryOnline}><${Icon} name="sparkle" /> অনলাইন স্ক্যানারে আবার পড়ুন</button>`}
      <div class="btn-row" style="margin-top:10px">
        <button class="btn ghost" onClick=${again}><${Icon} name="camera" /> আবার স্ক্যান</button>
        <button class="btn soft" onClick=${onAdd}>কোনোটিই নয় — নতুন যোগ করুন</button>
      </div>
      ${engineNote}${readBox}
    </div>`;
  }
  return html`<div>
    <div class="result-big no"><${Icon} name="close" /> আপনার সংগ্রহে এই বইটি পাওয়া যায়নি</div>
    ${result.titleGuess && html`<p class="muted" style="margin:0 0 8px">পড়া নাম: <b style="font-family:var(--font-book)">${result.titleGuess}</b>${result.author.authorName ? ` — ${result.author.authorName}` : ''}</p>`}
    ${source === 'offline' && html`<p class="faint" style="margin-top:0">মলাটের লেখা ঝাপসা বা নকশাদার হলে অফলাইন স্ক্যানার ভুল পড়তে পারে। আলোতে সোজা করে ধরে আবার চেষ্টা করুন${canOnline ? ', অথবা অনলাইন স্ক্যানার ব্যবহার করুন' : ''}।</p>`}
    ${canOnline && html`<button class="btn soft block" onClick=${retryOnline}><${Icon} name="sparkle" /> অনলাইন স্ক্যানারে আবার পড়ুন</button>`}
    <div class="btn-row" style="margin-top:10px">
      <button class="btn ghost" onClick=${again}><${Icon} name="camera" /> আবার স্ক্যান</button>
      <button class="btn primary" onClick=${onAdd}><${Icon} name="plus" /> এই বইটি যোগ করুন</button>
    </div>
    ${engineNote}${readBox}
  </div>`;
}

function errorText(e) {
  return ({
    'bad-key': 'API key ঠিক নেই',
    quota: 'আজকের সীমা শেষ',
    offline: 'ইন্টারনেট নেই',
    timeout: 'সময় শেষ',
    model: 'মডেল পাওয়া যায়নি',
    blocked: 'ছবিটি পড়তে দেওয়া হয়নি',
  })[e?.code] || 'ত্রুটি';
}

export { findSimilarBooks };
