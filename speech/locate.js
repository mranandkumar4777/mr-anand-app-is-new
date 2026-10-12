'use strict';
// ONE place that knows where whisper.cpp's program and model files may live. Both setup.js (download/installer) and whisper.js
// (the thing that runs it) use it, so "installed" always means the same thing in both.
//
// Searched, in this order:
//   1. a path set in the Captions panel (binaryPath / modelPath)
//   2. <app data>\whisper\bin  and  <app data>\whisper            (what the automatic installer fills; Windows: %APPDATA%\Presenter\whisper)
//   3. <project folder>\whisper\bin  /  \models                    (manual install inside the project: dev builds)
//   4. <folder of PRESENTER.exe>\whisper\bin  /  \models           (manual install next to the installed app)
//   5. <resources>\whisper\...                                      (bundled with the installer, if ever added)
// A program that was unzipped one folder too deep (e.g. whisper\bin\Release\whisper-cli.exe) is still found.
const fs = require('fs');
const path = require('path');

const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch (e) { return false; } };

// Smallest believable size (bytes) per model: a truncated download is rejected. Unknown names only need to be > 20 MB.
const MODEL_MIN = { tiny: 70e6, 'tiny.en': 70e6, base: 135e6, 'base.en': 135e6, small: 440e6, 'small.en': 440e6, medium: 1.4e9, 'medium.en': 1.4e9 };
const NOT_A_SPEECH_MODEL = /silero|vad|encoder|openvino|coreml/i;

function whisperRoots(ctx) {
  const out = [];
  const add = (p) => { if (p && !out.includes(p)) out.push(p); };
  const base = (b) => { add(path.join(b, 'bin')); add(b); add(path.join(b, 'Release')); add(path.join(b, 'build', 'bin')); };
  base(path.join(ctx.dataDir, 'whisper'));
  if (ctx.appDir) base(path.join(ctx.appDir, 'whisper'));
  try { base(path.join(path.dirname(process.execPath), 'whisper')); } catch (e) {}
  if (process.resourcesPath) base(path.join(process.resourcesPath, 'whisper'));
  return out;
}
function modelDirs(ctx) {
  const out = [];
  const add = (p) => { if (p && !out.includes(p)) out.push(p); };
  const base = (b) => { add(path.join(b, 'models')); add(b); };
  base(path.join(ctx.dataDir, 'whisper'));
  if (ctx.appDir) base(path.join(ctx.appDir, 'whisper'));
  try { base(path.join(path.dirname(process.execPath), 'whisper')); } catch (e) {}
  if (process.resourcesPath) base(path.join(process.resourcesPath, 'whisper'));
  return out;
}

function walkFiles(root, depth) {
  const out = []; if (depth < 0) return out;
  let items = []; try { items = fs.readdirSync(root, { withFileTypes: true }); } catch (e) { return out; }
  for (const it of items) {
    const p = path.join(root, it.name);
    if (it.isDirectory()) { if (!/^(models|_download|_unpack|_src)$/i.test(it.name)) out.push(...walkFiles(p, depth - 1)); } else out.push(p);
  }
  return out;
}

// names: e.g. ['whisper-server.exe','server.exe']. custom: the Captions-panel path (a file, or the folder that holds it).
function findProgram(names, custom, ctx) {
  const lc = names.map((n) => n.toLowerCase());
  if (custom) {
    if (isFile(custom)) return custom;
    const d = isDir(custom) ? custom : path.dirname(custom);
    for (const n of names) if (isFile(path.join(d, n))) return path.join(d, n);
    const deep = walkFiles(d, 2).find((f) => lc.includes(path.basename(f).toLowerCase())); if (deep) return deep;
  }
  const roots = whisperRoots(ctx);
  for (const r of roots) for (const n of names) if (isFile(path.join(r, n))) return path.join(r, n);
  for (const r of [path.join(ctx.dataDir, 'whisper'), ctx.appDir && path.join(ctx.appDir, 'whisper')].filter(Boolean)) {
    const deep = walkFiles(r, 3).find((f) => lc.includes(path.basename(f).toLowerCase())); if (deep) return deep;
  }
  return '';
}

function modelComplete(p, name) {
  try { return fs.statSync(p).size >= (MODEL_MIN[name] || 20e6); } catch (e) { return false; }
}
// Every speech model found in the model folders: [{ file, name, size }]
function listModels(ctx) {
  const out = [];
  for (const d of modelDirs(ctx)) {
    let items = []; try { items = fs.readdirSync(d); } catch (e) { continue; }
    for (const f of items) {
      const m = /^ggml-(.+)\.bin$/i.exec(f); if (!m || NOT_A_SPEECH_MODEL.test(f)) continue;
      const file = path.join(d, f); if (!isFile(file) || out.some((o) => o.file === file)) continue;
      if (modelComplete(file, m[1])) out.push({ file, name: m[1], size: fs.statSync(file).size });
    }
  }
  return out;
}
// The wanted model if present; otherwise (so the app still works) the biggest complete model the user put there by hand.
function findModel(cfg, ctx) {
  cfg = cfg || {};
  if (cfg.modelPath && isFile(cfg.modelPath)) return { file: cfg.modelPath, name: path.basename(cfg.modelPath), exact: true };
  const all = listModels(ctx), want = cfg.model || 'tiny';
  const hit = all.find((m) => m.name === want);
  if (hit) return Object.assign({ exact: true }, hit);
  if (all.length) { const big = all.slice().sort((a, b) => b.size - a.size)[0]; return Object.assign({ exact: false }, big); }
  return null;
}

// What the person should do by hand, shown in errors and written next to the files.
function manualHelp(ctx, exe) {
  const bin = path.join(ctx.dataDir, 'whisper', 'bin'), models = path.join(ctx.dataDir, 'whisper', 'models');
  return 'Manual install: put ' + ['whisper-cli' + exe, 'whisper-server' + exe].join(' / ') + ' (and its .dll files) in "' + bin + '" and ggml-tiny.bin in "' + models + '". Details: README-MANUAL-INSTALL.txt in "' + path.join(ctx.dataDir, 'whisper') + '".';
}
function manualReadme(ctx, exe) {
  const bin = path.join(ctx.dataDir, 'whisper', 'bin'), models = path.join(ctx.dataDir, 'whisper', 'models');
  return [
    'PRESENTER - manual Whisper install',
    '==================================',
    '',
    'PRESENTER normally downloads these two things by itself. If that fails (no internet, a blocked site, antivirus), do this once by hand:',
    '',
    '1) The program',
    '   Open  https://github.com/ggml-org/whisper.cpp/releases  in a browser.',
    '   Choose a release that lists  whisper-bin-x64.zip  under Assets (v1.9.2 does). The very newest release can be source-code only.',
    '   Download whisper-bin-x64.zip, unzip it, and copy ALL files from inside (the .exe and .dll files) into:',
    '      ' + bin,
    '   You should end up with  ' + path.join(bin, 'whisper-cli' + exe) + '  (and/or whisper-server' + exe + ').',
    '',
    '2) The model',
    '   Download  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin?download=true  (about 75 MB)',
    '   and save it as ggml-tiny.bin in:',
    '      ' + models,
    '   (Telugu works much better with ggml-small.bin, about 466 MB, same address with  small  instead of  tiny.)',
    '',
    '3) Restart PRESENTER, open Captions and press Start listening.',
    '',
    'Alternative places that are also searched: a "whisper" folder next to PRESENTER.exe (with bin and models inside), or the path you type into the Captions panel.',
    'If whisper-cli' + exe + ' starts and immediately closes, install the Microsoft "Visual C++ Redistributable 2015-2022 (x64)" from microsoft.com and try again.',
    ''
  ].join('\r\n');
}

module.exports = { isFile, isDir, MODEL_MIN, whisperRoots, modelDirs, walkFiles, findProgram, findModel, listModels, modelComplete, manualHelp, manualReadme };
