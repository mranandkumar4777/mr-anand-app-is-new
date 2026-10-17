'use strict';
// Transition engine: preset table, shared swap routine, duration/direction handling. Run: node tests/fx-presets.test.js
const fs = require('fs'), path = require('path'), vm = require('vm');
const calls = [];
function el(tag) {
  const e = { tag, style: {}, children: [], parentNode: null,
    getBoundingClientRect: () => ({ left: 10, top: 20, width: 500, height: 80, right: 510, bottom: 100 }),
    cloneNode() { return el('clone'); }, removeAttribute() {}, setAttribute() {},
    appendChild(c) { c.parentNode = e; e.children.push(c); return c; },
    animate(k, o) { calls.push({ tag, k, o }); return { finished: new Promise(() => {}), cancel() {} }; } };
  return e;
}
const doc = { hidden: false, createElement: () => el('div'), documentElement: el('html') };
const win = { matchMedia: () => ({ matches: false }), CSS: { supports: () => true } };
const ctx = { window: win, document: doc, Math, Object, Number, Promise, getComputedStyle: () => ({ getPropertyValue: () => '#ff0066' }), requestAnimationFrame() {} };
vm.createContext(ctx); win.window = win;
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'fx-presets.js'), 'utf8'), ctx);
const PFX = win.PFX;
let fail = 0; const t = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fail++; };

const NEW = ['depthfade', 'accentline', 'dualfade', 'blurfloat', 'kineticpush', 'glassblur', 'cinezoom', 'cardflip', 'splitwipe', 'morph'];
t(NEW.every((k) => PFX.slide[k] && PFX.lt[k] && PFX.slide[k].label && PFX.IDS.includes(k)), 'all 10 presets exist for slides and lower thirds, each with a label');
t(PFX.MIN_MS === 200 && PFX.MAX_MS === 1000, 'duration range is 200-1000 ms');
// exact specs
t(JSON.stringify(PFX.slide.depthfade['in']).includes('scale(.98)') && JSON.stringify(PFX.slide.depthfade['in']).includes('scale(1)'), 'Depth Scale Fade: 0.98 -> 1.0 scale with opacity');
t(JSON.stringify(PFX.slide.blurfloat['in']).includes('blur(5px)') && JSON.stringify(PFX.slide.blurfloat['in']).includes('translateY(10px)'), 'Blur & Float: 5px blur, 10px drift');
t(JSON.stringify(PFX.slide.cinezoom.out).includes('scale(1.05)'), 'Cinematic Zoom: 100% -> 105%');
t(JSON.stringify(PFX.slide.splitwipe['in']).includes('inset(0 50% 0 50%)'), 'Split Wipe: starts from the center');
t(PFX.slide.cardflip.inEase === 'spring' && /^(linear\(|cubic-bezier)/.test(PFX.springEase()), 'Card Flip uses spring easing');
const up = PFX.resolve(PFX.slide.kineticpush.out, 1), back = PFX.resolve(PFX.slide.kineticpush.out, -1);
t(up[1].transform.includes('-9vh') && back[1].transform.includes('9vh') && !back[1].transform.includes('-9vh'), 'Kinetic Push reverses direction when going back');
t(PFX.lt.kineticpush.out(1)[1].transform.includes('4vh'), 'lower-third set uses smaller travel');
// swap behaviour
function run(effect, extra) {
  calls.length = 0; let applied = 0; const host = el('host'), node = el('text'); host.appendChild(node);
  PFX.swap(node, host, () => { applied++; }, true, true, Object.assign({ effect, duration: 600, fxSet: PFX.slide }, extra || {}));
  return { applied, calls: calls.slice(), host };
}
for (const k of NEW) {
  const r = run(k);
  t(r.applied === 1 && r.calls.length >= 2 && r.calls.every((c) => c.o.duration === 600), k + ': apply once, old + new layers animate at the requested duration');
}
let r = run('accentline'); t(r.calls.length === 4 && r.host.children.length >= 3, 'Accent Line Reveal adds a leading bar + underline layer');
r = run('glassblur'); t(r.calls.some((c) => c.k[1] && c.k[1].opacity === 1 && c.tag === 'div'), 'Glassmorphic Blur Fade adds a backdrop-blur pane');
r = run('none'); t(r.applied === 1 && r.calls.length === 0, 'none = instant');
r = run('fade', { fxSet: PFX.slide }); t(r.applied === 1, 'unknown/legacy key falls back without throwing');
calls.length = 0; { let n = 0; const h = el('h'), nd = el('n'); PFX.swap(nd, h, () => { n++; }, false, false, { effect: 'depthfade', duration: 400, fxSet: PFX.slide }); t(n === 1 && calls.length === 0, 'nothing to animate -> content still applied'); }
// presenter.html wiring
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'presenter.html'), 'utf8');
t(html.includes('<script src="fx-presets.js"></script>'), 'presenter.html loads fx-presets.js');
t((html.match(/min="200" max="1000" step="50"/g) || []).length === 2, 'both speed sliders are 200-1000 ms');
t(/id="fxSelect"[^>]*>/.test(html) && html.includes('Corporate & broadcast'), 'dropdowns list a "Corporate & broadcast" group');
for (const f of ['public/remote.html', 'mobile/www/remote.html']) t(fs.readFileSync(path.join(__dirname, '..', f), 'utf8').includes("origin + '/fx-presets.js'"), f + ' loads the shared engine from the computer');
console.log(fail ? fail + ' FAILED' : 'all transition checks passed'); process.exit(fail ? 1 : 0);
