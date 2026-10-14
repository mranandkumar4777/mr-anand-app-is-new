'use strict';
// Automatic setup of whisper.cpp: finds, downloads and configures the program files AND the model inside the app-data
// folder (<userData>/whisper), so nobody has to install anything by hand.
//
//   Windows  : downloads the official prebuilt zip (whisper-bin-x64.zip / whisper-bin-Win32.zip) from the whisper.cpp
//              GitHub release and unpacks it into <userData>/whisper/bin.
//   macOS/Linux : whisper.cpp publishes NO prebuilt command-line binaries for these systems, so the source of the same
//              release is downloaded and compiled with cmake (needs cmake + a C/C++ compiler, one time, ~2-5 minutes).
//              If those tools are missing the status says exactly what to install; nothing else is required.
//   Model    : ggml-<name>.bin from Hugging Face (resumes nothing, but writes to .part and renames only when complete,
//              and checks the size, so a cut-off download is never used).
//
// Everything is idempotent: when the files are already there and complete, ensure() returns immediately without network.
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');

const EXE = process.platform === 'win32' ? '.exe' : '';
const SERVER_NAMES = ['whisper-server' + EXE, 'server' + EXE];
const CLI_NAMES = ['whisper-cli' + EXE, 'main' + EXE];
const loc = require('./locate');
const REPO = 'ggml-org/whisper.cpp';
// IMPORTANT: GitHub's "latest" release is NOT guaranteed to carry the Windows zip - some releases hold only the source code, and asking for
// whisper-bin-x64.zip there gives HTTP 404 (this was the cause of the failed automatic install). So we look for the newest release that really
// has the file, and otherwise walk through these known-good releases (each one is tried; a 404 just moves on to the next).
const PINNED_TAGS = ['v1.9.2', 'v1.9.1', 'v1.8.7', 'v1.8.4', 'v1.8.3'];
// Model hosts, tried in order. The second is a public mirror for networks where huggingface.co is blocked or slow.
const MODEL_URLS = (m) => ['https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-' + m + '.bin', 'https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-' + m + '.bin'];
const MODEL_URL = (m) => MODEL_URLS(m)[0];
const MODEL_MIN = loc.MODEL_MIN;
const WIN_ASSET_BAD = /cublas|cuda|vulkan|blas|arm|openvino|sycl|hip|debug/i;

const exists = loc.isFile;
const isDir = loc.isDir;

function createSetup(opts) {
  const dir = path.join(opts.dataDir, 'whisper');
  const binDir = path.join(dir, 'bin');
  const modelsDir = path.join(dir, 'models');
  const log = opts.log || (() => {});
  const onState = opts.onState || (() => {});
  const marker = path.join(dir, 'installed.json');
  let running = null;
  let state = { state: 'idle', step: '', pct: 0, message: '', error: '' };

  function set(p) { state = Object.assign({}, state, p); try { onState(Object.assign({}, state)); } catch (e) {} }

  // ---------- locating what is already installed ----------
  const ctx = { dataDir: opts.dataDir, appDir: opts.appDir || __dirname };
  const modelComplete = loc.modelComplete;
  function inspect(cfg) {
    cfg = cfg || {};
    const server = loc.findProgram(SERVER_NAMES, cfg.binaryPath, ctx), cli = loc.findProgram(CLI_NAMES, cfg.binaryPath, ctx);
    const m = loc.findModel(cfg, ctx), model = m ? m.file : '';
    return { server, cli, binary: server || cli, model, modelExact: m ? m.exact : false, ready: !!((server || cli) && model) };
  }
  // A short README with the manual steps, kept next to the files, and the folders created, so "put the files here" always has a target.
  function ensureLayout() {
    try { fs.mkdirSync(binDir, { recursive: true }); fs.mkdirSync(modelsDir, { recursive: true }); fs.writeFileSync(path.join(dir, 'README-MANUAL-INSTALL.txt'), loc.manualReadme(ctx, EXE)); } catch (e) {}
  }

  // ---------- small helpers ----------
  function httpsGet(url, headers, hops) {
    return new Promise((resolve, reject) => {
      const rq = https.get(url, { headers: Object.assign({ 'User-Agent': 'PRESENTER-Desktop' }, headers || {}) }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && (hops || 0) < 8) {
          res.resume(); return resolve(httpsGet(new URL(res.headers.location, url).toString(), headers, (hops || 0) + 1));
        }
        resolve(res);
      });
      rq.on('error', reject);
      rq.setTimeout(30000, () => rq.destroy(new Error('Connection timed out.')));
    });
  }
  async function getJson(url) {
    const res = await httpsGet(url, { Accept: 'application/vnd.github+json' });
    if (res.statusCode !== 200) { res.resume(); throw new Error('HTTP ' + res.statusCode); }
    const ch = []; for await (const c of res) ch.push(c);
    return JSON.parse(Buffer.concat(ch).toString('utf8'));
  }
  // Downloads to dest via dest.part; reports percent through cb(pct). Returns the number of bytes written.
  async function download(url, dest, cb, minBytes) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const part = dest + '.part';
    try { fs.unlinkSync(part); } catch (e) {}
    const res = await httpsGet(url);
    if (res.statusCode !== 200) { res.resume(); throw new Error('Download failed (HTTP ' + res.statusCode + ').'); }
    const total = Number(res.headers['content-length']) || 0;
    let got = 0, last = -1;
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(part);
      res.on('data', (c) => { got += c.length; if (total) { const pct = Math.floor(got / total * 100); if (pct !== last) { last = pct; cb && cb(pct, got, total); } } });
      res.on('error', reject); out.on('error', reject); out.on('finish', resolve);
      res.pipe(out);
    });
    if (total && got !== total) { try { fs.unlinkSync(part); } catch (e) {} throw new Error('Download was cut off. It will be tried again next time.'); }
    if (minBytes && got < minBytes) { try { fs.unlinkSync(part); } catch (e) {} throw new Error('Downloaded file is too small to be valid.'); }
    fs.renameSync(part, dest);
    return got;
  }
  function run(cmd, args, o) {
    return new Promise((resolve, reject) => {
      const c = spawn(cmd, args, Object.assign({ windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }, o || {}));
      let tail = ''; const keep = (b) => { tail = (tail + b).slice(-2000); };
      c.stdout.on('data', keep); c.stderr.on('data', keep);
      c.on('error', (e) => reject(e));
      c.on('exit', (code) => code === 0 ? resolve(tail) : reject(new Error(cmd + ' failed (' + code + '): ' + tail.trim().split(/\r?\n/).slice(-3).join(' | '))));
    });
  }
  function which(cmd) {
    return run(process.platform === 'win32' ? 'where' : 'which', [cmd]).then(() => true, () => false);
  }
  function walk(root, depth) {   // all files below root (the unpack / build folders, so nothing is skipped here)
    const out = []; if (depth < 0) return out;
    let items = []; try { items = fs.readdirSync(root, { withFileTypes: true }); } catch (e) { return out; }
    for (const it of items) { const p = path.join(root, it.name); if (it.isDirectory()) out.push(...walk(p, depth - 1)); else out.push(p); }
    return out;
  }
  function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) {} }

  // ---------- which release? ----------
  // Returns the list of places the Windows zip may come from, best first: real releases that have it, then the pinned ones.
  async function windowsCandidates() {
    const want = process.arch === 'ia32' ? 'whisper-bin-Win32.zip' : 'whisper-bin-x64.zip';
    const out = [], seen = new Set();
    const add = (tag, name, url) => { if (url && !seen.has(url)) { seen.add(url); out.push({ tag, name, url }); } };
    try {
      const list = await getJson('https://api.github.com/repos/' + REPO + '/releases?per_page=30');
      for (const r of Array.isArray(list) ? list : []) {
        if (!r || r.draft || r.prerelease) continue;
        const assets = Array.isArray(r.assets) ? r.assets : [];
        const a = assets.find((x) => x.name === want) || assets.find((x) => /^whisper.*bin.*\.zip$/i.test(x.name) && /x64|win/i.test(x.name) && !WIN_ASSET_BAD.test(x.name) && (process.arch === 'ia32' ? /win32/i.test(x.name) : !/win32/i.test(x.name)));
        if (a) add(r.tag_name, a.name, a.browser_download_url);
      }
    } catch (e) { log('release list lookup failed: ' + (e && e.message)); }
    for (const tag of PINNED_TAGS) add(tag, want, 'https://github.com/' + REPO + '/releases/download/' + tag + '/' + want);
    return out;
  }
  // Windows reports a missing system DLL (Visual C++ runtime) with these exit codes; everything else from "-h" is fine.
  async function smokeTest(exe) {
    try { await run(exe, ['-h'], { cwd: path.dirname(exe), timeout: 8000 }); return ''; }
    catch (e) {
      const m = String(e && e.message || e);
      if (/3221225781|3221225595|3221225785|c0000135|c000007b/i.test(m)) return 'Windows says a system file is missing for whisper (the "Visual C++ Redistributable 2015-2022 x64" from microsoft.com). Install it and restart PRESENTER.';
      return '';
    }
  }

  // ---------- program: Windows ----------
  async function installWindows() {
    const cands = await windowsCandidates();
    let used = null, zip = '', lastErr = '';
    for (let i = 0; i < cands.length; i++) {
      const c = cands[i];
      zip = path.join(dir, '_download', c.name);
      set({ step: 'program', pct: 0, message: 'Downloading whisper.cpp ' + c.tag + '…' });
      try {
        await download(c.url, zip, (pct) => set({ step: 'program', pct, message: 'Downloading whisper.cpp ' + c.tag + '… ' + pct + '%' }), 1e6);
        used = c; break;
      } catch (e) { lastErr = String(e && e.message || e); log('whisper program ' + c.tag + ' failed: ' + lastErr); if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|timed out|certificate/i.test(lastErr)) break; }   // offline: more tries will not help
    }
    if (!used) throw new Error('Could not download the whisper.cpp program (' + (lastErr || 'no release found') + ').');
    set({ step: 'program', pct: 100, message: 'Unpacking whisper.cpp…' });
    const tmp = path.join(dir, '_unpack'); rmrf(tmp); fs.mkdirSync(tmp, { recursive: true });
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      "Expand-Archive -LiteralPath '" + zip.replace(/'/g, "''") + "' -DestinationPath '" + tmp.replace(/'/g, "''") + "' -Force"]);
    // the zip holds a "Release" folder with the programs and their .dll files: copy that folder's whole content
    const all = walk(tmp, 4);
    const anchor = all.find((f) => SERVER_NAMES.includes(path.basename(f))) || all.find((f) => CLI_NAMES.includes(path.basename(f)));
    if (!anchor) throw new Error('The whisper.cpp download did not contain whisper-server' + EXE + ' or whisper-cli' + EXE + '.');
    const from = path.dirname(anchor);
    rmrf(binDir); fs.mkdirSync(binDir, { recursive: true });
    for (const f of fs.readdirSync(from)) { const s = path.join(from, f); if (exists(s)) fs.copyFileSync(s, path.join(binDir, f)); }
    rmrf(tmp); rmrf(path.join(dir, '_download'));
    return { tag: used.tag, how: 'prebuilt' };
  }

  // ---------- program: macOS / Linux (build from source) ----------
  async function installFromSource() {
    const need = [];
    if (!(await which('cmake'))) need.push('cmake');
    if (!(await which('cc')) && !(await which('gcc')) && !(await which('clang'))) need.push(process.platform === 'darwin' ? 'Xcode command-line tools (run: xcode-select --install)' : 'a C/C++ compiler (build-essential)');
    if (need.length) throw new Error('whisper.cpp must be compiled once on this system. Please install ' + need.join(' and ') + ', then restart PRESENTER.');
    const rel = await pickRelease();
    const tgz = path.join(dir, '_download', 'whisper.cpp-' + rel.tag + '.tar.gz');
    set({ step: 'program', pct: 0, message: 'Downloading whisper.cpp ' + rel.tag + ' source…' });
    await download('https://github.com/' + REPO + '/archive/refs/tags/' + rel.tag + '.tar.gz', tgz, (pct) => set({ step: 'program', pct, message: 'Downloading whisper.cpp source… ' + pct + '%' }), 1e5);
    const src = path.join(dir, '_src'); rmrf(src); fs.mkdirSync(src, { recursive: true });
    await run('tar', ['-xzf', tgz, '-C', src, '--strip-components=1']);
    const jobs = String(Math.max(1, Math.min(4, os.cpus().length - 1)));
    set({ step: 'build', pct: 0, message: 'Compiling whisper.cpp (one time, a few minutes)…' });
    await run('cmake', ['-B', 'build', '-DCMAKE_BUILD_TYPE=Release', '-DBUILD_SHARED_LIBS=OFF', '-DWHISPER_BUILD_EXAMPLES=ON', '-DWHISPER_BUILD_TESTS=OFF'], { cwd: src });
    await run('cmake', ['--build', 'build', '--config', 'Release', '-j', jobs, '--target', 'whisper-server', 'whisper-cli'], { cwd: src });
    rmrf(binDir); fs.mkdirSync(binDir, { recursive: true });
    const built = walk(path.join(src, 'build'), 5).filter((f) => [...SERVER_NAMES, ...CLI_NAMES].includes(path.basename(f)));
    if (!built.length) throw new Error('The build finished but no whisper program was produced.');
    built.forEach((f) => { const d = path.join(binDir, path.basename(f)); fs.copyFileSync(f, d); try { fs.chmodSync(d, 0o755); } catch (e) {} });
    rmrf(src); rmrf(path.join(dir, '_download'));
    return { tag: rel.tag, how: 'source' };
  }

  // ---------- model ----------
  async function installModel(name) {
    const dest = path.join(modelsDir, 'ggml-' + name + '.bin');
    const urls = MODEL_URLS(name); let lastErr = '';
    for (let i = 0; i < urls.length; i++) {
      set({ step: 'model', pct: 0, message: 'Downloading the "' + name + '" speech model…' + (i ? ' (mirror)' : '') });
      try {
        await download(urls[i], dest, (pct, got, total) => set({ step: 'model', pct, message: 'Downloading the "' + name + '" speech model… ' + pct + '%' + (total ? ' (' + Math.round(got / 1048576) + ' / ' + Math.round(total / 1048576) + ' MB)' : '') }), MODEL_MIN[name] || 20e6);
        return;
      } catch (e) { lastErr = String(e && e.message || e); log('model download from ' + urls[i] + ' failed: ' + lastErr); }
    }
    throw new Error('Could not download the "' + name + '" model (' + lastErr + ').');
  }

  // ---------- public ----------
  // cfg: the speech config (model, modelPath, binaryPath). Resolves { ok, ... }; never rejects. Concurrent calls share one run.
  function ensure(cfg) {
    if (running) return running;
    running = (async () => {
      cfg = cfg || {};
      let info = inspect(cfg);
      if (info.ready) { set({ state: 'ready', step: '', pct: 100, message: 'Speech engine ready', error: '' }); return { ok: true, info, changed: false }; }
      fs.mkdirSync(dir, { recursive: true }); ensureLayout();
      set({ state: 'installing', step: 'check', pct: 0, message: 'Checking the speech engine…', error: '' });
      let changed = false;
      try {
        if (!info.binary) {
          const r = process.platform === 'win32' ? await installWindows() : await installFromSource();
          try { fs.writeFileSync(marker, JSON.stringify({ tag: r.tag, how: r.how, at: new Date().toISOString() })); } catch (e) {}
          changed = true; info = inspect(cfg);
          if (!info.binary) throw new Error('Setup finished but the whisper program could not be found.');
          const warn = await smokeTest(info.binary); if (warn) throw new Error(warn);
        }
        if (!info.model) {
          const name = /^[a-z0-9._-]{2,24}$/i.test(String(cfg.model || '')) ? String(cfg.model) : 'tiny';
          if (cfg.modelPath && !exists(cfg.modelPath)) log('configured modelPath not found, downloading ' + name + ' instead');
          await installModel(name); changed = true; info = inspect(cfg);
          if (!info.model) throw new Error('The model download finished but the file is not valid.');
        }
        set({ state: 'ready', step: '', pct: 100, message: 'Speech engine ready', error: '' });
        return { ok: true, info, changed };
      } catch (e) {
        const msg = String(e && e.message || e);
        const offline = /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|timed out|certificate/i.test(msg);
        const help = loc.manualHelp(ctx, EXE);
        set({ state: 'error', step: '', pct: 0, message: '', error: (offline ? 'No internet connection, so the speech engine could not be downloaded. It will be tried again when PRESENTER starts, or press Retry. ' : msg + ' ') + help });
        log('whisper setup failed: ' + msg);
        return { ok: false, error: state.error, info: inspect(cfg) };
      }
    })().finally(() => { running = null; });
    return running;
  }

  return { ensure, inspect, ensureLayout, state: () => Object.assign({}, state), dir, binDir, modelsDir, isRunning: () => !!running };
}

module.exports = { createSetup, MODEL_URL, MODEL_URLS };
