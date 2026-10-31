// Gemini REST client with a mocked fetch (the real endpoint is not reachable from CI).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickModel, buildRequest, parseResponse, readCover, testKey, listModels, GeminiError } from '../../src/lib/gemini.js';

const m = (name, methods = ['generateContent']) => ({ name, displayName: name, methods });
const IMG = 'data:image/jpeg;base64,/9j/AAAA';

function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, init });
    for (const [re, reply] of routes) {
      if (re.test(url)) {
        const r = typeof reply === 'function' ? reply(url, init, calls) : reply;
        return { ok: r.status < 400, status: r.status, text: async () => JSON.stringify(r.body) };
      }
    }
    return { ok: false, status: 404, text: async () => '{"error":{"message":"no route"}}' };
  };
  fn.calls = calls;
  return fn;
}

const answer = (obj) => ({ status: 200, body: { candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] }, finishReason: 'STOP' }] } });

test('pickModel prefers the newest stable full "flash" model', () => {
  const list = [
    m('gemini-2.5-flash'), m('gemini-3.6-flash'), m('gemini-3.6-flash-lite'), m('gemini-3.6-flash-preview-09-2026'),
    m('gemini-3.5-pro'), m('gemini-3.6-flash-image'), m('gemini-3.6-flash-tts'), m('text-embedding-005', ['embedContent']),
    m('gemini-3.6-flash-live', ['bidiGenerateContent']),
  ];
  assert.equal(pickModel(list), 'gemini-3.6-flash');
  assert.equal(pickModel(list.filter((x) => x.name !== 'gemini-3.6-flash')), 'gemini-2.5-flash');
  assert.equal(pickModel([m('gemini-3.6-flash-lite')]), 'gemini-3.6-flash-lite');
  assert.equal(pickModel([m('gemini-9-pro')]), null);
  assert.equal(pickModel(list, { exclude: ['gemini-3.6-flash'] }), 'gemini-2.5-flash');
});

test('request: image as inline_data, JSON schema answer, temperature 0', () => {
  const r = buildRequest(IMG);
  const parts = r.contents[0].parts;
  assert.match(parts[0].text, /FRONT COVER/);
  assert.deepEqual(parts[1], { inline_data: { mime_type: 'image/jpeg', data: '/9j/AAAA' } });
  assert.equal(r.generationConfig.temperature, 0);
  assert.equal(r.generationConfig.responseMimeType, 'application/json');
  assert.deepEqual(r.generationConfig.responseSchema.required, ['title', 'author']);
  assert.throws(() => buildRequest('not-a-data-url'), GeminiError);
});

test('response parsing: fenced JSON, NFC, blocked and empty answers', () => {
  const fenced = { candidates: [{ content: { parts: [{ text: '```json\n{"title":"হিমু  মামা","author":"হুমায়ূন আহমেদ","otherLines":["অন্যপ্রকাশ"]}\n```' }] } }] };
  assert.deepEqual(parseResponse(fenced), { title: 'হিমু মামা', author: 'হুমায়ূন আহমেদ', otherLines: ['অন্যপ্রকাশ'] });
  assert.throws(() => parseResponse({ promptFeedback: { blockReason: 'SAFETY' } }), (e) => e.code === 'blocked');
  assert.throws(() => parseResponse({ candidates: [{ finishReason: 'SAFETY', content: { parts: [] } }] }), (e) => e.code === 'blocked');
  assert.throws(() => parseResponse({}), (e) => e.code === 'bad-response');
});

test('readCover: picks a model, sends the key in a header, returns the reading', async () => {
  const f = fakeFetch([
    [/\/models\?pageSize/, { status: 200, body: { models: [{ name: 'models/gemini-3.6-flash', supportedGenerationMethods: ['generateContent'] }] } }],
    [/gemini-3\.6-flash:generateContent/, answer({ title: 'দেয়াল', author: 'হুমায়ূন আহমেদ', otherLines: [] })],
  ]);
  const r = await readCover(IMG, { apiKey: 'k1', fetchImpl: f });
  assert.equal(r.title, 'দেয়াল');
  assert.equal(r.model, 'gemini-3.6-flash');
  const post = f.calls.find((c) => c.init.method === 'POST');
  assert.equal(post.init.headers['x-goog-api-key'], 'k1');
  assert.ok(!post.url.includes('k1'), 'key never goes into the URL');
});

test('readCover: a retired model (404) is replaced once by a freshly picked one', async () => {
  const f = fakeFetch([
    [/gemini-old-flash:generateContent/, { status: 404, body: { error: { message: 'model not found' } } }],
    [/\/models\?pageSize/, { status: 200, body: { models: [{ name: 'models/gemini-old-flash', supportedGenerationMethods: ['generateContent'] }, { name: 'models/gemini-4.0-flash', supportedGenerationMethods: ['generateContent'] }] } }],
    [/gemini-4\.0-flash:generateContent/, answer({ title: 'কুহক', author: '' })],
  ]);
  const r = await readCover(IMG, { apiKey: 'k', model: 'gemini-old-flash', fetchImpl: f });
  assert.equal(r.title, 'কুহক');
  assert.equal(r.model, 'gemini-4.0-flash');
});

test('errors are typed: bad key, quota, offline, timeout', async () => {
  const bad = fakeFetch([[/generateContent/, { status: 400, body: { error: { message: 'API key not valid. Please pass a valid API key.', details: [{ reason: 'API_KEY_INVALID' }] } } }]]);
  await assert.rejects(readCover(IMG, { apiKey: 'x', model: 'gemini-3.6-flash', fetchImpl: bad }), (e) => e.code === 'bad-key');
  const quota = fakeFetch([[/generateContent/, { status: 429, body: { error: { message: 'quota' } } }]]);
  await assert.rejects(readCover(IMG, { apiKey: 'x', model: 'gemini-3.6-flash', fetchImpl: quota }), (e) => e.code === 'quota');
  const offline = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(readCover(IMG, { apiKey: 'x', model: 'gemini-3.6-flash', fetchImpl: offline }), (e) => e.code === 'offline');
  const slow = (url, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted'))));
  await assert.rejects(readCover(IMG, { apiKey: 'x', model: 'gemini-3.6-flash', fetchImpl: slow, timeoutMs: 50 }), (e) => e.code === 'timeout');
});

test('testKey and listModels follow pagination', async () => {
  const f = fakeFetch([
    [/pageToken=p2/, { status: 200, body: { models: [{ name: 'models/gemini-3.6-flash', supportedGenerationMethods: ['generateContent'] }] } }],
    [/\/models\?pageSize/, { status: 200, body: { models: [{ name: 'models/text-embedding-005', supportedGenerationMethods: ['embedContent'] }], nextPageToken: 'p2' } }],
  ]);
  assert.equal((await listModels('k', { fetchImpl: f })).length, 2);
  assert.deepEqual(await testKey('k', { fetchImpl: f }), { ok: true, model: 'gemini-3.6-flash' });
  const denied = fakeFetch([[/models/, { status: 403, body: { error: { message: 'denied' } } }]]);
  const r = await testKey('k', { fetchImpl: denied });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'bad-key');
});
