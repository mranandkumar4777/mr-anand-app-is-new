'use strict';
// External Stage Display: sessions, AIR gating of the OBS camera feed. Run: node tests/stage-air.server.test.js
const server = require('../server.js');
const http = require('http'), os = require('os'), fs = require('fs'), path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pres-'));
function req(method, port, p, body, headers) {
  return new Promise((res) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}) }, (x) => {
      const parts = []; x.on('data', (c) => parts.push(c)); x.on('end', () => res({ code: x.statusCode, body: Buffer.concat(parts).toString() }));
    });
    if (body) r.write(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)); r.end();
  });
}
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9, 0, 0]);
(async () => {
  const s = await server.start({ dataDir: dir, appDir: path.join(__dirname,'..'), port: 18700 + Math.floor(Math.random()*200), noSpeechSetup: true });
  const port = s.port, pin = s.getPin();
  let fail = 0; const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fail++; };
  // stage session
  const a = JSON.parse((await req('POST', port, '/api/auth', { mode: 'stage', device: 'tab1', name: 't', password: pin })).body);
  ok(a.ok && a.token, 'stage session created with PIN');
  const bad = await req('POST', port, '/api/auth', { mode: 'stage', device: 'tab1', password: '000000x' });
  ok(bad.code === 401, 'wrong PIN rejected');
  // /live page: no PIN leaked for a non-loopback style request is covered by servePage(local) - here loopback gets the PIN
  const live = await req('GET', port, '/live');
  ok(live.code === 200 && live.body.includes('id="extVideo"') && live.body.includes('__SERVER_PIN__'), '/live served (loopback gets PIN for OBS source)');
  // frame while AIR on -> viewers counted, then AIR off
  const state = (air) => ({ from: 'control', type: 'state', pin, live: { text: air ? 'hi' : '', blank: !air, air }, style: { obsRoute: true } });
  await req('POST', port, '/api/send', state(true));
  // open video stream as stage viewer
  let got = 0, ended = false;
  http.get({ host: '127.0.0.1', port, path: '/stage-video?token=' + a.token }, (x) => { x.on('data', () => { got++; }); x.on('end', () => { ended = true; }); x.on('close', () => { ended = true; }); });
  await new Promise((r2) => setTimeout(r2, 200));
  const f1 = JSON.parse((await req('POST', port, '/api/stage-video/frame', jpeg, { 'Content-Type': 'image/jpeg' })).body);
  ok(f1.ok && f1.viewers === 1, 'camera frame relayed to the stage viewer while AIR is ON');
  await new Promise((r2) => setTimeout(r2, 200));
  ok(got > 0, 'viewer actually received the frame');
  await req('POST', port, '/api/send', state(false));            // AIR OFF
  await new Promise((r2) => setTimeout(r2, 200));
  ok(ended, 'AIR OFF closes the external camera stream');
  const f2 = JSON.parse((await req('POST', port, '/api/stage-video/frame', jpeg, { 'Content-Type': 'image/jpeg' })).body);
  ok(f2.viewers === 0, 'frames are dropped while AIR is OFF (0 viewers)');
  // stage clients get live.air in the state replay
  const evt = await new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port, path: '/events?token=' + a.token }, (x) => { x.setEncoding('utf8'); x.on('data', (d) => { const m = /data: (.*)/.exec(d); if (m) { resolve(JSON.parse(m[1])); x.destroy(); } }); });
  });
  ok(evt.live && evt.live.air === false && evt.live.blank === true, 'stage client receives live.air=false + blank on connect');
  console.log(fail ? fail + ' failed' : 'all server checks passed'); process.exit(fail ? 1 : 0);
})();
