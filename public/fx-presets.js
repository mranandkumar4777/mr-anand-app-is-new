/* PRESENTER transition engine: corporate / broadcast presets + the ONE swap routine used everywhere.
   Loaded by presenter.html (Control, Preview, Live window, OBS /live page) and, from the computer, by remote.html (phones / tablets in
   Main Stage Display mode over Tailscale). Because every screen runs this same file, the same preset has the same keyframes, easing,
   duration and direction on all of them.

   Performance: presets animate opacity / transform (compositor-driven) plus, where the look needs it, a small blur (<= 12 px) or a
   clip-path. Glass / accent decorations are separate layers whose OPACITY or TRANSFORM is animated, never a growing blur radius.
   will-change is set only while a transition runs. window.PFX.measure() reports the real frame rate of a preset on the current screen. */
(function(){
  'use strict';
  var EASE = 'ease-in-out';
  var DEFAULT_ACCENT = '#f5b301';

  // ---- spring easing: a real damped spring sampled into CSS linear() (Chromium 113+ / Safari 17.2+); older engines get a spring-like bezier ----
  var springCache = null;
  function springEase(){
    if(springCache) return springCache;
    var ok = false; try{ ok = !!(window.CSS && CSS.supports && CSS.supports('animation-timing-function', 'linear(0, 1)')); }catch(e){}
    if(!ok){ springCache = 'cubic-bezier(.34,1.56,.64,1)'; return springCache; }
    var zeta = 0.5, w0 = 11, wd = w0 * Math.sqrt(1 - zeta * zeta), pts = [], n = 36;       // lightly damped: one visible overshoot, then settles
    for(var i = 0; i <= n; i++){
      var t = i / n * 1.0, v = 1 - Math.exp(-zeta * w0 * t) * (Math.cos(wd * t) + (zeta * w0 / wd) * Math.sin(wd * t));
      pts.push((i === n ? 1 : v).toFixed(4));
    }
    springCache = 'linear(' + pts.join(',') + ')';
    return springCache;
  }

  // ---- the new presets. big = full-screen slide text (distances in vh); !big = lower-third panels (smaller travel) ----
  function build(big){
    var y = big ? 9 : 4;
    var fx = {};
    fx.depthfade = { label:'Subtle Depth Scale Fade',
      out:[{opacity:1,transform:'scale(1)'},{opacity:0,transform:'scale(.99)'}],
      'in':[{opacity:0,transform:'scale(.98)'},{opacity:1,transform:'scale(1)'}], inEase:'cubic-bezier(.22,.61,.36,1)' };
    fx.accentline = { label:'Accent Line Reveal',
      out:[{opacity:1},{opacity:0}],
      'in':[{clipPath:'inset(0 100% 0 0)',opacity:1},{clipPath:'inset(0 0 0 0)',opacity:1}], deco:'accentline' };
    fx.dualfade = { label:'Smooth Dual-Layer Crossfade',          // background layer (old) and foreground layer (new) fade on offset curves, with opposite scale = depth
      out:[{opacity:1,transform:'scale(1)',offset:0},{opacity:0,transform:'scale(1.03)',offset:.6},{opacity:0,transform:'scale(1.03)',offset:1}],
      'in':[{opacity:0,transform:'scale(.97)',offset:0},{opacity:0,transform:'scale(.97)',offset:.3},{opacity:1,transform:'scale(1)',offset:1}] };
    fx.blurfloat = { label:'Soft Blur & Vertical Float',
      out:[{opacity:1,filter:'blur(0px)',transform:'translateY(0)'},{opacity:0,filter:'blur(5px)',transform:'translateY(-10px)'}],
      'in':[{opacity:0,filter:'blur(5px)',transform:'translateY(10px)'},{opacity:1,filter:'blur(0px)',transform:'translateY(0)'}] };
    fx.kineticpush = { label:'Kinetic Push (Smart Up/Down)',      // forward = old line pushed up, new from below; going back reverses it
      out:function(d){ return [{opacity:1,transform:'translateY(0)'},{opacity:0,transform:'translateY(' + (-d * y) + 'vh)'}]; },
      'in':function(d){ return [{opacity:0,transform:'translateY(' + (d * y) + 'vh)'},{opacity:1,transform:'translateY(0)'}]; },
      outEase:'cubic-bezier(.65,0,.35,1)', inEase:'cubic-bezier(.65,0,.35,1)' };
    fx.glassblur = { label:'Glassmorphic Blur Fade',               // a frosted-glass pane (backdrop blur) sweeps over the change; text settles crisp
      out:[{opacity:1,filter:'blur(0px)'},{opacity:0,filter:'blur(8px)'}],
      'in':[{opacity:0,filter:'blur(12px)'},{opacity:1,filter:'blur(0px)'}], deco:'glass' };
    fx.cinezoom = { label:'Cinematic Zoom Dissolve',               // both layers travel forward by 5 % while they dissolve
      out:[{opacity:1,transform:'scale(1)'},{opacity:0,transform:'scale(1.05)'}],
      'in':[{opacity:0,transform:'scale(.95)'},{opacity:1,transform:'scale(1)'}],
      outEase:'cubic-bezier(.33,0,.2,1)', inEase:'cubic-bezier(.33,0,.2,1)' };
    fx.cardflip = { label:'3D Card Flip (Spring)',
      out:[{opacity:1,transform:'perspective(1000px) rotateX(0deg)'},{opacity:0,transform:'perspective(1000px) rotateX(-90deg)'}],
      'in':[{opacity:0,transform:'perspective(1000px) rotateX(90deg)'},{opacity:1,transform:'perspective(1000px) rotateX(0deg)'}],
      outEase:'cubic-bezier(.4,0,1,1)', inEase:'spring' };
    fx.splitwipe = { label:'Split Wipe (Center-Out)',
      out:[{clipPath:'inset(0 0 0 0)',opacity:1},{clipPath:'inset(0 50% 0 50%)',opacity:1}],
      'in':[{clipPath:'inset(0 50% 0 50%)',opacity:1},{clipPath:'inset(0 0 0 0)',opacity:1}],
      outEase:'cubic-bezier(.55,0,.8,.4)', inEase:'cubic-bezier(.22,.61,.36,1)' };
    fx.morph = { label:'Morph Blend',                              // old and new text overlap while blurring into each other (a blend, not glyph-by-glyph morphing)
      out:[{opacity:1,filter:'blur(0px)',transform:'scale(1)',offset:0},{opacity:0,filter:'blur(6px)',transform:'scale(1.02)',offset:.65},{opacity:0,filter:'blur(6px)',transform:'scale(1.02)',offset:1}],
      'in':[{opacity:0,filter:'blur(6px)',transform:'scale(.98)',offset:0},{opacity:0,filter:'blur(6px)',transform:'scale(.98)',offset:.25},{opacity:1,filter:'blur(0px)',transform:'scale(1)',offset:1}] };
    return fx;
  }
  var IDS = ['depthfade','accentline','dualfade','blurfloat','kineticpush','glassblur','cinezoom','cardflip','splitwipe','morph'];

  function resolve(v, dir){ return typeof v === 'function' ? v(dir) : v; }

  // ---- decorations (separate layers; they never change the text's own layout) ----
  function mk(css){ var d = document.createElement('div'); d.setAttribute('aria-hidden', 'true'); d.style.cssText = 'position:fixed;pointer-events:none;margin:0;z-index:9;' + css; return d; }
  function accentOf(el){
    var c = ''; try{ c = (getComputedStyle(el).getPropertyValue('--lt-accent') || getComputedStyle(document.documentElement).getPropertyValue('--lt-accent') || '').trim(); }catch(e){}
    return /^#[0-9a-f]{3,8}$/i.test(c) ? c : DEFAULT_ACCENT;
  }
  function addDeco(kind, el, host, o, anims, nodes){
    var r = el.getBoundingClientRect(); if(!r.width || !r.height) return;
    var big = r.width > 400, bw = big ? 5 : 3;
    if(kind === 'accentline'){
      var col = accentOf(el);
      // thin accent bar that LEADS the mask: it rides the reveal edge from left to right, then fades
      var bar = mk('left:' + r.left + 'px;top:' + r.top + 'px;width:' + bw + 'px;height:' + r.height + 'px;background:' + col + ';box-shadow:0 0 12px ' + col + ';border-radius:2px;will-change:transform,opacity;');
      // underline that draws itself under the line of text
      var ul = mk('left:' + r.left + 'px;top:' + (r.bottom - 2) + 'px;width:' + r.width + 'px;height:2px;background:' + col + ';transform-origin:left center;will-change:transform,opacity;');
      host.appendChild(bar); host.appendChild(ul); nodes.push(bar, ul);
      anims.push(bar.animate([{transform:'translateX(0)',opacity:1,offset:0},{transform:'translateX(' + Math.max(0, r.width - bw) + 'px)',opacity:1,offset:.88},{transform:'translateX(' + Math.max(0, r.width - bw) + 'px)',opacity:0,offset:1}], o));
      anims.push(ul.animate([{transform:'scaleX(0)',opacity:1,offset:0},{transform:'scaleX(1)',opacity:1,offset:.85},{transform:'scaleX(1)',opacity:0,offset:1}], o));
    } else if(kind === 'glass'){
      var g = mk('left:' + (r.left - 18) + 'px;top:' + (r.top - 10) + 'px;width:' + (r.width + 36) + 'px;height:' + (r.height + 20) + 'px;border-radius:14px;' +
                 'background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.16);-webkit-backdrop-filter:blur(14px) saturate(1.25);backdrop-filter:blur(14px) saturate(1.25);opacity:0;will-change:opacity;');
      host.appendChild(g); nodes.push(g);
      anims.push(g.animate([{opacity:0,offset:0},{opacity:1,offset:.35},{opacity:0,offset:1}], { duration:o.duration, easing:'ease-in-out', fill:'both' }));
    }
  }

  // ---- running transitions: one per element, so Preview and Live (which animate at the same moment) never cancel each other ----
  var running = [];
  function cancel(el){
    running = running.filter(function(r){
      if(el && r.el !== el) return true;
      r.anims.forEach(function(a){ try{ a.cancel(); }catch(e){} });
      r.nodes.forEach(function(n){ if(n.parentNode) n.parentNode.removeChild(n); });
      if(r.el && r.el.style) r.el.style.willChange = '';
      return false;
    });
  }
  function ease(name, fallback){ return name === 'spring' ? springEase() : (name || fallback || EASE); }

  /* swap(el, host, apply, hadText, hasText, cfg)
       apply()    : changes the element's content (called exactly once, even when no animation plays)
       cfg.effect : preset key        cfg.fxSet : { key: preset }       cfg.duration : ms (200-1000 from the UI)
       cfg.dir    : +1 forward / -1 back (used by Kinetic Push) */
  function swap(el, host, apply, hadText, hasText, cfg){
    cancel(el);
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var map = cfg.fxSet || {}, effect = cfg.effect;
    if(effect === 'none' || reduce || document.hidden || !el.animate || (!hadText && !hasText)){ apply(); return; }
    var fx = map[effect] || map.fade;
    if(!fx){ apply(); return; }
    var dir = cfg.dir === -1 ? -1 : 1, dur = Math.max(100, Number(cfg.duration) || 500);
    var outK = resolve(fx.out, dir), inK = resolve(fx['in'], dir);
    var base = { duration:dur, fill:'both' };
    var clone = null, nodes = [], anims = [];
    if(hadText){
      var r = el.getBoundingClientRect();
      clone = el.cloneNode(true); clone.removeAttribute('id');
      Object.assign(clone.style, { position:'fixed', margin:'0', pointerEvents:'none', maxWidth:'none', left:r.left + 'px', top:r.top + 'px', width:r.width + 'px', height:r.height + 'px', willChange:'opacity, transform, filter' });
      host.appendChild(clone); nodes.push(clone);
      // position:fixed is relative to the window only when no ancestor has a transform / filter / backdrop-filter (dock panels do):
      // measure where the clone really landed and move it back onto the element it replaces
      var c0 = clone.getBoundingClientRect();
      if(Math.abs(c0.left - r.left) > 0.5 || Math.abs(c0.top - r.top) > 0.5){
        clone.style.left = (r.left + (r.left - c0.left)) + 'px'; clone.style.top = (r.top + (r.top - c0.top)) + 'px';
      }
    }
    apply();
    el.style.willChange = 'opacity, transform, filter';
    if(clone && outK) anims.push(clone.animate(outK, Object.assign({ easing: ease(fx.outEase) }, base)));
    if(hasText && inK) anims.push(el.animate(inK, Object.assign({ easing: ease(fx.inEase) }, base)));
    if(hasText && fx.deco) addDeco(fx.deco, el, host, Object.assign({ easing: EASE }, base), anims, nodes);
    var entry = { el:el, anims:anims, nodes:nodes };
    running.push(entry);
    Promise.all(anims.map(function(a){ return a.finished; })).then(function(){
      anims.forEach(function(a){ try{ a.cancel(); }catch(e){} });
      nodes.forEach(function(n){ if(n.parentNode) n.parentNode.removeChild(n); });
      el.style.willChange = '';
      running = running.filter(function(x){ return x !== entry; });
    }).catch(function(){});
  }

  /* measure(el, host, effect, duration, cb): plays the preset once on `el` and reports { fps, worst } from requestAnimationFrame timing.
     Use from the console on any screen:  PFX.measure(document.getElementById('stageText'), document.body, 'cardflip', 600, console.log) */
  function measure(el, host, effect, duration, cb){
    var sets = { slide: PFX.slide, lt: PFX.lt }, map = Object.assign({}, sets.slide), last = 0, deltas = [], t0 = 0;
    function tick(t){
      if(last) deltas.push(t - last); last = t; if(!t0) t0 = t;
      if(t - t0 < duration + 80) return requestAnimationFrame(tick);
      var avg = deltas.reduce(function(a, b){ return a + b; }, 0) / (deltas.length || 1);
      cb && cb({ effect:effect, fps:Math.round(1000 / (avg || 16.7)), worstFrameMs:Math.round(Math.max.apply(null, deltas.concat([0]))), frames:deltas.length });
    }
    swap(el, host, function(){}, true, true, { effect:effect, duration:duration, fxSet:map });
    requestAnimationFrame(tick);
  }

  var PFX = window.PFX = { IDS:IDS, slide:build(true), lt:build(false), swap:swap, cancel:cancel, resolve:resolve, springEase:springEase, measure:measure,
                           MIN_MS:200, MAX_MS:1000 };
})();
