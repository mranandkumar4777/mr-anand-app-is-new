'use strict';
// PNG lower-third model: normalisation, older libraries, CSS variables. No browser needed.
const assert = require('assert');
const P = require('../public/ltpng.js');
const FILE = '/lt-assets/ltp_0123456789abcdef.png';
let n = 0; const t = (name, fn) => { fn(); n++; console.log('  ok   ' + name); };

t('rejects pictures that are not served PNGs', () => {
  assert.strictEqual(P.valid({ file: 'http://evil.example/x.png' }), null);
  assert.strictEqual(P.valid({ file: '/lt-assets/../../etc/passwd' }), null);
  assert.ok(P.valid({ file: FILE }));
  assert.ok(P.valid({ file: 'http://192.168.1.5:8787' + FILE }));
});
t('older library items (scale, texts, x/y) still load', () => {
  const it = P.normItem({ id: 'lp_a', file: FILE, name: 'Old', w: 1200, h: 200, x: 50, y: 84, scale: 60, opacity: 90, anim: 'zoom', texts: [{ text: 'Name' }] });
  assert.strictEqual(it.size, 60); assert.strictEqual(it.opacity, 90); assert.strictEqual(it.mode, 'grow'); assert.ok(!('texts' in it));
});
t('values are clamped', () => {
  const it = P.normItem({ file: FILE, size: 999, capX: -4, padY: 80, offX: 900, opacity: -5, mode: 'weird' });
  assert.strictEqual(it.size, 100); assert.strictEqual(it.capX, 0); assert.strictEqual(it.padY, 45); assert.strictEqual(it.offX, 50); assert.strictEqual(it.opacity, 0); assert.strictEqual(it.mode, 'grow');
});
t('auto edges keep round ends round', () => {
  assert.strictEqual(P.autoCaps(1200, 200).capX, 8);          // about half the height
  assert.strictEqual(P.autoCaps(400, 400).capX, 30);          // capped
  assert.strictEqual(P.autoCaps(0, 0).capX, 8);               // unknown size
});
t('css variables follow the size', () => {
  const a = P.cssVars({ file: FILE, w: 1000, h: 200, size: 40 }), b = P.cssVars({ file: FILE, w: 1000, h: 200, size: 80 });
  assert.strictEqual(a['--ltp-minw'], '40'); assert.strictEqual(a['--ltp-minh'], '8');
  assert.strictEqual(Number(b['--ltp-br']), 2 * Number(a['--ltp-br']));
  assert.ok(a['--ltp-img'].startsWith('url("')); assert.strictEqual(a['--ltp-ar'], '1000 / 200');
  P.VAR_KEYS.forEach(k => assert.ok(k in a, k));
});
t('text scale is 1 at the reference size', () => {
  assert.strictEqual(P.textScale({ file: FILE, size: P.REF_SIZE }), 1);
  assert.strictEqual(P.textScale({ file: FILE, size: 90 }), 2);
});
t('manual extra space adds to the text margins', () => {
  const a = P.cssVars({ file: FILE, w: 1000, h: 200, size: 40 }), b = P.cssVars({ file: FILE, w: 1000, h: 200, size: 40, extraX: 3, extraY: 2 });
  assert.ok(Math.abs(Number(b['--ltp-px']) - Number(a['--ltp-px']) - 3) < 0.01); assert.ok(Math.abs(Number(b['--ltp-py']) - Number(a['--ltp-py']) - 2) < 0.01);
  assert.strictEqual(P.normItem({ file: FILE, extraY: 99 }).extraY, 20);
});
console.log('\n' + n + ' PNG lower-third tests passed');
