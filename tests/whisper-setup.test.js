'use strict';
// Offline tests for the Whisper file finder and installer: no network (https is faked), no real downloads.
// Run: node tests/whisper-setup.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { EventEmitter } = require('events');
const { Readable } = require('stream');

let n = 0; const ok = (name) => { n++; console.log('  ok   ' + name); };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'p1-whisper-'));
const touch = (p, bytes) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, Buffer.alloc(bytes || 1, 1)); };
const EXE = process.platform === 'win32' ? '.exe' : '';

(async () => {
  const loc = require('../speech/locate');

  // ---- locate: program in bin, one folder too deep, and next to the app ----
  {
    const d = tmp(), ctx = { dataDir: d, appDir: path.join(d, 'app') };
    assert.strictEqual(loc.findProgram(['whisper-cli' + EXE], '', ctx), '');
    touch(path.join(d, 'whisper', 'bin', 'Release', 'whisper-cli' + EXE));
    assert.ok(loc.findProgram(['whisper-cli' + EXE], '', ctx).endsWith('whisper-cli' + EXE)); ok('finds a program unzipped one folder too deep');
    const d2 = tmp(), ctx2 = { dataDir: d2, appDir: path.join(d2, 'app') };
    touch(path.join(ctx2.appDir, 'whisper', 'bin', 'whisper-server' + EXE));
    assert.ok(loc.findProgram(['whisper-server' + EXE], '', ctx2)); ok('finds a program in <project>/whisper/bin');
    touch(path.join(d2, 'custom', 'whisper-cli' + EXE));
    assert.strictEqual(loc.findProgram(['whisper-cli' + EXE], path.join(d2, 'custom'), ctx2), path.join(d2, 'custom', 'whisper-cli' + EXE)); ok('accepts a folder as the custom program path');
  }
  // ---- locate: model exact / fallback / truncated ----
  {
    const d = tmp(), ctx = { dataDir: d, appDir: path.join(d, 'app') };
    touch(path.join(d, 'whisper', 'models', 'ggml-tiny.bin'), 1000);
    assert.strictEqual(loc.findModel({ model: 'tiny' }, ctx), null); ok('rejects a truncated model file');
    touch(path.join(d, 'whisper', 'models', 'ggml-tiny.bin'), 71e6);
    assert.strictEqual(loc.findModel({ model: 'tiny' }, ctx).exact, true); ok('finds the wanted model');
    const m = loc.findModel({ model: 'small' }, ctx);
    assert.ok(m && m.exact === false && m.name === 'tiny'); ok('falls back to another complete model the user put there');
    touch(path.join(d, 'whisper', 'models', 'ggml-silero-v5.bin'), 90e6);
    assert.ok(!loc.listModels(ctx).some((x) => /silero/.test(x.file))); ok('ignores VAD / non-speech models');
  }

  // ---- installer: a release with only source code must not stop the install (the real-world 404) ----
  {
    const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32' });
    delete require.cache[require.resolve('../speech/setup')];
    const { createSetup } = require('../speech/setup');
    const asked = [];
    const realGet = https.get;
    https.get = (url, o, cb) => {
      const u = String(url); asked.push(u);
      const rq = new EventEmitter(); rq.setTimeout = () => {}; rq.destroy = () => {};
      const reply = (code, body, headers) => { const r = Readable.from([body]); r.statusCode = code; r.headers = headers || {}; process.nextTick(() => cb(r)); };
      process.nextTick(() => {
        if (/api\.github\.com.*releases\?per_page/.test(u)) return reply(200, Buffer.from(JSON.stringify([
          { tag_name: 'v9.9.9', draft: false, prerelease: false, assets: [{ name: 'source.zip', browser_download_url: 'https://x/source.zip' }] },       // newest, but NO windows zip
          { tag_name: 'v9.9.0', draft: false, prerelease: true, assets: [{ name: 'whisper-bin-x64.zip', browser_download_url: 'https://x/pre.zip' }] },  // pre-release: skipped
          { tag_name: 'v9.8.0', draft: false, prerelease: false, assets: [{ name: 'whisper-bin-x64.zip', browser_download_url: 'https://github.com/ggml-org/whisper.cpp/releases/download/v9.8.0/whisper-bin-x64.zip' }, { name: 'whisper-cublas-12.4.0-bin-x64.zip', browser_download_url: 'https://x/cublas.zip' }] }
        ])));
        if (/v9\.8\.0\/whisper-bin-x64\.zip/.test(u)) return reply(404, Buffer.from('nf'));
        if (/v1\.9\.2\/whisper-bin-x64\.zip/.test(u)) return reply(200, Buffer.alloc(1.2e6, 1), { 'content-length': String(1.2e6) });   // pinned release works
        return reply(404, Buffer.from('nf'));
      });
      return rq;
    };
    const d = tmp();
    const setup = createSetup({ dataDir: d, appDir: path.join(d, 'app'), log: () => {} });
    const r = await setup.ensure({ model: 'tiny' });
    https.get = realGet; Object.defineProperty(process, 'platform', realPlatform);
    const prog = asked.filter((u) => /\.zip$/.test(u));
    assert.ok(!prog.some((u) => /x\/(source|pre|cublas)\.zip/.test(u)), 'must not pick source, pre-release or CUDA zips'); ok('never picks a source-only, pre-release or CUDA zip');
    assert.ok(/v9\.8\.0/.test(prog[0]), 'first try = newest release that really has the zip'); ok('tries the newest release that has the Windows zip first');
    assert.ok(prog.some((u) => /v1\.9\.2/.test(u)), '404 moves on to the pinned releases'); ok('a 404 moves on to the next candidate');
    assert.strictEqual(r.ok, false);   // (unpacking needs PowerShell, absent here) - but it got that far
    assert.ok(/Manual install/.test(r.error), 'error explains the manual install'); ok('failure message tells the person how to install by hand');
    assert.ok(fs.existsSync(path.join(d, 'whisper', 'README-MANUAL-INSTALL.txt')), 'readme written');
    assert.ok(fs.existsSync(path.join(d, 'whisper', 'bin')) && fs.existsSync(path.join(d, 'whisper', 'models'))); ok('creates bin/ models/ and a README so there is always a place to drop the files');
  }
  console.log('\nAll ' + n + ' whisper setup checks passed');
})().catch((e) => { console.error('FAILED:', e && e.stack || e); process.exit(1); });
