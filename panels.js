'use strict';
// Float — panels on top of the canvas: toasts, places, downloads, site info and
// settings. Shares renderer.js's globals (wins, active, cam, spotlight helpers…).

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtBytes = (n) => {
  if (!n && n !== 0) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n < 10 && i ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
};
const fmtDate = (t) => (t ? new Date(typeof t === 'number' && t < 1e12 ? t * 1000 : t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '');
function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
function switchEl(on, onChange, title) {
  const b = el('button', 'sw' + (on ? ' on' : ''), '<i></i>');
  if (title) b.title = title;
  b.onclick = () => { b.classList.toggle('on'); onChange(b.classList.contains('on')); };
  return b;
}

// ---------------------------------------------------------------- toasts
// Short notices at the bottom; optional action buttons.
const toasts = $('#toasts');
function toast(msg, actions = [], ms = 3500) {
  const t = el('div', 'toast');
  t.append(el('span', '', esc(msg)));
  for (const a of actions) {
    const b = el('button', '', esc(a.label));
    b.onclick = () => { a.run(); t.remove(); };
    t.append(b);
  }
  toasts.append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, actions.length ? ms * 2 : ms);
  return t;
}

// ---------------------------------------------------------------- places
// A place is a named view of the canvas (where you were and how far zoomed), plus
// the windows that were in it, so it can bring them back if they were closed.
let places = [];
window.drift.places().then((p) => { places = Array.isArray(p) ? p : []; refreshStarts(); });
const savePlaces = () => { window.drift.savePlaces(places); refreshStarts(); };
function savePlacePrompt() {
  const c = viewCenter(), vw = W() / cam.z, vh = H() / cam.z;
  const inView = wins.filter((w) => w.space !== 'private' && w.x < cam.x + vw && w.x + w.w > cam.x && w.y < cam.y + vh && w.y + w.h > cam.y);
  const guess = (active && inView.includes(active) && (active.title || siteOfURL(active.url))) || '';
  openSpotlight({ mode: 'prompt', prompt: { placeholder: 'Name this place', value: guess, hint: `${inView.length} window${inView.length === 1 ? '' : 's'} in view`,
    submit: (name) => {
      places.unshift({ id: Date.now().toString(36), name, cx: c.x, cy: c.y, z: cam.z, t: Date.now(),
        wins: inView.map(({ x, y, w, h, url, title, favicon, space }) => ({ x, y, w, h, url, title, favicon, space })) });
      savePlaces();
      toast(`Saved place “${name}”`);
    } } });
}
const placesMatching = (q) => {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  return places.filter((p) => terms.every((t) => (p.name + ' ' + p.wins.map((w) => w.title + ' ' + w.url).join(' ')).toLowerCase().includes(t)));
};
function placeItem(pl, manage) {
  return {
    icon: '⚑', label: pl.name, sub: `${pl.wins.length} window${pl.wins.length === 1 ? '' : 's'} · saved ${timeAgo(pl.t)}`,
    run: () => goToPlace(pl),
    remove: manage ? () => { places = places.filter((x) => x !== pl); savePlaces(); refreshSpotlight(); } : undefined,
    removeTitle: 'Forget this place',
  };
}
function goToPlace(pl) {
  centerOn(pl.cx, pl.cy, pl.z, 420);
  // Windows saved with the place that are no longer on the canvas: offer to bring them back.
  const missing = pl.wins.filter((s) => !wins.some((w) => w.url === s.url && Math.abs(w.x - s.x) < 400 && Math.abs(w.y - s.y) < 400));
  if (missing.length) {
    toast(`${missing.length} window${missing.length === 1 ? '' : 's'} of “${pl.name}” ${missing.length === 1 ? 'was' : 'were'} closed`, [{
      label: 'Reopen', run: () => {
        for (const s of missing) {
          const space = !s.space || spaces.spaces.some((x) => x.id === s.space) ? s.space || '' : '';
          createWin({ ...s, space, ...findFree(s.x, s.y, s.w, s.h) });
        }
        invalidate(); scheduleSave();
      },
    }]);
  }
}

// ---------------------------------------------------------------- downloads
const dlBtn = $('#dlbtn'), dlPanel = $('#downloads'), dlList = $('.list', dlPanel);
let dls = [], dlSpeed = new Map(); // id -> { t, bytes, rate }
const appStart = Date.now();
window.drift.downloads().then((l) => { dls = l; renderDownloads(); });
window.drift.onDownloads((l) => {
  const now = Date.now();
  for (const d of l) {
    const s = dlSpeed.get(d.id);
    if (d.state === 'progressing' && s && now > s.t) {
      const r = (d.received - s.bytes) / ((now - s.t) / 1000);
      dlSpeed.set(d.id, { t: now, bytes: d.received, rate: s.rate ? s.rate * 0.7 + r * 0.3 : r });
    } else if (!s) dlSpeed.set(d.id, { t: now, bytes: d.received, rate: 0 });
  }
  dls = l; renderDownloads();
});
const dlToasts = new Map(); // download id -> its "Downloading…" toast, replaced when it ends
window.drift.onDownloadEvent((e) => {
  dlToasts.get(e.id)?.remove(); dlToasts.delete(e.id);
  if (e.type === 'started') dlToasts.set(e.id, toast(`Downloading ${e.filename}`, [{ label: 'Show', run: () => toggleDownloads(true) }]));
  else if (e.type === 'completed') toast(`Downloaded ${e.filename}`, [{ label: 'Open', run: () => window.drift.openDownload(e.id) }, { label: 'Show in folder', run: () => window.drift.showDownload(e.id) }]);
  else if (e.type === 'interrupted') toast(`Download failed: ${e.filename}`, [{ label: 'Retry', run: () => window.drift.retryDownload(e.id) }]);
});
function toggleDownloads(force) {
  const show = force ?? dlPanel.hidden;
  dlPanel.hidden = !show;
  if (show) { closeSettings(); renderDownloads(); }
}
const DL_ICON = { progressing: '↓', paused: '❚❚', completed: '✓', cancelled: '×', interrupted: '!' };
function renderDownloads() {
  const activeDl = dls.filter((d) => d.state === 'progressing' || d.state === 'paused');
  const recent = dls.some((d) => d.start >= appStart);
  dlBtn.hidden = !activeDl.length && !recent && dlPanel.hidden;
  const tot = activeDl.reduce((a, d) => a + (d.total || 0), 0), got = activeDl.reduce((a, d) => a + (d.received || 0), 0);
  dlBtn.style.setProperty('--p', activeDl.length && tot ? got / tot : activeDl.length ? 0.15 : 0);
  dlBtn.classList.toggle('busy', activeDl.length > 0);
  dlBtn.title = activeDl.length ? `${activeDl.length} download${activeDl.length > 1 ? 's' : ''} in progress (Ctrl J)` : 'Downloads (Ctrl J)';
  if (dlPanel.hidden) return;
  dlList.textContent = '';
  if (!dls.length) dlList.append(el('div', 'empty', 'Nothing downloaded yet'));
  for (const d of dls) {
    const row = el('div', 'dl ' + d.state);
    const sp = dlSpeed.get(d.id);
    let sub;
    if (d.state === 'progressing') {
      const left = sp && sp.rate > 0 && d.total ? Math.round((d.total - d.received) / sp.rate) : null;
      sub = `${fmtBytes(d.received)}${d.total ? ' of ' + fmtBytes(d.total) : ''}${sp && sp.rate ? ' · ' + fmtBytes(sp.rate) + '/s' : ''}${left != null ? ' · ' + (left > 90 ? Math.round(left / 60) + ' min' : left + ' s') + ' left' : ''}`;
    } else if (d.state === 'paused') sub = `Paused · ${fmtBytes(d.received)}${d.total ? ' of ' + fmtBytes(d.total) : ''}`;
    else if (d.state === 'completed') sub = d.exists === false ? 'Deleted or moved' : `${fmtBytes(d.received)} · ${timeAgo(d.end || d.start)}`;
    else if (d.state === 'cancelled') sub = 'Cancelled';
    else sub = 'Failed';
    let host = '';
    try { host = new URL(d.url).host; } catch {}
    row.innerHTML = `<span class="ic">${DL_ICON[d.state] || '↓'}</span>
      <span class="lb"><span class="l">${esc(d.filename)}${d.private ? ' <em>private</em>' : ''}</span><span class="s">${esc(sub)} · ${esc(host)}</span>
      ${d.state === 'progressing' || d.state === 'paused' ? `<span class="bar"><i style="width:${d.total ? Math.round(d.received / d.total * 100) : 10}%"></i></span>` : ''}</span>
      <span class="btns"></span>`;
    const btns = $('.btns', row);
    const b = (label, title, fn) => { const x = el('button', '', label); x.title = title; x.onclick = (e) => { e.stopPropagation(); fn(); }; btns.append(x); };
    if (d.state === 'progressing') { b('❚❚', 'Pause', () => window.drift.pauseDownload(d.id)); b('×', 'Cancel', () => window.drift.cancelDownload(d.id)); }
    if (d.state === 'paused') { b('▶', 'Resume', () => window.drift.resumeDownload(d.id)); b('×', 'Cancel', () => window.drift.cancelDownload(d.id)); }
    if (d.state === 'completed' && d.exists !== false) { b('Open', 'Open file', () => window.drift.openDownload(d.id)); b('Folder', 'Show in folder', () => window.drift.showDownload(d.id)); }
    if (d.state === 'interrupted' || d.state === 'cancelled') b('Retry', 'Download again', () => window.drift.retryDownload(d.id));
    if (d.state !== 'progressing' && d.state !== 'paused') b('✕', 'Remove from list (the file stays)', () => window.drift.removeDownload(d.id));
    if (d.state === 'completed' && d.exists !== false) row.ondblclick = () => window.drift.openDownload(d.id);
    dlList.append(row);
  }
}
dlBtn.onclick = () => toggleDownloads();
$('.open-folder', dlPanel).onclick = () => window.drift.openDownloadsFolder();
$('.clear', dlPanel).onclick = () => window.drift.clearDownloads();
$('.close', dlPanel).onclick = () => toggleDownloads(false);

// ---------------------------------------------------------------- site info
// Everything about the page in one window: connection, permissions, site settings,
// what it loaded (and what was blocked), its cookies, and the user's own CSS/script.
const siPanel = $('#siteinfo');
let siteInfoWin = null, siTab = 'overview', siTimer = 0, siFilter = '';
function openSiteInfo(w) {
  if (!w) return;
  closeSettings(); toggleDownloads(false);
  siteInfoWin = w; siTab = 'overview'; siFilter = '';
  siPanel.hidden = false;
  refreshSiteInfo();
  clearInterval(siTimer);
  siTimer = setInterval(() => { if (siTab === 'requests' || siTab === 'overview') refreshSiteInfo(true); }, 2000);
}
function closeSiteInfo() { siPanel.hidden = true; siteInfoWin = null; clearInterval(siTimer); }
async function refreshSiteInfo(live) {
  const w = siteInfoWin;
  if (!w) return;
  if (!wins.includes(w)) return closeSiteInfo();
  if (!w.wcId) {
    siPanel.innerHTML = `<div class="head"><b>${esc(siteOfURL(w.url) || 'New window')}</b><button class="close" title="Close">×</button></div>
      <div class="sec"><p class="muted">This window’s page isn’t loaded${w.paused ? ' (paused)' : ''}. Load it to see what it does.</p></div>`;
    $('.close', siPanel).onclick = closeSiteInfo;
    return;
  }
  const i = await window.drift.siteInfo(w.wcId);
  if (siteInfoWin !== w) return;
  // Keep typing focus / scroll positions during live refreshes of the request list.
  if (live && (siPanel.contains(document.activeElement) && document.activeElement.tagName === 'TEXTAREA')) return;
  const scroller = $('.body', siPanel), scroll = scroller ? scroller.scrollTop : 0;
  const sp = spaceInfo(w.space);
  siPanel.innerHTML = `
    <div class="head">${w.favicon ? `<img src="${esc(w.favicon)}" alt="">` : ''}<b>${esc(i.siteName || i.url)}</b>
      <span class="chip" style="--space:${esc(sp.color)}">${esc(sp.name)}</span><button class="close" title="Close">×</button></div>
    <div class="tabs">${['overview', 'requests', 'cookies', 'customize'].map((t) => `<button data-t="${t}" class="${t === siTab ? 'on' : ''}">${{ overview: 'Overview', requests: `Requests <em>${i.total}</em>`, cookies: 'Cookies & data', customize: 'Customize' }[t]}</button>`).join('')}</div>
    <div class="body"></div>`;
  $('.close', siPanel).onclick = closeSiteInfo;
  for (const b of siPanel.querySelectorAll('.tabs button')) b.onclick = () => { siTab = b.dataset.t; refreshSiteInfo(); };
  const body = $('.body', siPanel);
  ({ overview: siOverview, requests: siRequests, cookies: siCookies, customize: siCustomize })[siTab](body, i, w);
  if (live) body.scrollTop = scroll;
}

function siOverview(body, i, w) {
  // Connection
  let conn;
  if (i.url.startsWith('https:')) {
    const c = i.cert;
    if (i.certException) conn = `<div class="state bad">⚠ You bypassed a certificate warning for ${esc(i.host)}. This connection may not be private.</div>`;
    else conn = `<div class="state good">🔒 Secure connection (HTTPS)</div>`;
    if (c) {
      conn += `<dl><dt>Issued to</dt><dd>${esc(c.subject)}</dd><dt>Issued by</dt><dd>${esc(c.issuer)}${c.knownRoot === false ? ' <em>(not a public authority)</em>' : ''}</dd>
        <dt>Valid</dt><dd>${esc(fmtDate(c.validStart))} – ${esc(fmtDate(c.validExpiry))}</dd><dt>Fingerprint</dt><dd class="mono">${esc((c.fingerprint || '').replace(/^sha256\//, ''))}</dd></dl>`;
    } else conn += '<p class="muted">Certificate details weren’t captured for this connection (it was reused from earlier). Reload to see them.</p>';
  } else if (i.url.startsWith('http:')) conn = `<div class="state bad">⚠ Not secure: this page is not encrypted. Anyone on your network could read or change it.${i.httpsOnly ? '' : ' Turn on HTTPS-only mode in Settings to try the secure version first.'}</div>`;
  else conn = `<div class="state">${esc(i.url.split(':')[0])} page</div>`;
  if (i.private) conn += '<p class="muted">Private window: nothing from this page is saved, and its cookies are forgotten when the last private window closes.</p>';

  // Permissions
  const perms = i.permissions.length ? i.permissions.map((p) => `<div class="row"><span>${esc(p.label)}</span>
      <select data-k="${esc(p.key)}"><option value="1" ${p.allowed ? 'selected' : ''}>Allowed</option><option value="0" ${p.allowed ? '' : 'selected'}>Blocked</option></select>
      <button class="x" data-revoke="${esc(p.key)}" title="Forget: ask again next time">×</button></div>`).join('')
    : `<p class="muted">${i.private ? 'Private windows ask every time and remember nothing.' : 'No remembered permissions. When this site asks for something, a bar appears at the top of its window.'}</p>`;

  // Activity
  const third = i.domains.filter((d) => d.third);
  const bySite = new Map();
  for (const d of third) { const s = bySite.get(d.site) || { site: d.site, requests: 0, blocked: 0, hosts: [] }; s.requests += d.requests; s.blocked += d.blocked; s.hosts.push(d.host); bySite.set(d.site, s); }
  const thirdList = [...bySite.values()].sort((a, b) => b.requests - a.requests);
  const activity = `<p>${i.total} request${i.total === 1 ? '' : 's'} · <b>${i.blocked}</b> blocked · ${thirdList.length} other site${thirdList.length === 1 ? '' : 's'} contacted</p>
    ${thirdList.length ? `<div class="domains">${thirdList.slice(0, 40).map((s) => `<div class="row" title="${esc(s.hosts.join(', '))}"><span>${esc(s.site)}</span><span class="n">${s.requests}${s.blocked ? ` · <b class="blk">${s.blocked} blocked</b>` : ''}</span></div>`).join('')}</div>` : ''}
    <button class="link" data-goto="requests">See every request →</button>`;

  const r = i.rule;
  body.innerHTML = `
    <div class="sec"><h4>Connection</h4>${conn}</div>
    <div class="sec"><h4>Site settings <span class="muted">for ${esc(i.siteName)}</span></h4><div class="switches"></div>
      <div class="row zoom"><span>Page zoom</span><button data-z="out">−</button><b>${Math.round((i.zoom || 1) * 100)}%</b><button data-z="in">+</button><button data-z="reset">Reset</button></div></div>
    <div class="sec"><h4>Permissions</h4>${perms}</div>
    <div class="sec"><h4>What this page loaded</h4>${activity}</div>`;
  const sw = $('.switches', body);
  const add = (label, on, desc, patch) => {
    const row = el('div', 'row', `<span>${esc(label)}<small>${esc(desc)}</small></span>`);
    row.append(switchEl(on, async (v) => { await setSiteFor(w, i.siteName, patch(v)); }));
    sw.append(row);
  };
  if (i.adblockOn) add('Block ads and trackers', r.ads, 'Off = allow ads on this site', (v) => ({ ads: v }));
  add('JavaScript', r.js, 'Off = scripts don’t run (pages may break)', (v) => ({ js: v }));
  add('Cache', r.cache, 'Off = always fetch fresh, store nothing', (v) => ({ cache: v }));
  if (i.block3pc) add('Allow third-party cookies here', r.cookies3p, 'Some sign-ins and embeds need them', (v) => ({ cookies3p: v }));
  for (const b of body.querySelectorAll('[data-z]')) b.onclick = () => pageZoom(w, { in: 1.1, out: 1 / 1.1, reset: 0 }[b.dataset.z]);
  for (const s of body.querySelectorAll('select[data-k]')) s.onchange = async () => {
    // Change a remembered decision: forget it and store the new one.
    const key = s.dataset.k;
    await window.drift.setPermission(key, s.value === '1');
    refreshSiteInfo();
  };
  for (const b of body.querySelectorAll('[data-revoke]')) b.onclick = async () => { await window.drift.revokePermission(b.dataset.revoke); toast('Permission forgotten — the site will ask again'); refreshSiteInfo(); };
  for (const b of body.querySelectorAll('[data-goto]')) b.onclick = () => { siTab = b.dataset.goto; refreshSiteInfo(); };
}
async function setSiteFor(w, site, patch) {
  await window.drift.setSite(site, patch);
  for (const o of wins) {
    const h = siteOfURL(o.url);
    if (o.wv && (h === site || h.endsWith('.' + site))) o.wv.reloadIgnoringCache();
  }
  toast(`${site}: setting saved, page reloaded`);
  refreshSiteInfo();
}

function siRequests(body, i) {
  body.innerHTML = `<div class="sec"><input class="filter" placeholder="Filter: address, type, status, “blocked”…" value="${esc(siFilter)}">
    <p class="muted">Every request this page made since it loaded (newest last, up to 400 shown). Blocked = stopped by the ad blocker.</p>
    <table class="reqs"><thead><tr><th>Status</th><th>Type</th><th>Address</th></tr></thead><tbody></tbody></table></div>`;
  const tb = $('tbody', body), f = $('.filter', body);
  const draw = () => {
    const q = siFilter.toLowerCase();
    tb.innerHTML = i.requests.filter((r) => !q || [r.url, r.type, r.method, r.blocked ? 'blocked' : '', r.error || '', r.status || '', r.third ? 'third-party' : ''].join(' ').toLowerCase().includes(q)).map((r) => {
      let u = r.url;
      try { const x = new URL(r.url); u = /^(https?|wss?):$/.test(x.protocol) ? x.host + x.pathname + (x.search ? '?…' : '') : x.protocol + x.pathname; } catch {}
      if (u.length > 160) u = u.slice(0, 160) + '…'; // data: addresses can be megabytes long
      const st = r.blocked ? '<b class="blk">blocked</b>' : r.error ? `<span class="rq-err">${esc(r.error.replace('net::', ''))}</span>` : esc(r.status) + (r.cache ? ' <em>cache</em>' : '');
      return `<tr class="${r.blocked ? 'blocked' : ''}" title="${esc(r.method + ' ' + r.url)}"><td>${st}</td><td>${esc(r.type)}</td><td class="u">${esc(u)}</td></tr>`;
    }).join('');
  };
  f.oninput = () => { siFilter = f.value; draw(); };
  draw();
}

async function siCookies(body, i, w) {
  body.innerHTML = '<div class="sec"><p class="muted">Loading…</p></div>';
  const cookies = await window.drift.siteCookies(w.wcId, i.siteName);
  let est = null;
  try { est = await w.wv.executeJavaScript(`(async () => { let ls = 0; try { for (let k = 0; k < localStorage.length; k++) { const n = localStorage.key(k); ls += (n.length + (localStorage.getItem(n) || '').length) * 2; } } catch {}
      let u = 0; try { u = (await navigator.storage.estimate()).usage || 0; } catch {} return { usage: u + ls }; })()`); } catch {}
  if (siteInfoWin !== w || siTab !== 'cookies') return;
  body.innerHTML = `<div class="sec"><h4>Stored by ${esc(i.siteName)}${w.space === 'private' ? ' (private: forgotten on close)' : ''}</h4>
      <p>${cookies.length} cookie${cookies.length === 1 ? '' : 's'}${est ? ` · about ${fmtBytes(est.usage)} of site storage` : ''}</p>
      <button class="danger clear">Clear all data for ${esc(i.siteName)}</button>
      <p class="muted">Signs you out of this site and deletes its cookies, storage and cache in this space.</p></div>
    <div class="sec"><h4>Cookies</h4><p class="muted">Names and properties only; values are hidden.</p>
      <table class="reqs ck"><thead><tr><th>Name</th><th>Domain</th><th>Expires</th></tr></thead><tbody>${cookies.map((c) => `<tr title="${esc([c.secure && 'Secure', c.httpOnly && 'HttpOnly', c.sameSite && 'SameSite=' + c.sameSite].filter(Boolean).join(' · '))}"><td>${esc(c.name)}</td><td>${esc(c.domain)}</td><td>${c.session ? 'when closed' : esc(fmtDate(c.expires))}</td></tr>`).join('')}</tbody></table></div>`;
  $('.clear', body).onclick = async () => {
    await window.drift.clearSiteData(w.wcId, i.siteName);
    toast(`Cleared ${i.siteName}`, [{ label: 'Reload page', run: () => w.wv && w.wv.reload() }]);
    refreshSiteInfo();
  };
}

function siCustomize(body, i, w) {
  const r = i.rule;
  body.innerHTML = `<div class="sec"><h4>Your CSS for ${esc(i.siteName)}</h4>
      <textarea class="css" spellcheck="false" placeholder="e.g. .cookie-banner { display: none !important }">${esc(r.css || '')}</textarea>
      <h4>Your script for ${esc(i.siteName)}</h4>
      <textarea class="script" spellcheck="false" placeholder="Runs on every page of this site after it loads">${esc(r.script || '')}</textarea>
      <div class="row"><button class="save">Save and reload</button><span class="muted">Applies to ${esc(i.siteName)} and its subdomains, in every space.</span></div></div>`;
  $('.save', body).onclick = async () => {
    await window.drift.setSite(i.siteName, { css: $('.css', body).value.trim(), script: $('.script', body).value.trim() });
    if (w.wv) w.wv.reload();
    toast('Saved — reloading the page');
  };
}
siPanel.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSiteInfo(); });

// ---------------------------------------------------------------- settings
const setPanel = $('#settings'), setScrim = $('#settings-scrim');
let setSection = 'general', setData = null, capture = null;
const SECTIONS = [['general', 'General'], ['privacy', 'Privacy & security'], ['sites', 'Sites & data'], ['spaces', 'Spaces'], ['extensions', 'Extensions'], ['shortcuts', 'Shortcuts'], ['about', 'About & transparency']];
function openSettings(section) {
  closeSpotlight(); toggleDownloads(false); closeSiteInfo();
  if (section) setSection = section;
  setPanel.hidden = setScrim.hidden = false;
  renderSettings();
}
function closeSettings() {
  if (capture) stopCapture();
  setPanel.hidden = setScrim.hidden = true;
}
setScrim.onclick = closeSettings;
setPanel.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !capture) closeSettings(); });

async function renderSettings() {
  setData = await window.drift.allSettings();
  setPanel.innerHTML = `<nav>${SECTIONS.map(([k, l]) => `<button data-s="${k}" class="${k === setSection ? 'on' : ''}">${esc(l)}</button>`).join('')}</nav>
    <div class="content"><div class="top"><h2>${esc(SECTIONS.find((x) => x[0] === setSection)[1])}</h2><button class="close" title="Close (Esc)">×</button></div><div class="pane"></div></div>`;
  for (const b of setPanel.querySelectorAll('nav button')) b.onclick = () => { if (capture) stopCapture(); setSection = b.dataset.s; renderSettings(); };
  $('.close', setPanel).onclick = closeSettings;
  const pane = $('.pane', setPanel);
  await ({ general: sGeneral, privacy: sPrivacy, sites: sSites, spaces: sSpaces, extensions: sExtensions, shortcuts: sShortcuts, about: sAbout })[setSection](pane);
}
const setSet = async (patch) => { setData = await window.drift.setSettings(patch); refreshStarts(); return setData; };
function optRow(title, desc, control) {
  const r = el('div', 'opt', `<div class="txt"><b>${esc(title)}</b>${desc ? `<small>${desc}</small>` : ''}</div>`);
  r.append(control);
  return r;
}

async function sGeneral(pane) {
  const d = setData;
  // Search engine
  const sel = el('select');
  const known = Object.entries(d.searchEngines);
  const cur = known.find(([, e]) => e.url === d.search);
  sel.innerHTML = known.map(([k, e]) => `<option value="${k}" ${cur && cur[0] === k ? 'selected' : ''}>${esc(e.name)}</option>`).join('') + `<option value="custom" ${cur ? '' : 'selected'}>Custom…</option>`;
  const custom = el('input', 'wide');
  custom.placeholder = 'https://example.com/search?q=%s';
  custom.value = cur ? '' : d.search;
  custom.hidden = !!cur;
  sel.onchange = async () => {
    custom.hidden = sel.value !== 'custom';
    if (sel.value !== 'custom') { await setSet({ search: d.searchEngines[sel.value].url }); toast(`Searching with ${d.searchEngines[sel.value].name}`); }
    else custom.focus();
  };
  custom.onchange = async () => {
    if (!custom.value.includes('%s')) return toast('The address must contain %s where the search words go');
    await setSet({ search: custom.value.trim() }); toast('Custom search engine saved');
  };
  const sbox = el('div', 'stack'); sbox.append(sel, custom);
  pane.append(optRow('Search engine', 'Used when what you type isn’t an address.', sbox));

  // Keywords
  const kw = el('div', 'keywords');
  const drawKw = () => {
    kw.innerHTML = Object.entries(d.keywords).map(([k, u]) => `<div class="row"><code>${esc(k)}</code><span class="u">${esc(u)}</span><button class="x" data-k="${esc(k)}" title="Remove">×</button></div>`).join('')
      + '<div class="row add"><input class="k" placeholder="gh" size="6"><input class="u wide" placeholder="https://github.com/search?q=%s"><button>Add</button></div>';
    for (const b of kw.querySelectorAll('[data-k]')) b.onclick = async () => { const k2 = { ...d.keywords }; delete k2[b.dataset.k]; d.keywords = (await setSet({ keywords: k2 })).keywords; drawKw(); };
    $('.add button', kw).onclick = async () => {
      const k = $('.add .k', kw).value.trim(), u = $('.add .u', kw).value.trim();
      if (!k || !u.includes('%s')) return toast('Give a keyword and an address containing %s');
      d.keywords = (await setSet({ keywords: { ...d.keywords, [k]: u } })).keywords; drawKw();
    };
  };
  drawKw();
  pane.append(optRow('Search keywords', 'Type a keyword, a space and words: <code>gh electron</code> searches GitHub.', kw));

  // Downloads
  const dl = el('div', 'stack');
  dl.innerHTML = `<div class="row"><span class="path">${esc(d.downloads.dir || d.downloadsDefault)}</span><button class="ch">Change…</button>${d.downloads.dir ? '<button class="rs">Default</button>' : ''}</div>`;
  $('.ch', dl).onclick = async () => { const p = await window.drift.chooseDownloadsFolder(); if (p) { await setSet({ downloads: { dir: p } }); renderSettings(); } };
  if (d.downloads.dir) $('.rs', dl).onclick = async () => { await setSet({ downloads: { dir: '' } }); renderSettings(); };
  pane.append(optRow('Download to', 'Files are saved here without asking.', dl));
  pane.append(optRow('Ask where to save each file', '', switchEl(d.downloads.ask, (v) => setSet({ downloads: { ask: v } }))));
  pane.append(optRow('Spell check', 'Underlines misspelled words; right-click for suggestions.', switchEl(d.spellcheck, (v) => setSet({ spellcheck: v }))));

  pane.append(optRow('Window bar', 'A bar along the top listing every open window. Click one to fly to it.', switchEl(d.tabBar !== false, (v) => setSet({ tabBar: v }))));

  // What a new empty window shows
  pane.append(el('h3', '', 'New windows'));
  const sp = el('div', 'stack');
  const mode = d.startPage === 'drift' || d.startPage === 'blank' ? d.startPage : 'url';
  const own = el('input', 'wide'); own.placeholder = 'https://example.com'; own.value = mode === 'url' ? d.startPage : ''; own.hidden = mode !== 'url';
  const pick = el('select');
  pick.innerHTML = `<option value="drift">Float start page</option><option value="blank">Empty window</option><option value="url">A page of my choice…</option>`;
  pick.value = mode;
  pick.onchange = () => { own.hidden = pick.value !== 'url'; if (pick.value !== 'url') setSet({ startPage: pick.value }); else own.focus(); };
  own.onchange = () => { let u = own.value.trim(); if (u && !/^https?:\/\//i.test(u)) u = 'https://' + u; if (u) { own.value = u; setSet({ startPage: u }); } };
  sp.append(pick, own);
  pane.append(optRow('A new empty window shows', 'The start page is made on this computer from your own history and places; it loads nothing from the internet.', sp));
  if (d.startPage === 'drift') {
    pane.append(optRow('Most visited sites', 'From your history. Remove one with its ×.', switchEl(d.start.top, (v) => setSet({ start: { top: v } }))));
    pane.append(optRow('Blocking summary', 'How many ad and tracker requests Float stopped this week (counted locally, never sent).', switchEl(d.start.stats, (v) => setSet({ start: { stats: v } }))));
    if (d.startHidden.length) {
      const b = el('button', '', `Show ${d.startHidden.length} removed site${d.startHidden.length === 1 ? '' : 's'} again`);
      b.onclick = async () => { await window.drift.startUnhideAll(); refreshStarts(); renderSettings(); };
      pane.append(optRow('Removed from most visited', esc(d.startHidden.join(', ')), b));
    }
  }
}

async function sPrivacy(pane) {
  const d = setData;
  pane.append(el('h3', '', 'Tracking'));
  pane.append(optRow('Block ads and trackers', d.adblockReady ? 'EasyList-based lists, updated weekly. Turn off per site in its site info.' : 'Filter lists haven’t downloaded yet (needs internet once).',
    switchEl(d.adblock, async (v) => { await window.drift.setAdblock(v); toast(`Ad blocking ${v ? 'on' : 'off'} — reload pages to apply`); })));
  pane.append(optRow('Block third-party cookies', 'Sites you visit can’t let other companies (ad networks, trackers) set or read cookies through them. Some embedded sign-ins and widgets may stop working; allow them per site in its site info.',
    switchEl(d.block3pc, async (v) => { await setSet({ block3pc: v }); toast(`Third-party cookies ${v ? 'blocked' : 'allowed'} — reload pages to apply`); })));
  pane.append(el('h3', '', 'Connections'));
  pane.append(optRow('HTTPS-only mode', 'Always try the encrypted version of a site first. If a site has none, Float says so and lets you continue.',
    switchEl(d.httpsOnly, async (v) => { await setSet({ httpsOnly: v }); toast(`HTTPS-only ${v ? 'on' : 'off'}`); })));
  const dns = el('div', 'stack');
  dns.innerHTML = `<select class="mode"><option value="off">Off — use your system’s DNS</option><option value="automatic">Automatic — encrypt if your DNS provider supports it</option><option value="secure">On — always use this provider</option></select>
    <select class="prov">${Object.entries(d.dnsProviders).map(([k, p]) => `<option value="${k}">${esc(p.name)}</option>`).join('')}<option value="custom">Custom…</option></select>
    <input class="custom wide" placeholder="https://dns.example/dns-query">`;
  const mode = $('.mode', dns), prov = $('.prov', dns), cu = $('.custom', dns);
  mode.value = d.dns.mode; prov.value = d.dns.provider; cu.value = d.dns.custom || '';
  const vis = () => { prov.hidden = mode.value === 'off'; cu.hidden = mode.value === 'off' || prov.value !== 'custom'; };
  vis();
  mode.onchange = prov.onchange = async () => { vis(); await setSet({ dns: { mode: mode.value, provider: prov.value } }); toast('DNS setting applied'); };
  cu.onchange = async () => { if (!/^https:\/\//.test(cu.value)) return toast('A DNS-over-HTTPS address starts with https://'); await setSet({ dns: { custom: cu.value.trim() } }); toast('DNS setting applied'); };
  pane.append(optRow('Encrypted DNS', 'Hides which sites you look up from your network and internet provider (DNS-over-HTTPS).', dns));
  pane.append(el('h3', '', 'History and data'));
  pane.append(optRow('Save history', 'Off = new visits aren’t recorded. Private windows never are.', switchEl(d.history, (v) => window.drift.setHistory(v))));
  const clr = el('div', 'stack');
  clr.innerHTML = `<label><input type="checkbox" class="h" checked> History</label><label><input type="checkbox" class="c"> Cookies and site data (signs you out everywhere)</label><label><input type="checkbox" class="k" checked> Cached files</label><button class="danger">Clear now</button>`;
  $('button', clr).onclick = async () => {
    const what = { history: $('.h', clr).checked, cookies: $('.c', clr).checked, cache: $('.k', clr).checked };
    if (!what.history && !what.cookies && !what.cache) return;
    await window.drift.clearAllData(what);
    toast('Cleared: ' + Object.entries(what).filter(([, v]) => v).map(([k]) => ({ history: 'history', cookies: 'cookies and site data', cache: 'cache' }[k])).join(', '));
  };
  pane.append(optRow('Clear browsing data', 'In every space. Private windows keep nothing anyway.', clr));
}

async function sSites(pane) {
  const list = await window.drift.privacyOverview();
  pane.append(el('p', 'muted', 'Every site you’ve given a rule or a permission. Change a site’s settings from its site info (the lock / icon in its title bar).'));
  if (!list.length) pane.append(el('p', 'empty', 'No site rules or permissions yet.'));
  const LABEL = { js: (v) => (v === false ? 'JavaScript off' : ''), cache: (v) => (v === false ? 'Cache off' : ''), ads: (v) => (v === false ? 'Ads allowed' : ''),
    cookies3p: (v) => (v ? 'Third-party cookies allowed' : ''), zoom: (v) => `Zoom ${Math.round(v * 100)}%`, css: () => 'Custom CSS', script: () => 'Custom script' };
  for (const s of list) {
    const chips = Object.entries(s.rule).map(([k, v]) => LABEL[k] && LABEL[k](v)).filter(Boolean);
    const box = el('div', 'site', `<div class="row"><b>${esc(s.site)}</b><button class="x" title="Forget all settings and permissions for this site">Forget</button></div>
      ${chips.length ? `<div class="chips">${chips.map((c) => `<span>${esc(c)}</span>`).join('')}</div>` : ''}
      ${s.permissions.map((p) => `<div class="row perm"><span>${esc(p.label)} <small>${esc(p.origin)}</small></span><span class="${p.allowed ? 'ok' : 'no'}">${p.allowed ? 'Allowed' : 'Blocked'}</span><button class="x" data-k="${esc(p.key)}" title="Forget">×</button></div>`).join('')}`);
    $('.row .x', box).onclick = async () => { await window.drift.clearSiteRules(s.site); toast(`Forgot everything for ${s.site}`); renderSettings(); };
    for (const b of box.querySelectorAll('[data-k]')) b.onclick = async () => { await window.drift.revokePermission(b.dataset.k); renderSettings(); };
    pane.append(box);
  }
  pane.append(el('h3', '', 'Stored data'));
  const spSel = el('select');
  const all = [{ id: '', ...spaces.main }, ...spaces.spaces];
  spSel.innerHTML = all.map((x) => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('');
  const box = el('div', 'stored');
  const draw = async () => {
    const st = await window.drift.storageSites(spSel.value);
    box.innerHTML = st.length ? st.map((x) => `<div class="row"><span>${esc(x.site)}</span><span class="n">${x.cookies} cookie${x.cookies === 1 ? '' : 's'}</span><button class="x" data-s="${esc(x.site)}" title="Delete this site’s cookies and storage">Clear</button></div>`).join('') : '<p class="empty">Nothing stored.</p>';
    for (const b of box.querySelectorAll('[data-s]')) b.onclick = async () => { await window.drift.clearStorageSite(spSel.value, b.dataset.s); toast(`Cleared ${b.dataset.s}`); draw(); };
  };
  spSel.onchange = draw;
  if (all.length > 1) pane.append(optRow('Space', 'Each space stores its own data.', spSel));
  pane.append(box);
  draw();
}

async function sSpaces(pane) {
  spaces = await window.drift.spaces();
  pane.append(el('p', 'muted', 'A space has its own logins, cookies and site data — e.g. a Work and a Personal Google account side by side. Windows show their space’s colour. New windows open in the space of the window you’re in; the spotlight can open or move windows into any space. Extensions only run in the Main space.'));
  const COLORS = ['#7aa2f7', '#e0af68', '#9ece6a', '#f7768e', '#bb9af7', '#7dcfff', '#ff9e64', '#73daca'];
  const row = (x, isMain) => {
    const n = wins.filter((w) => w.space === x.id).length;
    const r = el('div', 'space-row');
    r.style.setProperty('--space', x.color);
    r.innerHTML = `<i class="dot"></i><input value="${esc(x.name)}"><span class="sw-colors">${COLORS.map((c) => `<button style="background:${c}" data-c="${c}" class="${c === x.color ? 'on' : ''}"></button>`).join('')}</span>
      <span class="n">${n} window${n === 1 ? '' : 's'}</span>${isMain ? '<span class="muted">default</span>' : '<button class="danger del">Delete</button>'}`;
    $('input', r).onchange = async (e) => { await window.drift.updateSpace(x.id, { name: e.target.value }); spaces = await window.drift.spaces(); wins.forEach(applySpace); };
    for (const b of r.querySelectorAll('[data-c]')) b.onclick = async () => { await window.drift.updateSpace(x.id, { color: b.dataset.c }); spaces = await window.drift.spaces(); wins.forEach(applySpace); renderSettings(); };
    if (!isMain) $('.del', r).onclick = async () => {
      if (!confirm(`Delete space “${x.name}”? Its logins, cookies and site data are deleted and its ${n} window${n === 1 ? '' : 's'} closed.`)) return;
      for (const w of wins.filter((o) => o.space === x.id)) closeWin(w);
      await window.drift.deleteSpace(x.id);
      spaces = await window.drift.spaces(); wins.forEach(applySpace);
      toast(`Deleted space “${x.name}”`); renderSettings();
    };
    return r;
  };
  pane.append(row({ id: '', ...spaces.main }, true));
  for (const x of spaces.spaces) pane.append(row(x));
  const add = el('div', 'row add', '<input placeholder="New space name, e.g. Work"><button>Create space</button>');
  $('button', add).onclick = async () => {
    const name = $('input', add).value.trim();
    if (!name) return;
    await window.drift.createSpace(name);
    spaces = await window.drift.spaces(); wins.forEach(applySpace); renderSettings();
  };
  pane.append(add);
}

async function sExtensions(pane) {
  const list = await window.drift.extensions();
  const top = el('div', 'row', '<button class="store">Get extensions from the Chrome Web Store</button>');
  $('.store', top).onclick = () => { closeSettings(); openWindow({ url: WEB_STORE, space: '' }); };
  pane.append(top);
  pane.append(el('p', 'muted', 'Extensions run in the Main space only. Float supports part of Chrome’s extension system: most page-changing and popup extensions work; downloads, declarativeNetRequest-based blockers and some other APIs don’t.'));
  if (!list.length) pane.append(el('p', 'empty', 'No extensions installed.'));
  for (const x of list) {
    const a = x.access || { hosts: [], apis: [] };
    const box = el('div', 'ext' + (x.enabled ? '' : ' off'), `<div class="row"><b>${esc(x.name)}</b><small>v${esc(x.version)}</small><span class="sp"></span><button class="danger rm">Remove</button></div>
      ${x.description ? `<p>${esc(x.description)}</p>` : ''}
      <p class="${a.all ? 'warn' : ''}">${esc(x.summary || '')}</p>
      ${a.hosts.length && !a.all ? `<p class="muted">Sites: ${esc(a.hosts.join(', '))}</p>` : ''}
      ${a.apis.length ? `<p class="muted">Can use: ${esc(a.apis.join(', '))}</p>` : ''}`);
    $('.sp', box).append(switchEl(x.enabled, async (v) => { await window.drift.setExtensionEnabled(x.id, v); toast(`${x.name} ${v ? 'turned on' : 'turned off'}`); renderSettings(); }, x.enabled ? 'Turn off (stays installed)' : 'Turn on'));
    $('.rm', box).onclick = async () => { if (!confirm(`Remove ${x.name}?`)) return; await window.drift.removeExtension(x.id); toast(`Removed ${x.name}`); renderSettings(); };
    pane.append(box);
  }
}

async function sShortcuts(pane) {
  const list = await window.drift.shortcuts();
  pane.append(el('p', 'muted', 'Click a shortcut to change it, then press the new keys (Esc cancels). Shortcuts work everywhere, including inside pages.'));
  const used = new Map();
  for (const b of list) for (const k of b.keys) used.set(k, (used.get(k) || []).concat(b.label));
  const t = el('div', 'shortcuts');
  for (const b of list) {
    const r = el('div', 'row', `<span>${esc(b.label)}</span><span class="keys">${b.keys.map((k) => `<kbd class="${used.get(k).length > 1 ? 'clash' : ''}" title="${used.get(k).length > 1 ? 'Also used by: ' + esc(used.get(k).filter((l) => l !== b.label).join(', ')) : ''}">${esc(k)}</kbd>`).join('') || '<em>none</em>'}</span>
      <button class="ch">Change</button>${b.keys.length ? '<button class="cl" title="Remove shortcut">×</button>' : ''}${b.custom ? '<button class="rs" title="Back to default">Default</button>' : ''}`);
    $('.ch', r).onclick = () => startCapture(b, r);
    if (b.keys.length) $('.cl', r).onclick = async () => { await window.drift.setShortcut(b.cmd, []); renderSettings(); loadKeys(); };
    if (b.custom) $('.rs', r).onclick = async () => { await window.drift.setShortcut(b.cmd, null); renderSettings(); loadKeys(); };
    t.append(r);
  }
  pane.append(t);
}
function startCapture(b, row) {
  if (capture) stopCapture();
  capture = { b, row };
  row.classList.add('capturing');
  $('.keys', row).innerHTML = '<em>Press the new shortcut…</em>';
  window.drift.captureKeys(true);
}
function stopCapture() { window.drift.captureKeys(false); capture = null; }
async function onCapturedKey(accel) {
  if (!capture) return;
  const { b } = capture;
  stopCapture();
  if (accel !== 'Escape') {
    const list = await window.drift.setShortcut(b.cmd, [accel]); loadKeys();
    const clash = list.filter((x) => x.cmd !== b.cmd && x.keys.includes(accel));
    toast(clash.length ? `${accel} is also used by “${clash[0].label}” — the first one listed wins` : `${b.label}: ${accel}`);
  }
  renderSettings();
}

async function sAbout(pane) {
  const [a, u, s] = await Promise.all([window.drift.about(), window.drift.updateState(), window.drift.allSettings()]);
  pane.innerHTML = `<div class="about">
    <p><b>Float ${esc(a.version)}</b> · Electron ${esc(a.electron)} · Chromium ${esc(a.chromium)}</p>
    <div class="updates"></div>
    <p>${a.widevine ? 'Protected video (Widevine DRM) is available: Netflix, Spotify, Disney+ and similar can play.' : '<b>Protected video (Netflix, Spotify, Disney+…) isn’t available in this build.</b> It needs the Widevine-enabled Electron from castLabs. In Float’s folder run <code>npm install --save-dev "https://github.com/castlabs/electron-releases#v41.10.7+wvcus"</code> and restart (rebuild with <code>npm run dist</code> for the packaged app).'}</p>
    <h3>What Float sends, and to whom</h3>
    <p><b>Float has no telemetry, analytics or crash reporting.</b> Besides the sites you open, these are the only connections Float makes on its own (checked with a network log of an idle start):</p>
    <ul>
      <li><b>Ad-block filter lists</b> — downloaded from Ghostery’s list repository on GitHub (<code>raw.githubusercontent.com</code>) once, then weekly, while ad blocking is on.</li>
      ${u.supported ? `<li><b>Float updates</b> — ${s.updates !== false ? 'at start and every 6 hours' : 'only when you click “Check now”'}, the update feed (<code>${esc(u.feed)}</code>) is asked for the latest version number. Updates download only when you say so.</li>` : ''}
      <li><b>Extension updates</b> — Chrome Web Store’s update service is asked about installed extensions (${a.extensions} installed).</li>
      <li><b>Spell-check dictionary</b> — downloaded once per language from Google’s download servers (<code>gvt1.com</code>) on first start, while spell check is on (General → Spell check).</li>
      ${a.widevine ? '<li><b>Widevine</b> — the DRM module is downloaded and updated from Google’s component servers.</li>' : ''}
      <li><b>Encrypted DNS</b> — if you turn it on, site lookups go to the provider you chose instead of your network’s DNS.</li>
    </ul>
    <p>Pages you visit see a normal Chrome browser (Google’s sign-in page sees Electron, so sign-in works).</p>
    <h3>Your data</h3>
    <p>Everything Float keeps is plain files in <code>${esc(a.dataPath)}</code>: <code>settings.json</code>, <code>history.json</code>, <code>permissions.json</code>, <code>places.json</code>, <code>downloads.json</code>, <code>session.json</code> (your canvas), <code>stats.json</code> (the start page’s blocking counts, last 7 days), plus the browser profile itself (cookies and site data).</p>
    <button class="open">Open data folder</button></div>`;
  renderUpdates($('.updates', pane), u, s);
  $('.open', pane).onclick = () => window.drift.openDataFolder();
}

// Keep the UI's copy of the search engine in sync when settings change it.
window.drift.onConfigChanged((c) => { config = { ...config, ...c }; setTabBar(config.tabBar !== false); refreshStarts(); });

// ---- Updates (packaged builds only) ----
function renderUpdates(box, u, s) {
  if (!box) return;
  if (!u.supported) { box.innerHTML = '<p class="muted">Updates: this copy runs from source or has no update feed, so it never checks. Update with git / npm, or install a packaged build.</p>'; return; }
  const line = {
    idle: 'Not checked yet.', checking: 'Checking…', current: `You have the latest version${u.checked ? ' (checked ' + fmtDate(u.checked) + ')' : ''}.`,
    available: `Version ${esc(u.version)} is available.`, downloading: `Downloading ${esc(u.version || '')}… ${Math.round(u.progress * 100)}%`,
    ready: `Version ${esc(u.version)} is ready.`, error: `Couldn’t check: ${esc(u.error)}`,
  }[u.status] || '';
  box.innerHTML = `<div class="opt"><div class="txt"><b>Updates</b><small>${line}</small></div><div class="stack"></div></div>`;
  const st = $('.stack', box);
  const btn = (label, fn) => { const b = el('button', '', esc(label)); b.onclick = fn; st.append(b); };
  if (u.status === 'available') btn('Download update', () => window.drift.downloadUpdate());
  else if (u.status === 'ready') btn('Restart to update', () => window.drift.installUpdate());
  else if (u.status !== 'checking' && u.status !== 'downloading') btn('Check now', () => window.drift.checkUpdates());
  const sw = switchEl(s.updates !== false, (on) => window.drift.setSettings({ updates: on }));
  const lab = el('label', '', '<span>Check automatically</span>'); lab.prepend(sw); st.append(lab);
}
window.drift.onUpdates((u) => {
  if (u.status === 'available') toast(`Float ${u.version} is available`, [{ label: 'Download', run: () => window.drift.downloadUpdate() }]);
  if (u.status === 'ready') toast(`Float ${u.version} is ready`, [{ label: 'Restart to update', run: () => window.drift.installUpdate() }]);
  const box = document.querySelector('#settings .about .updates');
  if (box) window.drift.allSettings().then((s) => renderUpdates(box, u, s));
});

// ---------------------------------------------------------------- start page
// What an empty window shows: search, your places, most visited sites and what Float
// blocked this week. Built here from local data only: no network requests (tiles use
// letters, not the sites' icons, so nothing is fetched).
// The logo mark: the Float feather without its tile (assets/logo-mark.svg, made by build/make-logo.py).
const FLOAT_MARK = '<img class="mark" src="assets/logo-mark.svg" alt="">';
const tileHue = (s) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const fmtNum = (n) => n.toLocaleString();

async function renderStart(w) {
  const box = $('.start', w.el);
  if (!box || w.url) return;
  if (config.startPage === 'blank') { box.hidden = true; return; } // the plain "type an address" placeholder
  box.hidden = false;
  let d;
  try { d = await window.drift.startData(); } catch { return; }
  if (w.url) { box.hidden = true; return; } // navigated meanwhile
  const priv = w.space === 'private';
  const p = d.protections;
  const chip = (on, label, tip) => `<span class="pchip ${on ? 'on' : 'off'}" title="${esc(tip)}">${on ? '●' : '○'} ${esc(label)}</span>`;
  const placeTiles = priv ? '' : places.slice(0, 6).map((pl, i) => `<button class="pl" data-i="${i}" title="Fly to this place">
      <b>${esc(pl.name)}</b><small>${pl.wins.length} window${pl.wins.length === 1 ? '' : 's'} · ${esc(timeAgo(pl.t))}</small></button>`).join('');
  const topTiles = priv ? '' : d.top.map((t, i) => `<div class="tile" data-i="${i}" title="${esc(t.title)}\n${esc(t.url)}">
      <span class="mono" style="--h:${tileHue(t.site)}">${esc(t.site[0].toUpperCase())}</span>
      <span class="nm">${esc(t.site)}</span>
      <button class="x" title="Remove from start page">×</button></div>`).join('');
  const st = d.stats;
  box.innerHTML = `<div class="st">
    <div class="st-brand">${FLOAT_MARK}<span>Float</span></div>
    <form class="st-search"><input spellcheck="false" placeholder="${esc(d.searchName ? `Search ${d.searchName} or type an address` : 'Search or type an address')}"></form>
    ${d.keywords.length ? `<div class="st-hint">Shortcuts: ${d.keywords.slice(0, 6).map((k) => `<code>${esc(k)}</code>`).join(' ')} + space + words</div>` : ''}
    ${priv ? `<div class="st-private"><b>Private window</b>
      <p>Nothing from this window is kept: no history, not saved with your canvas, and its cookies and site data are deleted when you close the last private window. Sites ask again for every permission.</p>
      <p class="muted">Not hidden: your network, your employer or school, and the sites themselves still see your visits. Downloads stay on disk.</p></div>` : ''}
    ${placeTiles ? `<section><h4>Places</h4><div class="st-places">${placeTiles}</div></section>` : ''}
    ${topTiles ? `<section><h4>Most visited</h4><div class="st-top">${topTiles}</div></section>` : ''}
    <div class="st-foot">
      ${st ? `<div class="st-stat">${st.total
        ? `<b>${fmtNum(st.total)}</b> ad and tracker requests blocked this week${st.today ? ` (${fmtNum(st.today)} today)` : ''}, from ${fmtNum(st.sites)} site${st.sites === 1 ? '' : 's'}${st.top.length ? ` — most from ${st.top.slice(0, 3).map((x) => `<code>${esc(x.site)}</code>`).join(', ')}` : ''}.`
        : (p.adblock ? 'Nothing blocked yet this week.' : 'Ad and tracker blocking is off.')}</div>` : ''}
      <div class="st-prot">
        ${chip(p.adblock, 'Ads & trackers blocked', 'Built-in blocker (EasyList-based lists)')}
        ${chip(p.block3pc, p.block3pc ? 'Third-party cookies blocked' : 'Third-party cookies allowed', 'Cookies set by embedded trackers on other sites')}
        ${chip(p.httpsOnly, p.httpsOnly ? 'HTTPS-only' : 'HTTPS-only off', 'Always try the encrypted version of a site first')}
        ${chip(!!p.dns, p.dns ? `Encrypted DNS: ${p.dns}` : 'System DNS', 'Which server looks up site addresses')}
        ${chip(p.history && !priv, priv ? 'Not saving history' : p.history ? 'Saving history' : 'Not saving history', 'Your visits are kept only on this computer')}
        <button class="link st-change">Change…</button>
      </div>
    </div></div>`;
  const input = $('.st-search input', box);
  $('.st-search', box).onsubmit = (e) => { e.preventDefault(); const url = toURL(input.value); if (url) load(w, url); };
  input.addEventListener('pointerdown', (e) => { e.stopPropagation(); setActive(w); });
  for (const b of box.querySelectorAll('.pl')) b.onclick = () => goToPlace(places[+b.dataset.i]);
  for (const t of box.querySelectorAll('.tile')) {
    const item = d.top[+t.dataset.i];
    t.onclick = (e) => {
      if (e.target.closest('.x')) { window.drift.startHide(item.site).then(refreshStarts); return; }
      if (e.ctrlKey) openWindow({ url: item.url, parent: w, background: true }); else load(w, item.url);
    };
    t.onauxclick = (e) => { if (e.button === 1) openWindow({ url: item.url, parent: w, background: true }); };
  }
  $('.st-change', box).onclick = () => openSettings('privacy');
  if (active === w && document.activeElement === document.body) input.focus({ preventScroll: true });
}
function refreshStarts() { for (const w of wins) if (!w.url) renderStart(w); }
