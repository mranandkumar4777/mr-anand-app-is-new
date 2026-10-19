'use strict';
// PRESENTER desktop app (Electron main process).
// - starts the helper server (pages, phone remote, PIN) inside the app
// - opens the Control window; Live / Preview windows are opened by the page itself
// - "Check for Updates" reads a small JSON file published on GitHub Releases
// - AI API keys (Gemini / OpenRouter, several each) are stored encrypted by the operating system (safeStorage)
const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, session, desktopCapturer } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const server = require('./server');
// The app is called PRESENTER, but its data folder keeps the original name "Presenter" so existing installs keep their saved keys,
// workspaces, bibles and the downloaded speech model. (Do not remove this line unless you also migrate that folder.)
app.setPath('userData', path.join(app.getPath('appData'), 'Presenter'));
// Troubleshooting switch for a Live window that stays black / white instead of transparent (some Windows graphics drivers):
// create an empty file called  disable-gpu  in the Presenter data folder (%APPDATA%\Presenter), or start with PRESENTER_DISABLE_GPU=1.
// Must run before the app is ready, so it lives here. Normal installs do not need it.
try { if (process.env.PRESENTER_DISABLE_GPU === '1' || fs.existsSync(path.join(app.getPath('userData'), 'disable-gpu'))) app.disableHardwareAcceleration(); } catch (e) {}
let autoUpdater = null;
try { ({ autoUpdater } = require('electron-updater')); } catch (e) { /* not installed: falls back to the manual checker below */ }

// ---------------------------------------------------------------------------------------------
// Settings you may want to change
// ---------------------------------------------------------------------------------------------
const { createAiHub, parseModelList, parseKeys, parseProviderLines } = require('./ai-hub');   // Gemini + OpenRouter + OpenAI-compatible providers, key rotation, retries, model/provider fallback
const UPDATE_CHECK_TIMEOUT_MS = 10000;
const WINDOW_DEFAULT = { width: 1280, height: 800 };
const UPDATE_INFO_URL = 'https://github.com/mranandkumar4777/p1-app-pc/releases/download/desktop-latest/desktop-version.json';
const RELEASES_PAGE = 'https://github.com/mranandkumar4777/p1-app-pc/releases';

let mainWindow = null;
let serverInfo = null;
let bgMode = 'dark';          // 'dark' | 'transparent' (Live window background)
const liveWins = new Set();   // the open Live windows (so mode changes reach windows that already exist)
let checking = false;

// ---------------------------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------------------------
function createMainWindow() {
  mainWindow = new BrowserWindow(Object.assign({}, WINDOW_DEFAULT, {
    backgroundColor: '#0b1220',
    title: 'PRESENTER',
    autoHideMenuBar: true,
    // backgroundThrottling off: the Control window keeps streaming the OBS camera to the Stage Display even when it is covered / minimised
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false }
  }));
  mainWindow.loadURL('http://localhost:' + serverInfo.port + '/');
  mainWindow.on('closed', () => { mainWindow = null; });

  // Live / Preview windows are opened by the page with window.open(...?mode=display|preview)
  // Every Live window that opens: make sure it is really see-through, keep it on top in Transparent mode, and forget it when it closes.
  mainWindow.webContents.on('did-create-window', (win, details) => {
    let live = false; try { live = new URL(details.url).searchParams.get('mode') === 'display'; } catch (e) {}
    if (!live) return;
    liveWins.add(win);
    try { win.setBackgroundColor('#00000000'); } catch (e) {}
    applyLiveMode(win);
    win.on('closed', () => liveWins.delete(win));
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    let u; try { u = new URL(url); } catch (e) { return { action: 'deny' }; }
    if (u.origin === 'http://localhost:' + serverInfo.port) {
      const live = u.searchParams.get('mode') === 'display';
      // backgroundThrottling OFF: a Live window that is covered, behind OBS, or on a second screen must keep painting new lyrics / captions
      // (with throttling on, Chromium pauses a window it thinks is hidden, and the audience sees stale text).
      const web = { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false };
      // Live window: ALWAYS created transparent + frameless (Electron cannot change this after creation).
      // The page paints it black in "Dark" mode and leaves it clear in "Transparent" mode, so OBS
      // Window Capture sees real transparency (use the "Windows 10 (1903 and up)" capture method).
      const liveOpts = { transparent: true, frame: false, backgroundColor: '#00000000', hasShadow: false, alwaysOnTop: bgMode === 'transparent' };
      return {
        action: 'allow',
        overrideBrowserWindowOptions: Object.assign({ autoHideMenuBar: true, backgroundColor: '#000000', webPreferences: web }, live ? liveOpts : {})
      };
    }
    if (/^https?:$/.test(u.protocol)) shell.openExternal(url);   // e.g. the Google search link
    return { action: 'deny' };
  });
}

// Transparent mode keeps the Live window above other programs (so the lyrics float over the slides / video); Dark mode is a normal window.
function applyLiveMode(win) {
  if (!win || win.isDestroyed()) return;
  try { win.setAlwaysOnTop(bgMode === 'transparent', 'screen-saver'); } catch (e) {}
}

// ---------------------------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------------------------
const UPDATE_RECHECK_MS = 4 * 60 * 60 * 1000;   // look again every 4 hours while the app stays open
// Small log file so "why did it not update?" can be answered:  %APPDATA%\Presenter\update.log
function updLog(msg) {
  try { fs.appendFileSync(path.join(app.getPath('userData'), 'update.log'), new Date().toISOString() + '  ' + msg + '\n'); } catch (e) {}
}
function cmpVersions(a, b) {
  const pa = String(a).replace(/^v/, '').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d > 0 ? 1 : -1; }
  return 0;
}
function downloadUrlFor(info) {
  if (process.platform === 'win32') return info.windows;
  if (process.platform === 'darwin') return process.arch === 'arm64' ? info.mac_arm64 : info.mac_x64;
  return info.url || RELEASES_PAGE;
}
// Manual / fallback checker: reads desktop-version.json and offers the download link.
//   opts.silent = true  -> say nothing when up to date or offline (used for the automatic checks)
let promptedFor = '';   // the version we already asked about in this session (so "Later" is not nagged every 4 hours)
async function checkForUpdates(opts) {
  const silent = !!(opts && opts.silent);
  const current = app.getVersion();
  if (checking) return { status: 'busy', current };
  checking = true;
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), UPDATE_CHECK_TIMEOUT_MS);
    let r; try { r = await fetch(UPDATE_INFO_URL + '?t=' + Date.now(), { signal: ctl.signal, cache: 'no-store', redirect: 'follow' }); } finally { clearTimeout(t); }
    if (!r.ok) { updLog('manual check: HTTP ' + r.status); return { status: 'error', current, error: 'The update file was not found yet (HTTP ' + r.status + ').' }; }
    const info = await r.json();
    const latest = String(info.version || '').trim();
    if (!latest) return { status: 'error', current, error: 'The update file has no version.' };
    updLog('manual check: installed ' + current + ', published ' + latest);
    if (cmpVersions(latest, current) <= 0) return { status: 'uptodate', current, latest };
    if (silent && promptedFor === latest) return { status: 'dismissed', current, latest };
    promptedFor = latest;
    const parent = (mainWindow && !mainWindow.isDestroyed()) ? mainWindow : undefined;
    const choice = await dialog.showMessageBox(parent, {
      type: 'info', buttons: ['Download', 'Later'], defaultId: 0, cancelId: 1,
      title: 'Update available',
      message: 'PRESENTER ' + latest + ' is available (you have ' + current + ').',
      detail: info.notes ? String(info.notes).slice(0, 500) : ''
    });
    if (choice.response === 0) { shell.openExternal(downloadUrlFor(info) || RELEASES_PAGE); return { status: 'available', current, latest }; }
    return { status: 'dismissed', current, latest };
  } catch (e) {
    updLog('manual check failed: ' + (e && e.message || e));
    return { status: 'error', current, error: e && e.name === 'AbortError' ? 'Timed out.' : 'No internet connection?' };
  } finally { checking = false; }
}

// ---------------------------------------------------------------------------------------------
// Automatic updates (electron-updater) - Windows installer builds
// ---------------------------------------------------------------------------------------------
const AUTO_UPDATE = !!autoUpdater && app.isPackaged && process.platform === 'win32';
let updateState = { status: 'idle' };
let fallbackDone = false;
function sendUpdate(s) { updateState = s; if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('presenter:updateStatus', s); }
function fallbackToManual() {
  if (fallbackDone) return; fallbackDone = true;
  checkForUpdates({ silent: true }).then((r) => updLog('fallback result: ' + r.status)).catch(() => {});
}
function setupAutoUpdater() {
  autoUpdater.logger = { info: (m) => updLog('updater: ' + m), warn: (m) => updLog('updater WARN: ' + m), error: (m) => updLog('updater ERROR: ' + m), debug: () => {} };
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowDowngrade = false;
  autoUpdater.on('checking-for-update', () => sendUpdate({ status: 'checking' }));
  autoUpdater.on('update-available', (i) => sendUpdate({ status: 'downloading', latest: i.version, percent: 0 }));
  autoUpdater.on('update-not-available', (i) => sendUpdate({ status: 'uptodate', current: app.getVersion(), latest: i && i.version }));
  autoUpdater.on('download-progress', (p) => sendUpdate({ status: 'downloading', latest: updateState.latest, percent: Math.round(p.percent || 0) }));
  autoUpdater.on('error', (e) => { sendUpdate({ status: 'error', error: String(e && e.message || e).slice(0, 200) }); fallbackToManual(); });
  autoUpdater.on('update-downloaded', async (i) => {
    sendUpdate({ status: 'ready', latest: i.version });
    const choice = await dialog.showMessageBox((mainWindow && !mainWindow.isDestroyed()) ? mainWindow : undefined, {
      type: 'info', buttons: ['Update Now', 'Later'], defaultId: 0, cancelId: 1,
      title: 'Update ready',
      message: 'PRESENTER ' + i.version + ' has been downloaded.',
      detail: 'Update Now restarts PRESENTER and installs it. If you choose Later, it installs the next time you close PRESENTER.'
    });
    if (choice.response === 0) setImmediate(() => autoUpdater.quitAndInstall(true, true));
  });
}
async function autoCheck() {
  if (updateState.status === 'downloading' || updateState.status === 'ready') return;
  try { await autoUpdater.checkForUpdates(); } catch (e) { updLog('autoCheck failed: ' + (e && e.message || e)); fallbackToManual(); }
}
function startUpdateChecks() {
  updLog('start: version ' + app.getVersion() + ', packaged=' + app.isPackaged + ', platform=' + process.platform + ', auto=' + AUTO_UPDATE);
  if (AUTO_UPDATE) setupAutoUpdater();
  const tick = () => { if (AUTO_UPDATE) autoCheck(); else checkForUpdates({ silent: true }); };
  setTimeout(tick, 5000);
  const iv = setInterval(tick, UPDATE_RECHECK_MS); if (iv.unref) iv.unref();
}

// ---------------------------------------------------------------------------------------------
// Gemini API key (encrypted with the OS keychain when available) + AI helpers
// ---------------------------------------------------------------------------------------------
const cfgFile = () => path.join(app.getPath('userData'), 'ai-config.bin');
const legacyKeyFile = () => path.join(app.getPath('userData'), 'gemini.key');
function decode(raw) {
  if (raw[0] === 0x45 /* 'E' */) return safeStorage.decryptString(raw.subarray(1));
  return raw.subarray(1).toString('utf8');             // 'P' = stored without encryption
}
function encode(text) {
  if (safeStorage.isEncryptionAvailable()) return Buffer.concat([Buffer.from('E'), safeStorage.encryptString(text)]);
  return Buffer.concat([Buffer.from('P'), Buffer.from(text, 'utf8')]);
}
function loadAiConfig() {
  let c = {};
  try { c = JSON.parse(decode(fs.readFileSync(cfgFile()))) || {}; } catch (e) {}
  if (!c.geminiKeys) {                                  // one-time import of the old single Gemini key
    try { const k = decode(fs.readFileSync(legacyKeyFile())).trim(); if (k) c.geminiKeys = [k]; } catch (e) {}
  }
  c.geminiKeys = c.geminiKeys || []; c.openrouterKeys = c.openrouterKeys || []; c.models = c.models || [];
  return c;
}
function saveAiConfig(c) { fs.writeFileSync(cfgFile(), encode(JSON.stringify(c))); }

const aiHub = createAiHub({ load: loadAiConfig, save: saveAiConfig });
function keyStatus() {
  const s = aiHub.status();
  return { has: s.has, last4: (s.last4.gemini[0] || s.last4.openrouter[0] || ''), geminiKeys: s.geminiKeys, openrouterKeys: s.openrouterKeys,
           models: s.models, modelsText: s.models.map((m) => m.provider + ':' + m.model).join('\n'), providers: s.providers, providersText: aiHub.providersText(),
           defaultModels: s.defaultModels, verify: s.verify, encrypted: safeStorage.isEncryptionAvailable() };
}
function setAiConfig(patch) {
  const c = loadAiConfig();
  if (patch.geminiKeys !== undefined) c.geminiKeys = parseKeys(patch.geminiKeys);
  if (patch.openrouterKeys !== undefined) c.openrouterKeys = parseKeys(patch.openrouterKeys);
  let errors = [];
  if (patch.providers !== undefined) {
    const r = parseProviderLines(String(patch.providers), c.providers || {});
    c.providers = r.providers; errors = r.errors;
  }
  if (typeof patch.fallbackToDefaults === 'boolean') c.fallbackToDefaults = patch.fallbackToDefaults;
  if (typeof patch.verify === 'boolean') c.verify = patch.verify;
  if (patch.models !== undefined) {
    const names = Object.keys(c.providers || {});
    c.models = parseModelList(String(patch.models), names);
  }
  saveAiConfig(c);
  try { fs.unlinkSync(legacyKeyFile()); } catch (e) {}
  return errors.length ? { ok: true, warnings: errors } : { ok: true };
}

const aiLyrics = (query, ctx) => aiHub.lyricsSlides(query, ctx);
const aiIdentify = (audio, ctx) => aiHub.identify(typeof audio === 'string' ? { base64: audio, mime: 'audio/wav' } : audio, ctx);
async function aiDetect(wavB64, ctx) {
  const r = await aiIdentify(wavB64, { hint: ctx && ctx.recentTranscript });
  if (!r.ok) return r;
  return { ok: true, isSong: r.isSong, title: r.best.title, artist: r.best.artist, confidence: r.best.confidence, transcript: r.transcript, similar: r.similar, verified: r.best.verified };
}

ipcMain.handle('presenter:tailscaleStatus', () => {
  const addresses = [];
  const ifs = os.networkInterfaces();
  Object.keys(ifs).forEach((k) => (ifs[k] || []).forEach((a) => {
    if (a.family === 'IPv4' && !a.internal) { const p = a.address.split('.').map(Number); if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) addresses.push(a.address); }
  }));
  return { online: addresses.length > 0, addresses };
});
ipcMain.handle('presenter:getVersion', () => app.getVersion());

ipcMain.handle('presenter:checkForUpdates', async () => {
  if (!AUTO_UPDATE) return checkForUpdates();                       // Mac / dev run: manual flow (with popup)
  if (updateState.status === 'downloading' || updateState.status === 'checking') return { status: 'busy', current: app.getVersion(), latest: updateState.latest };
  if (updateState.status === 'ready') { autoUpdater.quitAndInstall(true, true); return { status: 'ready', current: app.getVersion(), latest: updateState.latest }; }
  try {
    const r = await autoUpdater.checkForUpdates();
    const latest = r && r.updateInfo && r.updateInfo.version;
    if (!latest || cmpVersions(latest, app.getVersion()) <= 0) return { status: 'uptodate', current: app.getVersion(), latest };
    return { status: 'downloading', current: app.getVersion(), latest };
  } catch (e) {
    updLog('button check failed: ' + (e && e.message || e));
    return checkForUpdates();                                        // automatic path failed: use the download-popup path instead
  }
});

ipcMain.handle('presenter:setBgMode', (_e, mode) => { bgMode = mode === 'transparent' ? 'transparent' : 'dark'; liveWins.forEach(applyLiveMode); return true; });
ipcMain.handle('presenter:setClickThrough', (e, on) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win || win === mainWindow || !liveWins.has(win)) return false;
  try { win.setIgnoreMouseEvents(!!on, { forward: true }); return true; } catch (err) { return false; }
});
ipcMain.handle('presenter:ai:keyStatus', () => keyStatus());
ipcMain.handle('presenter:ai:setKey', (_e, k) => { try { return setAiConfig({ geminiKeys: String(k || '') }); } catch (e) { return { ok: false, error: 'Could not store the key.' }; } });
ipcMain.handle('presenter:ai:setConfig', (_e, p) => { try { return setAiConfig(p || {}); } catch (e) { return { ok: false, error: 'Could not store the settings.' }; } });
ipcMain.handle('presenter:ai:identify', (_e, audio, c) => aiIdentify(audio, c));
ipcMain.handle('presenter:ai:lyrics', (_e, q, c) => aiLyrics(q, c));
ipcMain.handle('presenter:ai:formatLyrics', (_e, text, c) => aiHub.formatLyrics(String(text || '').slice(0, 20000), c || {}));
ipcMain.handle('presenter:ai:detect', (_e, wav, c) => aiDetect(wav, c));
ipcMain.handle('presenter:ai:listModels', (_e, provider, o) => aiHub.listModels(String(provider || ''), { audioOnly: !!(o && o.audioOnly), force: !!(o && o.force), limit: 300 }));
ipcMain.handle('presenter:ai:test', (_e, provider, model) => aiHub.test(String(provider || ''), String(model || '')));

// ---------------------------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); }
else {
  app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); } });
  app.whenReady().then(async () => {
    session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => cb(permission === 'media' && /^http:\/\/localhost:/.test(wc.getURL())));
    session.defaultSession.setDisplayMediaRequestHandler((request, cb) => {
      const f = request && request.frame, local = f && /^http:\/\/localhost:/.test(f.url || '');
      if (!local) return cb({});
      desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
        .then((src) => { if (!src.length) return cb({}); const r = { video: src[0] }; if (process.platform === 'win32') r.audio = 'loopback'; cb(r); })
        .catch(() => cb({}));
    });
    serverInfo = await server.start({ dataDir: app.getPath('userData'), appDir: __dirname, ai: { identify: aiIdentify, lyrics: aiLyrics, translate: (t, to, from) => aiHub.translate(t, to, from) } });
    createMainWindow();
    startUpdateChecks();   // check shortly after launch, then every few hours
    app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createMainWindow(); });
  }).catch((e) => { dialog.showErrorBox('PRESENTER could not start', String(e && e.message || e)); app.quit(); });
  app.on('will-quit', () => { try { serverInfo && serverInfo.speech && serverInfo.speech.stop(); } catch (e) {} });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}