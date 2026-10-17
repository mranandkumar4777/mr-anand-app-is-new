'use strict';
// Centralized AI hub. Runs ONLY in the desktop app (Electron main process).
// Phones never see keys: they send audio/text to the desktop, the desktop calls the AI and returns JSON.
//
// PROVIDERS
//   gemini        Google Gemini REST API.
//   openrouter    OpenRouter (OpenAI-compatible, thousands of models, with a public model catalog).
//   openai, groq, together, mistral, deepseek, xai, ollama, lmstudio
//                 ready-made presets for OpenAI-compatible APIs (ollama / lmstudio run locally, no key needed).
//   <any name>    your own OpenAI-compatible endpoint: { baseUrl, keys, headers } in the "providers" setting.
//
// MODELS
//   A model is "provider:modelId", e.g. "gemini:gemini-2.5-flash", "openrouter:google/gemini-2.5-flash",
//   "openai:gpt-4o-audio-preview". A bare id is routed by its shape ("a/b" -> openrouter, "gemini-*" -> gemini,
//   "gpt-*" -> openai). The list is a fallback chain: the first model that works wins.
//
// RELIABILITY
//   * every request has a timeout and can never hang
//   * 5xx / timeouts / dropped connections are retried with exponential backoff, honoring Retry-After
//   * rate-limited or rejected keys are rotated; broken / unsupported models are remembered and skipped
//   * when a model or a whole provider is down, the next model / provider in the chain is used
//   * every failure becomes a short, human message plus a stable `code`; raw HTTP dumps never reach the UI
//
// SONG DETECTION
//   * the clip is inspected first (too short / silent / too large are reported clearly) and quiet clips are normalised
//   * the reply is parsed leniently (fences, prose around the JSON, truncated JSON, 0-1 or 0-100 confidence, ...)
//   * candidates are checked against public music catalogs (iTunes, Deezer): invented titles are demoted, real ones are
//     marked verified:true. If the catalogs cannot be reached, nothing is demoted.
const crypto = require('crypto');

// ---------------------------------------------------------------------------------------------------------------------
// Provider presets and defaults
// ---------------------------------------------------------------------------------------------------------------------
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/';
const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

const PRESETS = {
  gemini:     { label: 'Gemini',     kind: 'gemini', baseUrl: GEMINI_BASE, envKeys: ['GEMINI_API_KEY', 'GEMINI_API_KEYS', 'GOOGLE_API_KEY'] },
  openrouter: { label: 'OpenRouter', kind: 'openai', baseUrl: OPENROUTER_BASE, catalog: 'openrouter',
                headers: { 'HTTP-Referer': 'https://github.com/mranandkumar4777/p1-app-pc', 'X-Title': 'Presenter' },
                envKeys: ['OPENROUTER_API_KEY', 'OPENROUTER_API_KEYS'] },
  openai:     { label: 'OpenAI',     kind: 'openai', baseUrl: 'https://api.openai.com/v1' },
  groq:       { label: 'Groq',       kind: 'openai', baseUrl: 'https://api.groq.com/openai/v1' },
  together:   { label: 'Together',   kind: 'openai', baseUrl: 'https://api.together.xyz/v1' },
  mistral:    { label: 'Mistral',    kind: 'openai', baseUrl: 'https://api.mistral.ai/v1' },
  deepseek:   { label: 'DeepSeek',   kind: 'openai', baseUrl: 'https://api.deepseek.com/v1' },
  xai:        { label: 'xAI',        kind: 'openai', baseUrl: 'https://api.x.ai/v1' },
  ollama:     { label: 'Ollama (local)',    kind: 'openai', baseUrl: 'http://localhost:11434/v1', keyless: true },
  lmstudio:   { label: 'LM Studio (local)', kind: 'openai', baseUrl: 'http://localhost:1234/v1', keyless: true }
};
const PROVIDER_ORDER = ['gemini', 'openrouter', 'openai'];     // order used when building default fallbacks
const PROVIDER_ALIASES = { google: 'gemini', googleai: 'gemini', 'google-ai': 'gemini', or: 'openrouter', 'open-router': 'openrouter', oai: 'openai' };

// Only used when the user configured no models (and appended as a last-resort fallback unless fallbackToDefaults:false).
// Plain, editable defaults: nothing in the logic depends on a particular model name.
const DEFAULT_MODELS = {
  gemini:     ['gemini-flash-latest', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'],
  openrouter: ['google/gemini-2.5-flash', 'google/gemini-2.5-flash-lite', 'openai/gpt-4o-audio-preview'],
  openai:     ['gpt-4o-audio-preview', 'gpt-4o-mini-audio-preview']
};

const DEFAULTS = {
  retries: 2,                 // extra attempts on the same model for 5xx / timeout (3 tries in total)
  backoffMs: 800,             // 800ms, 1.6s, ... (+ jitter), or the server's Retry-After when it is short
  maxRetryWaitMs: 8000,
  timeoutAudioMs: 40000,
  timeoutTextMs: 60000,
  budgetAudioMs: 75000,       // total time one identify() may spend across all models
  budgetTextMs: 110000,
  catalogTtlMs: 6 * 3600 * 1000,
  catalogTimeoutMs: 5000,
  verifyTimeoutMs: 4000,
  verifyBudgetMs: 6000,
  unverifiedCap: 60,          // when the catalogs are reachable but do not know a song, its confidence is capped here
  minClipSeconds: 0.7,
  maxClipBytes: 8 * 1024 * 1024
};

const COOL = {                // how long a failing thing is skipped
  badKeyMs: 10 * 60000, quotaMs: 30 * 60000, rateLimitMs: 30000,
  badModelMs: 30 * 60000, unsupportedAudioMs: 60 * 60000, badRequestMs: 10 * 60000,
  serverMs: 45000, regionMs: 30 * 60000
};

// ---------------------------------------------------------------------------------------------------------------------
// Parsing helpers (settings text -> structures)
// ---------------------------------------------------------------------------------------------------------------------
const NAME_RE = /^[a-z][a-z0-9_-]{1,30}$/;
const cleanName = (s) => { s = String(s || '').trim().toLowerCase(); s = PROVIDER_ALIASES[s] || s; return NAME_RE.test(s) ? s : ''; };

function inferProvider(id) {
  if (/^gemini[-\d]|^gemini$|^models\/gemini/i.test(id)) return 'gemini';
  if (/^(gpt-|chatgpt|o\d(-|$)|whisper-)/i.test(id)) return 'openai';
  if (/\//.test(id)) return 'openrouter';
  return 'gemini';
}

// "gemini:gemini-flash-latest, openrouter:google/gemini-2.5-flash" (comma or one per line). `known` = extra provider names.
// Also accepts an array of strings / {provider, model}. Never throws.
function parseModelList(input, known) {
  const names = new Set(Object.keys(PRESETS).concat(Object.keys(PROVIDER_ALIASES), (known || []).map(cleanName).filter(Boolean)));
  const items = Array.isArray(input) ? input : String(input == null ? '' : input).split(/[,\n;]/);
  const out = [], seen = new Set();
  for (let it of items) {
    let provider = '', model = '';
    if (it && typeof it === 'object') { provider = cleanName(it.provider); model = String(it.model || '').trim(); }
    else {
      const s = String(it == null ? '' : it).trim();
      const i = s.indexOf(':');
      if (i > 0 && names.has(s.slice(0, i).trim().toLowerCase())) { provider = cleanName(s.slice(0, i)); model = s.slice(i + 1).trim(); }
      else model = s;
    }
    model = model.replace(/^models\//, '').replace(/\s+/g, '');
    if (!model) continue;
    if (!provider) provider = inferProvider(model);
    const id = provider + '|' + model;
    if (seen.has(id)) continue;
    seen.add(id); out.push({ provider, model });
  }
  return out;
}

function parseKeys(text) {
  const list = Array.isArray(text) ? text : String(text == null ? '' : text).split(/[\s,;]+/);
  return Array.from(new Set(list.map((k) => String(k || '').trim()).filter((k) => k && !/[•*]/.test(k))));
}

const isHttpUrl = (u) => { try { const x = new URL(u); return (x.protocol === 'http:' || x.protocol === 'https:') && !x.username && !x.password; } catch (e) { return false; } };
const cleanUrl = (u) => String(u || '').trim().replace(/\/+$/, '');

// Settings text for extra providers, one per line:
//   openai = sk-abc, sk-def                                   (preset providers: just keys)
//   myhost | https://host.example/v1 | key1, key2 | X-Org: acme; X-Team: a    (custom endpoint, optional headers)
// A key shown masked (••••abcd) keeps the stored key that ends with abcd. Returns { providers, errors }.
function parseProviderLines(text, existing) {
  existing = existing || {};
  const providers = {}, errors = [];
  String(text == null ? '' : text).split('\n').forEach((raw, n) => {
    const line = raw.trim();
    if (!line || line[0] === '#') return;
    let name, baseUrl = '', keysText = '', headersText = '';
    if (line.includes('|')) { const p = line.split('|').map((s) => s.trim()); name = p[0]; baseUrl = p[1] || ''; keysText = p[2] || ''; headersText = p.slice(3).join('|'); }
    else { const i = line.indexOf('='); if (i < 0) { errors.push('Line ' + (n + 1) + ': expected "name = key" or "name | url | key".'); return; } name = line.slice(0, i); keysText = line.slice(i + 1); }
    name = cleanName(name);
    if (!name) { errors.push('Line ' + (n + 1) + ': invalid provider name.'); return; }
    if (baseUrl && !isHttpUrl(baseUrl)) { errors.push('Line ' + (n + 1) + ': "' + baseUrl.slice(0, 60) + '" is not a valid http(s) URL.'); return; }
    const old = existing[name] || {};
    const keys = [];
    keysText.split(/[\s,;]+/).filter(Boolean).forEach((k) => {
      if (/[•*]/.test(k)) { const tail = k.replace(/[•*]/g, ''); const m = (old.keys || []).find((x) => tail && x.endsWith(tail)); if (m) keys.push(m); }
      else keys.push(k);
    });
    const headers = {};
    headersText.split(';').forEach((h) => { const i = h.indexOf(':'); if (i > 0) { const k = h.slice(0, i).trim(), v = h.slice(i + 1).trim(); if (/^[A-Za-z0-9-]+$/.test(k) && v) headers[k] = v; } });
    if (!PRESETS[name] && !baseUrl && !old.baseUrl) { errors.push('Line ' + (n + 1) + ': "' + name + '" needs a base URL (name | https://host/v1 | key).'); return; }
    const cur = providers[name] || { keys: [], headers: {} };
    cur.keys = Array.from(new Set(cur.keys.concat(keys)));
    Object.assign(cur.headers, headers);
    if (baseUrl) cur.baseUrl = cleanUrl(baseUrl); else if (old.baseUrl) cur.baseUrl = old.baseUrl;
    providers[name] = cur;
  });
  return { providers, errors };
}

// ---------------------------------------------------------------------------------------------------------------------
// Audio inspection (WAV) - decides whether a clip is worth sending at all
// ---------------------------------------------------------------------------------------------------------------------
function inspectAudio(b64, mime) {
  const clean = String(b64 || '').replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
  if (!clean) return { ok: false, code: 'bad_audio', error: 'No audio was received. Check that the microphone is working and try again.' };
  let buf;
  try { buf = Buffer.from(clean, 'base64'); } catch (e) { buf = null; }
  if (!buf || buf.length < 64) return { ok: false, code: 'bad_audio', error: 'The audio clip was empty or damaged. Please try again.' };
  const info = { ok: true, buf, base64: clean, mime: String(mime || 'audio/wav').toLowerCase(), bytes: buf.length, wav: false };
  if (buf.length >= 44 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WAVE') {
    let off = 12, fmt = null, dataStart = -1, dataLen = 0;
    while (off + 8 <= buf.length) {
      const id = buf.toString('latin1', off, off + 4); let size = buf.readUInt32LE(off + 4);
      if (id === 'fmt ' && off + 8 + 16 <= buf.length) fmt = { format: buf.readUInt16LE(off + 8), channels: buf.readUInt16LE(off + 10), rate: buf.readUInt32LE(off + 12), bits: buf.readUInt16LE(off + 22) };
      if (id === 'data') { dataStart = off + 8; if (!size || size > buf.length - dataStart) size = buf.length - dataStart; dataLen = size; break; }
      off += 8 + size + (size & 1);
    }
    if (fmt && dataStart >= 0 && fmt.rate > 0 && fmt.channels > 0 && fmt.bits > 0) {
      info.wav = true; info.rate = fmt.rate; info.channels = fmt.channels; info.bits = fmt.bits;
      info.seconds = dataLen / (fmt.rate * fmt.channels * (fmt.bits / 8));
      if (fmt.format === 1 && fmt.bits === 16) {
        const count = Math.floor(dataLen / 2), step = Math.max(1, Math.floor(count / 200000));
        let sum = 0, n = 0, peak = 0;
        for (let i = 0; i < count; i += step) { const v = buf.readInt16LE(dataStart + i * 2) / 32768; sum += v * v; n++; const a = Math.abs(v); if (a > peak) peak = a; }
        info.pcm16 = true; info.dataStart = dataStart; info.dataLen = count * 2; info.peak = peak; info.rms = n ? Math.sqrt(sum / n) : 0;
      }
    }
  }
  return info;
}

// Quiet hums and distant speakers: raise the level so the model hears them (never amplifies pure noise: peak > 0.004 only).
function normalizeAudio(info) {
  if (!info.pcm16 || !(info.peak > 0.004 && info.peak < 0.3)) return info;
  const gain = Math.min(0.7 / info.peak, 30);
  const out = Buffer.from(info.buf);
  for (let i = 0; i < info.dataLen; i += 2) {
    const v = Math.round(out.readInt16LE(info.dataStart + i) * gain);
    out.writeInt16LE(v > 32767 ? 32767 : v < -32768 ? -32768 : v, info.dataStart + i);
  }
  return Object.assign({}, info, { buf: out, base64: out.toString('base64'), peak: Math.min(1, info.peak * gain), rms: Math.min(1, info.rms * gain), normalized: true, gain });
}

function audioFormat(mime) {
  const m = String(mime || '').toLowerCase();
  if (/mp3|mpeg/.test(m)) return 'mp3';
  if (/flac/.test(m)) return 'flac';
  if (/ogg|opus/.test(m)) return 'ogg';
  if (/aac/.test(m)) return 'aac';
  if (/m4a|mp4/.test(m)) return 'm4a';
  if (/webm/.test(m)) return 'webm';
  return 'wav';
}

// ---------------------------------------------------------------------------------------------------------------------
// Reply parsing
// ---------------------------------------------------------------------------------------------------------------------
// Close whatever a truncated JSON text left open, so a reply cut off by a token limit still yields its complete part.
function repairJson(s) {
  const stack = []; let inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') stack.pop();
  }
  let out = s;
  if (esc) out = out.slice(0, -1);
  if (inStr) out += '"';
  out = out.replace(/\s+$/, '');
  if (stack[stack.length - 1] === '}') out = out.replace(/,?\s*"(?:[^"\\]|\\.)*"\s*:?\s*$/, (m, off) => (/:\s*$/.test(m) || /^\s*,/.test(m) || /^"/.test(m.trim()) && /[{,]\s*$/.test(out.slice(0, off + 1)) ? '' : m));
  out = out.replace(/,\s*$/, '');
  return out + stack.reverse().join('');
}

function extractJson(raw) {
  const s = String(raw == null ? '' : raw).replace(/^﻿/, '').trim();
  if (!s) return null;
  const tryParse = (t) => { try { return JSON.parse(t); } catch (e) { return undefined; } };
  let v = tryParse(s); if (v !== undefined && v !== null) return v;
  const fence = s.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  if (fence) { v = tryParse(fence[1].trim()); if (v !== undefined && v !== null) return v; }
  const body = fence ? fence[1] : s.replace(/^```(?:json|JSON)?\s*/, '');
  const start = body.search(/[{[]/);
  if (start < 0) return null;
  // find the matching close of the first value, string- and escape-aware
  const stack = []; let inStr = false, esc = false, end = -1;
  for (let i = start; i < body.length; i++) {
    const ch = body[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') { stack.pop(); if (!stack.length) { end = i; break; } }
  }
  if (end >= 0) { v = tryParse(body.slice(start, end + 1)); if (v !== undefined && v !== null) return v; }
  v = tryParse(repairJson(body.slice(start).replace(/```\s*$/, '')));   // truncated reply
  return v === undefined ? null : v;
}

const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').slice(0, n);
const PLACEHOLDER = /^(unknown|unidentified|n\/?a|none|null|undefined|untitled|not (sure|known|identified|available)|no (match|song|title)|can'?t (tell|identify)|unable)\b/i;
const asBool = (v, dflt) => (typeof v === 'boolean' ? v : /^(true|yes|1)$/i.test(String(v)) ? true : /^(false|no|0)$/i.test(String(v)) ? false : dflt);

function toConfidence(v) {
  if (typeof v === 'string') {
    const t = v.trim().toLowerCase();
    if (/^(very high|certain)/.test(t)) return 95; if (/^high/.test(t)) return 85; if (/^(medium|moderate)/.test(t)) return 60; if (/^low/.test(t)) return 30;
    v = parseFloat(t.replace('%', ''));
  }
  v = Number(v);
  if (!isFinite(v) || v <= 0) return 0;
  if (v <= 1) v *= 100;                    // 0.85 -> 85
  return Math.max(0, Math.min(100, Math.round(v)));
}

function toSong(x, dfltConf) {
  if (x == null) return null;
  if (typeof x === 'string') {
    const m = x.match(/^(.*?)\s+(?:by|[-–—])\s+(.*)$/i);
    x = m ? { title: m[1], artist: m[2] } : { title: x };
  }
  if (typeof x !== 'object') return null;
  const title = clean(x.title || x.song || x.name || x.track, 120).trim().replace(/^["“”']+|["“”']+$/g, '');
  if (!title || PLACEHOLDER.test(title)) return null;
  const artistRaw = Array.isArray(x.artist) ? x.artist.join(', ') : (x.artist || x.singer || x.artists || x.performer || '');
  const artist = clean(artistRaw, 120).trim();
  const conf = x.confidence !== undefined ? toConfidence(x.confidence) : (x.score !== undefined ? toConfidence(x.score) : dfltConf);
  return { title, artist: PLACEHOLDER.test(artist) ? '' : artist, confidence: conf };
}

// Any plausible reply shape -> { isSong, best, similar, transcript, language }
function normalizeIdentify(d) {
  if (Array.isArray(d)) d = { similar: d };
  d = d && typeof d === 'object' ? d : {};
  const list = [];
  const push = (x, c) => { const s = toSong(x, c); if (s) list.push(s); };
  const bestRaw = d.best || d.match || d.result || (d.title ? { title: d.title, artist: d.artist, confidence: d.confidence } : null);
  push(bestRaw, 0);
  [d.similar, d.alternatives, d.alternates, d.candidates, d.songs, d.matches, d.others].forEach((a) => { if (Array.isArray(a)) a.forEach((x) => push(x, 0)); });
  const seen = new Set(), uniq = [];
  list.forEach((s) => { const k = (s.title + '|' + s.artist).toLowerCase().replace(/[^\p{L}\p{M}\p{N}|]+/gu, ''); if (!seen.has(k)) { seen.add(k); uniq.push(s); } });
  return {
    isSong: asBool(d.isSong !== undefined ? d.isSong : d.is_song, true) && uniq.length > 0,
    list: uniq, transcript: clean(d.transcript || d.lyrics || d.heard, 200).trim(), language: clean(d.language, 30).trim()
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Title matching for catalog verification
// ---------------------------------------------------------------------------------------------------------------------
const normText = (s) => String(s || '').toLowerCase().replace(/\(.*?\)|\[.*?\]/g, ' ').replace(/\s[-–—]\s.*$/, ' ').replace(/\b(feat|ft|featuring)\b.*$/i, ' ')
  .normalize('NFC').replace(/[^\p{L}\p{M}\p{N}]+/gu, '');
function similarity(a, b) {
  a = normText(a); b = normText(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (Math.min(a.length, b.length) >= 4 && (a.includes(b) || b.includes(a))) return 0.9;
  const grams = (s) => { const m = new Map(); const arr = Array.from(s); for (let i = 0; i < arr.length - 1; i++) { const g = arr[i] + arr[i + 1]; m.set(g, (m.get(g) || 0) + 1); } return m; };
  const A = grams(a), B = grams(b); let inter = 0, na = 0, nb = 0;
  A.forEach((v, k) => { na += v; if (B.has(k)) inter += Math.min(v, B.get(k)); }); B.forEach((v) => { nb += v; });
  return na + nb ? (2 * inter) / (na + nb) : 0;
}

// ---------------------------------------------------------------------------------------------------------------------
// Friendly messages
// ---------------------------------------------------------------------------------------------------------------------
const redact = (s) => String(s || '').replace(/[A-Za-z0-9_\-]{24,}/g, '…').slice(0, 160);
const wait = (ms) => `${Math.max(1, Math.round(ms / 1000))} second${Math.round(ms / 1000) === 1 ? '' : 's'}`;
const transient = (code) => code === 'server' || code === 'timeout' || code === 'network';

function messageFor(code, label) {
  switch (code) {
    case 'network':          return 'Could not reach ' + label + '. Check the internet connection.';
    case 'timeout':          return label + ' took too long to answer.';
    case 'server':           return label + ' is busy or having trouble right now.';
    case 'rate_limit':       return label + ' rate limit reached.';
    case 'quota':            return label + ' quota or credit is used up.';
    case 'bad_key':          return label + ' rejected the API key.';
    case 'region':           return label + ' is not available in this region.';
    case 'bad_model':        return label + ' does not offer that model.';
    case 'unsupported_audio': return 'That ' + label + ' model cannot listen to audio.';
    case 'blocked':          return label + ' declined to answer this request.';
    case 'declined':         return label + ' could not confirm the answer.';
    case 'parse':            return label + ' sent back an answer that could not be read.';
    case 'bad_request':      return label + ' could not accept this request.';
    case 'too_large':        return 'The request was too large for ' + label + '.';
    default:                 return label + ' returned an error.';
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The hub
// ---------------------------------------------------------------------------------------------------------------------
// store = { load(): { geminiKeys:[], openrouterKeys:[], models:[], providers:{}, ... }, save(cfg) }  (main.js; keys encrypted there)
// options = { fetch, sleep, now, env, log, retries, backoffMs, ... }  (everything optional; mainly for tests)
function createAiHub(store, options) {
  const O = Object.assign({}, DEFAULTS, options || {});
  const fetchFn = O.fetch || (typeof fetch === 'function' ? fetch : null);
  const sleep = O.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = O.now || Date.now;
  const env = O.env || process.env;
  const debug = O.log || (env.PRESENTER_AI_DEBUG ? (...a) => console.warn('[ai-hub]', ...a) : () => {});

  const cool = new Map();          // key -> { until, code, ms }   k:<hash> (api key) | m:<provider>|<model>|<needs> | p:<provider>
  const rr = {};                   // round-robin start index per provider
  const jsonOff = new Set();       // provider|model that rejected JSON mode
  const catalogs = new Map();      // provider -> { at, ok, models: Map }
  const catalogInflight = new Map();

  const hashKey = (k) => 'k:' + crypto.createHash('sha1').update(String(k)).digest('hex').slice(0, 12);
  const isCool = (k) => { const c = cool.get(k); if (!c) return null; if (c.until <= now()) { cool.delete(k); return null; } return c; };
  const setCool = (k, ms, code) => cool.set(k, { until: now() + ms, code, ms });

  // ---- configuration --------------------------------------------------------------------------------------------
  function loadStore() { try { return store && store.load ? (store.load() || {}) : {}; } catch (e) { return {}; } }

  function config() {
    const c = loadStore();
    const providers = {};
    Object.keys(PRESETS).forEach((n) => { const p = PRESETS[n]; providers[n] = { name: n, label: p.label, kind: p.kind, baseUrl: p.baseUrl, catalog: p.catalog || '', keyless: !!p.keyless, headers: Object.assign({}, p.headers), keys: [] }; });
    const stored = c.providers && typeof c.providers === 'object' ? c.providers : {};
    Object.keys(stored).forEach((raw) => {
      const n = cleanName(raw); if (!n) return;
      const sp = stored[raw] || {};
      const p = providers[n] || (providers[n] = { name: n, label: sp.label ? clean(sp.label, 40) : n, kind: 'openai', baseUrl: '', catalog: '', keyless: false, headers: {}, keys: [] });
      if (sp.baseUrl && isHttpUrl(sp.baseUrl)) p.baseUrl = cleanUrl(sp.baseUrl);
      if (sp.kind === 'gemini' || sp.kind === 'openai') p.kind = sp.kind;
      if (sp.keyless !== undefined) p.keyless = !!sp.keyless;
      if (sp.headers && typeof sp.headers === 'object') Object.keys(sp.headers).forEach((h) => { if (/^[A-Za-z0-9-]+$/.test(h) && sp.headers[h]) p.headers[h] = String(sp.headers[h]); });
      p.keys = p.keys.concat(parseKeys(sp.keys));
    });
    providers.gemini.keys = providers.gemini.keys.concat(parseKeys(c.geminiKeys));
    providers.openrouter.keys = providers.openrouter.keys.concat(parseKeys(c.openrouterKeys));
    Object.keys(providers).forEach((n) => {
      const p = providers[n], up = n.toUpperCase().replace(/-/g, '_');
      const envNames = (PRESETS[n] && PRESETS[n].envKeys) || [up + '_API_KEY', up + '_API_KEYS'];
      envNames.forEach((e) => { p.keys = p.keys.concat(parseKeys(env[e])); });
      if (env[up + '_BASE_URL'] && isHttpUrl(env[up + '_BASE_URL'])) p.baseUrl = cleanUrl(env[up + '_BASE_URL']);
      p.keys = Array.from(new Set(p.keys));
      p.usable = (p.keys.length > 0 || p.keyless) && (p.kind === 'gemini' || !!p.baseUrl);
    });
    const names = Object.keys(providers);
    let models = parseModelList(c.models, names);
    if (!models.length && env.PRESENTER_AI_MODELS) models = parseModelList(env.PRESENTER_AI_MODELS, names);
    if (!models.length && env.PRESENTER_GEMINI_MODEL) models = [{ provider: 'gemini', model: String(env.PRESENTER_GEMINI_MODEL).trim() }];
    return {
      providers, models,
      fallbackToDefaults: c.fallbackToDefaults !== false,
      verify: c.verify !== false && !/^(0|false|off|no)$/i.test(String(env.PRESENTER_AI_VERIFY || '')),
      unverifiedCap: Number.isFinite(c.unverifiedCap) ? c.unverifiedCap : O.unverifiedCap
    };
  }

  function status() {
    const c = config();
    const list = Object.keys(c.providers).map((n) => c.providers[n]);
    const has = list.some((p) => p.keys.length > 0) || c.models.some((m) => c.providers[m.provider] && c.providers[m.provider].keyless);
    const last4 = {}; list.forEach((p) => { if (p.keys.length) last4[p.name] = p.keys.map((k) => k.slice(-4)); });
    last4.gemini = last4.gemini || []; last4.openrouter = last4.openrouter || [];
    return {
      geminiKeys: c.providers.gemini.keys.length, openrouterKeys: c.providers.openrouter.keys.length, last4,
      models: c.models, defaultModels: DEFAULT_MODELS, has,
      providers: list.filter((p) => p.usable || p.keys.length).map((p) => ({ name: p.name, label: p.label, kind: p.kind, baseUrl: p.baseUrl, keys: p.keys.length, keyless: p.keyless, usable: p.usable })),
      verify: c.verify
    };
  }

  // Extra providers as editable text, with keys masked (never the full key).
  function providersText() {
    const c = loadStore(), st = c.providers && typeof c.providers === 'object' ? c.providers : {};
    return Object.keys(st).map((n) => {
      const p = st[n] || {}, keys = parseKeys(p.keys).map((k) => '••••' + k.slice(-4)).join(', ');
      const hdr = p.headers ? Object.keys(p.headers).map((h) => h + ': ' + p.headers[h]).join('; ') : '';
      return (p.baseUrl || hdr) ? [n, p.baseUrl || '', keys, hdr].join(' | ').replace(/( \| )+$/, '') : n + ' = ' + keys;
    }).join('\n');
  }

  const knownNames = () => Object.keys(config().providers);
  const parseModels = (text) => parseModelList(text, knownNames());

  // ---- HTTP -------------------------------------------------------------------------------------------------------
  async function http(url, o) {
    if (!fetchFn) return { netError: 'network', cause: 'no_fetch' };
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), Math.max(1000, o.timeoutMs || 30000));
    try {
      const r = await fetchFn(url, { method: o.method || 'POST', headers: o.headers, body: o.body, signal: ctl.signal });
      const text = await r.text();
      let json = null; try { json = text ? JSON.parse(text) : null; } catch (e) {}
      return { ok: r.ok, status: r.status, headers: r.headers, text, json };
    } catch (e) {
      if (ctl.signal.aborted || (e && (e.name === 'AbortError' || e.name === 'TimeoutError'))) return { netError: 'timeout' };
      return { netError: 'network', cause: (e && ((e.cause && e.cause.code) || e.code)) || '' };
    } finally { clearTimeout(timer); }
  }

  const retryAfterMs = (res) => {
    let ms = 0;
    try { const v = res.headers && res.headers.get && res.headers.get('retry-after'); if (v) { const n = Number(v); ms = isFinite(n) ? n * 1000 : Math.max(0, Date.parse(v) - now()) || 0; } } catch (e) {}
    const det = res.json && res.json.error && Array.isArray(res.json.error.details) ? res.json.error.details : [];
    det.forEach((d) => { if (d && d.retryDelay) { const s = parseFloat(d.retryDelay); if (isFinite(s)) ms = Math.max(ms, s * 1000); } });
    return ms;
  };

  // HTTP error -> { ok:false, code, status, retryMs, hint }
  function classify(label, res) {
    if (res.netError) return { ok: false, code: res.netError, status: 0, hint: res.cause || '' };
    const b = res.json, status = res.status;
    const e = b && b.error;
    const msg = clean(typeof e === 'string' ? e : (e && (e.message || (e.metadata && e.metadata.raw))) || (b && b.message) || res.text, 400);
    const innerStatus = e && Number(e.code) >= 400 ? Number(e.code) : 0;         // OpenRouter: HTTP 200 + {error:{code}}
    const st = status >= 400 ? status : (innerStatus || status);
    const out = (code, extra) => Object.assign({ ok: false, code, status: st, hint: redact(msg) }, extra);
    const quotaWords = /per ?day|daily|billing|insufficient[_ ]quota|credit|balance/i;
    if (st === 401) return out('bad_key', { retryMs: COOL.badKeyMs });
    if (st === 402) return out('quota', { retryMs: COOL.quotaMs });
    if (st === 408) return out('timeout');
    if (st === 413) return out('too_large');
    if (st === 429) {
      const ra = retryAfterMs(res);
      if (quotaWords.test(msg) || /PerDay/.test(res.text || '')) return out('quota', { retryMs: Math.max(ra, COOL.quotaMs) });
      return out('rate_limit', { retryMs: Math.max(ra, COOL.rateLimitMs), waitMs: ra });
    }
    if (st === 403) {
      if (/location|region|country|territor/i.test(msg)) return out('region', { retryMs: COOL.regionMs });
      if (/moderation|flagged|safety|blocked/i.test(msg)) return out('blocked');
      return out('bad_key', { retryMs: COOL.badKeyMs });
    }
    if (st === 400) {
      if (/api[ _-]?key|api_key_invalid|key (is )?(not valid|expired|invalid)|invalid.*key|unauthori[sz]ed/i.test(msg)) return out('bad_key', { retryMs: COOL.badKeyMs });
      if (/location|region/i.test(msg) && /not supported/i.test(msg)) return out('region', { retryMs: COOL.regionMs });
      if (/response_format|json_object|json mode|responseMimeType|mime type|structured/i.test(msg)) return out('bad_format');
      if (/audio|modalit|input_audio|multimodal/i.test(msg)) return out('unsupported_audio', { retryMs: COOL.unsupportedAudioMs });
      if (/model|not found|not supported|does not exist/i.test(msg)) return out('bad_model', { retryMs: COOL.badModelMs });
      if (/safety|blocked|prohibited|policy/i.test(msg)) return out('blocked');
      return out('bad_request', { retryMs: COOL.badRequestMs });
    }
    if (st === 404) return /audio|modalit|support input/i.test(msg) ? out('unsupported_audio', { retryMs: COOL.unsupportedAudioMs }) : out('bad_model', { retryMs: COOL.badModelMs });
    if (st === 422) return out('bad_request', { retryMs: COOL.badRequestMs });
    if (st >= 500) return out('server', { waitMs: retryAfterMs(res), retryMs: COOL.serverMs });
    return out('http');
  }

  // ---- provider calls: parts = [{text}|{audio:{mime,base64}}] -> { ok, text } | { ok:false, code, ... } ---------------
  async function callGemini(p, key, model, parts, opt) {
    const gp = parts.map((x) => x.audio ? { inlineData: { mimeType: x.audio.mime || 'audio/wav', data: x.audio.base64 } } : { text: x.text });
    const gen = { temperature: 0.2 }; if (opt.json) gen.responseMimeType = 'application/json';
    const res = await http(p.baseUrl.replace(/\/?$/, '/') + 'models/' + encodeURIComponent(String(model).replace(/^models\//, '')) + ':generateContent', {
      timeoutMs: opt.timeoutMs, headers: Object.assign({ 'Content-Type': 'application/json', 'x-goog-api-key': key }, p.headers),
      body: JSON.stringify({ contents: [{ role: 'user', parts: gp }], generationConfig: gen })
    });
    if (res.netError || !res.ok) return classify(p.label, res);
    const j = res.json;
    if (!j) return { ok: false, code: 'parse', status: res.status };
    if (j.promptFeedback && j.promptFeedback.blockReason) return { ok: false, code: 'blocked', status: res.status };
    const cand = (j.candidates || [])[0];
    if (!cand) return { ok: false, code: 'parse', status: res.status, hint: 'no candidates' };
    const text = (((cand.content || {}).parts) || []).filter((x) => x && !x.thought).map((x) => x.text || '').join('');
    const fr = String(cand.finishReason || '');
    if (!text.trim()) return { ok: false, code: /SAFETY|RECITATION|BLOCKLIST|PROHIBITED|SPII|IMAGE_SAFETY/.test(fr) ? 'blocked' : 'parse', status: res.status, hint: fr };
    return { ok: true, text, truncated: fr === 'MAX_TOKENS' };
  }

  async function callOpenAI(p, key, model, parts, opt) {
    const hasAudio = parts.some((x) => x.audio);
    const content = hasAudio
      ? parts.map((x) => x.audio ? { type: 'input_audio', input_audio: { data: x.audio.base64, format: audioFormat(x.audio.mime) } } : { type: 'text', text: x.text })
      : parts.map((x) => x.text).join('\n\n');
    const body = { model, temperature: 0.2, messages: [{ role: 'user', content }] };
    if (opt.json) body.response_format = { type: 'json_object' };
    const headers = Object.assign({ 'Content-Type': 'application/json' }, p.headers);
    if (key) headers.Authorization = 'Bearer ' + key;
    const res = await http(p.baseUrl + '/chat/completions', { timeoutMs: opt.timeoutMs, headers, body: JSON.stringify(body) });
    if (res.netError || !res.ok) return classify(p.label, res);
    const j = res.json;
    if (!j) return { ok: false, code: 'parse', status: res.status };
    if (j.error) return classify(p.label, Object.assign({}, res, { ok: false }));
    const ch = (j.choices || [])[0];
    if (!ch) return { ok: false, code: 'parse', status: res.status, hint: 'no choices' };
    if (ch.error) return classify(p.label, { ok: false, status: Number(ch.error.code) || 502, json: { error: ch.error }, text: '', headers: res.headers });
    const m = ch.message || {};
    const text = Array.isArray(m.content) ? m.content.map((x) => (x && x.text) || '').join('') : String(m.content || '');
    if (!text.trim()) return { ok: false, code: ch.finish_reason === 'content_filter' ? 'blocked' : 'parse', status: res.status, hint: String(ch.finish_reason || '') };
    return { ok: true, text, truncated: ch.finish_reason === 'length' };
  }

  // ---- model catalogs (dynamic detection of what a provider offers) ------------------------------------------------
  function normalizeCatalog(p, j) {
    const out = new Map();
    if (p.kind === 'gemini') {
      ((j && j.models) || []).forEach((m) => {
        const id = String(m.name || '').replace(/^models\//, '');
        if (!id || !(m.supportedGenerationMethods || []).includes('generateContent')) return;
        out.set(id, { id, name: m.displayName || id, audio: /^gemini/.test(id) && !/embedding|image|tts|live|veo|robotics/.test(id), free: null, json: true, context: m.inputTokenLimit || 0 });
      });
    } else {
      ((j && (j.data || j.models)) || []).forEach((m) => {
        const id = String(m.id || m.name || ''); if (!id) return;
        const mods = m.architecture && Array.isArray(m.architecture.input_modalities) ? m.architecture.input_modalities : null;
        const outMods = m.architecture && Array.isArray(m.architecture.output_modalities) ? m.architecture.output_modalities : ['text'];
        if (!outMods.includes('text')) return;
        const sp = Array.isArray(m.supported_parameters) ? m.supported_parameters : null;
        const pr = m.pricing || {};
        out.set(id, { id, name: m.name || id, audio: mods ? mods.includes('audio') : null,
          free: pr.prompt !== undefined ? Number(pr.prompt) === 0 && Number(pr.completion) === 0 : null,
          json: sp ? (sp.includes('response_format') || sp.includes('structured_outputs')) : null, context: m.context_length || 0 });
      });
    }
    return out;
  }

  async function loadCatalog(provName, force, timeoutMs) {
    const c = config(), p = c.providers[provName];
    if (!p || !p.usable) return null;
    const cached = catalogs.get(provName);
    if (!force && cached && now() - cached.at < (cached.ok ? O.catalogTtlMs : 10 * 60000)) return cached.ok ? cached : null;
    if (catalogInflight.has(provName)) return catalogInflight.get(provName);
    const job = (async () => {
      const key = p.keys[0] || '';
      const headers = Object.assign({}, p.headers); let url;
      if (p.kind === 'gemini') { url = p.baseUrl.replace(/\/?$/, '/') + 'models?pageSize=200'; headers['x-goog-api-key'] = key; }
      else { url = p.baseUrl + '/models'; if (key) headers.Authorization = 'Bearer ' + key; }
      const res = await http(url, { method: 'GET', headers, timeoutMs: timeoutMs || O.catalogTimeoutMs });
      if (res.netError || !res.ok || !res.json) { const f = classify(p.label, res); catalogs.set(provName, { at: now(), ok: false, models: new Map() }); return { error: f }; }
      const entry = { at: now(), ok: true, models: normalizeCatalog(p, res.json) };
      catalogs.set(provName, entry); return entry;
    })().finally(() => catalogInflight.delete(provName));
    catalogInflight.set(provName, job);
    const r = await job;
    return r && r.ok ? r : null;
  }

  // Public: what does this provider offer? ({ ok, provider, models:[{id,name,audio,free,json,context}] })
  async function listModels(provName, opts) {
    opts = opts || {};
    const c = config(), name = cleanName(provName) || 'openrouter', p = c.providers[name];
    if (!p) return { ok: false, code: 'bad_model', error: 'Unknown provider "' + clean(provName, 30) + '".' };
    if (!p.usable) return { ok: false, code: 'no_key', error: 'Add an API key for ' + p.label + ' first.' };
    const r = await loadCatalog(name, !!opts.force, 12000);
    if (!r) return { ok: false, code: 'network', error: p.label + ' did not return its model list. Check the key and the internet connection.' };
    let models = Array.from(r.models.values());
    if (opts.audioOnly) models = models.filter((m) => m.audio !== false);
    const pref = (m) => (m.audio === true ? 0 : 2) + (/gemini.*flash/i.test(m.id) ? 0 : /audio|omni/i.test(m.id) ? 1 : 2);
    models.sort((a, b) => pref(a) - pref(b) || a.id.localeCompare(b.id));
    return { ok: true, provider: name, models: opts.limit ? models.slice(0, opts.limit) : models };
  }

  const catalogInfo = (prov, model) => { const c = catalogs.get(prov); return c && c.ok ? (c.models.get(model) || null) : null; };

  // ---- the model chain ----------------------------------------------------------------------------------------------
  async function buildPlan(c, needs, only) {
    const entries = [], seen = new Set();
    const add = (m, auto) => { const id = m.provider + '|' + m.model; if (!seen.has(id)) { seen.add(id); entries.push({ provider: m.provider, model: m.model, auto: !!auto }); } };
    const usable = (n) => !!(c.providers[n] && c.providers[n].usable);
    if (only) {
      if (usable(only.provider)) {
        const model = only.model || (c.models.find((m) => m.provider === only.provider) || {}).model || (DEFAULT_MODELS[only.provider] || [])[0];
        if (model) add({ provider: only.provider, model }, false);
      }
      return { entries, missing: usable(only.provider) ? [] : [only.provider] };
    }
    c.models.forEach((m) => { if (usable(m.provider)) add(m, false); });
    const missing = Array.from(new Set(c.models.filter((m) => !usable(m.provider)).map((m) => m.provider)));
    if (c.fallbackToDefaults || (!entries.length && !c.models.length)) {
      const order = PROVIDER_ORDER.concat(Object.keys(c.providers).filter((n) => !PROVIDER_ORDER.includes(n)));
      for (const n of order) {
        if (!usable(n) || !DEFAULT_MODELS[n]) continue;
        let list = DEFAULT_MODELS[n];
        if (needs === 'audio' && c.providers[n].catalog) {                       // dynamic: keep only what the catalog says is audio-capable
          await loadCatalog(n, false, O.catalogTimeoutMs);
          const cat = catalogs.get(n);
          if (cat && cat.ok) {
            const ok = list.filter((id) => { const i = cat.models.get(id); return i && i.audio !== false; });
            list = ok.length ? ok : Array.from(cat.models.values()).filter((m) => m.audio === true)
              .sort((a, b) => (/gemini.*flash/i.test(a.id) ? 0 : 1) - (/gemini.*flash/i.test(b.id) ? 0 : 1) || a.id.localeCompare(b.id)).slice(0, 3).map((m) => m.id);
          }
        }
        list.forEach((id) => add({ provider: n, model: id }, true));
      }
    } else if (needs === 'audio') {
      for (const n of Array.from(new Set(entries.map((e) => e.provider)))) if (c.providers[n].catalog) await loadCatalog(n, false, O.catalogTimeoutMs);
    }
    return { entries, missing };
  }

  function summarize(attempts, c, plan, needs) {
    const details = attempts.map((a) => ({ provider: a.provider, model: a.model, code: a.code, status: a.status || 0, hint: a.hint || '' }));
    const labelOf = (n) => (c.providers[n] && c.providers[n].label) || n;
    if (!attempts.length) {
      const anyKey = Object.keys(c.providers).some((n) => c.providers[n].keys.length);
      if (!anyKey && !(plan && plan.missing.length)) return { ok: false, code: 'no_key', error: 'Add an API key in Settings first (Gemini or OpenRouter).', details };
      const miss = plan && plan.missing.length ? plan.missing.map(labelOf).join(', ') : '';
      return { ok: false, code: 'no_key', error: miss ? 'The selected models need an API key for ' + miss + '. Add it in Settings, or remove those models.' : 'No usable AI provider is set up. Add an API key in Settings.', details };
    }
    const codes = Array.from(new Set(attempts.map((a) => a.code)));
    const provs = Array.from(new Set(attempts.map((a) => labelOf(a.provider)))).join(' and ');
    const retryAfter = attempts.reduce((m, a) => (a.retryMs && a.retryMs < COOL.badKeyMs ? Math.min(m || Infinity, a.retryMs) : m), 0) || 0;
    let code = codes[0], error;
    const only = codes.length === 1;
    const pick = ['server', 'timeout', 'network', 'rate_limit'].find((x) => codes.includes(x));   // transient causes win: the UI keeps retrying
    if (!only) code = pick || (codes.includes('bad_key') && codes.every((x) => x === 'bad_key' || x === 'no_key') ? 'bad_key' : 'all_failed');
    switch (code) {
      case 'network': error = 'Could not reach ' + provs + '. Check the internet connection and try again.'; break;
      case 'timeout': error = provs + ' took too long to answer. Try again in a moment.'; break;
      case 'server': error = 'The AI service (' + provs + ') is busy right now. Wait a minute and try again, or add another model or provider in Settings.'; break;
      case 'rate_limit': error = 'The AI rate limit was reached' + (retryAfter ? ' — try again in about ' + wait(retryAfter) : '') + '. Adding another API key or provider in Settings avoids this.'; break;
      case 'quota': error = 'The AI quota or credit on ' + provs + ' is used up. Top it up, wait for the quota to reset, or add another key or provider.'; break;
      case 'bad_key': error = 'The API key for ' + provs + ' was rejected. Check the key in Settings.'; break;
      case 'region': error = provs + ' is not available in this region. Use another provider (for example OpenRouter) in Settings.'; break;
      case 'unsupported_audio': error = 'None of the selected models can listen to audio. In Settings pick an audio-capable model such as gemini-2.5-flash.'; break;
      case 'bad_model': error = 'The selected model is not available on ' + provs + '. Check the model name in Settings.'; break;
      case 'blocked': error = 'The AI declined to answer this request. Try again, or try different wording.'; break;
      case 'declined': error = 'The AI could not confirm this answer.'; break;
      case 'parse': error = 'The AI answered in a form that could not be read. Please try again.'; break;
      default: {
        const bits = []; const seenP = new Set();
        attempts.forEach((a) => { const k = a.provider + a.code; if (!seenP.has(k) && bits.length < 3) { seenP.add(k); bits.push(messageFor(a.code, labelOf(a.provider)).replace(/\.$/, '')); } });
        error = 'No AI provider could complete this request. ' + bits.join('; ') + '.';
      }
    }
    const out = { ok: false, code, error, details };
    if (code === 'rate_limit' || code === 'server') { out.retryAfterMs = retryAfter || (code === 'server' ? 15000 : 30000); out.retryMs = out.retryAfterMs; }
    return out;
  }

  // Remove any configured API key from a diagnostic string (belt and braces: classify() already redacts long tokens).
  function scrubKeys(text, c) {
    let out = String(text || '');
    Object.keys(c.providers).forEach((n) => c.providers[n].keys.forEach((k) => { if (k && k.length >= 6) out = out.split(k).join('…'); }));
    return out;
  }

  // ---- run: a prompt through models x keys with retries and fallback -------------------------------------------------
  // opts: { needs:'audio'|null, accept(data)->bool, only:{provider,model}, budgetMs }
  async function run(parts, opts) {
    opts = opts || {};
    const needs = opts.needs || null;
    const c = config();
    const plan = await buildPlan(c, needs, opts.only);
    if (!plan.entries.length) return summarize([], c, plan, needs);
    const deadline = now() + (opts.budgetMs || (needs === 'audio' ? O.budgetAudioMs : O.budgetTextMs));
    const attempts = [];
    let triedAny = false, declines = 0;

    const pass = async (force) => {
      for (const m of plan.entries) {
        const p = c.providers[m.provider];
        const mk = 'm:' + m.provider + '|' + m.model + '|' + (needs || '');
        const mid = m.provider + '|' + m.model;
        if (now() >= deadline || (opts.maxDeclines && declines >= opts.maxDeclines)) return null;
        if (!force) {
          const pc = isCool('p:' + m.provider), mc = isCool(mk);
          if (pc || mc) { continue; }
        }
        if (needs === 'audio') {
          const info = catalogInfo(m.provider, m.model);
          if (info && info.audio === false) { attempts.push({ provider: m.provider, model: m.model, code: 'unsupported_audio', skipped: true }); continue; }
        }
        const allKeys = p.keys.length ? p.keys : [''];
        const start = (rr[m.provider] = ((rr[m.provider] || 0) + 1)) % allKeys.length;
        let keyTried = false, sawKeyCool = null;
        for (let i = 0; i < allKeys.length; i++) {
          const key = allKeys[(start + i) % allKeys.length];
          const kc = key ? isCool(hashKey(key)) : null;
          if (kc && !force) { sawKeyCool = kc; continue; }
          keyTried = true; triedAny = true;
          let res = null, json = !jsonOff.has(mid);
          const cat = catalogInfo(m.provider, m.model); if (cat && cat.json === false) json = false;
          let parseRetries = 0, waitedShort = false;
          for (let n = 0; ; n++) {
            const left = deadline - now();
            if (left < 1500) { res = { ok: false, code: 'timeout', status: 0 }; break; }
            const opt = { json, timeoutMs: Math.min(needs === 'audio' ? O.timeoutAudioMs : O.timeoutTextMs, left) };
            res = p.kind === 'gemini' ? await callGemini(p, key, m.model, parts, opt) : await callOpenAI(p, key, m.model, parts, opt);
            if (res.ok) {
              const data = extractJson(res.text);
              if (data !== null && (!opts.accept || opts.accept(data))) return { ok: true, data, provider: m.provider, model: m.model, fallback: attempts.length > 0 || m !== plan.entries[0], truncated: !!res.truncated };
              if (data !== null && opts.onReject) {                // a readable answer that the caller does not accept (for example "I do not know this song")
                try { opts.onReject(data, m); } catch (e) {}
                res = { ok: false, code: 'declined', status: 200, hint: 'answer declined' }; declines++;
                break;
              }
              res = { ok: false, code: 'parse', status: 200, hint: 'unreadable reply' };
              if (parseRetries++ < 1) continue;                    // models occasionally slip once: ask again
              break;
            }
            debug(m.provider, m.model, res.code, res.status, res.hint || '');
            if (res.code === 'bad_format' && json) { json = false; jsonOff.add(mid); continue; }       // model has no JSON mode
            if (transient(res.code) && n < O.retries && (res.code !== 'network' || n < 1)) {
              const ra = Math.min(res.waitMs || 0, O.maxRetryWaitMs);
              await sleep(Math.min(O.maxRetryWaitMs, ra || (O.backoffMs * Math.pow(2, n) + Math.floor(Math.random() * 250))));
              continue;
            }
            if (res.code === 'rate_limit' && !waitedShort && res.waitMs > 0 && res.waitMs <= 3000 && deadline - now() > res.waitMs + 4000) { waitedShort = true; await sleep(res.waitMs); continue; }
            break;
          }
          attempts.push({ provider: m.provider, model: m.model, code: res.code, status: res.status, hint: scrubKeys(res.hint, c), retryMs: res.retryMs });
          switch (res.code) {
            case 'rate_limit': case 'quota': case 'bad_key': if (key) setCool(hashKey(key), res.retryMs || COOL.rateLimitMs, res.code); break;
            case 'bad_model': setCool('m:' + m.provider + '|' + m.model + '|', COOL.badModelMs, res.code); setCool(mk, COOL.badModelMs, res.code); break;
            case 'unsupported_audio': setCool(mk, COOL.unsupportedAudioMs, res.code); break;
            case 'bad_request': setCool(mk, COOL.badRequestMs, res.code); break;
            case 'region': setCool('p:' + m.provider, COOL.regionMs, res.code); break;
            case 'server': case 'timeout': setCool(mk, COOL.serverMs, res.code); break;       // a busy server is not the key's fault: only this model rests
            default: break;
          }
          // Which failures make another KEY pointless (same model/service would fail the same way)?
          if (res.code !== 'rate_limit' && res.code !== 'quota' && res.code !== 'bad_key') break;
        }
        if (!keyTried && sawKeyCool) attempts.push({ provider: m.provider, model: m.model, code: sawKeyCool.code, status: 0, retryMs: Math.max(1000, sawKeyCool.until - now()), skipped: true });
      }
      return null;
    };

    let r = await pass(false);
    if (r) return r;
    if (!triedAny && now() < deadline) { r = await pass(true); if (r) return r; }     // everything was resting: try anyway rather than refuse
    return summarize(attempts, c, plan, needs);
  }

  // ---- features -----------------------------------------------------------------------------------------------------
  // Catalog check (iTunes + Deezer): does this title/artist really exist?
  async function lookupSong(title, artist, deadline) {
    const q = encodeURIComponent((title + ' ' + (artist || '')).trim());
    const left = () => Math.max(1000, Math.min(O.verifyTimeoutMs, deadline - now()));
    const score = (rt, ra) => {
      const ts = similarity(title, rt);
      const as = artist && ra ? similarity(artist, ra) : null;
      return { ok: ts >= 0.8 && (as === null || as >= 0.4 || (as === null)), ts, as };
    };
    const itunes = async () => {
      const r = await http('https://itunes.apple.com/search?media=music&entity=song&limit=10&term=' + q, { method: 'GET', timeoutMs: left(), headers: { Accept: 'application/json' } });
      if (!r.ok || !r.json || !Array.isArray(r.json.results)) return { reached: false };
      const hit = r.json.results.find((x) => score(x.trackName, x.artistName).ok);
      return { reached: true, hit: hit ? { source: 'itunes', title: hit.trackName, artist: hit.artistName, album: hit.collectionName || '', artwork: hit.artworkUrl100 || '', url: hit.trackViewUrl || '' } : null };
    };
    const deezer = async () => {
      const r = await http('https://api.deezer.com/search?limit=10&q=' + q, { method: 'GET', timeoutMs: left(), headers: { Accept: 'application/json' } });
      if (!r.ok || !r.json || r.json.error || !Array.isArray(r.json.data)) return { reached: false };
      const hit = r.json.data.find((x) => score(x.title, x.artist && x.artist.name).ok);
      return { reached: true, hit: hit ? { source: 'deezer', title: hit.title, artist: hit.artist && hit.artist.name || '', album: hit.album && hit.album.title || '', artwork: hit.album && (hit.album.cover_medium || '') || '', url: hit.link || '' } : null };
    };
    const [a, b] = await Promise.all([itunes().catch(() => ({ reached: false })), deezer().catch(() => ({ reached: false }))]);
    return { reached: a.reached || b.reached, hit: a.hit || b.hit || null };
  }

  async function verifyCandidates(list, cfg) {
    const deadline = now() + O.verifyBudgetMs;
    const head = list.slice(0, 5);
    const rs = await Promise.all(head.map((s) => lookupSong(s.title, s.artist, deadline).catch(() => ({ reached: false, hit: null }))));
    const reached = rs.some((r) => r.reached);
    head.forEach((s, i) => {
      s.rawConfidence = s.confidence;
      if (!reached) { s.verified = null; return; }
      if (rs[i].hit) { s.verified = true; s.source = rs[i].hit.source; s.album = rs[i].hit.album; s.artwork = rs[i].hit.artwork; s.url = rs[i].hit.url; if (!s.artist) s.artist = clean(rs[i].hit.artist, 120); }
      else { s.verified = false; s.confidence = Math.min(s.confidence, cfg.unverifiedCap); }
    });
    list.slice(5).forEach((s) => { s.verified = null; s.rawConfidence = s.confidence; });
    return { reached, list };
  }

  // Listen to a short clip (hummed, sung or played) and return the best match plus alternatives.
  async function identify(audio, ctx) {
    ctx = ctx || {};
    if (typeof audio === 'string') audio = { base64: audio, mime: 'audio/wav' };
    audio = audio || {};
    let clip = inspectAudio(audio.base64, audio.mime);
    if (!clip.ok) return clip;
    if (clip.bytes > O.maxClipBytes) return { ok: false, code: 'too_large', error: 'The audio clip is too large. Use a clip of 1 to 10 seconds.' };
    if (clip.wav && clip.seconds < O.minClipSeconds) return { ok: false, code: 'too_short', error: 'The clip is too short (' + clip.seconds.toFixed(1) + ' s). Record at least 1 second of the song.' };
    if (clip.pcm16 && clip.peak < 0.002) return { ok: false, code: 'silent_audio', error: 'No sound was picked up. Check the microphone or input level and try again.' };
    clip = normalizeAudio(clip);
    const sec = clip.wav ? Math.round(clip.seconds) : 0;
    const prompt =
      'You are an expert at recognising songs from very short audio clips' + (sec ? ' (this one is about ' + sec + ' seconds)' : '') + '. ' +
      'The clip may be a studio or live recording, a worship or devotional song, or someone humming, singing or playing a melody. Any language is possible (English, Telugu, Hindi, Tamil, Spanish, ...).\n' +
      'Do this: 1) write down any words you hear, in their original script; 2) name the language; 3) decide which song this most likely is from the lyrics, melody and style; 4) list other plausible songs.\n' +
      'Rules: give the real original title (in its original language and script) and the main artist, singer or band; leave artist "" if unsure; never use placeholders such as "Unknown". ' +
      '"confidence" is an integer 0-100: 90+ only when you clearly recognise the lyrics or a distinctive melody, 60-89 probable, below 60 a guess. Short clips are ambiguous: be honest. ' +
      'Never invent a song. If you recognise nothing, or it is only speech or noise, set isSong to false and leave best.title empty. ' +
      (ctx.hint ? 'Extra hint from the user: "' + clean(ctx.hint, 200) + '". ' : '') +
      'Reply with JSON only, no markdown: {"isSong":boolean,"language":string,"transcript":string (max 200 chars),' +
      '"best":{"title":string,"artist":string,"confidence":number},"similar":[{"title":string,"artist":string,"confidence":number}] (up to 5)}.';
    const r = await run([{ audio: { mime: clip.mime, base64: clip.base64 } }, { text: prompt }], { needs: 'audio', accept: (d) => d && typeof d === 'object' });
    if (!r.ok) return r;
    const n = normalizeIdentify(r.data);
    const cfg = config();
    let list = n.list, verified = null;
    if (list.length && cfg.verify) {
      const v = await verifyCandidates(list, cfg);
      verified = v.reached;
      list = v.list.slice().sort((a, b) => (b.confidence + (b.verified ? 25 : 0)) - (a.confidence + (a.verified ? 25 : 0)));
    }
    const best = list[0] || { title: '', artist: '', confidence: 0 };
    const similar = list.slice(1, 6);
    const out = { ok: true, isSong: n.isSong && !!best.title, best, similar, transcript: n.transcript, language: n.language, model: r.model, provider: r.provider, fallback: !!r.fallback };
    if (verified !== null) out.catalogChecked = verified;
    if (!out.isSong && !n.transcript && !list.length) out.note = 'No song was recognised in this clip.';
    return out;
  }

  // Song -> slide cards. If a model declines or can only give part of a song, that is reported back (complete:false / found:false).
  async function lyricsSlides(query, ctx) {
    ctx = ctx || {};
    const prompt =
      'The user is preparing presentation slides for a song. Query: "' + clean(query, 300) + '".' +
      (ctx.artist ? ' Artist hint: ' + clean(ctx.artist, 100) + '.' : '') +
      (ctx.transcript ? ' Heard in the room: "' + clean(ctx.transcript, 300) + '".' : '') +
      (ctx.prompt ? ' Formatting preference from the user: "' + clean(ctx.prompt, 300) + '".' : '') +
      ' Only answer if you actually know this song and do not invent text. Keep the original language and script; do not translate. If you cannot provide the full text, provide what you can and set complete=false. ' +
      'Reply with JSON only: {"found":boolean,"title":string,"artist":string,"complete":boolean,"note":string,' +
      '"slides":[string]} where each slide is 2-4 short lines separated by \\n, one verse or chorus section per slide.';
    const hasSlides = (d) => { if (Array.isArray(d)) return d.length > 0; if (!d || typeof d !== 'object') return false; const sl = d.slides || d.lyrics; return d.found !== false && (Array.isArray(sl) ? sl.length > 0 : typeof sl === 'string' && sl.trim().length > 0); };
    let declinedNote = '';
    // A model that does not know the song says so (found:false). Ask up to 3 different models before giving up: a stronger one may know it.
    const r = await run([{ text: prompt }], { accept: hasSlides, maxDeclines: 3, onReject: (d) => { if (!declinedNote && d && d.note) declinedNote = clean(d.note, 300); } });
    if (!r.ok) {
      if (r.code === 'declined' || r.code === 'all_failed' && (r.details || []).some((x) => x.code === 'declined'))
        return { ok: true, found: false, title: clean(query, 160), artist: '', complete: false, slides: [], note: declinedNote || 'The AI does not know the lyrics of this song well enough to write them without guessing.' };
      return r;
    }
    let d = r.data; if (Array.isArray(d)) d = { slides: d };
    const raw = Array.isArray(d.slides) ? d.slides : typeof d.slides === 'string' ? d.slides.split(/\n\s*\n/) : Array.isArray(d.lyrics) ? d.lyrics : typeof d.lyrics === 'string' ? d.lyrics.split(/\n\s*\n/) : [];
    const slides = raw.map((s) => (s && typeof s === 'object' ? (Array.isArray(s.lines) ? s.lines.join('\n') : (s.text || s.lyrics || '')) : String(s == null ? '' : s)))
      .map((s) => clean(s, 600).replace(/\r/g, '').trim()).filter(Boolean).slice(0, 60);
    const note = clean(d.note, 300);
    return { ok: true, found: asBool(d.found, true) && slides.length > 0, title: clean(d.title || query, 160), artist: clean(d.artist, 120),
             complete: asBool(d.complete, false) && !r.truncated, note: note || (r.truncated ? 'The reply was cut off, so only part of the song is shown.' : ''), slides, model: r.model, provider: r.provider };
  }

  // Pasted lyrics -> slides, locally (no AI, no network, nothing can be invented). Blank lines mark sections (verse / chorus);
  // a section longer than perSlide lines is split. perSlide: ctx.perSlide, else "N lines" found in ctx.prompt, else 4.
  function formatLyrics(text, ctx) {
    ctx = ctx || {};
    const raw = String(text == null ? '' : text).replace(/\r/g, '').replace(/\u00a0/g, ' ');
    let per = Number(ctx.perSlide);
    if (!(per >= 1)) { const m = String(ctx.prompt || '').match(/(\d+)\s*(?:lines?|lns?|\u0c35\u0c30\u0c41\u0c38\u0c32)/i); per = m ? Number(m[1]) : 4; }
    per = Math.max(1, Math.min(12, Math.round(per) || 4));
    const sections = raw.split(/\n\s*\n+/).map((b) => b.split('\n').map((l) => l.replace(/\s+$/g, '').replace(/^\s+/, '')).filter(Boolean)).filter((b) => b.length);
    const slides = [];
    sections.forEach((lines) => {
      const parts = Math.ceil(lines.length / per), size = Math.ceil(lines.length / parts);       // even chunks: 5 lines at 4 per slide -> 3 + 2
      for (let i = 0; i < lines.length; i += size) slides.push(clean(lines.slice(i, i + size).join('\n'), 600));
    });
    const first = sections.length ? sections[0][0] : '';
    const title = clean(ctx.title, 160).trim() || clean(first, 60);
    if (!slides.length) return { ok: true, found: false, title, artist: clean(ctx.artist, 120), complete: false, note: 'There was no text to turn into slides.', slides: [] };
    return { ok: true, found: true, title, artist: clean(ctx.artist, 120), complete: true, note: 'Slides made from the lyrics you pasted.', slides: slides.slice(0, 80), model: 'pasted' };
  }

  // Live captions: translate a small batch of short spoken phrases. Returns { ok, texts:[...] } in the same order.
  async function translate(texts, toName, fromName) {
    const list = (Array.isArray(texts) ? texts : []).map((t) => clean(t, 400)).slice(0, 6);
    if (!list.length) return { ok: true, texts: [] };
    const prompt =
      'Translate each string of this JSON array into ' + clean(toName, 40) + (fromName ? ' (the speaker uses ' + clean(fromName, 40) + ')' : '') + '. ' +
      'These are live speech-to-text captions from a church service: keep it natural and faithful, keep names, fix obvious recognition slips only when certain, and never add commentary. ' +
      'For quoted Bible verses use the familiar wording of a standard ' + clean(toName, 40) + ' Bible. ' +
      'Reply with JSON only: {"t":[string]} with exactly ' + list.length + ' items in the same order. Input: ' + JSON.stringify(list);
    const pick = (d) => (Array.isArray(d) ? d : d && Array.isArray(d.t) ? d.t : d && Array.isArray(d.translations) ? d.translations : d && typeof d.t === 'string' ? [d.t] : null);
    const r = await run([{ text: prompt }], { accept: (d) => { const a = pick(d); return !!a && a.length >= list.length; } });
    if (!r.ok) return r;
    const out = pick(r.data).slice(0, list.length).map((x) => clean(x && typeof x === 'object' ? (x.text || x.t || '') : x, 600));
    return { ok: true, texts: out, model: r.model, provider: r.provider };
  }

  // Settings "Test" button: one tiny request to one provider (and model). Never falls back to another provider.
  async function test(provider, model) {
    const c = config();
    const name = cleanName(provider) || (PROVIDER_ORDER.find((n) => c.providers[n].usable) || 'gemini');
    const t0 = now();
    const r = await run([{ text: 'Reply with exactly this JSON: {"ok":true}' }], { only: { provider: name, model: model || '' }, accept: (d) => !!d, budgetMs: 25000 });
    if (!r.ok) return r;
    return { ok: true, provider: r.provider, model: r.model, ms: now() - t0 };
  }

  function resetCooldowns() { cool.clear(); jsonOff.clear(); catalogs.clear(); return { ok: true }; }

  return { run, identify, lyricsSlides, formatLyrics, translate, status, listModels, test, resetCooldowns, providersText, parseModelList: parseModels, parseKeys, parseProviderLines };
}

module.exports = {
  createAiHub, parseModelList, parseKeys, parseProviderLines,
  _internals: { extractJson, repairJson, inspectAudio, normalizeAudio, normalizeIdentify, toConfidence, similarity, DEFAULT_MODELS, PRESETS }
};
