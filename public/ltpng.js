/* PRESENTER - PNG Lower Thirds: shared data model + skin renderer.

   A PNG graphic is a SKIN of the normal Lower Thirds. The slide / lyric text is still drawn by the one text element the
   app already uses (so every effect, transition, Preview -> Go live step, OBS page and phone Stage Display works unchanged);
   this file only describes how the picture is laid behind that text and how it adapts to the text.

   item = { id, file, name, w, h,            picture (served from /lt-assets/ or a small embedded PNG) and its pixel size
            mode   'grow' | 'fit'            grow : width AND height follow the text (9-slice, ends keep their shape)
                                             fit  : fixed width; the text shrinks a little (never below 60%), then the height grows
                                             In both modes the graphic always covers all of the text.
            size   graphic width, % of the screen width (8-100); the text scales with it
            capX capY   edge size, % of the picture that is never stretched (grow mode)
            padX padY   text margin, % of the picture width / height
            extraX extraY   extra space around the text, in screen-width units (manual width / height)
            offX offY   nudge from the chosen position, % of the screen
            opacity 0-100, shadow bool }

   Sizes are expressed in "units" (--ltp-u): 1 unit = 1% of the screen width. The page decides what one unit is
   (1vw on a full-screen window, a pixel value in the small boxes), so the same CSS works everywhere.            */
(function(){
  'use strict';

  var REF_SIZE = 45;                                   // graphic width (%) at which the text keeps the size chosen in Lower Thirds
  var MODES = { grow:'Grow with the text (width and height)', fit:'Fixed width (text shrinks a little, height grows)' };
  var FIT_FLOOR = 0.6;                                 // fixed-width mode never shrinks the text below this share of its normal size
  var HEX_FILE = /^(https?:\/\/[A-Za-z0-9.\-\[\]:]+)?\/lt-assets\/ltp_[a-f0-9]{16}\.png$/;

  function clamp(v, lo, hi, d){ v = Number(v); return isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; }
  function r1(v){ return Math.round(v * 10) / 10; }
  function r3(v){ return Math.round(v * 1000) / 1000; }
  function str(v, max){ return typeof v === 'string' ? v.slice(0, max) : ''; }
  function uid(p){ return p + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3); }
  function safeFile(f){
    f = typeof f === 'string' ? f : '';
    if(HEX_FILE.test(f)) return f;                                                         // relative, or absolute when a phone loads it from the computer
    if(/^data:image\/png;base64,[A-Za-z0-9+\/=]+$/.test(f) && f.length < 3500000) return f; // no server: a small embedded PNG
    return '';
  }

  // Sensible edges for any picture: round ends of a bar (about half its height) stay round, top / bottom keep their trim.
  function autoCaps(w, h){
    var cx = (w > 0 && h > 0) ? Math.round(Math.min(30, Math.max(3, 50 * h / w))) : 8;
    return { capX: cx, capY: 30 };
  }
  function autoPad(caps){ return { padX: Math.min(45, caps.capX + 3), padY: 18 }; }

  function normItem(o){
    o = o && typeof o === 'object' ? o : {};
    var w = Math.round(clamp(o.w, 0, 20000, 0)), h = Math.round(clamp(o.h, 0, 20000, 0));
    var ac = autoCaps(w, h), ap = autoPad(ac);
    return {
      id:      str(o.id, 24) || uid('lp_'),
      file:    safeFile(o.file),
      name:    str(o.name, 80) || 'PNG graphic',
      w:       w,
      h:       h,
      mode:    o.mode === 'fit' ? 'fit' : 'grow',
      size:    r1(clamp(o.size != null ? o.size : o.scale, 8, 100, REF_SIZE)),     // older libraries called it "scale"
      capX:    r1(clamp(o.capX, 0, 45, ac.capX)),
      capY:    r1(clamp(o.capY, 0, 45, ac.capY)),
      padX:    r1(clamp(o.padX, 0, 45, ap.padX)),
      padY:    r1(clamp(o.padY, 0, 45, ap.padY)),
      extraX:  r1(clamp(o.extraX, 0, 20, 0)),
      extraY:  r1(clamp(o.extraY, 0, 20, 0)),
      offX:    r1(clamp(o.offX, -50, 50, 0)),
      offY:    r1(clamp(o.offY, -50, 50, 0)),
      opacity: Math.round(clamp(o.opacity, 0, 100, 100)),
      shadow:  o.shadow === true
    };
  }
  // an item that can be drawn, or null
  function valid(o){ var it = normItem(o); return it.file ? it : null; }

  var VAR_KEYS = ['--ltp-img','--ltp-slice','--ltp-bt','--ltp-br','--ltp-minw','--ltp-minh','--ltp-px','--ltp-py','--ltp-ar','--ltp-op','--ltp-offx','--ltp-offy'];
  // CSS custom properties (numbers are in units, see above)
  function cssVars(item){
    var it = normItem(item), W = it.w || 1000, H = it.h || 200, k = it.size / W;     // k: units per picture pixel
    var v = {};
    v['--ltp-img']   = 'url("' + it.file + '")';
    v['--ltp-slice'] = it.capY + '% ' + it.capX + '% ' + it.capY + '% ' + it.capX + '%';
    v['--ltp-bt']    = String(r3(H * it.capY / 100 * k));     // border widths of the 9-slice, so the ends keep their proportions
    v['--ltp-br']    = String(r3(W * it.capX / 100 * k));
    v['--ltp-minw']  = String(r3(it.size));                    // never smaller than the design
    v['--ltp-minh']  = String(r3(it.size * H / W));
    v['--ltp-px']    = String(r3(it.size * it.padX / 100 + it.extraX));    // text margins + manual extra width
    v['--ltp-py']    = String(r3(it.size * H / W * it.padY / 100 + it.extraY));   // ... + manual extra height
    v['--ltp-ar']    = W + ' / ' + H;
    v['--ltp-op']    = String(it.opacity / 100);
    v['--ltp-offx']  = String(it.offX);
    v['--ltp-offy']  = String(r3(it.offY * 9 / 16));           // % of the screen height, in width units
    return v;
  }
  function attrs(item){ var it = normItem(item); return { 'data-ltp-mode': it.mode, 'data-ltp-sh': it.shadow ? '1' : '0' }; }
  // text scale that goes with the graphic size (1 at REF_SIZE)
  function textScale(item){ return r3(normItem(item).size / REF_SIZE); }

  /* ----------------------------------------------------------- styles (injected once) ----------------------------------------------------------- */
  var S = '.lt-skin[data-lt="png"]';
  var CSS =
    ':root{--ltp-u:1vw;}' +
    S + '{position:relative;isolation:isolate;flex:none;box-sizing:border-box;background:none !important;border:0 !important;border-radius:0 !important;box-shadow:none !important;' +
      '-webkit-backdrop-filter:none !important;backdrop-filter:none !important;' +
      'padding:calc(var(--ltp-py,2)*var(--ltp-u)) calc(var(--ltp-px,4)*var(--ltp-u));' +
      'min-width:min(calc(var(--ltp-minw,30)*var(--ltp-u)),100%);min-height:calc(var(--ltp-minh,6)*var(--ltp-u));' +
      'left:calc(var(--ltp-offx,0)*var(--ltp-u));top:calc(var(--ltp-offy,0)*var(--ltp-u));}' +
    S + ':not(:empty){display:flex;flex-direction:column;justify-content:center;}' +
    S + '[data-ltp-sh="0"]{text-shadow:none !important;}' +
    /* the picture is a 9-slice behind the text: the middle stretches with the text, the ends / trim keep their shape */
    S + '::before{content:"";position:absolute;left:0;top:0;right:0;bottom:0;z-index:-1;pointer-events:none;opacity:var(--ltp-op,1);box-sizing:border-box;border-style:solid;' +
      'border-width:calc(var(--ltp-bt,0)*var(--ltp-u)) calc(var(--ltp-br,0)*var(--ltp-u));' +
      'border-image-source:var(--ltp-img);border-image-slice:var(--ltp-slice,0) fill;border-image-width:1;border-image-repeat:stretch;}' +
    S + '[data-ltp-sh="1"]::before{filter:drop-shadow(0 calc(.45*var(--ltp-u)) calc(.9*var(--ltp-u)) rgba(0,0,0,.5));}' +
    /* always as tall as the text needs (nothing may squeeze or clip the graphic) */
    S + '{height:auto;max-height:none;overflow:visible;}' +
    /* fixed width: the width stays, the height still grows with the text */
    S + '[data-ltp-mode="fit"]:not(:empty){width:min(calc(var(--ltp-minw,30)*var(--ltp-u)),100%);min-width:0;}' +
    /* the "(nothing staged)" hint never gets a graphic */
    S + '.lt-placeholder{min-width:0;min-height:0;}' +
    S + '.lt-placeholder::before{display:none;}';
  function injectCss(){
    if(typeof document === 'undefined' || !document.head || document.getElementById('ltpng-css')) return;
    var s = document.createElement('style'); s.id = 'ltpng-css'; s.textContent = CSS; document.head.appendChild(s);
  }

  /* ----------------------------------------------------------- applying a skin to an element (hosts that do not use window.LT, e.g. the phone) ----------------------------------------------------------- */
  function skinEl(el, item){
    injectCss();
    var it = valid(item);
    if(!it){ unskinEl(el); return null; }
    var v = cssVars(it), a = attrs(it);
    Object.keys(v).forEach(function(k){ el.style.setProperty(k, v[k]); });
    Object.keys(a).forEach(function(k){ el.setAttribute(k, a[k]); });
    el.setAttribute('data-lt', 'png'); watch(el);
    return it;
  }
  function unskinEl(el){
    VAR_KEYS.forEach(function(k){ el.style.removeProperty(k); });
    el.removeAttribute('data-ltp-mode'); el.removeAttribute('data-ltp-sh');
    if(el.getAttribute('data-lt') === 'png') el.removeAttribute('data-lt');
    if(el._ltpFit){ el.style.fontSize = ''; el._ltpFit = false; }
  }

  /* ----------------------------------------------------------- "fit" mode: shrink the text until it sits inside the graphic ----------------------------------------------------------- */
  var watched = [];
  function textBox(el){                                  // size of the text, in layout pixels (an effect may be scaling the element right now)
    var r = document.createRange(); r.selectNodeContents(el);
    var b = r.getBoundingClientRect(), eb = el.getBoundingClientRect();
    var sx = el.offsetWidth ? eb.width / el.offsetWidth : 1, sy = el.offsetHeight ? eb.height / el.offsetHeight : 1;
    return { w: b.width / (sx || 1), h: b.height / (sy || 1) };
  }
  function fitEl(el){
    if(!el || !el.isConnected) return;
    var png = el.getAttribute('data-lt') === 'png' && !el.classList.contains('lt-placeholder') && !!el.textContent;
    el.style.minHeight = '';                                // back to the style sheet, then measure
    if(!png){ if(el._ltpFit){ el.style.fontSize = ''; el._ltpFit = false; } return; }
    if(el.getAttribute('data-ltp-mode') === 'fit'){
      // fixed width: the text may shrink to FIT_FLOOR so the design height is kept; below that the graphic grows taller
      el.style.fontSize = '';
      var cs = getComputedStyle(el), nominal = parseFloat(cs.fontSize);
      var aw = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      var ah = parseFloat(cs.minHeight) - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      el._ltpFit = true;
      if(aw > 2 && ah > 2 && nominal > 0){
        var fits = function(px){ el.style.fontSize = px + 'px'; var b = textBox(el); return b.h <= ah + 0.5 && b.w <= aw + 0.5; };
        if(fits(nominal)) el.style.fontSize = '';
        else {
          var lo = nominal * FIT_FLOOR, hi = nominal;
          if(fits(lo)){ for(var i = 0; i < 8; i++){ var mid = (lo + hi) / 2; if(fits(mid)) lo = mid; else hi = mid; } }
          el.style.fontSize = (Math.floor(lo * 10) / 10) + 'px';
        }
      }
    } else if(el._ltpFit){ el.style.fontSize = ''; el._ltpFit = false; }
    // safety net, any mode: if the text still sticks out of the graphic, make the graphic taller
    if(el.scrollHeight > el.clientHeight + 1) el.style.minHeight = el.scrollHeight + 'px';
  }
  function refitAll(){
    watched = watched.filter(function(e){ return e.isConnected; });
    watched.forEach(fitEl);
  }
  function watch(el){
    if(!el || el._ltpW || typeof MutationObserver === 'undefined') return;
    el._ltpW = true; watched.push(el);
    var mo = new MutationObserver(function(){ fitEl(el); });      // new text, new class (size step), mode switch: refit in the same frame
    mo.observe(el, { childList:true, characterData:true, subtree:true, attributes:true, attributeFilter:['class','data-lt','data-ltp-mode','lang'] });
    if(typeof ResizeObserver !== 'undefined') new ResizeObserver(function(){ fitEl(el); }).observe(el);
    fitEl(el);
  }
  if(typeof window !== 'undefined' && window.addEventListener){
    window.addEventListener('resize', refitAll);
    if(typeof document !== 'undefined' && document.fonts && document.fonts.ready) document.fonts.ready.then(refitAll).catch(function(){});
  }

  // keep --ltp-u (px per 1% of the screen width) right inside a small box (Control window Preview / Live boxes, catalog sample)
  function trackUnit(host){
    if(!host || host._ltpU || typeof ResizeObserver === 'undefined') return;
    host._ltpU = true;
    function set(){ var w = host.clientWidth; if(w > 0) host.style.setProperty('--ltp-u', (w / 100) + 'px'); }
    new ResizeObserver(function(){ set(); refitAll(); }).observe(host); set();
  }

  injectCss();
  var api = { REF_SIZE:REF_SIZE, MODES:MODES, VAR_KEYS:VAR_KEYS, uid:uid, clamp:clamp, safeFile:safeFile, autoCaps:autoCaps, autoPad:autoPad,
              normItem:normItem, valid:valid, cssVars:cssVars, attrs:attrs, textScale:textScale,
              injectCss:injectCss, skinEl:skinEl, unskinEl:unskinEl, watch:watch, fitEl:fitEl, refitAll:refitAll, trackUnit:trackUnit };
  if(typeof window !== 'undefined') window.LTPNG = api;
  if(typeof module !== 'undefined' && module.exports) module.exports = api;
})();
