'use strict';
// Go live / AIR rules, extracted from public/presenter.html. Run: node tests/stage-air.state.test.js
const fs = require('fs'), vm = require('vm');
const html = fs.readFileSync(require('path').join(__dirname,'..','public','presenter.html'), 'utf8');
const cut = (a, b) => { const i = html.indexOf(a), j = html.indexOf(b, i); if (i < 0 || j < 0) throw new Error('marker missing: ' + a); return html.slice(i, j); };
const code = [
  cut('    function airOf(l){', '    // PREVIEW panel: every newly staged'),                   // airOf + setLive
  cut('    function sendPreviewLive(){', '    // Used by the Playlist window'),                      // sendPreviewLive, setAir, toggleBlank
].join('\n');
const store = {};
const ctx = {
  localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
  LIVE_KEY: 'live', PREVIEW_KEY: 'prev', flushSlideEdit() {}, pushStyleToLive() {}, updateLiveBox() {}, renderSlides() {}, window: {}, JSON, Object,
};
vm.createContext(ctx);
vm.runInContext(`
  const readState = (k)=>{ try{ return JSON.parse(localStorage.getItem(k)) || {blank:true,text:'',subtitle:''}; }catch(e){ return {blank:true,text:'',subtitle:''}; } };
  const getLive = ()=>readState(LIVE_KEY), getPreview = ()=>readState(PREVIEW_KEY);
  ${code}
  this.api = { sendPreviewLive, setAir, toggleBlank, getLive, getPreview, airOf,
    stage:(t)=>localStorage.setItem(PREVIEW_KEY, JSON.stringify({text:t,blank:false,itemId:'i',slideIndex:0})),
    clearPreview:()=>localStorage.setItem(PREVIEW_KEY, JSON.stringify({blank:true,text:'',subtitle:''})) };
`, ctx);
const A = ctx.api; let fail = 0;
const t = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fail++; };
// 1. staging never touches Live
A.stage('Line 1'); t(A.getLive().text === undefined || A.getLive().text === '', 'staging in Preview does not change Live');
// 2. explicit Go live
A.sendPreviewLive(); t(A.getLive().text === 'Line 1' && A.airOf(A.getLive()), 'Go live moves Preview to Live and AIR is ON');
// 3. staging another line leaves Live alone
A.stage('Line 2'); t(A.getLive().text === 'Line 1', 'changing Preview does not update Live');
// 4. empty preview + Go live clears Live
A.clearPreview(); A.sendPreviewLive(); t(A.getLive().text === '' && A.getLive().blank === true, 'Go live with empty Preview clears Live (no stale slide)');
t(A.airOf(A.getLive()) === true, '... and AIR stays ON');
// 5. AIR OFF then AIR ON with a staged slide
A.stage('Line 3'); A.sendPreviewLive(); A.toggleBlank();
t(!A.airOf(A.getLive()) && A.getLive().text === '', 'AIR OFF: Live emptied, old slide forgotten');
A.stage('Line 4'); A.toggleBlank();
t(A.airOf(A.getLive()) && A.getLive().text === 'Line 4', 'AIR ON renders ONLY what is in Preview (Line 4, not Line 3)');
// 6. AIR OFF then AIR ON with EMPTY preview
A.toggleBlank(); A.clearPreview(); A.toggleBlank();
t(A.airOf(A.getLive()) && A.getLive().text === '' && A.getLive().blank === true, 'AIR ON with empty Preview stays blank (no restore of earlier text)');
// 7. legacy state without the air flag
store.live = JSON.stringify({ text: 'old', blank: false });
t(A.airOf(A.getLive()) === true, 'old saved state (no air flag, not blank) counts as ON AIR');
console.log(fail ? fail + ' FAILED' : 'all state-logic checks passed'); process.exit(fail ? 1 : 0);
