'use strict';
// Float — the canvas. Every page is a window on one infinite plane; the
// camera (x, y, z) decides which part of the plane you are looking at.

const $ = (s, el = document) => el.querySelector(s);
const viewport = $('#viewport'), world = $('#world'), grid = $('#grid'), overlay = $('#overlay');
const hint = $('#hint'), zoomLabel = $('#zoomlabel');
const findbar = $('#findbar'), findInput = $('input', findbar), findCount = $('.count', findbar);

// Storage partitions: '' = main space, 'private', or a space id (separate logins).
const partitionFor = (space) => (space === 'private' ? 'drift-private' : space ? `persist:drift-space-${space}` : 'persist:drift');
let spaces = { main: { name: 'Main', color: '#7aa2f7' }, spaces: [] };
const spaceInfo = (id) => (id === 'private' ? { id, name: 'Private', color: '#a277ff' } : id ? spaces.spaces.find((x) => x.id === id) || { id, name: 'Space', color: '#888' } : { id: '', ...spaces.main });
const MIN_Z = 0.04, MAX_Z = 2.5, GRID = 40, GAP = 40, MIN_W = 320, MIN_H = 200;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const W = () => window.innerWidth, H = () => window.innerHeight;
// Height of the window bar along the top (0 when it's switched off): the visible canvas starts below it.
const TOP = () => (document.body.classList.contains('tabs') ? 36 : 0);

let config = { search: 'https://duckduckgo.com/?q=%s', keywords: {} };
if (/^Mac/.test(navigator.platform)) document.documentElement.classList.add('mac');
const cam = { x: 0, y: 0, z: 1 };
const wins = [];
const closed = [];
let active = null, zTop = 10, uid = 0;

const toWorld = (sx, sy) => ({ x: cam.x + sx / cam.z, y: cam.y + sy / cam.z });
const defaultSize = () => ({ w: Math.round(clamp(W() * 0.78, MIN_W, 1200)), h: Math.round(clamp(H() * 0.8, MIN_H, 820)) });

// ---------------------------------------------------------------- sky (background depth)
// Seamless tiles painted once at startup; the GPU just slides them around.
function rng(seed) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function paintTile(size, seed, draw) {
  const dpr = Math.min(2, window.devicePixelRatio || 1), c = document.createElement('canvas');
  c.width = c.height = Math.round(size * dpr);
  const g = c.getContext('2d');
  g.scale(dpr, dpr);
  const r = rng(seed);
  // Draw each shape 9 times around the tile so it wraps without seams.
  const wrap = (fn) => { for (const dx of [-size, 0, size]) for (const dy of [-size, 0, size]) fn(dx, dy); };
  draw(g, r, wrap, size);
  return `url(${c.toDataURL()})`;
}
function nebula(g, r, wrap, size) {
  const hues = [[96, 112, 255], [40, 190, 200], [190, 80, 230], [255, 120, 100], [70, 140, 255]];
  g.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 9; i++) {
    const x = r() * size, y = r() * size, rad = 160 + r() * 340, [cr, cg, cb] = hues[i % hues.length], a = 0.08 + r() * 0.12;
    wrap((dx, dy) => {
      const gr = g.createRadialGradient(x + dx, y + dy, 0, x + dx, y + dy, rad);
      gr.addColorStop(0, `rgba(${cr},${cg},${cb},${a})`);
      gr.addColorStop(0.5, `rgba(${cr},${cg},${cb},${a * 0.4})`);
      gr.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
      g.fillStyle = gr; g.fillRect(x + dx - rad, y + dy - rad, rad * 2, rad * 2);
    });
  }
}
const starfield = (count, rMin, rMax, aMin, aMax, glow) => (g, r, wrap, size) => {
  const tints = ['255,255,255', '200,215,255', '255,236,210', '180,200,255'];
  for (let i = 0; i < count; i++) {
    const x = r() * size, y = r() * size, rad = rMin + r() * (rMax - rMin), a = aMin + r() * (aMax - aMin), tint = tints[(r() * tints.length) | 0];
    wrap((dx, dy) => {
      if (glow && rad > (rMin + rMax) / 2) {
        const gr = g.createRadialGradient(x + dx, y + dy, 0, x + dx, y + dy, rad * 5);
        gr.addColorStop(0, `rgba(${tint},${a * 0.35})`); gr.addColorStop(1, `rgba(${tint},0)`);
        g.fillStyle = gr; g.fillRect(x + dx - rad * 5, y + dy - rad * 5, rad * 10, rad * 10);
      }
      g.fillStyle = `rgba(${tint},${a})`;
      g.beginPath(); g.arc(x + dx, y + dy, rad, 0, Math.PI * 2); g.fill();
    });
  }
};
const SKY = [
  { sel: '.nebula', tile: 1100, f: 0.04, k: 0.08, seed: 7, draw: nebula, scale: 2 },
  { sel: '.stars.far.a', tile: 420, f: 0.12, k: 0.2, seed: 11, draw: starfield(40, 0.35, 0.9, 0.25, 0.7) },
  { sel: '.stars.far.b', tile: 460, f: 0.12, k: 0.2, seed: 13, draw: starfield(40, 0.35, 0.9, 0.25, 0.7) },
  { sel: '.stars.mid.a', tile: 640, f: 0.3, k: 0.45, seed: 23, draw: starfield(16, 0.7, 1.5, 0.45, 0.95, true) },
  { sel: '.stars.mid.b', tile: 700, f: 0.3, k: 0.45, seed: 41, draw: starfield(14, 0.7, 1.5, 0.45, 0.95, true) },
].map((L) => {
  const el = $(L.sel);
  el.style.backgroundImage = paintTile(L.tile, L.seed, L.draw);
  return { el, f: L.f, k: L.k, tile: L.tile * (L.scale || 1) };
});

// Now and then a faint shooting star crosses the sky (only while the window is visible).
const sky = $('#sky');
(function meteorLoop() {
  setTimeout(() => {
    if (!document.hidden && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const m = document.createElement('div');
      m.className = 'meteor';
      m.style.left = (0.1 + Math.random() * 0.7) * W() + 'px';
      m.style.top = Math.random() * 0.55 * H() + 'px';
      m.style.setProperty('--a', 15 + Math.random() * 35 + 'deg');
      m.addEventListener('animationend', () => m.remove());
      sky.appendChild(m);
    }
    meteorLoop();
  }, 7000 + Math.random() * 16000);
})();

// ---------------------------------------------------------------- rendering
let dirty = false;
function invalidate() { if (!dirty) { dirty = true; requestAnimationFrame(render); } }

function render() {
  dirty = false;
  if (fullWin) { cam.x = fullWin.x; cam.y = fullWin.y - TOP(); cam.z = 1; place(fullWin); }
  const { x, y, z } = cam;
  world.style.transform = `translate(${-x * z}px, ${-y * z}px) scale(${z})`;
  world.style.setProperty('--inv', 1 / z);
  world.style.setProperty('--z', z);
  let step = GRID;
  while (step * z < 18) step *= 2;
  const s = step * z;
  grid.style.backgroundSize = `${s}px ${s}px`;
  grid.style.backgroundPosition = `${(-x * z) % s}px ${(-y * z) % s}px`;
  // Parallax: deeper layers pan (f) and zoom (k) less than the canvas plane.
  for (const L of SKY) {
    const t = L.tile * Math.pow(z, L.k);
    L.el.style.backgroundSize = `${t}px ${t}px`;
    L.el.style.backgroundPosition = `${(-x * z * L.f) % t}px ${(-y * z * L.f) % t}px`;
  }
  document.body.classList.toggle('far', z < 0.45);
  zoomLabel.textContent = Math.round(z * 100) + '%';
  hint.hidden = wins.length > 0;
  lazyLoad();
  scheduleSave();
  markOnScreen();
}

// ---------------------------------------------------------------- camera motion
let motion = 0;
function stopMotion() { cancelAnimationFrame(motion); motion = 0; }

// Glide the camera so world point (cx, cy) is centred at zoom tz.
function centerOn(cx, cy, tz = cam.z, ms = 320) {
  if (fullWin) exitFull();
  stopMotion();
  tz = clamp(tz, MIN_Z, MAX_Z);
  const w = W(), oy = TOP() + (H() - TOP()) / 2; // screen y of the visible area's centre
  if (!ms) { cam.z = tz; cam.x = cx - w / 2 / tz; cam.y = cy - oy / tz; return invalidate(); }
  const z0 = cam.z, x0 = cam.x + w / 2 / z0, y0 = cam.y + oy / z0, t0 = performance.now();
  const tick = (now) => {
    const t = Math.min(1, (now - t0) / ms), e = 1 - Math.pow(1 - t, 3);
    cam.z = z0 * Math.pow(tz / z0, e);
    cam.x = x0 + (cx - x0) * e - w / 2 / cam.z;
    cam.y = y0 + (cy - y0) * e - oy / cam.z;
    invalidate();
    motion = t < 1 ? requestAnimationFrame(tick) : 0;
  };
  motion = requestAnimationFrame(tick);
}

// Momentum after a pan: keep drifting and slow down (v in screen px/ms).
function fling(vx, vy) {
  stopMotion();
  let last = performance.now();
  const tick = (now) => {
    const dt = Math.min(32, now - last); last = now;
    cam.x -= vx * dt / cam.z; cam.y -= vy * dt / cam.z;
    const d = Math.exp(-dt / 320); vx *= d; vy *= d;
    invalidate();
    motion = Math.hypot(vx, vy) > 0.02 ? requestAnimationFrame(tick) : 0;
  };
  motion = requestAnimationFrame(tick);
}

function zoomAt(sx, sy, f) {
  stopMotion();
  const p = toWorld(sx, sy);
  cam.z = clamp(cam.z * f, MIN_Z, MAX_Z);
  cam.x = p.x - sx / cam.z; cam.y = p.y - sy / cam.z;
  invalidate();
}
const wheelFactor = (dy, mode) => Math.exp(-clamp(mode === 1 ? dy * 20 : dy, -30, 30) / 100);

function panBy(dx, dy, mode) {
  stopMotion();
  if (mode === 1) { dx *= 40; dy *= 40; }
  cam.x += dx / cam.z; cam.y += dy / cam.z;
  invalidate();
}

function onWheel(e) {
  e.preventDefault();
  if (e.ctrlKey) zoomAt(e.clientX, e.clientY, wheelFactor(e.deltaY, e.deltaMode));
  else panBy(e.deltaX, e.deltaY, e.deltaMode);
}

const viewCenter = () => toWorld(W() / 2, TOP() + (H() - TOP()) / 2);
const fitZoom = (w, h, margin = 80) => Math.min(1, (W() - margin) / w, (H() - TOP() - margin) / h);

// ---- Full-window mode: one window fills Float's whole window at 100% zoom ----
// The page isn't moved in the DOM (a <webview> would reload): render() pins the camera
// to the window's corner and place() sizes it to the screen. Its canvas position and
// size (w.x/y/w/h) never change, so leaving restores the canvas exactly.
let fullWin = null, fullPrevCam = null;
// Current key for a command, for button tooltips (refreshed when shortcuts change).
let keyMap = {};
const keyFor = (cmd) => keyMap[cmd] || 'no shortcut';
function loadKeys() {
  return window.drift.shortcuts().then((list) => {
    keyMap = Object.fromEntries(list.map((b) => [b.cmd, (b.keys[0] || '').replace(/\+/g, ' ')]));
    for (const w of wins) { updateFullBtn(w); if (typeof updateMarkBtn === 'function') updateMarkBtn(w); }
  }).catch(() => {});
}
loadKeys();
function enterFull(w) {
  if (!w) return;
  if (fullWin) exitFull(false);
  stopMotion();
  fullPrevCam = { ...cam };
  fullWin = w;
  setActive(w, true);
  w.el.classList.add('full');
  document.body.classList.add('fullwin');
  updateTopReserve();
  updateFullBtn(w);
  invalidate();
}
function exitFull(restoreCam = true) {
  const w = fullWin;
  if (!w) return;
  fullWin = null;
  w.el.classList.remove('full');
  document.body.classList.remove('fullwin');
  place(w);
  if (restoreCam && fullPrevCam) Object.assign(cam, fullPrevCam);
  updateFullBtn(w);
  invalidate();
}
const toggleFull = (w) => (fullWin && fullWin === w ? exitFull() : enterFull(w));
function updateFullBtn(w) {
  const b = $('.b-full', w.el), on = fullWin === w;
  b.innerHTML = on ? FULL_EXIT_ICON : FULL_ICON;
  b.title = on ? `Back to the canvas (${keyFor('full-win')})` : `Fill the screen with this window (${keyFor('full-win')})`;
}

function focusWin(w) { if (w === fullWin) return; centerOn(w.x + w.w / 2, w.y + w.h / 2, fitZoom(w.w, w.h)); }
// True when the camera already shows the window the way focusWin would (or is gliding there).
function isFocused(w) {
  if (motion) return true;
  const z = fitZoom(w.w, w.h), c = viewCenter();
  return Math.abs(cam.z - z) < 0.01 && Math.hypot(c.x - (w.x + w.w / 2), c.y - (w.y + w.h / 2)) < 4 / cam.z;
}

// Bring a window into view only if it isn't comfortably visible already.
function reveal(w) {
  if (w === fullWin) return; // it already fills the screen
  const sx = (w.x - cam.x) * cam.z, sy = (w.y - cam.y) * cam.z;
  const visible = sx >= 0 && sy >= TOP() && sx + w.w * cam.z <= W() && sy + w.h * cam.z <= H();
  if (!visible || cam.z < 0.5) focusWin(w);
}

function fitAll() {
  if (!wins.length) return centerOn(0, 0, 1);
  const b = bounds(wins);
  centerOn(b.x + b.w / 2, b.y + b.h / 2, fitZoom(b.w, b.h, 140));
}

function bounds(list) {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const r of list) { x1 = Math.min(x1, r.x); y1 = Math.min(y1, r.y); x2 = Math.max(x2, r.x + r.w); y2 = Math.max(y2, r.y + r.h); }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

// ---------------------------------------------------------------- pointer drags
// Generic drag: captures the pointer, stops pages from stealing it, reports deltas.
function drag(e, onMove, onEnd, cls = 'busy') {
  const el = e.currentTarget, id = e.pointerId;
  el.setPointerCapture(id);
  document.body.classList.add(cls);
  let lx = e.clientX, ly = e.clientY, moved = 0;
  const mv = (ev) => {
    if (ev.pointerId !== id) return;
    const dx = ev.clientX - lx, dy = ev.clientY - ly;
    lx = ev.clientX; ly = ev.clientY; moved += Math.abs(dx) + Math.abs(dy);
    onMove(dx, dy, ev, moved);
  };
  const up = (ev) => {
    if (ev.pointerId !== id) return;
    el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up);
    document.body.classList.remove(cls);
    onEnd && onEnd(ev, moved);
  };
  el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
}

function panDrag(e, onEnd) {
  stopMotion();
  const samples = [];
  drag(e, (dx, dy, ev) => {
    cam.x -= dx / cam.z; cam.y -= dy / cam.z; invalidate();
    samples.push({ t: ev.timeStamp, x: ev.clientX, y: ev.clientY });
    while (samples.length > 2 && ev.timeStamp - samples[0].t > 90) samples.shift();
  }, (ev, moved) => {
    if (samples.length >= 2) {
      const a = samples[0], b = samples[samples.length - 1], dt = b.t - a.t;
      if (dt > 0 && ev.timeStamp - b.t < 60) {
        const vx = (b.x - a.x) / dt, vy = (b.y - a.y) / dt;
        if (Math.hypot(vx, vy) > 0.25) fling(vx, vy);
      }
    }
    onEnd && onEnd(ev, moved);
  });
}

function moveDrag(e, w, onEnd) {
  drag(e, (dx, dy) => { w.x += dx / cam.z; w.y += dy / cam.z; place(w); },
    (ev, moved) => { scheduleSave(); onEnd && onEnd(ev, moved); });
}

function resizeDrag(e, w, dir) {
  setActive(w);
  // Track the raw pointer so clamping at the minimum size never makes the edge drift.
  const start = { ...w }; let ax = 0, ay = 0;
  drag(e, (dx, dy) => {
    ax += dx / cam.z; ay += dy / cam.z;
    if (dir.includes('e')) w.w = Math.max(MIN_W, start.w + ax);
    if (dir.includes('s')) w.h = Math.max(MIN_H, start.h + ay);
    if (dir.includes('w')) { w.w = Math.max(MIN_W, start.w - ax); w.x = start.x + start.w - w.w; }
    if (dir.includes('n')) { w.h = Math.max(MIN_H, start.h - ay); w.y = start.y + start.h - w.h; }
    place(w);
  }, scheduleSave, 'resizing');
}

// Empty canvas: drag to pan, double-click to open a window there, wheel to pan/zoom.
viewport.addEventListener('pointerdown', (e) => {
  const empty = e.target === viewport || e.target === world;
  if ((e.button === 0 && empty) || e.button === 1) {
    e.preventDefault();
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    panDrag(e);
  }
});
viewport.addEventListener('dblclick', (e) => {
  if (e.target !== viewport && e.target !== world) return;
  openWindowAt(toWorld(e.clientX, e.clientY));
});
viewport.addEventListener('contextmenu', (e) => {
  if (e.target !== viewport && e.target !== world) return;
  e.preventDefault();
  openCanvasMenu(e.clientX, e.clientY);
});
viewport.addEventListener('wheel', onWheel, { passive: false });
// The canvas must never scroll natively (only the camera moves it); undo any that slips through.
viewport.addEventListener('scroll', () => { viewport.scrollLeft = 0; viewport.scrollTop = 0; });
window.addEventListener('scroll', () => window.scrollTo(0, 0));

// Alt held: grab anything. Left = move window / pan, right = resize, wheel = pan.
let altHeld = false, overlayDragging = false;
function syncOverlay() { document.body.classList.toggle('alt', altHeld || overlayDragging); }
function setAlt(on) { altHeld = on; syncOverlay(); }
function hitWin(p) {
  let best = null;
  for (const w of wins) if (p.x >= w.x && p.x <= w.x + w.w && p.y >= w.y && p.y <= w.y + w.h && (!best || w.z > best.z)) best = w;
  return best;
}
overlay.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  const w = hitWin(toWorld(e.clientX, e.clientY));
  const done = () => { overlayDragging = false; syncOverlay(); };
  overlayDragging = true;
  if (e.button === 0 && w) { setActive(w); moveDrag(e, w, done); }
  else if (e.button === 2 && w) {
    const p = toWorld(e.clientX, e.clientY);
    resizeDrag(e, w, (p.y < w.y + w.h / 2 ? 'n' : 's') + (p.x < w.x + w.w / 2 ? 'w' : 'e'));
    overlay.addEventListener('pointerup', done, { once: true });
  } else panDrag(e, done);
});
overlay.addEventListener('pointermove', (e) => { if (!e.altKey && altHeld && !overlayDragging) setAlt(false); });
overlay.addEventListener('contextmenu', (e) => e.preventDefault());
overlay.addEventListener('wheel', onWheel, { passive: false });
window.addEventListener('blur', () => setAlt(false));

// ---------------------------------------------------------------- windows
function toURL(text) {
  const t = text.trim();
  if (!t) return null;
  const sp = t.indexOf(' ');
  if (sp > 0 && config.keywords[t.slice(0, sp)]) return config.keywords[t.slice(0, sp)].replace('%s', encodeURIComponent(t.slice(sp + 1).trim()));
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t) || /^(about|data|view-source):/i.test(t)) return t;
  if (/^(localhost|127\.0\.0\.1|\[::1\]|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/|$)/i.test(t)) return 'http://' + t;
  if (!/\s/.test(t) && /^[^/?#]+\.[a-z][a-z0-9-]+\.?(:\d+)?([/?#].*)?$/i.test(t)) return 'https://' + t;
  return searchURL(t);
}
const searchURL = (q) => config.search.replace('%s', encodeURIComponent(q));

const HANDLES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
const FULL_ICON = '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2H14v4.5M14 2 9.5 6.5M6.5 14H2V9.5M2 14l4.5-4.5"/></svg>';
const FULL_EXIT_ICON = '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 6.5H9.5V2M9.5 6.5 14 2M2 9.5h4.5V14M6.5 9.5 2 14"/></svg>';
const FOCUS_ICON = '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M2 5.5V3a1 1 0 0 1 1-1h2.5M10.5 2H13a1 1 0 0 1 1 1v2.5M14 10.5V13a1 1 0 0 1-1 1h-2.5M5.5 14H3a1 1 0 0 1-1-1v-2.5"/><circle cx="8" cy="8" r="1.6" fill="currentColor" stroke="none"/></svg>';

function createWin(o = {}) {
  const size = defaultSize();
  const w = {
    id: ++uid, x: o.x ?? 0, y: o.y ?? 0, w: o.w || size.w, h: o.h || size.h,
    url: o.url || '', title: o.title || '', favicon: o.favicon || '', z: ++zTop, wv: null, wcId: null,
    space: o.space || '',
  };
  const el = document.createElement('div');
  el.className = 'win';
  el.innerHTML = `
    <div class="label"></div>
    <div class="bar">
      <button class="b-back" title="Back (Alt ←)" disabled>‹</button>
      <button class="b-fwd" title="Forward (Alt →)" disabled>›</button>
      <button class="b-reload" title="Reload (Ctrl R)">↻</button>
      <button class="b-site" title="Site info: connection, permissions, what this page loaded"><img class="fav" alt=""><span class="lock"></span></button>
      <span class="space-chip" hidden></span>
      <input class="url" spellcheck="false" placeholder="Search or enter address">
      <button class="b-audio" hidden></button>
      <button class="b-mark" hidden></button>
      <button class="b-focus" title="Focus this window (Ctrl Tab cycles windows)">${FOCUS_ICON}</button>
      <button class="b-full"></button>
      <button class="b-close" title="Close (Ctrl W)">×</button>
    </div>
    <div class="body">
      <div class="perms"></div>
      <div class="ph"><div class="t"></div><div class="u"></div></div>
      <div class="start" hidden></div>
      <div class="err" hidden><div class="t"></div><div class="d"></div><div class="acts"></div></div>
      <div class="progress"></div>
    </div>
    ${HANDLES.map((d) => `<div class="rz ${d}" data-d="${d}"></div>`).join('')}`;
  Object.assign(w, {
    el, bar: $('.bar', el), input: $('.url', el), fav: $('.fav', el), label: $('.label', el),
    body: $('.body', el), ph: $('.ph', el), err: $('.err', el), audioBtn: $('.b-audio', el),
    muted: !!o.muted, audible: false, paused: !!o.paused, permBox: $('.perms', el), perms: new Map(),
    back: $('.b-back', el), fwd: $('.b-fwd', el), markBtn: $('.b-mark', el),
  });
  el.style.zIndex = w.z;
  applySpace(w);
  $('.b-site', el).onclick = () => openSiteInfo(w);

  el.addEventListener('pointerdown', () => setActive(w), true);

  // Title bar: drag to move; a click on the (unfocused) address field focuses it.
  w.bar.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('button') || document.activeElement === w.input) return;
    e.preventDefault();
    const onInput = e.target === w.input;
    if (fullWin === w) { if (onInput) { w.input.focus({ preventScroll: true }); w.input.select(); } return; }
    moveDrag(e, w, (_ev, moved) => {
      if (moved > 3) return;
      if (onInput) { w.input.focus({ preventScroll: true }); w.input.select(); } else if (w.wv) w.wv.focus({ preventScroll: true });
    });
  });
  w.bar.addEventListener('dblclick', (e) => { if (!e.target.closest('button, input') && fullWin !== w) focusWin(w); });
  w.bar.addEventListener('auxclick', (e) => { if (e.button === 1 && !e.target.closest('input')) closeWin(w); });
  w.back.onclick = () => w.wv && w.wv.goBack();
  w.fwd.onclick = () => w.wv && w.wv.goForward();
  $('.b-reload', el).onclick = (e) => reload(w, e.shiftKey);
  $('.b-close', el).onclick = () => closeWin(w);
  $('.b-focus', el).onclick = () => { setActive(w, true); focusWin(w); };
  $('.b-full', el).onclick = () => toggleFull(w);
  w.markBtn.onclick = () => toggleBookmark(w);
  w.ph.addEventListener('pointerdown', () => w.url && load(w, w.url));
  w.audioBtn.onclick = () => { w.muted = !w.muted; if (w.wcId) window.drift.setMuted(w.wcId, w.muted); updateAudio(w); };

  w.input.addEventListener('focus', () => { w.input.value = w.url; w.input.select(); });
  w.input.addEventListener('blur', () => showTitle(w));
  w.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const url = toURL(w.input.value);
      if (url) { load(w, url); w.input.blur(); w.wv.focus({ preventScroll: true }); }
    } else if (e.key === 'Escape') {
      w.input.blur();
      if (w.wv) w.wv.focus({ preventScroll: true });
    }
  });

  for (const h of el.querySelectorAll('.rz')) {
    h.addEventListener('pointerdown', (e) => { if (e.button === 0) { e.preventDefault(); e.stopPropagation(); resizeDrag(e, w, h.dataset.d); } });
  }

  wins.push(w);
  world.appendChild(el);
  place(w);
  updateFullBtn(w);
  showTitle(w);
  updateLock(w);
  if (w.favicon) setFavicon(w, w.favicon);
  if (w.paused) el.classList.add('paused');
  updateAudio(w);
  invalidate();
  return w;
}

function place(w) {
  const s = w.el.style, full = w === fullWin;
  const ww = full ? W() : w.w, hh = full ? H() - TOP() : w.h;
  s.left = w.x + 'px'; s.top = w.y + 'px'; s.width = ww + 'px'; s.height = hh + 'px';
  s.setProperty('--ww', ww);
}

// Space colour stripe + name chip (nothing for the main space unless spaces exist).
function applySpace(w) {
  scheduleTabs();
  const sp = spaceInfo(w.space), chip = $('.space-chip', w.el);
  w.el.style.setProperty('--space', sp.color);
  w.el.classList.toggle('in-space', !!w.space || spaces.spaces.length > 0);
  w.el.classList.toggle('private', w.space === 'private');
  chip.hidden = !w.space && !spaces.spaces.length;
  chip.textContent = sp.name;
  chip.title = w.space === 'private' ? 'Private window: nothing is saved, everything is forgotten when the last private window closes'
    : `Space “${sp.name}”: its own logins and cookies`;
}
// Lock in the title bar: secure (https), not secure (http), or a certificate exception.
function updateLock(w) {
  const lock = $('.lock', w.el), u = w.url || '';
  const state = u.startsWith('https:') ? 'secure' : u.startsWith('http:') ? 'insecure' : 'none';
  lock.className = 'lock ' + state;
  lock.textContent = state === 'secure' ? '🔒' : state === 'insecure' ? '⚠' : '';
  $('.b-site', w.el).title = state === 'insecure' ? 'Not secure: this page is not encrypted. Click for site info.' : 'Site info: connection, permissions, what this page loaded';
}
// Page text zoom (Ctrl+Shift+wheel, site info panel): remembered per site.
async function pageZoom(w, f) {
  if (!w.wcId) return;
  const cur = (await window.drift.siteRule(w.url)).zoom || 1;
  const z = await window.drift.setPageZoom(w.wcId, f === 0 ? 1 : cur * f);
  toast(`Page zoom ${Math.round(z * 100)}% for ${siteOfURL(w.url)}`);
  if (siteInfoWin === w) refreshSiteInfo();
}
// Move a window to another space: its page reloads with that space's logins.
function moveToSpace(w, space) {
  if (w.space === space) return;
  w.space = space;
  if (w.wv) { if (findWin === w) closeFind(); dismissPerms(w); w.wv.remove(); w.wv = null; w.wcId = null; w.el.classList.remove('live', 'loading'); }
  applySpace(w);
  if (w.url) load(w, w.url);
  scheduleSave();
}

function showTitle(w) {
  scheduleTabs();
  if (typeof updateMarkBtn === 'function') updateMarkBtn(w);
  if (document.activeElement !== w.input) w.input.value = w.title || w.url;
  w.label.textContent = w.title || w.url || 'New window';
  $('.t', w.ph).textContent = w.url ? (w.title || w.url) : 'Type an address or search above';
  $('.u', w.ph).textContent = w.url ? (w.title ? w.url : '') + (w.paused ? '  ·  paused, click to resume' : '  ·  click to load') : '';
  // An empty window shows the start page (panels.js), unless that's switched off.
  const blank = !w.url;
  if (blank !== w.el.classList.contains('blank')) {
    w.el.classList.toggle('blank', blank);
    if (blank && typeof renderStart === 'function') renderStart(w); else $('.start', w.el).hidden = true;
  }
}

function setFavicon(w, src) {
  scheduleTabs();
  w.favicon = src || '';
  w.fav.classList.toggle('on', !!src);
  if (src) w.fav.src = src; else w.fav.removeAttribute('src');
}
// Hide the icon instead of showing a broken image.
document.addEventListener('error', (e) => {
  if (e.target.classList?.contains('fav')) e.target.classList.remove('on');
  else if (e.target.tagName === 'IMG' && e.target.closest('.panel')) e.target.remove();
}, true);

// Create the <webview> on first use, so windows that were never looked at cost nothing.
function load(w, url) {
  const section = driftSettingsFor(url);
  if (section) { // typed / pasted chrome://settings/…: show Float's settings instead
    if (!w.wv && (!w.url || w.url === url)) closeWin(w);
    else showTitle(w);
    return openSettings(section);
  }
  if (w.paused) { w.paused = false; w.el.classList.remove('paused'); $('.snap', w.body)?.remove(); }
  w.url = url;
  w.err.hidden = true;
  if (w.wv) { w.wv.loadURL(url).catch(() => {}); showTitle(w); return; }
  const wv = document.createElement('webview');
  wv.setAttribute('partition', partitionFor(w.space));
  wv.setAttribute('allowpopups', '');
  wv.setAttribute('src', url);
  w.wv = wv;
  hookWebview(w, wv);
  w.body.prepend(wv);
  w.el.classList.add('live');
  showTitle(w);
}

function hookWebview(w, wv) {
  const nav = () => { try { w.back.disabled = !wv.canGoBack(); w.fwd.disabled = !wv.canGoForward(); } catch {} };
  // Known as soon as the guest attaches (a page that only downloads never reaches dom-ready).
  const learnId = () => {
    if (w.wcId != null) return;
    try { w.wcId = wv.getWebContentsId(); } catch { return; }
    if (w.muted) window.drift.setMuted(w.wcId, true);
    if (active === w) { window.drift.tabActive(w.wcId); extBar.list.setAttribute('tab', w.wcId); }
  };
  wv.addEventListener('did-attach', learnId);
  wv.addEventListener('dom-ready', () => { learnId(); nav(); });
  wv.addEventListener('did-start-loading', () => { w.el.classList.add('loading'); w.err.hidden = true; });
  wv.addEventListener('did-stop-loading', () => { w.el.classList.remove('loading'); nav(); });
  wv.addEventListener('did-navigate', (e) => {
    // A source view reports the underlying page; keep showing (and saving) it as a source view.
    w.url = w.url.startsWith('view-source:') && w.url.slice(12) === e.url ? w.url : e.url;
    if (w.url.startsWith('view-source:')) w.title = 'Source: ' + e.url;
    setFavicon(w, ''); showTitle(w); nav(); scheduleSave(); dismissPerms(w); updateLock(w);
  });
  wv.addEventListener('did-navigate-in-page', (e) => { if (e.isMainFrame) { w.url = e.url; showTitle(w); nav(); scheduleSave(); } });
  wv.addEventListener('page-title-updated', (e) => { if (!w.url.startsWith('view-source:')) { w.title = e.title; showTitle(w); scheduleSave(); } });
  wv.addEventListener('page-favicon-updated', (e) => { setFavicon(w, e.favicons[0]); scheduleSave(); });
  wv.addEventListener('did-fail-load', (e) => {
    if (!e.isMainFrame || e.errorCode === -3) return; // -3 = aborted (e.g. superseded by another load)
    pageFailed(w, e);
  });
  wv.addEventListener('render-process-gone', (e) => { if (e.reason !== 'clean-exit') showError(w, 'This page crashed', w.url); });
  wv.addEventListener('found-in-page', (e) => {
    if (findWin === w) findCount.textContent = e.result.matches ? `${e.result.activeMatchOrdinal}/${e.result.matches}` : '0/0';
  });
  wv.addEventListener('ipc-message', (e) => {
    const [arg] = e.args;
    if (e.channel === 'activate') setActive(w);
    else if (e.channel === 'nav') arg === 'back' ? wv.canGoBack() && wv.goBack() : wv.canGoForward() && wv.goForward();
    else if (e.channel === 'textzoom') pageZoom(w, arg.dy < 0 ? 1.1 : 1 / 1.1);
    else if (e.channel === 'zoom') {
      const r = wv.getBoundingClientRect(), s = r.width / (wv.offsetWidth || 1);
      zoomAt(r.left + arg.x * s, r.top + arg.y * s, wheelFactor(arg.dy, arg.mode));
    }
  });
}

// ---------------------------------------------------------------- permission requests
// A slim bar at the top of the asking window. Nothing blocks: ignore it and the
// page simply doesn't get the permission. Allow/Block are remembered for the site.
function askPermission(w, { id, host, text, yes = 'Allow', no = 'Block', once = false }) {
  const bar = document.createElement('div');
  bar.className = 'perm';
  bar.innerHTML = `<span class="msg"><b></b> <span></span></span>
    <button class="no"></button><button class="yes"></button><button class="x" title="Not now">×</button>`;
  $('b', bar).textContent = host;
  $('.msg span', bar).textContent = text;
  $('.yes', bar).textContent = yes;
  $('.no', bar).textContent = no;
  const answer = (allow, remember) => {
    if (!w.perms.has(id)) return;
    w.perms.delete(id);
    bar.remove();
    window.drift.answerPermission(id, allow, remember);
  };
  $('.yes', bar).onclick = () => answer(true, !once);
  $('.no', bar).onclick = () => answer(false, !once);
  $('.x', bar).onclick = () => answer(false, false);
  w.perms.set(id, answer);
  w.permBox.appendChild(bar);
}
function dismissPerms(w) { for (const answer of [...w.perms.values()]) answer(false, false); }

window.drift.onPermission((req) => {
  const w = wins.find((o) => o.wcId === req.wcId) || active;
  if (!w) return window.drift.answerPermission(req.id, false, false);
  askPermission(w, req);
});

// ---------------------------------------------------------------- mute / pause
const SPEAKER = '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 6h2.3L8 3.3v9.4L4.8 10H2.5z" fill="currentColor"/>';
function updateAudio(w) {
  scheduleTabs();
  const show = w.muted || w.audible;
  w.audioBtn.hidden = !show;
  if (!show) return;
  w.audioBtn.classList.toggle('muted', w.muted);
  w.audioBtn.title = w.muted ? 'Muted — click to unmute' : 'Playing sound — click to mute';
  w.audioBtn.innerHTML = SPEAKER + (w.muted ? '<path d="M11 6l4 4M15 6l-4 4"/></svg>' : '<path d="M10.5 5.5a3.5 3.5 0 0 1 0 5M12.5 3.5a6.3 6.3 0 0 1 0 9"/></svg>');
}

// Paused windows show a dimmed snapshot; the page itself is gone until resumed.
function pauseWin(w, snapshot) {
  scheduleTabs();
  if (!w.wv) return;
  dismissPerms(w);
  if (findWin === w) closeFind();
  w.wv.remove(); // ends the page's renderer process
  w.wv = null; w.wcId = null; w.audible = false; w.paused = true;
  w.el.classList.remove('live', 'loading');
  w.el.classList.add('paused');
  w.back.disabled = w.fwd.disabled = true;
  let snap = $('.snap', w.body);
  if (!snap) {
    snap = document.createElement('div');
    snap.className = 'snap';
    snap.innerHTML = '<img alt=""><div class="resume"><span>⏸</span> Paused · click to resume</div>';
    snap.addEventListener('pointerdown', (e) => { if (e.button === 0) resumeWin(w); });
    w.body.appendChild(snap);
  }
  const img = $('img', snap);
  if (snapshot) img.src = snapshot; else img.removeAttribute('src');
  updateAudio(w); showTitle(w); scheduleSave();
}
function resumeWin(w) {
  scheduleTabs();
  if (!w.paused) return;
  w.paused = false;
  w.el.classList.remove('paused');
  $('.snap', w.body)?.remove();
  if (w.url) load(w, w.url);
  scheduleSave();
}

function showError(w, title, detail, actions) {
  w.el.classList.remove('loading');
  $('.t', w.err).textContent = title;
  $('.d', w.err).textContent = detail || '';
  // actions: [{ label, run, danger }]; default is a single "Try again".
  const box = $('.acts', w.err);
  box.textContent = '';
  for (const a of actions || [{ label: 'Try again', run: () => w.url && load(w, w.url) }]) {
    const b = document.createElement('button');
    b.textContent = a.label;
    if (a.danger) b.className = 'danger';
    b.onclick = a.run;
    box.appendChild(b);
  }
  w.err.hidden = false;
}

// Failed page loads: explain certificate problems and HTTPS-only upgrades plainly.
// Sites sometimes link to Chrome's own settings (e.g. Netflix → chrome://settings/content/protectedContent).
// Float has no chrome:// pages; send those to the matching Float settings section instead.
function driftSettingsFor(url) {
  const m = /^chrome:\/\/settings\/?(.*)$/i.exec(url || '');
  if (!m) return null;
  const p = m[1].toLowerCase();
  if (/protectedcontent|drm/.test(p)) return 'about'; // says whether Widevine is available
  if (/content|siteData|cookies/i.test(p)) return p.includes('cookies') ? 'privacy' : 'sites';
  if (/privacy|security|clear/.test(p)) return 'privacy';
  if (/password|autofill|extension/.test(p)) return 'extensions';
  return 'general';
}

async function pageFailed(w, e) {
  const url = e.validatedURL;
  if (/^chrome:\/\//i.test(url)) {
    const section = driftSettingsFor(url);
    if (section && w.wv && !w.wv.canGoBack()) { closeWin(w); return openSettings(section); } // a window opened just for it
    return showError(w, 'Float doesn’t have Chrome’s internal pages', `${url} is a Chrome settings page.${section ? ' Float’s own settings cover the same thing.' : ''}`,
      [...(section ? [{ label: 'Open Float settings', run: () => openSettings(section) }] : []), { label: 'Go back', run: () => w.wv && w.wv.canGoBack() && w.wv.goBack() }]);
  }
  if (e.errorCode <= -200 && e.errorCode > -300) { // certificate errors
    const c = await window.drift.certError(url);
    let host = url;
    try { host = new URL(url).host; } catch {}
    return showError(w, 'This connection isn’t private',
      `${host} presented a certificate Float can’t trust (${e.errorDescription}${c && c.issuer ? `, issued by ${c.issuer}` : ''}). `
      + 'Someone could be pretending to be this site, or it is misconfigured. Passwords or card details you enter could be stolen.',
      [{ label: 'Go back', run: () => (w.wv && w.wv.canGoBack() ? w.wv.goBack() : closeWin(w)) },
       { label: 'Proceed anyway (unsafe)', danger: true, run: async () => { await window.drift.allowCert(url); w.wv.loadURL(url).catch(() => {}); } }]);
  }
  const http = await window.drift.httpsFallback(url);
  if (http) {
    return showError(w, 'No secure connection available',
      `HTTPS-only mode tried ${url} but the site didn’t answer securely (${e.errorDescription}). The plain HTTP version is not encrypted: others on your network could see or change it.`,
      [{ label: 'Go back', run: () => (w.wv && w.wv.canGoBack() ? w.wv.goBack() : closeWin(w)) },
       { label: 'Continue to HTTP site', danger: true, run: async () => { await window.drift.allowHttp(http); w.wv.loadURL(http).catch(() => {}); } }]);
  }
  showError(w, 'Couldn’t load this page', `${e.errorDescription} · ${url}`);
}

function reload(w, hard) {
  if (!w.wv) return w.url && load(w, w.url);
  w.err.hidden = true;
  hard ? w.wv.reloadIgnoringCache() : w.wv.reload();
}

function setActive(w, focus = false) {
  if (active !== w) {
    if (active) active.el.classList.remove('active');
    active = w;
    if (w) {
      w.el.classList.add('active');
      w.activatedAt = performance.now();
      if (w.wcId) { window.drift.tabActive(w.wcId); extBar.list.setAttribute('tab', w.wcId); }
      w.z = ++zTop;
      w.el.style.zIndex = w.z; // z-index only: moving a <webview> in the DOM would reload it
    }
    scheduleSave();
    scheduleTabs();
  }
  if (w && focus) (w.wv ? w.wv : w.input).focus({ preventScroll: true });
}

function closeWin(w) {
  const i = wins.indexOf(w);
  if (i < 0) return;
  if (w.space !== 'private') {
    closed.push({ x: w.x, y: w.y, w: w.w, h: w.h, url: w.url, title: w.title, favicon: w.favicon, space: w.space });
    if (closed.length > 30) closed.shift();
  }
  if (findWin === w) closeFind();
  if (fullWin === w) exitFull();
  wins.splice(i, 1);
  w.el.remove();
  scheduleTabs();
  if (w.space === 'private' && !wins.some((o) => o.space === 'private')) window.drift.privateClosed();
  if (active === w) {
    active = null;
    const c = { x: w.x + w.w / 2, y: w.y + w.h / 2 };
    let best = null, bd = Infinity;
    for (const o of wins) { const d = Math.hypot(o.x + o.w / 2 - c.x, o.y + o.h / 2 - c.y); if (d < bd) { bd = d; best = o; } }
    setActive(best);
  }
  invalidate();
}

// ---------------------------------------------------------------- placement
function overlaps(x, y, w, h, skip) {
  const g = GAP / 2;
  return wins.some((o) => o !== skip && x < o.x + o.w + g && x + w + g > o.x && y < o.y + o.h + g && y + h + g > o.y);
}
// Nearest free spot to (x, y), searching outward in a spiral.
function findFree(x, y, w, h) {
  if (!overlaps(x, y, w, h)) return { x, y };
  const step = 60;
  for (let r = 1; r <= 60; r++) {
    const ring = [];
    for (let i = -r; i <= r; i++) ring.push([i, -r], [i, r], [-r, i], [r, i]);
    // Nearest first; on ties prefer below, then to the right (reading order).
    ring.sort((a, b) => Math.hypot(...a) - Math.hypot(...b) || b[1] - a[1] || b[0] - a[0]);
    for (const [i, j] of ring) if (!overlaps(x + i * step, y + j * step, w, h)) return { x: x + i * step, y: y + j * step };
  }
  return { x: x + 40, y: y + 40 };
}

// A new window centred on a world point (double-click / canvas menu).
function openWindowAt(p, url, space) {
  const { w, h } = defaultSize();
  return openWindow({ x: p.x - w / 2, y: p.y - h / 2, w, h, url, space });
}

function openWindow({ url, x, y, w, h, parent, background, space } = {}) {
  // New windows open in the space of the window they came from (or the selected one).
  if (space == null) space = parent ? parent.space : active ? active.space : '';
  const size = defaultSize();
  w = w || (parent ? parent.w : size.w); h = h || (parent ? parent.h : size.h);
  if (x == null) {
    if (parent) { x = parent.x + parent.w + GAP; y = parent.y; }
    else { const c = viewCenter(); x = c.x - w / 2; y = c.y - h / 2; }
  }
  // An empty new window opens your own start page if you chose a URL for it (Settings → General).
  if (!url && /^https?:/i.test(config.startPage || '')) url = config.startPage;
  const pos = findFree(x, y, w, h);
  const win = createWin({ ...pos, w, h, url, space });
  if (background) { showTitle(win); return win; } // loads lazily once you drift to it
  if (url) load(win, url);
  setActive(win, true);
  reveal(win);
  return win;
}

// Lazy-load: a restored or background window starts its page only once it is
// on screen and big enough to see.
function lazyLoad() {
  const vx = cam.x, vy = cam.y, vw = W() / cam.z, vh = H() / cam.z;
  for (const w of wins) {
    if (w.wv || !w.url || w.paused || w.w * cam.z < 220) continue;
    if (w.x < vx + vw && w.x + w.w > vx && w.y < vy + vh && w.y + w.h > vy) load(w, w.url);
  }
}

// ---------------------------------------------------------------- keyboard nav
function navDir(dir) {
  const v = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] }[dir];
  const from = active ? { x: active.x + active.w / 2, y: active.y + active.h / 2 } : viewCenter();
  let best = null, bs = Infinity;
  for (const o of wins) {
    if (o === active) continue;
    const dx = o.x + o.w / 2 - from.x, dy = o.y + o.h / 2 - from.y;
    const along = dx * v[0] + dy * v[1], across = Math.abs(dx * v[1] - dy * v[0]);
    if (along <= 1) continue;
    const score = along + across * 2;
    if (score < bs) { bs = score; best = o; }
  }
  if (!best) return;
  setActive(best, true);
  centerOn(best.x + best.w / 2, best.y + best.h / 2, Math.min(cam.z, fitZoom(best.w, best.h)));
}

// Ctrl+Tab: visit every window in reading order (rows top to bottom, then left to right).
function cycle(dir) {
  if (!wins.length) return;
  const row = (w) => Math.round((w.y + w.h / 2) / 500);
  const order = [...wins].sort((a, b) => row(a) - row(b) || a.x - b.x);
  const i = order.indexOf(active);
  const next = order[(i + dir + order.length) % order.length];
  setActive(next, true);
  focusWin(next);
}

// ---------------------------------------------------------------- find in page
let findWin = null;
function openFind(w) {
  if (!w || !w.wv) return;
  findWin = w; findbar.hidden = false; findCount.textContent = '';
  findInput.focus(); findInput.select();
  if (findInput.value) w.wv.findInPage(findInput.value, { findNext: true });
}
function closeFind() {
  if (findWin && findWin.wv) { findWin.wv.stopFindInPage('clearSelection'); findWin.wv.focus({ preventScroll: true }); }
  findWin = null; findbar.hidden = true;
}
findInput.addEventListener('input', () => {
  if (!findWin) return;
  if (findInput.value) findWin.wv.findInPage(findInput.value, { findNext: true });
  else { findWin.wv.stopFindInPage('clearSelection'); findCount.textContent = ''; }
});
findInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeFind();
  else if (e.key === 'Enter' && findWin && findInput.value) findWin.wv.findInPage(findInput.value, { findNext: false, forward: !e.shiftKey });
});

// ---------------------------------------------------------------- canvas menu
// Right-click empty space: a short menu of things to do at that spot.
const cmenu = $('#cmenu');
let cmItems = [], cmSel = -1;
const hostOf = (u) => { try { return new URL(u).host.replace(/^www\./, ''); } catch { return u; } };
// Same "site" notion as main.js: hostname without www. (no port).
const siteOfURL = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };

function openCanvasMenu(sx, sy) {
  const at = toWorld(sx, sy), last = closed[closed.length - 1];
  cmItems = [
    { icon: '+', label: 'New window here…', key: 'Ctrl T', run: () => openSpotlight({ at }) },
    { icon: '◷', label: 'View history…', key: 'Ctrl H', run: () => openSpotlight({ at, mode: 'history' }) },
    ...(last ? [{ icon: '↺', label: 'Reopen closed window', sub: last.title || hostOf(last.url), key: 'Ctrl Shift T', run: () => reopenClosed(at) }] : []),
    { sep: true },
    { icon: '⤢', label: 'Show all windows', key: 'Ctrl 0', run: fitAll },
    { icon: '◎', label: 'Zoom to 100% here', key: 'Ctrl 1', run: () => centerOn(at.x, at.y, 1) },
  ];
  cmSel = -1;
  renderMenu(cmenu, cmItems, () => cmSel, (i) => { cmSel = i; }, runMenuItem);
  cmenu.hidden = false;
  const r = cmenu.getBoundingClientRect();
  cmenu.style.left = Math.max(8, Math.min(sx, W() - r.width - 8)) + 'px';
  cmenu.style.top = Math.max(8, Math.min(sy, H() - r.height - 8)) + 'px';
  cmenu.focus({ preventScroll: true });
}
function closeCanvasMenu() { cmenu.hidden = true; }
function runMenuItem(it) { closeCanvasMenu(); it.run(); }
cmenu.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') return closeCanvasMenu();
  if (e.key === 'Enter' && cmItems[cmSel]) return runMenuItem(cmItems[cmSel]);
  const d = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
  if (!d) return;
  e.preventDefault();
  cmSel = stepSel(cmItems, cmSel, d);
  markSel(cmenu, cmSel);
});
document.addEventListener('pointerdown', (e) => { if (!cmenu.hidden && !cmenu.contains(e.target)) closeCanvasMenu(); }, true);
window.addEventListener('blur', () => { if (!cmenu.hidden) closeCanvasMenu(); });
cmenu.addEventListener('contextmenu', (e) => e.preventDefault());

// Shared list rendering for the menu and the spotlight.
function renderMenu(box, items, getSel, setSel, run) {
  box.textContent = '';
  items.forEach((it, i) => {
    const el = document.createElement('div');
    if (it.sep) el.className = 'sep';
    else if (it.header) { el.className = 'hdr'; el.textContent = it.header; }
    else {
      el.className = 'item' + (i === getSel() ? ' sel' : '');
      el.innerHTML = (it.noIcon ? '' : '<span class="ic"></span>') + '<span class="lb"><span class="l"></span><span class="s"></span></span><span class="k"></span>';
      if (it.noIcon) el.classList.add('plain');
      const ic = $('.ic', el);
      if (!ic) { /* bookmarks: text only */ } else if (it.favicon) {
        const img = document.createElement('img');
        img.src = it.favicon;
        img.onerror = () => { ic.textContent = it.icon || ''; img.remove(); };
        ic.appendChild(img);
      } else ic.textContent = it.icon || '';
      $('.l', el).textContent = it.label;
      $('.s', el).textContent = it.sub || '';
      $('.k', el).textContent = it.key || '';
      if (it.remove) {
        const del = document.createElement('button');
        del.className = 'del'; del.title = it.removeTitle || 'Remove from history'; del.textContent = '×';
        del.addEventListener('click', (e) => { e.stopPropagation(); it.remove(); });
        el.appendChild(del);
      }
      el.addEventListener('pointermove', () => { if (getSel() !== i) { setSel(i); markSel(box, i); } });
      el.addEventListener('click', () => run(it));
    }
    box.appendChild(el);
  });
}
function markSel(box, sel) {
  [...box.children].forEach((el, i) => el.classList.toggle('sel', i === sel));
  box.children[sel]?.scrollIntoView({ block: 'nearest' });
}
function stepSel(items, sel, d) {
  for (let i = sel + d; i >= 0 && i < items.length; i += d) if (items[i].run) return i;
  return sel;
}

function reopenClosed(at) {
  const c = closed.pop();
  if (!c) return;
  const r = createWin(at ? { ...c, ...findFree(at.x - c.w / 2, at.y - c.h / 2, c.w, c.h) } : c);
  if (c.url) load(r, c.url);
  setActive(r, true); reveal(r);
}

// ---------------------------------------------------------------- spotlight
// Ctrl+T: a frosted search bar. Type an address or search, or arrow down into
// history, open windows and commands. The footer holds the privacy switches.
const spot = $('#spot'), spotScrim = $('#spot-scrim'), spInput = $('input', spot), spList = $('.results', spot);
const spFoot = $('.foot', spot);
let sp = null; // { at, mode, items, sel, seq, site, url, settings }

function openSpotlight({ at = null, mode = 'launch', space, prompt } = {}) {
  closeCanvasMenu();
  if (space == null) space = active ? active.space : '';
  sp = { at, mode, space, prompt, items: [], sel: -1, seq: 0, url: active && active.wv ? active.url : '', wcId: active && active.wcId };
  spot.classList.toggle('history', ['history', 'places', 'bookmarks', 'import'].includes(mode));
  spInput.placeholder = prompt ? prompt.placeholder : { history: 'Search history', extensions: 'Search extensions', places: 'Search places', bookmarks: 'Search bookmarks', import: 'Import bookmarks from…' }[mode]
    || (space === 'private' ? 'Private window: search or enter address' : 'Search or enter address');
  spInput.value = prompt && prompt.value ? prompt.value : '';
  const chip = $('.space', spot), si = spaceInfo(space);
  chip.hidden = mode !== 'launch' || (!space && !spaces.spaces.length);
  chip.textContent = si.name;
  chip.style.setProperty('--space', si.color);
  spot.classList.toggle('private', space === 'private' && mode === 'launch');
  spot.hidden = spotScrim.hidden = false;
  spInput.focus({ preventScroll: true });
  refreshSpotlight();
}
function closeSpotlight() {
  if (!sp) return;
  sp = null;
  spot.hidden = spotScrim.hidden = true;
}

const timeAgo = (t) => {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + ' min ago';
  if (s < 86400) return Math.floor(s / 3600) + ' h ago';
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};
const dayLabel = (t) => {
  const d = new Date(t), today = new Date();
  const days = Math.round((new Date(today.toDateString()) - new Date(d.toDateString())) / 864e5);
  return days === 0 ? 'Today' : days === 1 ? 'Yesterday' : d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
};

function spOpen(url) {
  const space = sp ? sp.space : undefined, at = sp && sp.at;
  return () => (at ? openWindowAt(at, url, space) : openWindow({ url, space }));
}
const historyItem = (h, withTime) => ({
  favicon: h.icon, icon: '◷', label: h.title || hostOf(h.url), sub: hostOf(h.url) + (withTime ? '  ·  ' + timeAgo(h.t) : ''),
  url: h.url, run: spOpen(h.url),
  remove: async () => { await window.drift.historyRemove(h.url); refreshSpotlight(); },
});

async function refreshSpotlight() {
  if (!sp) return;
  const seq = ++sp.seq, q = spInput.value.trim();
  const st = await window.drift.settings(sp.url, sp.wcId);
  if (!sp || seq !== sp.seq) return;
  sp.settings = st;
  const items = [];

  if (sp.mode === 'prompt') {
    const pr = sp.prompt;
    items.push({ icon: '↵', label: q || pr.placeholder, sub: pr.hint || '', keep: true,
      run: () => { const v = spInput.value.trim(); if (!v) return; closeSpotlight(); pr.submit(v); } });
  } else if (sp.mode === 'places') {
    const list = placesMatching(q);
    if (!list.length) items.push({ header: q ? 'No matches' : 'No places yet — press Ctrl D to save the current view' });
    for (const pl of list) items.push(placeItem(pl, true));
  } else if (sp.mode === 'bookmarks') {
    const list = bookmarksMatching(q), SHOW = 400;
    if (!list.length) items.push({ header: q ? 'No matches' : `No bookmarks yet — press ${keyMap.bookmark || 'the ☆ in a window'} to add the page, or import them below` });
    let folder = null;
    for (const b of list.slice(0, SHOW)) {
      if (b.folder !== folder) { folder = b.folder; if (folder || list.some((x) => x.folder)) items.push({ header: folder || 'Bookmarks' }); }
      items.push(bookmarkItem(b, true));
    }
    if (list.length > SHOW) items.push({ header: `Showing ${SHOW} of ${list.length} — type to search` });
  } else if (sp.mode === 'import') {
    items.push({ header: 'Looking for other browsers…' });
    sp.items = items; renderMenu(spList, items, () => -1, () => {}, () => {}); spList.hidden = false;
    const sources = await window.drift.bookmarkSources();
    if (!sp || seq !== sp.seq) return;
    items.length = 0;
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    const ok = (t) => terms.every((x) => t.toLowerCase().includes(x));
    items.push({ header: sources.length ? 'Found on this computer' : 'No other browsers with bookmarks found on this computer' });
    for (const x of sources) if (ok(x.name)) items.push({ noIcon: true, label: `From ${x.name}`, sub: `${x.count.toLocaleString()} bookmark${x.count === 1 ? '' : 's'}`, keep: true, run: () => runImport(x.id) });
    items.push({ header: 'Or' });
    items.push({ noIcon: true, label: 'From a bookmarks file…', sub: 'An HTML file exported from any browser (Firefox, Safari, Chrome…)', keep: true, run: () => runImport('html') });
  } else if (sp.mode === 'history') {
    if (!st.history) items.push({ header: 'History is off — new visits aren’t saved' });
    const hits = await window.drift.historyQuery(q, 300);
    if (!sp || seq !== sp.seq) return;
    let day = '';
    for (const h of hits) {
      const d = dayLabel(h.t);
      if (d !== day) { items.push({ header: d }); day = d; }
      items.push(historyItem(h, true));
    }
    if (!hits.length) items.push({ header: q ? 'No matches' : 'No history yet' });
  } else if (sp.mode === 'extensions') {
    const exts = (await window.drift.extensions()).filter((x) => x.name.toLowerCase().includes(q.toLowerCase()));
    if (!sp || seq !== sp.seq) return;
    items.push({ icon: '+', label: 'Get extensions from the Chrome Web Store', sub: 'Opens in a new window', run: spOpen(WEB_STORE) });
    items.push({ header: exts.length ? 'Installed' : 'No extensions installed' });
    for (const x of exts) {
      items.push({ icon: '◆', label: x.name, sub: 'v' + x.version, keep: true, run: () => {},
        remove: async () => { await window.drift.removeExtension(x.id); flash(`Removed ${x.name}`); refreshSpotlight(); } });
    }
  } else if (q) {
    const url = toURL(q), isSearch = url === searchURL(q);
    items.push({ icon: isSearch ? '⌕' : '→', label: isSearch ? q : url, sub: isSearch ? 'Search' : 'Open address', key: '↵', run: spOpen(url) });
    const terms = q.toLowerCase().split(/\s+/);
    const winHits = wins.filter((w) => terms.every((t) => (w.title + ' ' + w.url).toLowerCase().includes(t))).slice(0, 3);
    if (winHits.length) items.push({ header: 'Open windows' });
    for (const w of winHits) items.push({ icon: '▢', label: w.title || w.url, sub: 'Switch to window', run: () => { setActive(w, true); focusWin(w); } });
    const bms = bookmarksMatching(q).slice(0, 4);
    if (bms.length) items.push({ header: 'Bookmarks' });
    for (const b of bms) items.push(bookmarkItem(b));
    const pls = placesMatching(q).slice(0, 3);
    if (pls.length) items.push({ header: 'Places' });
    for (const pl of pls) items.push(placeItem(pl));
    const hits = await window.drift.historyQuery(q, 6);
    if (!sp || seq !== sp.seq) return;
    if (hits.length) items.push({ header: 'History' });
    for (const h of hits) if (!bms.some((b) => b.url === h.url)) items.push(historyItem(h));
    const cmds = commands(st).filter((c) => terms.every((t) => c.words.some((w) => w.startsWith(t))));
    if (cmds.length) items.push({ header: 'Commands' });
    items.push(...cmds);
  } else {
    // Enter with nothing typed: a new empty window (it shows the start page).
    const priv = sp.space === 'private';
    items.push({ icon: '+', label: priv ? 'New private window' : 'New window', key: '↵',
      sub: config.startPage === 'blank' ? 'Empty' : /^https?:/i.test(config.startPage || '') ? 'Opens ' + hostOf(config.startPage) : 'Opens the start page',
      run: spOpen(undefined) });
    const pls = places.slice(0, 4);
    if (pls.length) items.push({ header: 'Places' });
    for (const pl of pls) items.push(placeItem(pl));
    if (st.history && sp.space !== 'private') {
      const recent = await window.drift.historyQuery('', 6);
      if (!sp || seq !== sp.seq) return;
      if (recent.length) items.push({ header: 'Recent' });
      for (const h of recent) items.push(historyItem(h));
    }
  }

  sp.items = items;
  sp.sel = items.findIndex((i) => i.run);
  renderMenu(spList, items, () => sp.sel, (i) => { sp.sel = i; }, runSpotItem);
  spList.hidden = !items.length;
  renderFooter(st);
}

// Everything the footer can do, also reachable by typing (e.g. "javascript", "cache").
const WEB_STORE = 'https://chromewebstore.google.com/';
function commands(st) {
  const c = [];
  const add = (label, sub, words, run) => c.push({ icon: '⚙', label, sub, words: (label + ' ' + words).toLowerCase().split(/\s+/), run, keep: true });
  add(st.history ? 'Turn off history' : 'Turn on history', 'Privacy', 'history privacy save record', () => toggleHistory(!st.history));
  add('View history', '', 'history all browse', () => { sp.mode = 'history'; openSpotlight({ at: sp.at, mode: 'history' }); });
  add('Clear history', 'Deletes every saved visit', 'history clear delete erase', clearHistory);
  add(st.adblock ? 'Turn off ad blocking' : 'Turn on ad blocking', 'Everywhere', 'ads adblock blocker ad block tracking trackers', () => toggleAdblock(!st.adblock));
  add('Extensions', 'Manage installed extensions', 'extensions addons plugins manage remove uninstall', () => openSpotlight({ at: sp.at, mode: 'extensions' }));
  const go = (fn) => () => { closeSpotlight(); fn(); };
  add('Settings', 'Search engine, privacy, spaces, shortcuts…', 'settings preferences options config', go(openSettings));
  add('Downloads', 'Ctrl J', 'downloads files', go(toggleDownloads));
  add('New private window', 'Nothing is saved', 'private incognito window new', () => openSpotlight({ at: sp.at, space: 'private' }));
  for (const x of [{ id: '', ...spaces.main }, ...spaces.spaces]) {
    if (x.id === sp.space) continue;
    add(`New window in ${x.name}`, 'Space: separate logins', `space new window ${x.name}`, () => openSpotlight({ at: sp.at, space: x.id }));
  }
  add('New space…', 'Separate logins and cookies, e.g. Work / Personal', 'space new create profile container', () => openSpotlight({
    mode: 'prompt', prompt: { placeholder: 'Name the new space (e.g. Work)', hint: 'Then open windows in it from the spotlight', submit: async (name) => {
      const x = await window.drift.createSpace(name); spaces = await window.drift.spaces(); wins.forEach(applySpace);
      openSpotlight({ space: x.id }); flash(`Space “${x.name}” created — this window will open in it`);
    } } }));
  const target = sp.wcId && wins.find((o) => o.wcId === sp.wcId);
  if (target) {
    for (const x of [{ id: '', ...spaces.main }, ...spaces.spaces]) {
      if (x.id === target.space) continue;
      add(`Move window to ${x.name}`, 'Reloads it with that space’s logins', `space move window ${x.name}`, go(() => moveToSpace(target, x.id)));
    }
    add('Site info', 'Connection, permissions, cookies, requests', 'site info security certificate cookies requests permissions', go(() => openSiteInfo(target)));
    add('Print…', 'Ctrl P', 'print pdf', go(() => window.drift.print(target.wcId)));
    add('View page source', 'Ctrl U', 'source html view', go(() => openWindow({ url: 'view-source:' + target.url, parent: target })));
  }
  if (target && /^(https?|ftp|file):/i.test(target.url)) {
    const on = bookmarkURLs.has(target.url);
    add(on ? 'Remove bookmark' : 'Bookmark this page', keyMap.bookmark || '', 'bookmark star favourite favorite save add remove', go(() => toggleBookmark(target)));
  }
  add('Bookmarks', keyMap.bookmarks || '', 'bookmarks favourites favorites saved', () => openSpotlight({ at: sp.at, mode: 'bookmarks' }));
  add('Import bookmarks…', 'From Chrome, Firefox, Brave, Edge or a file', 'bookmarks import chrome firefox brave edge vivaldi opera html', () => openSpotlight({ at: sp.at, mode: 'import' }));
  add('Export bookmarks…', 'As an HTML file any browser can import', 'bookmarks export backup html', go(exportBookmarks));
  add('Save this place', 'Ctrl D — name the current view', 'place save bookmark', go(savePlacePrompt));
  add('Places', 'Ctrl Shift O', 'places bookmarks saved', () => openSpotlight({ mode: 'places' }));
  add('Open data folder', 'Settings, history, permissions as plain JSON', 'data folder config files json', go(() => window.drift.openDataFolder()));
  add('Chrome Web Store', 'Install extensions', 'extensions store chrome web install addons', () => { closeSpotlight(); spOpen(WEB_STORE)(); });
  if (st.site) {
    add(st.ads ? `Allow ads on ${st.site}` : `Block ads on ${st.site}`, 'Site setting', 'ads adblock blocker ad block allow whitelist', () => setSite({ ads: !st.ads }));
    add(st.js ? `Disable JavaScript on ${st.site}` : `Enable JavaScript on ${st.site}`, 'Site setting', 'javascript js script', () => setSite({ js: !st.js }));
    add(st.cache ? `Turn off cache for ${st.site}` : `Turn on cache for ${st.site}`, 'Site setting', 'cache caching', () => setSite({ cache: !st.cache }));
    add(`Clear cache for ${st.site}`, 'Site setting', 'cache clear', clearCache);
    add(`Reset permissions for ${st.site}`, 'Site setting', 'permissions reset location camera notifications', resetPerms);
  }
  return c;
}

function renderFooter(st) {
  spFoot.textContent = '';
  const sw = (label, on, title, fn) => {
    const b = document.createElement('button');
    b.className = 'sw' + (on ? ' on' : '');
    b.title = title;
    b.innerHTML = '<i></i><span></span>';
    $('span', b).textContent = label;
    b.onclick = fn;
    return b;
  };
  const btn = (label, title, fn) => {
    const b = document.createElement('button');
    b.className = 'act'; b.textContent = label; b.title = title; b.onclick = fn;
    return b;
  };
  const left = document.createElement('div'), right = document.createElement('div');
  left.className = 'grp'; right.className = 'grp';
  left.append(sw('History', st.history, st.history ? 'Visits are saved. Click to stop saving history.' : 'History is off. Click to save visits again.', () => toggleHistory(!st.history)));
  left.append(sw('Ad block', st.adblock, st.adblockReady ? 'Block ads and trackers on all sites' : 'Filter lists not loaded yet (needs internet once)', () => toggleAdblock(!st.adblock)));
  if (sp.mode === 'history') left.append(btn('Clear history', 'Delete every saved visit', clearHistory));
  if (sp.mode === 'bookmarks') left.append(btn('Import…', 'From another browser or a bookmarks file', () => openSpotlight({ at: sp.at, mode: 'import' })),
    btn('Export…', 'Save every bookmark as an HTML file', () => { closeSpotlight(); exportBookmarks(); }));
  if (sp.mode === 'import') left.append(btn('‹ Bookmarks', 'Back to your bookmarks', () => openSpotlight({ at: sp.at, mode: 'bookmarks' })));
  if (sp.mode === 'extensions') left.append(btn('Chrome Web Store', 'Install extensions', () => { closeSpotlight(); spOpen(WEB_STORE)(); }));
  if (st.site) {
    const name = document.createElement('span');
    name.className = 'site'; name.textContent = st.site;
    if (st.adblock && st.ads && st.blocked) name.title = `${st.blocked} ads/trackers blocked on this page`;
    const count = document.createElement('span');
    count.className = 'count'; count.textContent = st.adblock && st.ads && st.blocked ? `${st.blocked} blocked` : '';
    right.append(name, count,
      ...(st.adblock ? [sw('Block ads', st.ads, `Block ads and trackers on ${st.site}`, () => setSite({ ads: !st.ads }))] : []),
      sw('JavaScript', st.js, `Run scripts on ${st.site}`, () => setSite({ js: !st.js })),
      sw('Cache', st.cache, `Keep a cache for ${st.site} (off = always fetch fresh)`, () => setSite({ cache: !st.cache })),
      btn('Clear cache', `Delete cached files of ${st.site}`, clearCache));
  }
  spFoot.append(left, right);
}

async function toggleAdblock(on) {
  await window.drift.setAdblock(on);
  flash(on ? 'Ad blocking on — reload pages to apply' : 'Ad blocking off — reload pages to apply');
  refreshSpotlight();
}
async function toggleHistory(on) { await window.drift.setHistory(on); refreshSpotlight(); }
async function clearHistory() { await window.drift.historyClear(); flash('History cleared'); refreshSpotlight(); }
async function setSite(patch) {
  const site = sp.settings.site;
  await window.drift.setSite(site, patch);
  // Reload every window showing this site so the change takes effect.
  for (const w of wins) {
    const h = siteOfURL(w.url);
    if (w.wv && (h === site || h.endsWith('.' + site))) w.wv.reloadIgnoringCache();
  }
  const [k, v] = Object.entries(patch)[0];
  flash(`${{ js: 'JavaScript', cache: 'Cache', ads: 'Ad blocking' }[k]} ${v ? 'on' : 'off'} for ${site}`);
  refreshSpotlight();
}
async function clearCache() { await window.drift.clearSiteCache(sp.settings.site); flash(`Cache cleared for ${sp.settings.site}`); }
async function resetPerms() { const n = await window.drift.resetSitePerms(sp.url); flash(n ? `Permissions reset for ${sp.settings.site}` : 'No saved permissions for this site'); }

// Brief confirmation in the spotlight footer.
function flash(msg) {
  let f = $('.flash', spot);
  if (!f) { f = document.createElement('div'); f.className = 'flash'; spot.appendChild(f); }
  f.textContent = msg;
  f.classList.remove('show'); void f.offsetWidth; f.classList.add('show');
}

function runSpotItem(it) {
  if (!it || !it.run) return;
  if (it.keep) return it.run();
  closeSpotlight();
  it.run();
}

spInput.addEventListener('input', refreshSpotlight);
spInput.addEventListener('keydown', async (e) => {
  if (!sp) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    if (['history', 'bookmarks', 'places'].includes(sp.mode) && spInput.value) { spInput.value = ''; return refreshSpotlight(); }
    return closeSpotlight();
  }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    sp.sel = stepSel(sp.items, sp.sel, e.key === 'ArrowDown' ? 1 : -1);
    return markSel(spList, sp.sel);
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    if (sp.items[sp.sel]) runSpotItem(sp.items[sp.sel]);
    else if (spInput.value.trim() && sp.mode !== 'prompt') { const u = toURL(spInput.value); spOpen(u)(); closeSpotlight(); }
    // Nothing typed, nothing picked: a new empty window (it shows the start page).
    else if (!spInput.value.trim() && (sp.mode === 'launch' || !sp.mode)) { spOpen(undefined)(); closeSpotlight(); }
    return;
  }
  // Shift+Delete forgets the highlighted history entry.
  if (e.key === 'Delete' && e.shiftKey && sp.items[sp.sel]?.url) {
    e.preventDefault();
    const it = sp.items[sp.sel];
    if (it.bookmark) { if (sp.mode !== 'bookmarks') return; await window.drift.removeBookmark(it.bookmark.id); }
    else await window.drift.historyRemove(it.url);
    refreshSpotlight();
  }
});
spotScrim.addEventListener('pointerdown', closeSpotlight);
spotScrim.addEventListener('wheel', (e) => e.preventDefault(), { passive: false });

// ---------------------------------------------------------------- extension toolbar
// Icons of installed extensions (top right), acting on the selected window.
const extBar = { el: $('#extbar'), list: $('#extbar browser-action-list') };
async function refreshExtBar() { extBar.el.hidden = !(await window.drift.extensions()).length; }
window.drift.onExtensionsChanged(refreshExtBar);
refreshExtBar();

// ---------------------------------------------------------------- window bar (top)
// One tab per open window (title only, no icons, to keep the bar calm), in the order they were opened. Click: fly to it (or, while a
// window fills the screen, show this one full instead). Middle-click or ×: close.
const tabBar = { el: $('#tabbar'), list: $('#tabbar .tabs') };
let tabsQueued = false;
function scheduleTabs() { if (!tabsQueued) { tabsQueued = true; requestAnimationFrame(renderTabs); } }
function setTabBar(on) {
  if (on === document.body.classList.contains('tabs')) return;
  const keep = viewCenter(); // keep the same spot in the middle of the visible area
  document.body.classList.toggle('tabs', on);
  if (!fullWin) centerOn(keep.x, keep.y, cam.z, 0);
  invalidate(); scheduleTabs(); updateTopReserve();
}
function renderTabs() {
  tabsQueued = false;
  if (!document.body.classList.contains('tabs')) return;
  const have = new Map([...tabBar.list.children].map((t) => [+t.dataset.id, t]));
  for (const w of wins) {
    let t = have.get(w.id);
    if (!t) {
      t = document.createElement('div');
      t.className = 'tab'; t.dataset.id = w.id; t.setAttribute('role', 'button');
      t.innerHTML = '<span class="tt"></span><span class="snd"></span><button class="x" title="Close (Ctrl W)">×</button>';
      t.addEventListener('click', (e) => {
        if (e.target.closest('.x')) return closeWin(w);
        if (fullWin) return fullWin === w ? null : enterFull(w);
        setActive(w, true); focusWin(w);
      });
      t.addEventListener('auxclick', (e) => { if (e.button === 1) { e.preventDefault(); closeWin(w); } });
      t.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); }); // no autoscroll
    }
    have.delete(w.id);
    tabBar.list.append(t); // keeps order; moving these plain elements is cheap
    const label = w.title || (w.url ? hostOf(w.url) : 'New window');
    $('.tt', t).textContent = label;
    t.title = w.url ? `${w.title || ''}${w.title ? '\n' : ''}${w.url}` : 'New window';
    $('.snd', t).textContent = w.muted ? '🔇' : w.audible ? '🔊' : '';
    t.classList.toggle('active', w === active);
    t.classList.toggle('paused', !!w.paused);
    t.classList.toggle('private', w.space === 'private');
    t.style.setProperty('--space', w.space ? spaceInfo(w.space).color : 'transparent');
  }
  for (const t of have.values()) t.remove();
  const a = active && tabBar.list.querySelector(`.tab[data-id="${active.id}"]`);
  if (a) a.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  markOnScreen();
}
// Tabs of windows you can currently see are brighter.
function markOnScreen() {
  if (!document.body.classList.contains('tabs')) return;
  for (const t of tabBar.list.children) {
    const w = wins.find((o) => o.id === +t.dataset.id);
    if (!w) continue;
    const sx = (w.x - cam.x) * cam.z, sy = (w.y - cam.y) * cam.z;
    const seen = fullWin ? w === fullWin : sx < W() && sy < H() && sx + w.w * cam.z > 0 && sy + w.h * cam.z > TOP();
    t.classList.toggle('seen', seen);
  }
}
tabBar.list.addEventListener('wheel', (e) => { if (!e.ctrlKey && Math.abs(e.deltaY) > Math.abs(e.deltaX)) { e.preventDefault(); tabBar.list.scrollLeft += e.deltaY; } }, { passive: false });
$('.tb-new', tabBar.el).onclick = () => openSpotlight();
tabBar.el.addEventListener('dblclick', (e) => { if (!e.target.closest('.tab, button')) openSpotlight(); });

// Room the floating top-right controls (extensions, downloads) take, so a full-screen
// window's title bar can keep its own buttons clear of them.
function updateTopReserve() {
  let left = innerWidth;
  for (const el of [extBar.el, $('#dlbtn')]) if (!el.hidden) { const r = el.getBoundingClientRect(); if (r.width) left = Math.min(left, r.left); }
  document.body.style.setProperty('--top-reserve', left < innerWidth ? Math.ceil(innerWidth - left + 6) + 'px' : '0px');
}
const topRO = new ResizeObserver(updateTopReserve);
topRO.observe(extBar.el); topRO.observe($('#dlbtn'));
new MutationObserver(updateTopReserve).observe($('#dlbtn'), { attributes: true, attributeFilter: ['hidden'] });
new MutationObserver(updateTopReserve).observe(extBar.el, { attributes: true, attributeFilter: ['hidden'] });
window.addEventListener('resize', updateTopReserve);

// ---------------------------------------------------------------- zoom bar
const zoomStep = (f) => { const c = viewCenter(); centerOn(c.x, c.y, cam.z * f, 180); };
const zoom100 = () => { const c = active ? { x: active.x + active.w / 2, y: active.y + active.h / 2 } : viewCenter(); centerOn(c.x, c.y, 1); };
$('#zoombar').addEventListener('click', (e) => {
  const z = e.target.dataset.z;
  if (z === 'in') zoomStep(1.25); else if (z === 'out') zoomStep(0.8);
  else if (z === '100') zoom100(); else if (z === 'fit') fitAll();
});

// ---------------------------------------------------------------- commands from main
window.drift.onCmd(({ cmd, arg, wcId }) => {
  // A command about a specific page acts only on that page's window (never falls back
  // to the active one: e.g. "close" arrives when a paused page's process ends).
  const w = wcId != null ? wins.find((o) => o.wcId === wcId) : active;
  switch (cmd) {
    case 'alt': return setAlt(arg);
    case 'new': return sp ? closeSpotlight() : openSpotlight();
    case 'history': return openSpotlight({ mode: 'history' });
    case 'close': return w && closeWin(w);
    case 'url':
      if (!w) return openSpotlight();
      setActive(w); reveal(w); w.input.focus({ preventScroll: true }); return w.input.select();
    case 'reload': return w && reload(w, false);
    case 'hard-reload': return w && reload(w, true);
    case 'back': return w && w.wv && w.wv.canGoBack() && w.wv.goBack();
    case 'forward': return w && w.wv && w.wv.canGoForward() && w.wv.goForward();
    case 'devtools': return w && w.wv && w.wv.openDevTools();
    // First press flies to the selected window; once it's in view, opens find-in-page.
    case 'find':
      if (!w) return;
      if (!isFocused(w)) { setActive(w, true); focusWin(w); } // bring it into view so the find bar is visible
      return openFind(w);
    case 'nav': return navDir(arg);
    case 'fit': return fitAll();
    case 'zoom100': return zoom100();
    case 'zoom-in': return zoomStep(1.25);
    case 'zoom-out': return zoomStep(0.8);
    case 'audio': if (w) { w.muted = arg.muted; w.audible = arg.audible; updateAudio(w); scheduleSave(); } return;
    case 'pause': return w && pauseWin(w, arg);
    case 'focus-win': if (w) { setActive(w, true); focusWin(w); } return;
    // First press flies to the window; once it's in view, the next fills the screen with it;
    // in full-window mode it goes back to the canvas.
    case 'full-win':
      if (fullWin) return exitFull();
      if (!w) return;
      if (!isFocused(w)) { setActive(w, true); return focusWin(w); }
      return enterFull(w);
    case 'cycle-next': return cycle(1);
    case 'cycle-prev': return cycle(-1);
    case 'reopen': return reopenClosed();
    case 'private': return openSpotlight({ space: 'private' });
    case 'downloads': return toggleDownloads();
    case 'places': return openSpotlight({ mode: 'places' });
    case 'bookmarks': return openSpotlight({ mode: 'bookmarks' });
    case 'bookmark': return arg && arg.url ? addBookmarkFor(arg) : w && toggleBookmark(w);
    case 'place': return savePlacePrompt();
    case 'settings': return openSettings();
    case 'site-info': return w && openSiteInfo(w);
    case 'print': return w && w.wcId && window.drift.print(w.wcId);
    case 'view-source': return w && w.url && openWindow({ url: 'view-source:' + w.url, parent: w });
    case 'page-zoom-in': return w && pageZoom(w, 1.1);
    case 'page-zoom-out': return w && pageZoom(w, 1 / 1.1);
    case 'page-zoom-reset': return w && pageZoom(w, 0);
    case 'captured-key': return onCapturedKey(arg);
  }
});

window.drift.onOpenWindow(({ url, query, fromId, background, reqId, space }) => {
  if (!reqId && driftSettingsFor(url)) return openSettings(driftSettingsFor(url));
  const parent = wins.find((o) => o.wcId === fromId) || active;
  // Extensions only live in the main space: their tabs always open there.
  const w = openWindow({ url: url || (query ? searchURL(query) : undefined), parent, background, space: reqId ? '' : space });
  if (reqId) {
    // An extension asked for a tab: it needs the page's webContents straight away.
    if (!w.wv) load(w, url || 'about:blank');
    // The page's id is available once attached, at the latest by dom-ready: report it then.
    let sent = false;
    const report = () => {
      if (sent) return;
      try { window.drift.tabReady(reqId, w.wv.getWebContentsId()); sent = true; } catch { /* not ready yet */ }
    };
    w.wv.addEventListener('did-attach', report, { once: true });
    w.wv.addEventListener('dom-ready', report, { once: true });
  }
});

// ---------------------------------------------------------------- session
let saveTimer = 0, restored = false;
function scheduleSave() { if (restored) { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 700); } }
function saveNow() {
  if (!restored) return;
  const list = [...wins].filter((w) => w.space !== 'private').sort((a, b) => a.z - b.z);
  window.drift.saveSession({
    version: 1,
    cam: fullWin && fullPrevCam ? { ...fullPrevCam } : { ...cam },
    active: active ? list.indexOf(active) : -1,
    wins: list.map(({ x, y, w, h, url, title, favicon, muted, paused, space }) => ({ x, y, w, h, url, title, favicon, muted, paused, space: space || undefined })),
  });
}
window.addEventListener('beforeunload', saveNow);
window.addEventListener('resize', invalidate);

(async () => {
  try { config = { ...config, ...(await window.drift.config()) }; } catch {}
  setTabBar(config.tabBar !== false);
  try { spaces = await window.drift.spaces(); } catch {}
  const s = await window.drift.loadSession().catch(() => null);
  if (s && Array.isArray(s.wins)) {
    for (const o of s.wins) if (o.space !== 'private') createWin({ ...o, space: spaces.spaces.some((x) => x.id === o.space) ? o.space : '' });
    if (s.cam) Object.assign(cam, { x: +s.cam.x || 0, y: +s.cam.y || 0, z: clamp(+s.cam.z || 1, MIN_Z, MAX_Z) });
    if (wins[s.active]) setActive(wins[s.active]);
  } else {
    cam.x = -W() / 2; cam.y = -H() / 2; // world origin in the middle of the screen
  }
  restored = true;
  invalidate();
})();
