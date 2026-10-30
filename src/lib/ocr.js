// Offline OCR (Bengali + English) with tesseract.js, fully self-hosted so it
// works with no network once the files are cached. Browser only.

const BASE = new URL('../../vendor/tesseract/', import.meta.url).href;
const IDLE_MS = 3 * 60 * 1000;
const READY_KEY = 'mazedar:ocrReady';

let workerPromise = null;
let idleTimer = null;
let queue = Promise.resolve();
let progressSink = null;

function touchIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    const p = workerPromise;
    workerPromise = null;
    try { (await p)?.terminate(); } catch { /* already gone */ }
  }, IDLE_MS);
}

async function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      const mod = await import('../../vendor/tesseract/tesseract.esm.min.js');
      const Tesseract = mod.default || mod;
      const worker = await Tesseract.createWorker(['ben', 'eng'], Tesseract.OEM?.LSTM_ONLY ?? 1, {
        workerPath: `${BASE}worker.min.js`,
        corePath: `${BASE}core`,
        langPath: `${BASE}lang`,
        gzip: true,
        workerBlobURL: false,
        cacheMethod: 'write',
        logger: (m) => progressSink?.(m),
        errorHandler: () => { workerPromise = null; },
      });
      await worker.setParameters({ preserve_interword_spaces: '1', tessedit_pageseg_mode: '3' });
      try { localStorage.setItem(READY_KEY, '1'); } catch { /* ignore */ }
      return worker;
    })();
    workerPromise.catch(() => { workerPromise = null; });
  }
  touchIdle();
  return workerPromise;
}

/** Download/initialise the OCR engine and language data now (cached for offline use). */
export async function warmupOffline({ onProgress } = {}) {
  progressSink = onProgress || null;
  try {
    await getWorker();
  } finally {
    progressSink = null;
  }
}

export function isOfflineReady() {
  try { return localStorage.getItem(READY_KEY) === '1'; } catch { return false; }
}

// ---------------------------------------------------------------- preprocessing
function newCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

/** Scale so the longest side is about `target` px (small crops get upscaled). */
function scaled(src, target = 1600) {
  const k = target / Math.max(src.width, src.height);
  const kk = k > 1 ? Math.min(k, 2.5) : Math.max(k, 0.5);
  const c = newCanvas(src.width * kk, src.height * kk);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

function grayAndStats(img) {
  const d = img.data;
  const n = d.length / 4;
  const gray = new Uint8ClampedArray(n);
  const hist = new Uint32Array(256);
  for (let i = 0, j = 0; i < d.length; i += 4, j += 1) {
    const v = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
    gray[j] = v;
    hist[gray[j]] += 1;
  }
  return { gray, hist, n };
}

function otsu(hist, n) {
  let sum = 0;
  for (let t = 0; t < 256; t += 1) sum += t * hist[t];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let thr = 127;
  for (let t = 0; t < 256; t += 1) {
    wB += hist[t];
    if (!wB) continue;
    const wF = n - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) {
      best = between;
      thr = t;
    }
  }
  return thr;
}

function percentile(hist, n, p) {
  let acc = 0;
  for (let t = 0; t < 256; t += 1) {
    acc += hist[t];
    if (acc >= n * p) return t;
  }
  return 255;
}

/**
 * Image variants for OCR: contrast-stretched grayscale, and an Otsu
 * binarisation flipped to dark text on light background when needed.
 */
export function preprocessVariants(canvas) {
  const base = scaled(canvas);
  const g = base.getContext('2d', { willReadFrequently: true });
  const img = g.getImageData(0, 0, base.width, base.height);
  const { gray, hist, n } = grayAndStats(img);
  const lo = percentile(hist, n, 0.02);
  const hi = Math.max(lo + 1, percentile(hist, n, 0.98));
  const thr = otsu(hist, n);
  let below = 0;
  for (let t = 0; t <= thr; t += 1) below += hist[t];
  const darkBackground = below > n * 0.5; // most pixels dark => light text on dark cover

  const grayCanvas = newCanvas(base.width, base.height);
  const binCanvas = newCanvas(base.width, base.height);
  const gi = new ImageData(base.width, base.height);
  const bi = new ImageData(base.width, base.height);
  for (let j = 0, i = 0; j < n; j += 1, i += 4) {
    let v = ((gray[j] - lo) * 255) / (hi - lo);
    v = v < 0 ? 0 : v > 255 ? 255 : v;
    if (darkBackground) v = 255 - v;
    gi.data[i] = gi.data[i + 1] = gi.data[i + 2] = v;
    gi.data[i + 3] = 255;
    let b = gray[j] > thr ? 255 : 0;
    if (darkBackground) b = 255 - b;
    bi.data[i] = bi.data[i + 1] = bi.data[i + 2] = b;
    bi.data[i + 3] = 255;
  }
  grayCanvas.getContext('2d').putImageData(gi, 0, 0);
  binCanvas.getContext('2d').putImageData(bi, 0, 0);
  return [{ name: 'gray', canvas: grayCanvas }, { name: 'otsu', canvas: binCanvas }];
}

// ---------------------------------------------------------------- recognition
function parseTsv(tsv) {
  const lines = new Map();
  for (const row of String(tsv || '').split('\n')) {
    const c = row.split('\t');
    if (c.length < 12 || c[0] !== '5') continue; // level 5 = word
    const text = c.slice(11).join('\t').trim();
    if (!text) continue;
    const key = `${c[2]}-${c[3]}-${c[4]}`;
    const conf = Number(c[10]);
    const height = Number(c[9]);
    const top = Number(c[7]);
    if (!lines.has(key)) lines.set(key, { words: [], confs: [], heights: [], top });
    const l = lines.get(key);
    l.words.push(text);
    if (conf >= 0) l.confs.push(conf);
    l.heights.push(height);
  }
  return [...lines.values()]
    .sort((a, b) => a.top - b.top)
    .map((l) => ({
      text: l.words.join(' ').normalize('NFC'),
      confidence: l.confs.length ? l.confs.reduce((x, y) => x + y, 0) / l.confs.length : 0,
      height: l.heights.length ? Math.max(...l.heights) : 0,
    }))
    .filter((l) => /[ঀ-৿A-Za-z0-9]/.test(l.text));
}

function sameLine(a, b) {
  const k = (s) => s.replace(/\s+/g, '');
  return k(a) === k(b);
}

/**
 * Read the text on a captured cover.
 * @returns {Promise<{text:string, lines:{text:string,confidence:number,height:number}[], ms:number, variant:string}>}
 */
export function ocrOffline(canvas, { onProgress, signal } = {}) {
  const job = queue.then(async () => {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const t0 = Date.now();
    progressSink = onProgress || null;
    try {
      onProgress?.('অফলাইন স্ক্যানার চালু হচ্ছে…');
      const worker = await getWorker();
      const variants = preprocessVariants(canvas);
      const results = [];
      for (const v of variants) {
        if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
        onProgress?.(`ফোনেই নাম পড়া হচ্ছে… (${results.length + 1}/${variants.length})`);
        const { data } = await worker.recognize(v.canvas, {}, { text: true, tsv: true });
        const lines = parseTsv(data.tsv);
        const score = lines.reduce((s, l) => s + l.confidence * Math.min(l.text.length, 30), 0);
        results.push({ name: v.name, lines, score });
        touchIdle();
      }
      results.sort((a, b) => b.score - a.score);
      const merged = [...results[0].lines];
      for (const r of results.slice(1)) {
        for (const l of r.lines) if (l.confidence >= 55 && !merged.some((m) => sameLine(m.text, l.text))) merged.push(l);
      }
      return { text: merged.map((l) => l.text).join('\n'), lines: merged, ms: Date.now() - t0, variant: results[0].name };
    } finally {
      progressSink = null;
    }
  });
  queue = job.catch(() => {});
  return job;
}
