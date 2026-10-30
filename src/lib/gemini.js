// Online cover reading with Google Gemini (REST API, the user's own API key).
// The model is discovered from the key's model list, so the app keeps working
// when Google retires or renames models.

const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const LS_MODEL = 'mazedar:geminiModel';

export class GeminiError extends Error {
  /** @param {'bad-key'|'quota'|'model'|'offline'|'timeout'|'aborted'|'blocked'|'server'|'bad-request'|'bad-response'} code */
  constructor(code, message, status) {
    super(message || code);
    this.name = 'GeminiError';
    this.code = code;
    this.status = status;
  }
}

async function call(path, { apiKey, method = 'GET', body, signal, timeoutMs = 25000, fetchImpl = globalThis.fetch }) {
  if (!apiKey) throw new GeminiError('bad-key', 'API key missing');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const onAbort = () => ac.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  let res;
  try {
    res = await fetchImpl(`${BASE}${path}`, {
      method,
      headers: { 'x-goog-api-key': apiKey, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: ac.signal,
    });
  } catch (e) {
    if (signal?.aborted) throw new GeminiError('aborted', 'cancelled');
    if (ac.signal.aborted) throw new GeminiError('timeout', 'Gemini did not answer in time');
    throw new GeminiError('offline', e?.message || 'network error');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!res.ok) {
    const msg = json?.error?.message || text.slice(0, 300) || `HTTP ${res.status}`;
    const reason = JSON.stringify(json?.error?.details || '') + msg;
    if (res.status === 400 && /API_KEY_INVALID|API key not valid|API_KEY/i.test(reason)) throw new GeminiError('bad-key', msg, 400);
    if (res.status === 401 || res.status === 403) throw new GeminiError('bad-key', msg, res.status);
    if (res.status === 429) throw new GeminiError('quota', msg, 429);
    if (res.status === 404) throw new GeminiError('model', msg, 404);
    if (res.status >= 500) throw new GeminiError('server', msg, res.status);
    throw new GeminiError('bad-request', msg, res.status);
  }
  return json;
}

/** All models available to this key: [{ name, displayName, methods }]. */
export async function listModels(apiKey, opts = {}) {
  const out = [];
  let token = '';
  for (let page = 0; page < 10; page += 1) {
    const json = await call(`/models?pageSize=1000${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`, { apiKey, ...opts });
    for (const m of json?.models || []) {
      out.push({
        name: String(m.name || '').replace(/^models\//, ''),
        displayName: m.displayName || '',
        methods: m.supportedGenerationMethods || [],
      });
    }
    token = json?.nextPageToken;
    if (!token) break;
  }
  return out;
}

const EXCLUDE = /(tts|image|audio|live|embedding|embed|learnlm|robotics|computer-use|aqa|veo|imagen|thinking-exp|native|gemma)/i;

/** Best fast multimodal model: newest stable "flash" (lite only as a fallback). */
export function pickModel(models, { exclude = [] } = {}) {
  const ranked = (models || [])
    .filter((m) => (m.methods || []).includes('generateContent'))
    .filter((m) => /^gemini-/i.test(m.name) && /flash/i.test(m.name) && !EXCLUDE.test(m.name) && !exclude.includes(m.name))
    .map((m) => {
      const v = Number((m.name.match(/^gemini-(\d+(?:\.\d+)?)/i) || [])[1] || 0);
      const preview = /(preview|exp|experimental)/i.test(m.name);
      const lite = /lite/i.test(m.name);
      const alias = /latest/i.test(m.name);
      return { m, v, preview, lite, alias };
    })
    .sort((a, b) => (a.lite - b.lite) || (a.preview - b.preview) || (b.v - a.v) || (a.alias - b.alias) || (a.m.name.length - b.m.name.length));
  return ranked[0]?.m.name || null;
}

const PROMPT = `This photo shows the FRONT COVER of a printed book, most often in Bengali (Bangla).
Read the book's TITLE and the AUTHOR's name exactly as printed.
Rules:
- Copy the title in its original script and spelling, character by character. Do not translate, transliterate, correct or modernise the spelling. Keep Bengali conjuncts, vowel signs, spaces and punctuation as printed.
- If the title is in English, copy it in English as printed.
- Include a subtitle only if it is clearly part of the title. Never put the series name, publisher, price, edition or taglines into the title.
- If the author is not visible, use an empty string. If no book cover is visible, use empty strings.
- Put other clearly readable lines (publisher, series, translator, illustrator) into otherLines.
Answer with JSON only.`;

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    title: { type: 'STRING' },
    author: { type: 'STRING' },
    otherLines: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['title', 'author'],
};

export function buildRequest(imageDataUrl) {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(imageDataUrl || '');
  if (!m) throw new GeminiError('bad-request', 'image must be a base64 data URL');
  return {
    contents: [{ role: 'user', parts: [{ text: PROMPT }, { inline_data: { mime_type: m[1], data: m[2] } }] }],
    generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: SCHEMA },
  };
}

export function parseResponse(json) {
  if (json?.promptFeedback?.blockReason) throw new GeminiError('blocked', json.promptFeedback.blockReason);
  const cand = json?.candidates?.[0];
  if (!cand) throw new GeminiError('bad-response', 'no candidates');
  if (cand.finishReason && /SAFETY|PROHIBITED|BLOCKLIST|RECITATION|SPII/.test(cand.finishReason)) throw new GeminiError('blocked', cand.finishReason);
  const text = (cand.content?.parts || []).map((p) => p.text || '').join('').trim()
    .replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new GeminiError('bad-response', `not JSON: ${text.slice(0, 120)}`);
  }
  const clean = (s) => String(s ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
  return {
    title: clean(data.title),
    author: clean(data.author),
    otherLines: Array.isArray(data.otherLines) ? data.otherLines.map(clean).filter(Boolean) : [],
  };
}

function rememberedModel() {
  try { return localStorage.getItem(LS_MODEL) || ''; } catch { return ''; }
}
function rememberModel(m) {
  try { localStorage.setItem(LS_MODEL, m); } catch { /* ignore */ }
}

async function resolveModel(apiKey, opts, exclude = []) {
  const models = await listModels(apiKey, opts);
  const m = pickModel(models, { exclude });
  if (!m) throw new GeminiError('model', 'no suitable Gemini model for this key');
  rememberModel(m);
  return m;
}

/**
 * Read title/author from a cover photo.
 * @returns {Promise<{title:string, author:string, otherLines:string[], ms:number, model:string}>}
 */
export async function readCover(imageDataUrl, { apiKey, model, signal, timeoutMs = 25000, fetchImpl } = {}) {
  const t0 = Date.now();
  const opts = { signal, timeoutMs, fetchImpl };
  const body = buildRequest(imageDataUrl);
  let m = model || rememberedModel() || (await resolveModel(apiKey, opts));
  let attempts = 0;
  for (;;) {
    attempts += 1;
    try {
      const json = await call(`/models/${encodeURIComponent(m)}:generateContent`, { apiKey, method: 'POST', body, ...opts });
      return { ...parseResponse(json), ms: Date.now() - t0, model: m };
    } catch (e) {
      if (e.code === 'model' && attempts === 1) {
        m = await resolveModel(apiKey, opts, [m]); // model retired: pick another once
        continue;
      }
      if ((e.code === 'server' || e.code === 'bad-response') && attempts === 1) continue; // one quick retry
      throw e;
    }
  }
}

/** Check a key: { ok, model } or { ok:false, error:{ code, message } }. */
export async function testKey(apiKey, opts = {}) {
  try {
    const model = await resolveModel(apiKey, opts);
    return { ok: true, model };
  } catch (e) {
    return { ok: false, error: { code: e.code || 'unknown', message: e.message } };
  }
}
