'use strict';
// Pre-flight check: run `npm run check` before tagging a release. No dependencies, no network.
//  1. every JS file parses            2. every inline <script> in the HTML pages parses
//  3. every file listed in package.json "build.files" exists          4. every relative require() resolves
//  5. the JSON / workflow-adjacent config files parse                 6. android + mobile versions are consistent
const fs = require('fs'), path = require('path'), vm = require('vm');
const root = path.join(__dirname, '..');
let errors = 0;
const fail = (m) => { errors++; console.log('  FAIL ' + m); };
const ok = (m) => console.log('  ok   ' + m);
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const walk = (d, out = []) => { for (const e of fs.readdirSync(path.join(root, d), { withFileTypes: true })) { const r = path.join(d, e.name); if (e.isDirectory()) { if (!/node_modules|^dist$|android$/.test(e.name) && e.name !== 'build') walk(r, out); } else out.push(r); } return out; };

// 1 + 4: JS parse and relative requires
const jsFiles = ['main.js', 'preload.js', 'server.js', 'ai-hub.js'].concat(walk('speech'), walk('tools'), walk('tests'), walk('scripts'), walk('public').filter((f) => f.endsWith('.js')), walk('mobile/www').filter((f) => f.endsWith('.js'))).filter((f) => f.endsWith('.js'));
jsFiles.forEach((f) => {
  const src = read(f).replace(/^#!.*/, '');
  try { new vm.Script(src, { filename: f }); } catch (e) { return fail(f + ': ' + e.message); }
  const re = /require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g; let m;
  while ((m = re.exec(src))) { const base = path.join(root, path.dirname(f), m[1]); if (!['', '.js', '.json'].some((x) => fs.existsSync(base + x) && fs.statSync(base + x).isFile())) fail(f + ': require("' + m[1] + '") does not resolve'); }
});
ok(jsFiles.length + ' JS files parse and their relative requires resolve');

// 2: inline scripts
['public/presenter.html', 'public/remote.html', 'public/overlay.html', 'mobile/www/index.html', 'mobile/www/remote.html'].forEach((f) => {
  const h = read(f), re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi; let m, n = 0;
  while ((m = re.exec(h))) { n++; try { new vm.Script(m[1], { filename: f + '#script' + n }); } catch (e) { fail(f + ' script #' + n + ': ' + e.message); } }
  const srcRe = /<script[^>]*\bsrc="([^"#?]+)"/gi; while ((m = srcRe.exec(h))) if (!/^https?:/.test(m[1]) && !fs.existsSync(path.join(root, path.dirname(f), m[1]))) fail(f + ': missing script ' + m[1]);
});
ok('inline scripts in the HTML pages parse');

// 3: packaged files
const pkg = JSON.parse(read('package.json'));
(pkg.build.files || []).forEach((g) => {
  if (g.includes('*')) { const d = g.split('/')[0]; if (!fs.existsSync(path.join(root, d)) || !fs.readdirSync(path.join(root, d)).length) fail('package.json build.files: folder "' + d + '" is missing or empty'); }
  else if (!fs.existsSync(path.join(root, g))) fail('package.json build.files: "' + g + '" does not exist');
});
if (!pkg.main || !fs.existsSync(path.join(root, pkg.main))) fail('package.json "main" is missing');
// every file main.js / server.js need at runtime must be packaged
const packagedTop = (pkg.build.files || []).map((g) => g.split('/')[0]);
['main.js', 'server.js', 'preload.js', 'ai-hub.js'].concat(walk('speech')).forEach((f) => { if (!packagedTop.includes(f.split(/[\\/]/)[0])) fail(f + ' is not in build.files, so the installed app would crash'); });
ok('package.json build.files covers every runtime file');

// 5 + 6: JSON + versions
['package.json', 'mobile/package.json', 'mobile/capacitor.config.json', 'mobile/www/bundle-version.json'].forEach((f) => { try { JSON.parse(read(f)); } catch (e) { fail(f + ': ' + e.message); } });
const mp = JSON.parse(read('mobile/package.json')), gradle = read('mobile/android/capacitor.settings.gradle');
Object.keys(mp.dependencies).filter((d) => (d.startsWith('@capacitor') || d.startsWith('@capgo')) && d !== '@capacitor/core').forEach((d) => {
  const dir = '../node_modules/' + d + '/'; if (!gradle.includes(dir)) fail('mobile/android/capacitor.settings.gradle does not include ' + d + ' (run: cd mobile && npx cap sync android)');
});
ok('mobile plugins are listed in the Android Gradle settings');
if (!/^\d+$/.test(read('mobile/min-native-version-code.txt').trim())) fail('mobile/min-native-version-code.txt must be a whole number');
const capV = Object.keys(mp.dependencies).filter((d) => /^@capacitor\/(core|android)$/.test(d)).map((d) => mp.dependencies[d].replace(/^[^\d]*/, '').split('.')[0]);
if (new Set(capV).size > 1) fail('@capacitor/core and @capacitor/android must share the same major version');
ok('mobile config is consistent');

console.log(errors ? '\n' + errors + ' problem(s) found' : '\nAll checks passed');
process.exit(errors ? 1 : 0);
