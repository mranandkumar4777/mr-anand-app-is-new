'use strict';
// Offline tests for ai-hub.js: a fake fetch plays the part of Gemini, OpenRouter, a custom provider and the music catalogs.
// Run: node tests/ai-hub.test.js   (no network, no dependencies)
const assert = require('assert');
const { createAiHub, parseModelList, parseKeys, parseProviderLines, _internals: I } = require('../ai-hub');

function wav(seconds, amp, rate = 16000) {
  const n = Math.round(seconds * rate), b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin(i / 20) * amp * 32767), 44 + i * 2);
  return { base64: b.toString('base64'), mime: 'audio/wav' };
}
const jres = (status, body, headers) => new Response(JSON.stringify(body), { status, headers: Object.assign({ 'content-type': 'application/json' }, headers || {}) });
const gemOk = (obj) => jres(200, { candidates: [{ content: { parts: [{ text: typeof obj === 'string' ? obj : JSON.stringify(obj) }] }, finishReason: 'STOP' }] });
const orOk = (obj) => jres(200, { choices: [{ message: { content: typeof obj === 'string' ? obj : JSON.stringify(obj) }, finish_reason: 'stop' }] });
const SONG = { isSong: true, language: 'en', transcript: 'amazing grace', best: { title: 'Amazing Grace', artist: 'John Newton', confidence: 92 }, similar: [{ title: 'Fake Song', artist: 'Nobody', confidence: 70 }] };

function setup(cfg, handler, opts) {
  const calls = [];
  const fetch = async (url, init) => {
    const body = init && init.body ? (() => { try { return JSON.parse(init.body); } catch (e) { return init.body; } })() : null;
    const call = { url: String(url), headers: (init && init.headers) || {}, body };
    calls.push(call);
    if (init && init.signal && init.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    const r = await handler(call, init);
    if (r === 'hang') return new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    if (r === 'netfail') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    return r;
  };
  const sleeps = [];
  const hub = createAiHub({ load: () => Object.assign({ verify: false }, cfg), save() {} }, Object.assign({ fetch, sleep: async (ms) => { sleeps.push(ms); }, env: {}, verify: false }, opts || {}));
  return { hub, calls, sleeps };
}
const noVerify = { verify: false };
const isGem = (c) => /generativelanguage/.test(c.url), isOR = (c) => /openrouter\.ai\/api\/v1\/chat/.test(c.url);
const catalogOK = (c) => /openrouter\.ai\/api\/v1\/models$/.test(c.url) ? jres(200, { data: [
  { id: 'google/gemini-2.5-flash', architecture: { input_modalities: ['text', 'audio', 'image'], output_modalities: ['text'] }, supported_parameters: ['response_format'], pricing: { prompt: '0.1', completion: '0.2' } },
  { id: 'meta/text-only', architecture: { input_modalities: ['text'], output_modalities: ['text'] }, supported_parameters: [] } ] }) : null;

const tests = [];
const t = (name, fn) => tests.push([name, fn]);

t('parseModelList routes prefixes and bare ids', () => {
  const l = parseModelList('gemini:gemini-2.5-flash, openrouter:meta/x:free\nopenai:gpt-4o-audio-preview\ngoogle/gemini-2.5-flash\ngemini-flash-latest\ngpt-4o-audio-preview\nmyhost:foo', ['myhost']);
  assert.deepStrictEqual(l.map((m) => m.provider + '|' + m.model), ['gemini|gemini-2.5-flash', 'openrouter|meta/x:free', 'openai|gpt-4o-audio-preview', 'openrouter|google/gemini-2.5-flash', 'gemini|gemini-flash-latest', 'myhost|foo']);
  assert.strictEqual(parseModelList('llama3:8b')[0].provider, 'gemini');   // legacy fallback for unknown prefix
});
t('parseProviderLines: preset, custom, headers, masked keys, errors', () => {
  const r = parseProviderLines('openai = sk-aaaa1111\nmyhost | https://h.example/v1/ | k1, k2 | X-Org: acme; X-T: b\nbad line\nfoo | ftp://x | k', { openai: { keys: ['sk-aaaa1111'] } });
  assert.deepStrictEqual(r.providers.openai.keys, ['sk-aaaa1111']);
  assert.strictEqual(r.providers.myhost.baseUrl, 'https://h.example/v1');
  assert.deepStrictEqual(r.providers.myhost.headers, { 'X-Org': 'acme', 'X-T': 'b' });
  assert.strictEqual(r.errors.length, 2);
  const m = parseProviderLines('openai = ••••1111', { openai: { keys: ['sk-aaaa1111'] } });
  assert.deepStrictEqual(m.providers.openai.keys, ['sk-aaaa1111']);
  assert.deepStrictEqual(parseKeys('a, b;c\n••••1 a'), ['a', 'b', 'c']);
});
t('JSON extraction: fences, prose, truncation', () => {
  assert.deepStrictEqual(I.extractJson('Here:\n```json\n{"a":1}\n```'), { a: 1 });
  assert.deepStrictEqual(I.extractJson('blah {"a":"x}y"} bye'), { a: 'x}y' });
  assert.deepStrictEqual(I.extractJson('{"slides":["a","b","c'), { slides: ['a', 'b', 'c'] });
  assert.strictEqual(I.extractJson('no json here'), null);
});
t('confidence normalisation and shapes', () => {
  assert.strictEqual(I.toConfidence(0.85), 85); assert.strictEqual(I.toConfidence('92%'), 92); assert.strictEqual(I.toConfidence('high'), 85); assert.strictEqual(I.toConfidence(150), 100);
  const n = I.normalizeIdentify({ best: 'Amazing Grace - John Newton', similar: ['Unknown', { title: 'X', confidence: 0.4 }] });
  assert.strictEqual(n.list[0].title, 'Amazing Grace'); assert.strictEqual(n.list[0].artist, 'John Newton'); assert.strictEqual(n.list.length, 2); assert.strictEqual(n.list[1].confidence, 40);
  assert.strictEqual(I.normalizeIdentify({ isSong: 'false', best: { title: 'A' } }).isSong, false);
  assert.strictEqual(I.normalizeIdentify({ isSong: false, best: { title: '' } }).list.length, 0);
});
t('identify via Gemini: success + shape', async () => {
  const { hub, calls } = setup({ geminiKeys: ['G1'] }, (c) => gemOk(SONG));
  const r = await hub.identify(wav(3, 0.3), {});
  assert.ok(r.ok, JSON.stringify(r)); assert.strictEqual(r.best.title, 'Amazing Grace'); assert.strictEqual(r.best.confidence, 92); assert.ok(r.isSong); assert.strictEqual(r.provider, 'gemini');
  assert.strictEqual(calls[0].headers['x-goog-api-key'], 'G1'); assert.ok(calls[0].body.contents[0].parts[0].inlineData, 'audio part first');
});
t('quiet clip is normalised before sending', async () => {
  const { hub, calls } = setup({ geminiKeys: ['G1'] }, () => gemOk(SONG));
  await hub.identify(wav(3, 0.02), {});
  const sent = I.inspectAudio(calls[0].body.contents[0].parts[0].inlineData.data, 'audio/wav');
  assert.ok(sent.peak > 0.5, 'peak ' + sent.peak);
});
t('too short / silent / empty clips are rejected without any request', async () => {
  const { hub, calls } = setup({ geminiKeys: ['G1'] }, () => gemOk(SONG));
  assert.strictEqual((await hub.identify(wav(0.3, 0.3))).code, 'too_short');
  assert.strictEqual((await hub.identify(wav(3, 0))).code, 'silent_audio');
  assert.strictEqual((await hub.identify({ base64: '' })).code, 'bad_audio');
  assert.strictEqual(calls.length, 0);
});
t('503 is retried with backoff on the same model, then succeeds', async () => {
  let n = 0;
  const { hub, calls, sleeps } = setup({ geminiKeys: ['G1'], models: [{ provider: 'gemini', model: 'm1' }], fallbackToDefaults: false }, () => (++n < 3 ? jres(503, { error: { status: 'UNAVAILABLE', message: 'overloaded' } }) : gemOk(SONG)));
  const r = await hub.identify(wav(3, 0.3)); assert.ok(r.ok); assert.strictEqual(calls.length, 3); assert.strictEqual(sleeps.length, 2); assert.ok(sleeps[1] > sleeps[0]);
});
t('persistent 503 falls back to the next model', async () => {
  const { hub, calls } = setup({ geminiKeys: ['G1'], models: parseModelList('gemini:m1,gemini:m2'), fallbackToDefaults: false }, (c) => (/models\/m1:/.test(c.url) ? jres(503, { error: { message: 'x' } }) : gemOk(SONG)));
  const r = await hub.identify(wav(3, 0.3)); assert.ok(r.ok); assert.strictEqual(r.model, 'm2'); assert.ok(r.fallback);
  assert.strictEqual(calls.filter((c) => /m1:/.test(c.url)).length, 3);
});
t('all 503 -> friendly server message, no raw dump', async () => {
  const { hub } = setup({ geminiKeys: ['G1'], models: parseModelList('gemini:m1'), fallbackToDefaults: false }, () => jres(503, { error: { message: 'The model is overloaded. {"stack":"secret"}' } }));
  const r = await hub.identify(wav(3, 0.3)); assert.strictEqual(r.ok, false); assert.strictEqual(r.code, 'server');
  assert.ok(/busy/.test(r.error)); assert.ok(!/stack|secret|503|overloaded/.test(r.error)); assert.ok(r.retryAfterMs > 0);
});
t('429 rotates to the next key and cools the first', async () => {
  const { hub, calls } = setup({ geminiKeys: ['G1', 'G2'], models: parseModelList('gemini:m1'), fallbackToDefaults: false }, (c) => (c.headers['x-goog-api-key'] === 'G1' ? jres(429, { error: { message: 'Quota exceeded for PerMinute' } }, { 'retry-after': '40' }) : gemOk(SONG)));
  for (let i = 0; i < 3; i++) { const r = await hub.identify(wav(3, 0.3)); assert.ok(r.ok); }
  const g1 = calls.filter((c) => c.headers['x-goog-api-key'] === 'G1').length; assert.ok(g1 <= 1, 'G1 should be cooling after its first 429, calls=' + g1);
});
t('bad key on Gemini falls back to OpenRouter (provider fallback)', async () => {
  const { hub, calls } = setup({ geminiKeys: ['BAD'], openrouterKeys: ['OR1'], models: parseModelList('gemini:m1') }, (c) => {
    const cat = catalogOK(c); if (cat) return cat;
    return isGem(c) ? jres(400, { error: { message: 'API key not valid. Please pass a valid API key.' } }) : orOk(SONG);
  });
  const r = await hub.identify(wav(3, 0.3)); assert.ok(r.ok, JSON.stringify(r)); assert.strictEqual(r.provider, 'openrouter'); assert.strictEqual(r.model, 'google/gemini-2.5-flash');
  const orc = calls.find(isOR); assert.strictEqual(orc.headers.Authorization, 'Bearer OR1'); assert.ok(orc.headers['X-Title']); assert.ok(orc.headers['HTTP-Referer']);
  assert.strictEqual(orc.body.messages[0].content[0].type, 'input_audio'); assert.strictEqual(orc.body.messages[0].content[0].input_audio.format, 'wav');
});
t('OpenRouter-only setup (no models configured) works and skips non-audio models', async () => {
  const { hub, calls } = setup({ openrouterKeys: ['OR1'] }, (c) => catalogOK(c) || orOk(SONG));
  const r = await hub.identify(wav(3, 0.3)); assert.ok(r.ok, JSON.stringify(r)); assert.strictEqual(r.provider, 'openrouter');
  assert.ok(!calls.some((c) => isGem(c)));
});
t('network failure on Gemini falls through to OpenRouter', async () => {
  const { hub } = setup({ geminiKeys: ['G1'], openrouterKeys: ['O1'], models: parseModelList('gemini:m1,openrouter:google/gemini-2.5-flash') }, (c) => catalogOK(c) || (isGem(c) ? 'netfail' : orOk(SONG)));
  const r = await hub.identify(wav(3, 0.3)); assert.ok(r.ok, JSON.stringify(r)); assert.strictEqual(r.provider, 'openrouter');
});
t('offline everywhere -> network message', async () => {
  const { hub } = setup({ geminiKeys: ['G1'], models: parseModelList('gemini:m1'), fallbackToDefaults: false }, () => 'netfail');
  const r = await hub.identify(wav(3, 0.3)); assert.strictEqual(r.code, 'network'); assert.ok(/internet/i.test(r.error));
});
t('hung request times out instead of hanging', async () => {
  const { hub } = setup({ geminiKeys: ['G1'], models: parseModelList('gemini:m1'), fallbackToDefaults: false }, () => 'hang', { timeoutAudioMs: 1200, retries: 0, budgetAudioMs: 5000 });
  const t0 = Date.now(); const r = await hub.identify(wav(3, 0.3)); assert.strictEqual(r.code, 'timeout'); assert.ok(Date.now() - t0 < 4000);
});
t('no key / key missing for the chosen provider', async () => {
  let r = await setup({}, () => null).hub.identify(wav(3, 0.3)); assert.strictEqual(r.code, 'no_key'); assert.ok(/API key/.test(r.error));
  r = await setup({ geminiKeys: ['G'], models: parseModelList('openai:gpt-4o-audio-preview'), fallbackToDefaults: false }, () => null).hub.identify(wav(3, 0.3));
  assert.strictEqual(r.code, 'no_key'); assert.ok(/OpenAI/.test(r.error));
});
t('only bad keys -> bad_key (listener stops), single clear message', async () => {
  const { hub } = setup({ geminiKeys: ['B'], models: parseModelList('gemini:m1'), fallbackToDefaults: false }, () => jres(403, { error: { message: 'permission denied' } }));
  const r = await hub.identify(wav(3, 0.3)); assert.strictEqual(r.code, 'bad_key'); assert.ok(/key/i.test(r.error));
});
t('model that cannot take audio is skipped (400 audio) and remembered', async () => {
  const { hub, calls } = setup({ openrouterKeys: ['O'], models: parseModelList('openrouter:meta/text-only,openrouter:good/audio'), fallbackToDefaults: false },
    (c) => catalogOK(c) || (c.body && c.body.model === 'meta/text-only' ? jres(404, { error: { message: 'No endpoints found that support input audio' } }) : orOk(SONG)));
  const r = await hub.identify(wav(3, 0.3)); assert.ok(r.ok); assert.strictEqual(r.model, 'good/audio');
  await hub.identify(wav(3, 0.3)); assert.ok(calls.filter((c) => c.body && c.body.model === 'meta/text-only').length <= 1);
});
t('JSON mode rejected -> retried once without response_format', async () => {
  const { hub, calls } = setup({ openrouterKeys: ['O'], models: parseModelList('openrouter:a/b'), fallbackToDefaults: false }, (c) => catalogOK(c) || (c.body && c.body.response_format ? jres(400, { error: { message: 'response_format json_object is not supported' } }) : orOk(SONG)));
  const r = await hub.identify(wav(3, 0.3)); assert.ok(r.ok); const chats = calls.filter(isOR); assert.ok(chats[0].body.response_format); assert.ok(!chats[1].body.response_format);
});
t('OpenRouter error inside HTTP 200 is handled', async () => {
  const { hub } = setup({ openrouterKeys: ['O'], models: parseModelList('openrouter:a/b,openrouter:c/d'), fallbackToDefaults: false }, (c) => catalogOK(c) || (c.body.model === 'a/b' ? jres(200, { error: { code: 503, message: 'provider down' } }) : orOk(SONG)));
  const r = await hub.identify(wav(3, 0.3)); assert.ok(r.ok); assert.strictEqual(r.model, 'c/d');
});
t('unreadable reply is retried once, then next model', async () => {
  let n = 0;
  const { hub, calls } = setup({ geminiKeys: ['G'], models: parseModelList('gemini:m1,gemini:m2'), fallbackToDefaults: false }, (c) => (/m1:/.test(c.url) ? gemOk('I think it is Amazing Grace, sorry') : gemOk(SONG)));
  const r = await hub.identify(wav(3, 0.3)); assert.ok(r.ok); assert.strictEqual(r.model, 'm2'); assert.strictEqual(calls.filter((c) => /m1:/.test(c.url)).length, 2);
});
t('Gemini safety block / empty candidate -> next model, friendly if all blocked', async () => {
  const { hub } = setup({ geminiKeys: ['G'], models: parseModelList('gemini:m1'), fallbackToDefaults: false }, () => jres(200, { candidates: [{ finishReason: 'SAFETY' }] }));
  const r = await hub.identify(wav(3, 0.3)); assert.strictEqual(r.code, 'blocked'); assert.ok(/declined/.test(r.error));
});
t('thinking parts are ignored when reading Gemini text', async () => {
  const { hub } = setup({ geminiKeys: ['G'], models: parseModelList('gemini:m1'), fallbackToDefaults: false }, () => jres(200, { candidates: [{ content: { parts: [{ thought: true, text: 'hmm {"x":1}' }, { text: JSON.stringify(SONG) }] }, finishReason: 'STOP' }] }));
  const r = await hub.identify(wav(3, 0.3)); assert.ok(r.ok); assert.strictEqual(r.best.title, 'Amazing Grace');
});
t('custom provider: base URL, key and custom headers', async () => {
  const { hub, calls } = setup({ providers: { myhost: { baseUrl: 'https://h.example/v1/', keys: ['K9'], headers: { 'X-Org': 'acme' } } }, models: [{ provider: 'myhost', model: 'llama-audio' }], fallbackToDefaults: false }, () => orOk(SONG));
  const r = await hub.identify(wav(3, 0.3)); assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(calls[0].url, 'https://h.example/v1/chat/completions'); assert.strictEqual(calls[0].headers.Authorization, 'Bearer K9'); assert.strictEqual(calls[0].headers['X-Org'], 'acme');
});
t('keyless local provider (ollama) needs no key and sends no Authorization', async () => {
  const { hub, calls } = setup({ models: parseModelList('ollama:llama3:8b') }, () => orOk({ found: true, slides: ['a'] }));
  const r = await hub.lyricsSlides('x'); assert.ok(r.ok, JSON.stringify(r)); assert.strictEqual(calls[0].body.model, 'llama3:8b'); assert.ok(!calls[0].headers.Authorization); assert.strictEqual(typeof calls[0].body.messages[0].content, 'string');
});
t('catalog verification: real song verified, invented one demoted', async () => {
  const { hub } = setup({ verify: true, geminiKeys: ['G'], models: parseModelList('gemini:m1'), fallbackToDefaults: false }, (c) => {
    if (isGem(c)) return gemOk({ isSong: true, best: { title: 'Totally Invented Song', artist: 'Ghost', confidence: 95 }, similar: [{ title: 'Amazing Grace', artist: 'Judy Collins', confidence: 70 }] });
    if (/itunes/.test(c.url)) return jres(200, { results: /Amazing/i.test(decodeURIComponent(c.url)) ? [{ trackName: 'Amazing Grace', artistName: 'Judy Collins', collectionName: 'Whales' }] : [] });
    if (/deezer/.test(c.url)) return jres(200, { data: [] });
  });
  const r = await hub.identify(wav(3, 0.3)); assert.ok(r.ok); assert.strictEqual(r.best.title, 'Amazing Grace'); assert.strictEqual(r.best.verified, true);
  const fake = r.similar.find((x) => /Invented/.test(x.title)); assert.strictEqual(fake.verified, false); assert.ok(fake.confidence <= 60); assert.strictEqual(r.catalogChecked, true);
});
t('catalogs unreachable -> nothing demoted, no failure', async () => {
  const { hub } = setup({ verify: true, geminiKeys: ['G'], models: parseModelList('gemini:m1'), fallbackToDefaults: false }, (c) => (isGem(c) ? gemOk(SONG) : 'netfail'));
  const r = await hub.identify(wav(3, 0.3)); assert.ok(r.ok); assert.strictEqual(r.best.confidence, 92); assert.strictEqual(r.best.verified, null);
});
t('lyricsSlides tolerates shapes; translate validates count', async () => {
  let { hub } = setup({ geminiKeys: ['G'], models: parseModelList('gemini:m1'), fallbackToDefaults: false }, () => gemOk({ title: 'T', slides: [{ lines: ['a', 'b'] }, 'c\nd', ''] }));
  let r = await hub.lyricsSlides('t'); assert.ok(r.ok && r.found); assert.deepStrictEqual(r.slides, ['a\nb', 'c\nd']);
  ({ hub } = setup({ geminiKeys: ['G'], models: parseModelList('gemini:m1'), fallbackToDefaults: false }, () => gemOk({ t: ['uno', 'dos'] })));
  r = await hub.translate(['one', 'two'], 'Spanish'); assert.deepStrictEqual(r.texts, ['uno', 'dos']);
  ({ hub } = setup({ geminiKeys: ['G'], models: parseModelList('gemini:m1'), fallbackToDefaults: false }, () => gemOk({ t: ['uno'] })));
  r = await hub.translate(['one', 'two'], 'Spanish'); assert.strictEqual(r.ok, false);
});
t('lyrics: a model that does not know the song is followed by another model, and the honest note is returned if all decline', async () => {
  const NOPE = { found: false, note: 'Exact lyrics could not be confirmed.', slides: [] };
  let { hub, calls } = setup({ geminiKeys: ['G'], models: parseModelList('gemini:m1,gemini:m2,gemini:m3,gemini:m4'), fallbackToDefaults: false }, () => gemOk(NOPE));
  let r = await hub.lyricsSlides('some telugu song'); assert.ok(r.ok); assert.strictEqual(r.found, false); assert.strictEqual(r.note, NOPE.note);
  assert.strictEqual(calls.length, 3, 'asks at most 3 models');
  ({ hub } = setup({ geminiKeys: ['G'], models: parseModelList('gemini:m1,gemini:m2'), fallbackToDefaults: false }, (c) => (/m1:/.test(c.url) ? gemOk(NOPE) : gemOk({ found: true, title: 'T', complete: true, slides: ['a\nb'] }))));
  r = await hub.lyricsSlides('x'); assert.ok(r.ok && r.found); assert.strictEqual(r.model, 'm2');
});
t('formatLyrics: pasted text becomes slides locally (no network)', () => {
  const { hub, calls } = setup({}, () => null);
  const txt = 'line1\nline2\nline3\nline4\nline5\n\nchorus1\nchorus2\n\n\n  \nlast';
  let r = hub.formatLyrics(txt, { title: 'My Song' });
  assert.deepStrictEqual(r.slides, ['line1\nline2\nline3', 'line4\nline5', 'chorus1\nchorus2', 'last']); assert.strictEqual(r.title, 'My Song'); assert.ok(r.found);
  r = hub.formatLyrics('a\nb\nc\nd', { prompt: 'Telugu lyrics, 2 lines per slide' }); assert.deepStrictEqual(r.slides, ['a\nb', 'c\nd']);
  r = hub.formatLyrics('\u0c28\u0c40 \u0c38\u0c4d\u0c35\u0c30\u0c2e\u0c47\nline2'); assert.strictEqual(r.title, '\u0c28\u0c40 \u0c38\u0c4d\u0c35\u0c30\u0c2e\u0c47');
  assert.strictEqual(hub.formatLyrics('  \n ').found, false); assert.strictEqual(calls.length, 0);
});
t('listModels (OpenRouter catalog) and test()', async () => {
  const { hub } = setup({ openrouterKeys: ['O'] }, (c) => catalogOK(c) || orOk({ ok: true }));
  const l = await hub.listModels('openrouter', { audioOnly: true }); assert.ok(l.ok); assert.deepStrictEqual(l.models.map((m) => m.id), ['google/gemini-2.5-flash']);
  const r = await hub.test('openrouter', 'google/gemini-2.5-flash'); assert.ok(r.ok, JSON.stringify(r));
  const bad = await setup({}, () => null).hub.listModels('openrouter'); assert.strictEqual(bad.code, 'no_key');
});
t('keys never appear in status() or error text', async () => {
  const { hub } = setup({ geminiKeys: ['SECRETKEY123456'] }, () => jres(500, { error: { message: 'oops SECRETKEY123456' } }));
  const st = JSON.stringify(hub.status()); assert.ok(!/SECRETKEY123456/.test(st));
  const r = await hub.identify(wav(3, 0.3)); assert.ok(!JSON.stringify(r).includes('SECRETKEY123456'));
});

(async () => {
  let fail = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + String(e && e.stack || e).split('\n').slice(0, 4).join('\n       ')); }
  }
  console.log(fail ? '\n' + fail + ' of ' + tests.length + ' tests FAILED' : '\nAll ' + tests.length + ' tests passed');
  process.exit(fail ? 1 : 0);
})();
