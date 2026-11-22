'use strict';
// Float — main process. Owns the native window, security policy for web
// content, keyboard shortcuts, context menus and everything stored on disk.
const { app, BrowserWindow, ipcMain, Menu, session, clipboard, webContents, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
// Must load before app 'ready': registers the crx:// scheme for extension icons.
const { ElectronChromeExtensions } = require('electron-chrome-extensions');
const { installChromeWebStore, uninstallExtension } = require('electron-chrome-web-store');
const { ElectronBlocker } = require('@ghostery/adblocker-electron');
const shortcuts = require('./lib/shortcuts');
const pageinfo = require('./lib/pageinfo');
const setupDownloads = require('./lib/downloads');
const { setupUpdates } = require('./lib/updates');
const { setupStats } = require('./lib/stats');

app.setName('Float');
const USER_DATA = process.env.FLOAT_USER_DATA || process.env.DRIFT_USER_DATA;
if (USER_DATA) app.setPath('userData', USER_DATA);
else migrateFromDrift();

// Float was called Drift: on the first start after the rename, copy the old profile
// (~/.config/Drift: canvas, history, logins, settings) to the new folder. The old
// folder is left untouched; delete it yourself once Float has everything.
function migrateFromDrift() {
  const now = app.getPath('userData'), old = path.join(path.dirname(now), 'Drift');
  // Electron creates the new folder as soon as the name is set, so check for a profile in it.
  const hasProfile = (d) => ['session.json', 'settings.json', 'history.json', 'Partitions'].some((f) => fs.existsSync(path.join(d, f)));
  if (hasProfile(now) || !hasProfile(old)) return;
  try {
    fs.cpSync(old, now, { recursive: true, filter: (src) => !/[\\/](Singleton(Lock|Cookie|Socket)|lockfile)$/.test(src) });
    console.log(`Float: copied your profile from ${old}`);
  } catch (err) { console.error('Float: could not copy the old Drift profile:', err.message); }
}
const DATA = (f) => path.join(app.getPath('userData'), f);
let stats = null; // created once the profile path is final (see whenReady)

// ---- Storage partitions ----
// The main space keeps Float's original profile. Every extra space has its own
// cookies, logins and storage; private windows share one in-memory partition that
// is wiped when the last private window closes.
const PARTITION = 'persist:drift';
const PRIVATE = 'drift-private';
const partitionFor = (space) => (space === 'private' ? PRIVATE : space ? `persist:drift-space-${space}` : PARTITION);
const sessions = new Map(); // partition -> Session (set up once)
const isPrivateSession = (ses) => sessions.get(PRIVATE) === ses;
const allowedPartition = (p) => p === PARTITION || p === PRIVATE || (loadSettings().spaces || []).some((s) => partitionFor(s.id) === p);

const SESSION_FILE = () => DATA('session.json');

// Everywhere except Google sign-in, present as plain Chrome (some sites refuse "Electron").
const ELECTRON_UA = app.userAgentFallback;
const CLEAN_UA = ELECTRON_UA
  .replace(/\s*Electron\/\S+/, '')
  .replace(new RegExp(`\\s*${app.getName()}\\/\\S+`, 'i'), '')
  .replace(/\s*ownbrowser\/\S+/i, '');
app.userAgentFallback = CLEAN_UA;

// ---- Settings (settings.json in the data folder) ----
const SEARCH_ENGINES = {
  duckduckgo: { name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=%s' },
  google: { name: 'Google', url: 'https://www.google.com/search?q=%s' },
  bing: { name: 'Bing', url: 'https://www.bing.com/search?q=%s' },
  brave: { name: 'Brave Search', url: 'https://search.brave.com/search?q=%s' },
  startpage: { name: 'Startpage', url: 'https://www.startpage.com/do/search?q=%s' },
  ecosia: { name: 'Ecosia', url: 'https://www.ecosia.org/search?q=%s' },
  kagi: { name: 'Kagi', url: 'https://kagi.com/search?q=%s' },
};
const DNS_PROVIDERS = {
  cloudflare: { name: 'Cloudflare (1.1.1.1)', url: 'https://cloudflare-dns.com/dns-query' },
  quad9: { name: 'Quad9 (malware blocking)', url: 'https://dns.quad9.net/dns-query' },
  google: { name: 'Google Public DNS', url: 'https://dns.google/dns-query' },
  mullvad: { name: 'Mullvad', url: 'https://dns.mullvad.net/dns-query' },
};
const SETTINGS_DEFAULTS = {
  history: true, adblock: true,
  block3pc: false, httpsOnly: false,
  dns: { mode: 'off', provider: 'cloudflare', custom: '' }, // off | automatic | secure
  search: null, keywords: null, // null = use config.json / Float's default
  downloads: { dir: '', ask: false },
  spellcheck: true,
  tabBar: true, // the bar of open windows along the top
  startPage: 'drift', // what a new empty window shows: 'drift' (start page), 'blank', or a URL
  start: { top: true, stats: true }, // start page sections
  startHidden: [], // sites removed from the start page's most visited
  updates: true, // packaged builds: check the update feed (never downloads without asking)
  spaces: [], // [{ id, name, color }]
  mainSpace: { name: 'Main', color: '#7aa2f7' },
  shortcuts: {},
  disabledExtensions: [], // [{ id, name, path }]
  sites: {}, // site -> { js:false, cache:false, ads:false, cookies3p:true, zoom:1.25, css:'', js_custom:'' }
};
const SETTINGS_FILE = () => DATA('settings.json');
let settings = null;
function loadSettings() {
  if (settings) return settings;
  let s = {};
  try { s = JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf8')); } catch {}
  settings = { ...SETTINGS_DEFAULTS, ...s };
  for (const k of ['dns', 'downloads', 'mainSpace', 'start']) settings[k] = { ...SETTINGS_DEFAULTS[k], ...(s[k] || {}) };
  settings.history = settings.history !== false;
  settings.adblock = settings.adblock !== false;
  return settings;
}
function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(SETTINGS_FILE()), { recursive: true });
    fs.writeFileSync(SETTINGS_FILE() + '.tmp', JSON.stringify(settings, null, 1));
    fs.renameSync(SETTINGS_FILE() + '.tmp', SETTINGS_FILE());
  } catch (err) { console.error('settings save failed:', err.message); }
}

// config.json (next to the app) is the original way to set the search engine; settings win.
function loadConfig() {
  let file = {};
  try { file = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')); }
  catch (err) { if (err.code !== 'ENOENT') console.error('config.json ignored:', err.message); }
  const s = loadSettings();
  return {
    search: s.search || file.search || SEARCH_ENGINES.duckduckgo.url,
    keywords: s.keywords || file.keywords || {},
    startPage: s.startPage || 'drift',
    tabBar: s.tabBar !== false,
  };
}

// A "site" is a hostname without www.; rules cover its subdomains too.
const siteOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };
const ruleFor = (url) => { const h = siteOf(url), s = loadSettings().sites; for (const k of Object.keys(s)) if (h === k || h.endsWith('.' + k)) return s[k]; return {}; };
const inSites = (url, list) => { const h = siteOf(url); return list.some((s) => h === s || h.endsWith('.' + s)); };
const sitePatterns = (s) => [`*://${s}/*`, `*://*.${s}/*`];
const headerKey = (headers, name) => Object.keys(headers).find((k) => k.toLowerCase() === name);
const isLocalHost = (h) => /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/.test(h) || h.endsWith('.local') || !h.includes('.');

let win = null;
const send = (channel, payload) => win && !win.isDestroyed() && win.webContents.send(channel, payload);

// ---- Keyboard shortcuts (work whether the host UI or a page has focus) ----
let matchShortcut = shortcuts.matcher(loadSettings().shortcuts);
let capturingKeys = false; // the settings panel is recording a new shortcut

function onInput(event, input, wc) {
  if (input.type !== 'keyDown' && input.key !== 'Alt') return;
  if (capturingKeys && input.type === 'keyDown') {
    const a = shortcuts.accelOf(input);
    if (a) { event.preventDefault(); send('cmd', { cmd: 'captured-key', arg: a }); }
    return;
  }
  if (input.key === 'Alt') {
    if (input.type === 'keyDown' && !input.isAutoRepeat) send('cmd', { cmd: 'alt', arg: true });
    if (input.type === 'keyUp') send('cmd', { cmd: 'alt', arg: false });
    return;
  }
  const sc = matchShortcut(input);
  if (!sc) return;
  event.preventDefault();
  if (sc.cmd === 'fullscreen') return win.setFullScreen(!win.isFullScreen());
  // Keys pressed in a page act on that page's window; keys in Float's own UI act on the selected one.
  send('cmd', wc.getType() === 'webview' ? { ...sc, wcId: wc.id } : sc);
}
const keyLabel = (cmd) => {
  const b = shortcuts.bindings(loadSettings().shortcuts).find((x) => x.cmd === cmd);
  return b && b.keys[0] ? b.keys[0] : undefined;
};

// ---- Right-click menu for pages ----
function contextMenu(wc, p) {
  const t = [];
  const sep = () => t.length && t[t.length - 1].type !== 'separator' && t.push({ type: 'separator' });
  const priv = isPrivateSession(wc.session);
  t.push({ label: 'Focus This Window', accelerator: keyLabel('focus-win'), click: () => send('cmd', { cmd: 'focus-win', wcId: wc.id }) });
  t.push({ label: 'Fill the Screen / Back to Canvas', accelerator: keyLabel('full-win'), click: () => send('cmd', { cmd: 'full-win', wcId: wc.id }) });
  t.push({ label: wc.isAudioMuted() ? 'Unmute Window' : 'Mute Window', click: () => setMuted(wc, !wc.isAudioMuted()) });
  t.push({ label: 'Pause Window (Free Memory)', click: () => pauseWindow(wc) });
  sep();
  const nh = wc.navigationHistory;
  if (p.linkURL) {
    t.push({ label: 'Open Link in New Window', click: () => send('open-window', { url: p.linkURL, fromId: wc.id }) });
    t.push({ label: 'Open Link Behind', click: () => send('open-window', { url: p.linkURL, fromId: wc.id, background: true }) });
    if (!priv) t.push({ label: 'Open Link in Private Window', click: () => send('open-window', { url: p.linkURL, fromId: wc.id, space: 'private' }) });
    t.push({ label: 'Copy Link Address', click: () => clipboard.writeText(p.linkURL) });
    t.push({ label: 'Download Linked File', click: () => wc.downloadURL(p.linkURL) });
    sep();
  }
  if (p.mediaType === 'image' && p.srcURL) {
    t.push({ label: 'Open Image in New Window', click: () => send('open-window', { url: p.srcURL, fromId: wc.id }) });
    t.push({ label: 'Save Image', click: () => wc.downloadURL(p.srcURL) });
    t.push({ label: 'Copy Image', click: () => wc.copyImageAt(p.x, p.y) });
    t.push({ label: 'Copy Image Address', click: () => clipboard.writeText(p.srcURL) });
    sep();
  }
  if ((p.mediaType === 'video' || p.mediaType === 'audio') && p.srcURL && !p.srcURL.startsWith('blob:')) {
    t.push({ label: `Save ${p.mediaType === 'video' ? 'Video' : 'Audio'}`, click: () => wc.downloadURL(p.srcURL) });
    sep();
  }
  if (p.isEditable && p.misspelledWord) {
    for (const s of p.dictionarySuggestions.slice(0, 4)) t.push({ label: s, click: () => wc.replaceMisspelling(s) });
    if (!p.dictionarySuggestions.length) t.push({ label: 'No suggestions', enabled: false });
    t.push({ label: `Add “${p.misspelledWord}” to Dictionary`, click: () => wc.session.addWordToSpellCheckerDictionary(p.misspelledWord) });
    sep();
  }
  if (p.isEditable) {
    t.push({ role: 'undo', enabled: p.editFlags.canUndo }, { role: 'redo', enabled: p.editFlags.canRedo }, { type: 'separator' });
    t.push({ role: 'cut', enabled: p.editFlags.canCut });
  }
  if (p.selectionText || p.isEditable) t.push({ role: 'copy', enabled: p.editFlags.canCopy });
  if (p.isEditable) t.push({ role: 'paste', enabled: p.editFlags.canPaste }, { role: 'selectAll' });
  if (p.selectionText && !p.isEditable) {
    const q = p.selectionText.trim().replace(/\s+/g, ' ');
    const short = q.length > 30 ? q.slice(0, 30) + '…' : q;
    t.push({ label: `Search for “${short}”`, click: () => send('open-window', { query: q, fromId: wc.id }) });
  }
  sep();
  if (!p.linkURL && !p.selectionText && !p.isEditable && p.mediaType === 'none') {
    t.push({ label: 'Back', enabled: nh.canGoBack(), click: () => nh.goBack() });
    t.push({ label: 'Forward', enabled: nh.canGoForward(), click: () => nh.goForward() });
    t.push({ label: 'Reload', click: () => wc.reload() });
    t.push({ type: 'separator' });
    t.push({ label: 'Print…', accelerator: keyLabel('print'), click: () => printPage(wc) });
    t.push({ label: 'Save Page As…', click: () => savePage(wc) });
    t.push({ label: 'View Page Source', accelerator: keyLabel('view-source'), click: () => send('cmd', { cmd: 'view-source', wcId: wc.id }) });
    t.push({ type: 'separator' });
  }
  t.push({ label: 'Site Info…', click: () => send('cmd', { cmd: 'site-info', wcId: wc.id }) });
  if (extensions && wc.session === sessions.get(PARTITION)) {
    const ext = extensions.getContextMenuItems(wc, p);
    if (ext.length) { sep(); t.push(...ext); sep(); }
  }
  t.push({ label: 'Inspect', click: () => wc.inspectElement(p.x, p.y) });
  Menu.buildFromTemplate(t).popup({ window: win });
}

function printPage(wc) {
  wc.print({}, (ok, reason) => { if (!ok && reason && reason !== 'cancelled') console.error('print failed:', reason); });
}
async function savePage(wc) {
  const name = (wc.getTitle() || 'page').replace(/[/\\?%*:|"<>]/g, '_').slice(0, 100);
  const r = await dialog.showSaveDialog(win, {
    defaultPath: path.join(downloads.folder(), name + '.html'),
    filters: [{ name: 'Web page, complete', extensions: ['html'] }],
  });
  if (!r.canceled && r.filePath) wc.savePage(r.filePath, 'HTMLComplete').catch((err) => console.error('save page failed:', err.message));
}

// ---- Permissions ----
// Requests show as a small bar inside the window that asked (never a blocking
// dialog). Allow/Block is remembered per site on disk; dismissing blocks once.
// Private windows always ask and never remember.
const PERMS_FILE = () => DATA('permissions.json');
let perms = null; // { "https://site permission": true|false }
const loadPerms = () => perms || (perms = (() => { try { return JSON.parse(fs.readFileSync(PERMS_FILE(), 'utf8')); } catch { return {}; } })());
function savePerms() {
  try { fs.mkdirSync(path.dirname(PERMS_FILE()), { recursive: true }); fs.writeFileSync(PERMS_FILE(), JSON.stringify(perms, null, 1)); }
  catch (err) { console.error('permissions save failed:', err.message); }
}
const PERM_TEXT = {
  geolocation: 'wants to know your location', notifications: 'wants to show notifications',
  media: 'wants to use your camera or microphone', 'clipboard-read': 'wants to read your clipboard',
  midi: 'wants to use MIDI devices', midiSysex: 'wants full control of MIDI devices',
  openExternal: 'wants to open an app on your computer', 'idle-detection': 'wants to know when you’re away',
  'speaker-selection': 'wants to choose your audio output', 'display-capture': 'wants to see your screen',
};
const PERM_NAMES = {
  geolocation: 'Location', notifications: 'Notifications', video: 'Camera', audio: 'Microphone', 'audio+video': 'Camera and microphone',
  media: 'Camera / microphone', 'clipboard-read': 'Read clipboard', midi: 'MIDI', midiSysex: 'MIDI (full control)',
  openExternal: 'Open apps', 'idle-detection': 'Idle detection', 'speaker-selection': 'Audio output', 'display-capture': 'Screen sharing',
};
const pendingPerms = new Map(); // id -> { cb, key }
let permSeq = 0;

function permKey(origin, permission, details) {
  if (permission !== 'media') return `${origin} ${permission}`;
  const types = (details.mediaTypes || []).slice().sort().join('+') || 'media';
  return `${origin} ${types}`;
}
function mediaText(details) {
  const t = details.mediaTypes || [];
  if (t.includes('video') && t.includes('audio')) return 'wants to use your camera and microphone';
  if (t.includes('video')) return 'wants to use your camera';
  if (t.includes('audio')) return 'wants to use your microphone';
  return PERM_TEXT.media;
}

ipcMain.on('permission-response', (_e, { id, allow, remember }) => {
  const p = pendingPerms.get(id);
  if (!p) return;
  if (remember && p.key) { loadPerms()[p.key] = !!allow; savePerms(); }
  p.cb(!!allow);
});

function resetPerms(origin) {
  const all = loadPerms();
  let n = 0;
  for (const k of Object.keys(all)) if (k.startsWith(origin + ' ')) { delete all[k]; n++; }
  if (n) savePerms();
  return n;
}

// ---- Google sign-in ----
// Google refuses sign-in ("This browser or app may not be secure") when a browser's
// identity contradicts itself. On Google's sign-in pages only, Float tells the plain
// truth: Electron's own user agent. Every other site gets the clean Chrome identity.
const GOOGLE_SIGNIN_HOSTS = ['accounts.google.com', 'accounts.youtube.com'];
const isSignInURL = (url) => { try { return GOOGLE_SIGNIN_HOSTS.includes(new URL(url).host); } catch { return false; } };

// ---- Request rules ----
// Electron allows one listener per webRequest event per session, so all request rules
// live here and are (re)registered on every session. URL filters are kept as narrow as
// the active features allow, so requests that need no rule never touch JavaScript.
const upgradedHosts = new Set(); // hosts HTTPS-only mode upgraded (for the fallback offer)
const httpAllowed = new Set(); // hosts the user let load over plain HTTP this run

function pageURLOf(d) {
  if (d.resourceType === 'mainFrame') return d.url;
  // Look the page up by id: reading d.webContents inside a request hook can crash
  // Electron natively (seen with Google's cookie-rotation iframe on signed-in YouTube).
  const wc = d.webContentsId != null ? webContents.fromId(d.webContentsId) : null;
  try { return (wc && !wc.isDestroyed() && wc.getURL()) || d.referrer || ''; } catch { return d.referrer || ''; }
}
const adsAllowedOnSite = (url) => ruleFor(url).ads === false;
const adsAllowedFor = (d) => adsAllowedOnSite(pageURLOf(d));
// Third-party cookies are blocked when the setting is on, unless the page's site allows them.
function block3pcFor(d) {
  if (!loadSettings().block3pc || d.resourceType === 'mainFrame') return false;
  const page = pageURLOf(d);
  return !!page && pageinfo.isThirdParty(d.url, page) && ruleFor(page).cookies3p !== true;
}

function applyRequestRules() {
  for (const ses of sessions.values()) applyRequestRulesTo(ses);
}
function applyRequestRulesTo(ses) {
  const s = loadSettings(), sites = s.sites;
  const noCache = Object.keys(sites).filter((k) => sites[k].cache === false);
  const noJs = Object.keys(sites).filter((k) => sites[k].js === false);
  const ads = adblockActive();
  const all = ['<all_urls>'];

  ses.webRequest.onBeforeSendHeaders({ urls: s.block3pc ? all : [...GOOGLE_SIGNIN_HOSTS.map((h) => `https://${h}/*`), ...noCache.flatMap(sitePatterns)] }, (d, cb) => {
    const h = d.requestHeaders;
    // Only for the sign-in pages themselves: background requests that signed-in pages
    // (YouTube, Gmail…) make to these hosts must match the page's own Chrome identity.
    if (isSignInURL(d.url) && (d.resourceType === 'mainFrame' || isSignInURL(pageURLOf(d)))) h['User-Agent'] = ELECTRON_UA;
    if (noCache.length && inSites(d.url, noCache)) { h['Cache-Control'] = 'no-cache'; h['Pragma'] = 'no-cache'; }
    if (block3pcFor(d)) { const k = headerKey(h, 'cookie'); if (k) delete h[k]; }
    cb({ requestHeaders: h });
  });

  if (ads || s.httpsOnly) {
    ses.webRequest.onBeforeRequest({ urls: ads ? all : ['http://*/*'] }, (d, cb) => {
      // HTTPS-only: page loads over plain HTTP are upgraded first.
      if (s.httpsOnly && d.resourceType === 'mainFrame' && d.url.startsWith('http://')) {
        const host = new URL(d.url).hostname;
        if (!isLocalHost(host) && !httpAllowed.has(host)) {
          upgradedHosts.add(host);
          return cb({ redirectURL: 'https://' + d.url.slice(7) });
        }
      }
      if (!ads || adsAllowedFor(d)) return cb({});
      blocker.onBeforeRequest(d, (res) => {
        if (!res.cancel && !res.redirectURL) return cb(res);
        // Redirecting an XHR/fetch to a data: URL crashes Electron natively (signed-in
        // YouTube's doubleclick requests did, at startup); block those outright instead.
        if (res.redirectURL && res.redirectURL.startsWith('data:') && d.resourceType === 'xhr') res = { cancel: true };
        if (d.webContentsId) blockedCounts.set(d.webContentsId, (blockedCounts.get(d.webContentsId) || 0) + 1);
        if (stats && !isPrivateSession(ses)) stats.blocked(d.url);
        const wait = retryStormDelay(d);
        wait ? setTimeout(() => cb(res), wait) : cb(res);
      });
    });
  } else ses.webRequest.onBeforeRequest(null);

  const rewrite = [...new Set([...noCache, ...noJs])];
  if (!rewrite.length && !ads && !s.block3pc) return ses.webRequest.onHeadersReceived(null);
  ses.webRequest.onHeadersReceived({ urls: ads || s.block3pc ? all : rewrite.flatMap(sitePatterns) }, (d, cb) => {
    if (!d.responseHeaders) d.responseHeaders = {};
    const r = d.responseHeaders;
    let changed = false;
    // The blocker edits d.responseHeaders in place when a filter adds a CSP.
    if (ads && !adsAllowedFor(d)) blocker.onHeadersReceived(d, (res) => { if (res.responseHeaders) changed = true; });
    if (noCache.length && inSites(d.url, noCache)) {
      for (const k of ['cache-control', 'expires', 'etag', 'last-modified']) { const key = headerKey(r, k); if (key) delete r[key]; }
      r['Cache-Control'] = ['no-store'];
      changed = true;
    }
    if (noJs.length && inSites(d.url, noJs) && (d.resourceType === 'mainFrame' || d.resourceType === 'subFrame')) {
      // Policies combine, so adding this one blocks every script on the page.
      const key = headerKey(r, 'content-security-policy') || 'Content-Security-Policy';
      r[key] = [...(r[key] || []), "script-src 'none'"];
      changed = true;
    }
    if (block3pcFor(d)) { const k = headerKey(r, 'set-cookie'); if (k) { delete r[k]; changed = true; } }
    cb(changed ? { responseHeaders: r } : {});
  });
}

// Third-party frames: when blocking is on, also neuter document.cookie inside them
// (guest-preload asks; HTTP cookies are handled by the request rules above).
ipcMain.on('frame:block-cookies', (e) => {
  try {
    const f = e.senderFrame, top = f && f.top;
    e.returnValue = !!(f && top && f !== top && loadSettings().block3pc
      && pageinfo.isThirdParty(f.url, top.url) && ruleFor(top.url).cookies3p !== true);
  } catch { e.returnValue = false; }
});

// ---- Ad blocking (Ghostery's engine with EasyList-based ads + tracking lists) ----
let blocker = null;
const blockedCounts = new Map(); // webContents id -> requests blocked on the current page
const adblockActive = () => !!blocker && loadSettings().adblock;
// Some ad scripts retry a blocked request in a tight loop (cnn.com: ~1000/s, forever).
// After 10 repeats of the same blocked URL from one page within 3 s, answer each further
// attempt only after 2 s: the loop slows to a crawl instead of burning CPU.
const blockedRepeats = new Map(); // "wcId url" -> { n, t }
function retryStormDelay(d) {
  const key = `${d.webContentsId} ${d.url}`, now = Date.now();
  let r = blockedRepeats.get(key);
  if (!r || now - r.t > 3000) {
    if (blockedRepeats.size > 2000) blockedRepeats.clear();
    r = { n: 0 };
    blockedRepeats.set(key, r);
  }
  r.n++; r.t = now;
  return r.n > 10 ? 2000 : 0;
}

// Ghostery runs its anti-ad "scriptlets" with webContents.executeJavaScript, which
// (a) waits on a did-stop-loading listener per script while the page loads, (b) leaves
// failures as unhandled promise rejections, and (c) always targets the top frame. Run
// them in the frame that asked, immediately, and ignore scriptlets that throw.
function safeCosmeticEvent(event) {
  const frame = event.senderFrame;
  return {
    frameId: event.frameId, processId: event.processId, senderFrame: frame,
    sender: {
      insertCSS: (css, opts) => event.sender.insertCSS(css, opts).catch(() => {}),
      executeJavaScript: (code) => {
        if (!frame || frame.detached) return Promise.resolve();
        // Each scriptlet must run in its own scope (as uBlock Origin does): in a shared
        // scope they redefine each other's helpers and wrap already-wrapped functions,
        // which breaks pages (YouTube: endless recursion, no video player).
        return frame.executeJavaScript(`(function(){${code}\n})();`, true).catch(() => {});
      },
    },
  };
}
const COSMETIC_PRELOAD = () => require.resolve('@ghostery/adblocker-electron-preload');
function registerCosmetics(ses) {
  if (blocker && !ses.getPreloadScripts().some((p) => p.id === 'drift-adblock')) {
    ses.registerPreloadScript({ id: 'drift-adblock', type: 'frame', filePath: COSMETIC_PRELOAD() });
  }
}

async function setupAdblock() {
  const cache = DATA('adblock-engine.bin');
  // Refresh the downloaded filter lists weekly.
  try { if (Date.now() - fs.statSync(cache).mtimeMs > 7 * 864e5) fs.unlinkSync(cache); } catch {}
  try {
    blocker = await ElectronBlocker.fromPrebuiltAdsAndTracking(fetch, {
      path: cache, read: fs.promises.readFile, write: fs.promises.writeFile,
    });
  } catch (err) {
    console.error('ad blocker unavailable (filter lists could not be loaded):', err.message);
    return;
  }
  // Element hiding ("cosmetic" filters) runs from a small preload in every page frame.
  for (const ses of sessions.values()) registerCosmetics(ses);
  ipcMain.handle('@ghostery/adblocker/inject-cosmetic-filters', (event, url, msg) => {
    if (!adblockActive() || adsAllowedOnSite(event.sender.getURL())) return;
    return blocker.onInjectCosmeticFilters(safeCosmeticEvent(event), url, msg);
  });
  ipcMain.handle('@ghostery/adblocker/is-mutation-observer-enabled', () => adblockActive() && blocker.config.enableMutationObserver);
  applyRequestRules();
}

// ---- Sessions: one per space, plus the private one ----
function ensureSession(partition) {
  if (sessions.has(partition)) return sessions.get(partition);
  const ses = session.fromPartition(partition);
  sessions.set(partition, ses);
  const priv = partition === PRIVATE;
  const silent = new Set(['fullscreen', 'clipboard-sanitized-write', 'pointerLock', 'keyboardLock', 'window-management']);
  ses.setPermissionRequestHandler((wc, permission, cb, details) => {
    if (silent.has(permission)) return cb(true);
    let origin;
    try { origin = new URL(details.requestingUrl).origin; } catch { return cb(false); }
    const key = permKey(origin, permission, details);
    const stored = priv ? undefined : loadPerms()[key];
    if (stored !== undefined) return cb(stored);
    if (!win || win.isDestroyed()) return cb(false);
    const id = ++permSeq;
    let done = false;
    const finish = (ok) => { if (!done) { done = true; pendingPerms.delete(id); cb(ok); } };
    pendingPerms.set(id, { cb: finish, key: priv ? null : key });
    wc.once('destroyed', () => finish(false));
    send('permission', {
      id, wcId: wc.id, host: new URL(origin).host, once: priv,
      text: permission === 'media' ? mediaText(details) : PERM_TEXT[permission] || `wants permission: ${permission}`,
    });
  });
  ses.setSpellCheckerEnabled(loadSettings().spellcheck);
  // Runs in every frame (the webview preload only reaches the top frame).
  ses.registerPreloadScript({ id: 'drift-frame', type: 'frame', filePath: path.join(__dirname, 'lib', 'frame-preload.js') });
  pageinfo.attach(ses);
  downloads.attach(ses);
  registerCosmetics(ses);
  applyRequestRulesTo(ses);
  return ses;
}

// ---- Certificate errors ----
// Chromium refuses bad certificates; Float's error page explains and offers "proceed
// anyway", which allows exactly that host + certificate for the rest of this run.
const certExceptions = new Set(); // "host fingerprint"
const lastCertError = new Map(); // host -> { error, fingerprint, issuer, subject, expiry }
app.on('certificate-error', (event, _wc, url, error, cert, cb) => {
  let host = '';
  try { host = new URL(url).hostname; } catch {}
  lastCertError.set(host, { error, fingerprint: cert.fingerprint, issuer: cert.issuerName, subject: cert.subjectName, expiry: cert.validExpiry });
  if (certExceptions.has(`${host} ${cert.fingerprint}`)) { event.preventDefault(); return cb(true); }
  cb(false);
});
ipcMain.handle('security:cert-error', (_e, url) => { try { return lastCertError.get(new URL(url).hostname) || null; } catch { return null; } });
ipcMain.handle('security:allow-cert', (_e, url) => {
  try { const h = new URL(url).hostname, c = lastCertError.get(h); if (c) certExceptions.add(`${h} ${c.fingerprint}`); return !!c; } catch { return false; }
});
const hasCertException = (host) => [...certExceptions].some((k) => k.startsWith(host + ' '));
// HTTPS-only fallback: was this failed https page an automatic upgrade?
ipcMain.handle('security:https-fallback', (_e, url) => {
  try { const u = new URL(url); return u.protocol === 'https:' && upgradedHosts.has(u.hostname) ? 'http://' + url.slice(8) : null; } catch { return null; }
});
ipcMain.handle('security:allow-http', (_e, url) => { try { httpAllowed.add(new URL(url).hostname); return true; } catch { return false; } });

// ---- Encrypted DNS ----
function applyDns() {
  const d = loadSettings().dns;
  const server = d.provider === 'custom' ? d.custom : (DNS_PROVIDERS[d.provider] || DNS_PROVIDERS.cloudflare).url;
  try {
    if (d.mode === 'secure' && /^https:\/\//.test(server)) app.configureHostResolver({ secureDnsMode: 'secure', secureDnsServers: [server] });
    else if (d.mode === 'automatic') app.configureHostResolver({ secureDnsMode: 'automatic', secureDnsServers: /^https:\/\//.test(server) ? [server] : [] });
    else app.configureHostResolver({ secureDnsMode: 'off' });
  } catch (err) { console.error('DNS setting failed:', err.message); }
}

// ---- Chrome extensions + Chrome Web Store (main space only) ----
let extensions = null, tabSeq = 0;
const tabWaiters = new Map();
// Extensions think in tabs; in Float every canvas window is a tab of the one native window.
function openTabForExtension(url, active = true) {
  const reqId = ++tabSeq;
  send('open-window', { url: url || undefined, reqId, background: !active });
  return new Promise((resolve, reject) => {
    tabWaiters.set(reqId, (wcId) => {
      const wc = webContents.fromId(wcId);
      wc ? resolve([wc, win]) : reject(new Error('tab was not created'));
    });
    setTimeout(() => { if (tabWaiters.delete(reqId)) reject(new Error('tab creation timed out')); }, 30000);
  });
}
ipcMain.on('tab-ready', (_e, { reqId, wcId }) => { const w = tabWaiters.get(reqId); if (w) { tabWaiters.delete(reqId); w(wcId); } });
ipcMain.on('tab-active', (_e, wcId) => {
  const wc = wcId && webContents.fromId(wcId);
  if (!(wc && extensions && wc.session === sessions.get(PARTITION))) return;
  // The library answers by calling our selectTab hook below; that echo of the user's own
  // click must not fly the view, so mark it as ours while it runs.
  selectingFromFloat = wc.id;
  try { extensions.selectTab(wc); } finally { selectingFromFloat = 0; }
});
let selectingFromFloat = 0;

// ---- Mute / pause ----
function sendAudio(wc) {
  if (!wc.isDestroyed()) send('cmd', { cmd: 'audio', wcId: wc.id, arg: { muted: wc.isAudioMuted(), audible: wc.isCurrentlyAudible() } });
}
function setMuted(wc, muted) { wc.setAudioMuted(muted); sendAudio(wc); }
ipcMain.on('set-muted', (_e, wcId, muted) => { const wc = webContents.fromId(wcId); if (wc) setMuted(wc, !!muted); });
// Pausing = Chrome-style tab discarding: keep a snapshot, shut the page down. The UI
// removes the <webview>, which ends its renderer process and frees its memory.
async function pauseWindow(wc) {
  let snapshot = '';
  try { snapshot = (await wc.capturePage()).resize({ quality: 'good', width: 1600 }).toDataURL(); } catch {}
  send('cmd', { cmd: 'pause', wcId: wc.id, arg: snapshot });
}

function extensionAccess(manifest) {
  const hosts = [...(manifest.host_permissions || []), ...(manifest.permissions || []).filter((p) => /[:/*]/.test(p)),
    ...(manifest.content_scripts || []).flatMap((c) => c.matches || [])];
  const all = hosts.some((h) => h === '<all_urls>' || /^\*:\/\/\*\//.test(h) || /^https?:\/\/\*\//.test(h));
  const list = [...new Set(hosts.map((h) => h.replace(/^\*?:?\/\/|\/\*?$/g, '').replace(/^\*:\/\//, '')))];
  return { all, hosts: list, apis: (manifest.permissions || []).filter((p) => !/[:/*]/.test(p)) };
}
function describePermissions(manifest) {
  const a = extensionAccess(manifest);
  if (a.all) return 'It can read and change your data on all websites.';
  if (a.hosts.length) return `It can read and change your data on ${a.hosts.slice(0, 3).join(', ')}.`;
  return 'It needs no access to websites.';
}

function setupExtensions(ses) {
  ElectronChromeExtensions.handleCRXProtocol(session.defaultSession); // icons in Float's own UI
  extensions = new ElectronChromeExtensions({
    session: ses,
    createTab: (details) => openTabForExtension(details.url, details.active !== false),
    // An extension asked to show a tab (chrome.tabs.update({ active: true })): fly to it.
    // Not when it's only echoing the window the user just selected in Float.
    selectTab: (wc) => { if (wc.id !== selectingFromFloat) send('cmd', { cmd: 'focus-win', wcId: wc.id }); },
    removeTab: (wc) => send('cmd', { cmd: 'close', wcId: wc.id }),
    createWindow: async (details) => { await openTabForExtension([].concat(details.url || [])[0], details.focused !== false); return win; },
    removeWindow: () => {}, // the canvas is the only window; never close it for an extension
  });
  const changed = () => send('extensions-changed');
  ses.extensions.on('extension-loaded', (_e, ext) => {
    // Turned off in settings: unload again right after the store loader loads it.
    if (loadSettings().disabledExtensions.some((d) => d.id === ext.id)) ses.extensions.removeExtension(ext.id);
    changed();
  });
  ses.extensions.on('extension-unloaded', changed);
  installChromeWebStore({
    session: ses,
    extensionsPath: DATA('Extensions'),
    // Ask in the store's window before installing (same bar as site permissions).
    beforeInstall: ({ localizedName, manifest, frame }) => new Promise((resolve) => {
      const wc = webContents.fromFrame(frame);
      const id = ++permSeq;
      pendingPerms.set(id, { key: null, cb: (ok) => { pendingPerms.delete(id); resolve({ action: ok ? 'allow' : 'deny' }); } });
      send('permission', { id, wcId: wc ? wc.id : null, host: `Add “${localizedName}”?`, text: describePermissions(manifest), yes: 'Add extension', no: 'Cancel', once: true });
    }),
  }).catch((err) => console.error('Chrome Web Store support failed:', err.message));
}
const mainSession = () => sessions.get(PARTITION);
function listExtensions() {
  const s = loadSettings();
  const on = mainSession().extensions.getAllExtensions().map((e) => ({
    id: e.id, name: e.name, version: e.version, enabled: true, path: e.path,
    description: e.manifest.description || '', access: extensionAccess(e.manifest), summary: describePermissions(e.manifest),
  }));
  const off = s.disabledExtensions.filter((d) => !on.some((e) => e.id === d.id)).map((d) => ({ ...d, enabled: false }));
  return [...on, ...off];
}
ipcMain.handle('extensions:list', () => listExtensions());
ipcMain.handle('extensions:remove', async (_e, id) => {
  const s = loadSettings();
  s.disabledExtensions = s.disabledExtensions.filter((d) => d.id !== id);
  saveSettings();
  await uninstallExtension(id, { session: mainSession(), extensionsPath: DATA('Extensions') }).catch(() => {});
  return listExtensions();
});
ipcMain.handle('extensions:set-enabled', async (_e, id, on) => {
  const s = loadSettings(), ses = mainSession();
  if (on) {
    const d = s.disabledExtensions.find((x) => x.id === id);
    s.disabledExtensions = s.disabledExtensions.filter((x) => x.id !== id);
    saveSettings();
    if (d && d.path && !ses.extensions.getExtension(id)) await ses.extensions.loadExtension(d.path, { allowFileAccess: false }).catch((err) => console.error('enable failed:', err.message));
  } else {
    const ext = ses.extensions.getExtension(id);
    if (ext && !s.disabledExtensions.some((x) => x.id === id)) {
      s.disabledExtensions.push({ id, name: ext.name, version: ext.version, path: ext.path, summary: describePermissions(ext.manifest), access: extensionAccess(ext.manifest) });
      saveSettings();
    }
    if (ext) ses.extensions.removeExtension(id);
  }
  return listExtensions();
});

// ---- Settings IPC ----
const publicSettings = () => {
  const s = loadSettings(), cfg = loadConfig();
  return {
    ...s, search: cfg.search, keywords: cfg.keywords,
    searchEngines: SEARCH_ENGINES, dnsProviders: DNS_PROVIDERS,
    adblockReady: !!blocker, downloadsDefault: app.getPath('downloads'),
  };
};
ipcMain.handle('settings:all', () => publicSettings());
// Global settings (not per-site). Each key applies itself immediately.
ipcMain.handle('settings:set', (_e, patch) => {
  const s = loadSettings();
  for (const [k, v] of Object.entries(patch || {})) {
    if (!(k in SETTINGS_DEFAULTS) || k === 'sites' || k === 'spaces' || k === 'disabledExtensions') continue;
    if (k === 'startPage' && !(v === 'drift' || v === 'blank' || /^https?:\/\/\S+$/i.test(String(v)))) continue;
    s[k] = v && typeof v === 'object' && !Array.isArray(v) && SETTINGS_DEFAULTS[k] && typeof SETTINGS_DEFAULTS[k] === 'object' ? { ...s[k], ...v } : v;
  }
  saveSettings();
  if ('adblock' in patch || 'block3pc' in patch || 'httpsOnly' in patch) applyRequestRules();
  if ('dns' in patch) applyDns();
  if ('spellcheck' in patch) for (const ses of sessions.values()) ses.setSpellCheckerEnabled(!!s.spellcheck);
  if ('shortcuts' in patch) matchShortcut = shortcuts.matcher(s.shortcuts);
  if ('search' in patch || 'keywords' in patch || 'startPage' in patch || 'tabBar' in patch) send('config-changed', loadConfig());
  return publicSettings();
});
ipcMain.handle('settings:get', (_e, url, wcId) => {
  const s = loadSettings(), site = url ? siteOf(url) : '';
  const rule = ruleFor(url || '');
  return {
    history: s.history, adblock: s.adblock, adblockReady: !!blocker,
    site, js: rule.js !== false, cache: rule.cache !== false, ads: rule.ads !== false,
    blocked: (wcId && blockedCounts.get(wcId)) || 0,
  };
});
ipcMain.handle('settings:adblock', (_e, on) => { loadSettings().adblock = !!on; saveSettings(); applyRequestRules(); return !!on; });
ipcMain.handle('settings:history', (_e, on) => { loadSettings().history = !!on; saveSettings(); return !!on; });

// Per-site rules. Only values that differ from the default are stored.
const SITE_DEFAULTS = { js: true, cache: true, ads: true, cookies3p: false, zoom: 1, css: '', script: '' };
ipcMain.handle('settings:site', async (_e, site, patch) => {
  const s = loadSettings();
  const rule = { ...(s.sites[site] || {}), ...patch };
  for (const k of Object.keys(rule)) if (!(k in SITE_DEFAULTS) || rule[k] === SITE_DEFAULTS[k] || rule[k] == null) delete rule[k];
  if (Object.keys(rule).length) s.sites[site] = rule; else delete s.sites[site];
  saveSettings();
  if (['js', 'cache', 'ads', 'cookies3p'].some((k) => k in patch)) applyRequestRules();
  if (patch.cache === false) await clearSiteCache(site);
  if ('zoom' in patch) for (const wc of webContents.getAllWebContents()) if (wc.getType() === 'webview' && siteOf(wc.getURL()) === site) wc.setZoomFactor(rule.zoom || 1);
  return s.sites[site] || {};
});
ipcMain.handle('settings:site-rule', (_e, url) => ({ ...SITE_DEFAULTS, ...ruleFor(url) }));
async function clearSiteCache(site) {
  try { await allSessions(async (ses) => ses.clearData({ dataTypes: ['cache'], origins: originsOf(site) })); }
  catch (err) { console.error('clear cache failed:', err.message); }
}
function originsOf(site) {
  const isIP = /^[\d.]+$|:/.test(site), origins = [];
  for (const scheme of ['https', 'http']) for (const h of isIP ? [site] : [site, 'www.' + site]) origins.push(`${scheme}://${h}`);
  return origins;
}
const allSessions = (fn) => Promise.all([...sessions.values()].map((ses) => fn(ses).catch(() => {})));
ipcMain.handle('site:clear-cache', (_e, site) => clearSiteCache(site));
ipcMain.handle('site:reset-perms', (_e, url) => { try { return resetPerms(new URL(url).origin); } catch { return 0; } });

// ---- Site info: what the page did, its cookies, permissions ----
const sessionOfWc = (wcId) => { const wc = webContents.fromId(wcId); return wc && !wc.isDestroyed() ? wc.session : mainSession(); };
ipcMain.handle('site:info', (_e, wcId) => {
  const i = pageinfo.info(wcId);
  const wc = webContents.fromId(wcId);
  let origin = '';
  try { origin = new URL(i.url).origin; } catch {}
  const p = loadPerms();
  i.permissions = Object.keys(p).filter((k) => k.startsWith(origin + ' ')).map((k) => {
    const name = k.slice(origin.length + 1);
    return { key: k, name, label: PERM_NAMES[name] || name, allowed: p[k] };
  });
  i.rule = { ...SITE_DEFAULTS, ...ruleFor(i.url) };
  i.siteName = siteOf(i.url);
  i.blockedCount = (wcId && blockedCounts.get(wcId)) || 0;
  i.private = !!(wc && isPrivateSession(wc.session));
  i.certException = hasCertException(i.host);
  i.httpsOnly = loadSettings().httpsOnly;
  i.block3pc = loadSettings().block3pc;
  i.adblockOn = adblockActive();
  i.zoom = wc && !wc.isDestroyed() ? wc.getZoomFactor() : 1;
  return i;
});
ipcMain.handle('site:revoke-perm', (_e, key) => { const p = loadPerms(); if (key in p) { delete p[key]; savePerms(); } return true; });
ipcMain.handle('site:set-perm', (_e, key, allowed) => { if (typeof key === 'string' && key.includes(' ')) { loadPerms()[key] = !!allowed; savePerms(); } return true; });
ipcMain.handle('downloads:choose-folder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], defaultPath: downloads.folder() });
  return r.canceled ? null : r.filePaths[0];
});
// Cookies of a site (names and properties only; values stay out of the UI).
ipcMain.handle('site:cookies', async (_e, wcId, site) => {
  const ses = sessionOfWc(wcId), key = pageinfo.siteKey('https://' + site);
  const all = await ses.cookies.get({});
  return all.filter((c) => { const d = c.domain.replace(/^\./, ''); return d === key || d.endsWith('.' + key); })
    .map((c) => ({ name: c.name, domain: c.domain, path: c.path, secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite, session: c.session, expires: c.expirationDate }));
});
// Everything a site stored: cookies, storage, cache, service workers.
ipcMain.handle('site:clear-data', async (_e, wcId, site) => {
  const ses = sessionOfWc(wcId), key = pageinfo.siteKey('https://' + site);
  const cookies = await ses.cookies.get({});
  for (const c of cookies) {
    const d = c.domain.replace(/^\./, '');
    if (d === key || d.endsWith('.' + key)) await ses.cookies.remove(`http${c.secure ? 's' : ''}://${d}${c.path}`, c.name).catch(() => {});
  }
  const origins = [...originsOf(key), ...originsOf(site)];
  await ses.clearData({ origins: [...new Set(origins)] }).catch((err) => console.error('clear site data failed:', err.message));
  return true;
});
ipcMain.handle('site:storage-sites', async (_e, space) => {
  const ses = ensureSession(partitionFor(space || ''));
  const cookies = await ses.cookies.get({});
  const by = new Map();
  for (const c of cookies) { const k = pageinfo.siteKey('https://' + c.domain.replace(/^\./, '')); by.set(k, (by.get(k) || 0) + 1); }
  return [...by].map(([site, cookies]) => ({ site, cookies })).sort((a, b) => b.cookies - a.cookies);
});
ipcMain.handle('site:clear-storage-site', async (_e, space, site) => {
  const ses = ensureSession(partitionFor(space || ''));
  for (const c of await ses.cookies.get({})) {
    const d = c.domain.replace(/^\./, '');
    if (d === site || d.endsWith('.' + site)) await ses.cookies.remove(`http${c.secure ? 's' : ''}://${d}${c.path}`, c.name).catch(() => {});
  }
  await ses.clearData({ origins: originsOf(site) }).catch(() => {});
  return true;
});
ipcMain.handle('privacy:overview', () => {
  const s = loadSettings(), p = loadPerms();
  const sites = new Map();
  const get = (site) => { if (!sites.has(site)) sites.set(site, { site, rule: {}, permissions: [] }); return sites.get(site); };
  for (const [site, rule] of Object.entries(s.sites)) get(site).rule = rule;
  for (const [k, v] of Object.entries(p)) {
    const i = k.indexOf(' '), origin = k.slice(0, i), name = k.slice(i + 1);
    get(siteOf(origin)).permissions.push({ key: k, origin, name, label: PERM_NAMES[name] || name, allowed: v });
  }
  return [...sites.values()].sort((a, b) => a.site.localeCompare(b.site));
});
ipcMain.handle('privacy:clear-site-rules', (_e, site) => {
  const s = loadSettings();
  delete s.sites[site]; saveSettings();
  const p = loadPerms();
  for (const k of Object.keys(p)) if (siteOf(k.split(' ')[0]) === site) delete p[k];
  savePerms();
  applyRequestRules();
  return true;
});
// Clear browsing data across every space (not private: that one is wiped on close anyway).
ipcMain.handle('privacy:clear-all', async (_e, what) => {
  const types = [];
  if (what.cookies) types.push('cookies', 'localStorage', 'indexedDB', 'serviceWorkers', 'cacheStorage', 'fileSystems', 'webSQL');
  if (what.cache) types.push('cache');
  if (types.length) await allSessions((ses) => ses.clearData({ dataTypes: types }));
  if (what.history) { history = []; writeHistory(); if (stats) stats.clear(); }
  return true;
});

// ---- Spaces ----
const SPACE_COLORS = ['#e0af68', '#9ece6a', '#f7768e', '#bb9af7', '#7dcfff', '#ff9e64', '#73daca'];
ipcMain.handle('spaces:list', () => ({ main: loadSettings().mainSpace, spaces: loadSettings().spaces }));
ipcMain.handle('spaces:create', (_e, name) => {
  const s = loadSettings();
  const id = (String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'space') + '-' + Date.now().toString(36);
  const sp = { id, name: String(name).trim() || 'Space', color: SPACE_COLORS[s.spaces.length % SPACE_COLORS.length] };
  s.spaces.push(sp); saveSettings();
  return sp;
});
ipcMain.handle('spaces:update', (_e, id, patch) => {
  const s = loadSettings();
  if (!id) { s.mainSpace = { ...s.mainSpace, ...patch }; saveSettings(); return s.mainSpace; }
  const sp = s.spaces.find((x) => x.id === id);
  if (sp) { if (patch.name != null) sp.name = String(patch.name).trim() || sp.name; if (patch.color) sp.color = patch.color; saveSettings(); }
  return sp;
});
// Deleting a space also deletes everything stored in it (logins, cookies, cache).
ipcMain.handle('spaces:delete', async (_e, id) => {
  const s = loadSettings();
  if (!id || !s.spaces.some((x) => x.id === id)) return false;
  const ses = ensureSession(partitionFor(id));
  await ses.clearData().catch(() => {});
  await ses.clearCache().catch(() => {});
  s.spaces = s.spaces.filter((x) => x.id !== id); saveSettings();
  return true;
});
// Last private window closed: forget everything it stored.
ipcMain.handle('private:closed', async () => {
  const ses = sessions.get(PRIVATE);
  if (ses) { await ses.clearData().catch(() => {}); await ses.clearCache().catch(() => {}); }
  for (const k of [...certExceptions]) certExceptions.delete(k); // conservative: re-ask everywhere
});

// ---- Shortcuts IPC ----
ipcMain.handle('shortcuts:list', () => shortcuts.bindings(loadSettings().shortcuts));
ipcMain.handle('shortcuts:set', (_e, cmd, keys) => {
  const s = loadSettings();
  s.shortcuts = { ...s.shortcuts };
  if (keys == null) delete s.shortcuts[cmd]; else s.shortcuts[cmd] = keys.map(shortcuts.canonical);
  saveSettings();
  matchShortcut = shortcuts.matcher(s.shortcuts);
  return shortcuts.bindings(s.shortcuts);
});
ipcMain.handle('shortcuts:capture', (_e, on) => { capturingKeys = !!on; });

// ---- Places (saved spots on the canvas) ----
const PLACES_FILE = () => DATA('places.json');
ipcMain.handle('places:get', () => { try { return JSON.parse(fs.readFileSync(PLACES_FILE(), 'utf8')); } catch { return []; } });
ipcMain.handle('places:set', (_e, list) => {
  try { fs.writeFileSync(PLACES_FILE() + '.tmp', JSON.stringify(list)); fs.renameSync(PLACES_FILE() + '.tmp', PLACES_FILE()); } catch (err) { console.error('places save failed:', err.message); }
});

// ---- About / transparency ----
ipcMain.handle('about', () => ({
  version: app.getVersion(), electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node,
  dataPath: app.getPath('userData'), widevine: !!require('electron').components, // castLabs builds only
  extensions: mainSession().extensions.getAllExtensions().length,
}));
ipcMain.handle('open-data-folder', () => shell.openPath(app.getPath('userData')));
ipcMain.handle('print', (_e, wcId) => { const wc = webContents.fromId(wcId); if (wc) printPage(wc); });
ipcMain.handle('page:zoom', (_e, wcId, factor) => {
  const wc = webContents.fromId(wcId);
  if (!wc) return 1;
  const z = Math.min(3, Math.max(0.3, Math.round(factor * 100) / 100));
  wc.setZoomFactor(z);
  const site = siteOf(wc.getURL());
  const s = loadSettings();
  if (site) {
    const rule = { ...(s.sites[site] || {}), zoom: z };
    if (z === 1) delete rule.zoom;
    if (Object.keys(rule).length) s.sites[site] = rule; else delete s.sites[site];
    saveSettings();
  }
  return z;
});

// Keeps navigator.userAgent in the page consistent with the header for each page.
function matchUserAgentToPage(wc) {
  wc.on('did-start-navigation', (details) => {
    if (!details.isMainFrame || details.isSameDocument) return;
    const ua = isSignInURL(details.url) ? ELECTRON_UA : CLEAN_UA;
    if (wc.getUserAgent() !== ua) wc.setUserAgent(ua);
  });
}

// Per-site look (zoom) and the user's own CSS / script, applied as each page loads.
function applySiteCustomizations(wc) {
  wc.on('did-navigate', (_e, url) => {
    const r = ruleFor(url);
    if (wc.getZoomFactor() !== (r.zoom || 1)) wc.setZoomFactor(r.zoom || 1);
  });
  wc.on('dom-ready', () => {
    const r = ruleFor(wc.getURL());
    if (r.css) wc.insertCSS(r.css, { cssOrigin: 'user' }).catch(() => {});
    if (r.script) wc.executeJavaScript(r.script, false).catch((err) => console.error(`custom script for ${siteOf(wc.getURL())} failed:`, err.message));
  });
}

function createWindow() {
  Menu.setApplicationMenu(null);
  win = new BrowserWindow({
    width: 1440, height: 920, backgroundColor: '#0e1014', title: 'Float',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // Float's own UI page only (never web content): unsandboxed so its preload can
      // load the extension toolbar. Pages run in sandboxed <webview>s.
      contextIsolation: true, nodeIntegration: false, sandbox: false, webviewTag: true,
    },
  });
  win.webContents.on('will-attach-webview', (_e, prefs, params) => {
    // Pages never get Node, always get our tiny preload, only use Float's partitions.
    delete prefs.preloadURL;
    prefs.preload = path.join(__dirname, 'guest-preload.js');
    prefs.nodeIntegration = false;
    prefs.contextIsolation = true;
    prefs.sandbox = true;
    // Let preloads run in iframes too (Float's frame preload, clicks/zoom inside embeds).
    // Sandboxed + isolated, so this grants frames no Node access.
    prefs.nodeIntegrationInSubFrames = true;
    prefs.plugins = true; // built-in PDF viewer
    prefs.spellcheck = true;
    if (!allowedPartition(params.partition)) params.partition = PARTITION;
    ensureSession(params.partition);
  });
  // The host page itself must never navigate away.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.on('blur', () => send('cmd', { cmd: 'alt', arg: false }));
  win.loadFile(path.join(__dirname, 'index.html'));
}

app.on('web-contents-created', (_e, wc) => {
  wc.on('before-input-event', (event, input) => onInput(event, input, wc));
  if (wc.getType() === 'webview' || wc.getType() === 'window') matchUserAgentToPage(wc);
  if (wc.getType() !== 'webview') return;
  const priv = isPrivateSession(wc.session);
  if (extensions && win && wc.session === mainSession()) extensions.addTab(wc, win);
  applySiteCustomizations(wc);
  wc.on('did-start-navigation', (d) => {
    if (d.isMainFrame && !d.isSameDocument) { blockedCounts.delete(wc.id); pageinfo.reset(wc.id, d.url); }
  });
  wc.once('destroyed', () => { blockedCounts.delete(wc.id); pageinfo.forget(wc.id); });
  wc.on('audio-state-changed', () => sendAudio(wc));
  if (!priv) {
    wc.on('did-navigate', (_ev, url) => recordVisit(url));
    wc.on('did-navigate-in-page', (_ev, url, isMainFrame) => isMainFrame && recordVisit(url));
    wc.on('page-title-updated', (_ev, title) => recordTitle(wc.getURL(), title));
    wc.on('page-favicon-updated', (_ev, icons) => recordFavicon(wc.getURL(), icons[0]));
  }
  wc.setWindowOpenHandler(({ url, disposition }) => {
    // Scripted popups with window features (OAuth, payment) stay real popups so
    // window.opener keeps working. Ordinary new-tab links become canvas windows.
    if (disposition === 'new-window') {
      return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, width: 600, height: 720 } };
    }
    if (url && url !== 'about:blank') send('open-window', { url, fromId: wc.id, background: disposition === 'background-tab' });
    return { action: 'deny' };
  });
  wc.on('context-menu', (_ev, params) => contextMenu(wc, params));
});

// ---- History: one entry per URL, most recent first (never from private windows) ----
const HISTORY_FILE = () => DATA('history.json');
const HISTORY_MAX = 5000;
let history = null, historyTimer = 0;
const loadHistory = () => history || (history = (() => { try { return JSON.parse(fs.readFileSync(HISTORY_FILE(), 'utf8')); } catch { return []; } })());
function writeHistory() {
  clearTimeout(historyTimer); historyTimer = 0;
  if (!history) return;
  try {
    fs.mkdirSync(path.dirname(HISTORY_FILE()), { recursive: true });
    fs.writeFileSync(HISTORY_FILE() + '.tmp', JSON.stringify(history));
    fs.renameSync(HISTORY_FILE() + '.tmp', HISTORY_FILE());
  } catch (err) { console.error('history save failed:', err.message); }
}
const saveHistory = () => { if (!historyTimer) historyTimer = setTimeout(writeHistory, 2000); };
function recordVisit(url) {
  if (!/^https?:/i.test(url) || !loadSettings().history) return;
  const h = loadHistory(), i = h.findIndex((e) => e.url === url);
  const e = i >= 0 ? h.splice(i, 1)[0] : { url, title: '', n: 0 };
  e.n++; e.t = Date.now();
  h.unshift(e);
  if (h.length > HISTORY_MAX) h.length = HISTORY_MAX;
  saveHistory();
}
function recordTitle(url, title) {
  const e = title && loadHistory().find((x) => x.url === url);
  if (e && e.title !== title) { e.title = title; saveHistory(); }
}
function recordFavicon(url, icon) {
  const e = icon && loadHistory().find((x) => x.url === url);
  if (e && e.icon !== icon) { e.icon = icon; saveHistory(); }
}
ipcMain.handle('history:query', (_e, q = '', limit = 8) => {
  const terms = String(q).toLowerCase().split(/\s+/).filter(Boolean);
  const host = (u) => u.replace(/^https?:\/\/(www\.)?/i, '');
  let res = loadHistory().filter((e) => terms.every((t) => (e.title + ' ' + e.url).toLowerCase().includes(t)));
  // Sites whose address starts with what you typed come first, then by recency.
  if (terms.length) res = res.filter((e) => host(e.url).toLowerCase().startsWith(terms[0])).concat(res.filter((e) => !host(e.url).toLowerCase().startsWith(terms[0])));
  return res.slice(0, limit);
});
// ---- Start page (a new empty window): everything it shows, computed locally ----
ipcMain.handle('start:data', () => {
  const s = loadSettings(), cfg = loadConfig();
  const engine = Object.values(SEARCH_ENGINES).find((e) => e.url === cfg.search);
  let searchName = engine ? engine.name : '';
  if (!searchName) { try { searchName = new URL(cfg.search).hostname.replace(/^www\./, ''); } catch {} }
  // Most visited: history grouped by site, most visits first; a site's tile opens its
  // most visited page. Sites you removed (×) stay hidden.
  const hidden = new Set(s.startHidden || []);
  const bySite = new Map();
  for (const e of loadHistory()) {
    const site = siteOf(e.url);
    if (!site || hidden.has(site)) continue;
    const g = bySite.get(site) || { site, n: 0, best: e };
    g.n += e.n || 1;
    if ((e.n || 1) > (g.best.n || 1)) g.best = e;
    bySite.set(site, g);
  }
  const top = [...bySite.values()].sort((a, b) => b.n - a.n).slice(0, 8)
    .map((g) => ({ site: g.site, url: g.best.url, title: g.best.title || g.site, visits: g.n }));
  const dns = s.dns.mode === 'off' ? '' : (s.dns.provider === 'custom' ? 'custom' : (DNS_PROVIDERS[s.dns.provider] || {}).name || '');
  return {
    searchName, keywords: Object.keys(cfg.keywords),
    show: s.start, history: s.history,
    top: s.start.top && s.history ? top : [],
    stats: s.start.stats && stats ? stats.week() : null,
    protections: { adblock: s.adblock, block3pc: s.block3pc, httpsOnly: s.httpsOnly, dns, history: s.history },
  };
});
ipcMain.handle('start:hide', (_e, site) => {
  const s = loadSettings();
  if (site && !s.startHidden.includes(site)) { s.startHidden.push(site); saveSettings(); }
});
ipcMain.handle('start:unhide-all', () => { loadSettings().startHidden = []; saveSettings(); });
ipcMain.handle('history:clear', () => { history = []; writeHistory(); });
ipcMain.handle('history:remove', (_e, url) => {
  const h = loadHistory(), i = h.findIndex((e) => e.url === url);
  if (i >= 0) { h.splice(i, 1); saveHistory(); }
});
app.on('before-quit', () => { writeHistory(); if (stats) stats.flush(); });

ipcMain.handle('config', () => loadConfig());
ipcMain.handle('session:load', () => {
  try { return JSON.parse(fs.readFileSync(SESSION_FILE(), 'utf8')); } catch { return null; }
});
ipcMain.on('session:save', (_e, data) => {
  const file = SESSION_FILE();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify(data));
    fs.renameSync(file + '.tmp', file);
  } catch (err) { console.error('session save failed:', err.message); }
});

const updates = setupUpdates({ send: (...a) => send(...a), loadSettings });
const downloads = setupDownloads({
  send, loadSettings, isPrivateSession,
  retry: (r) => ensureSession(r.private ? PRIVATE : PARTITION).downloadURL(r.url),
});

app.whenReady().then(async () => {
  // castLabs' Electron (Widevine DRM for Netflix, Spotify…) installs the CDM on first
  // start; stock Electron has no `components` and skips this.
  const { components } = require('electron');
  if (components) await components.whenReady().catch((err) => console.error('Widevine unavailable:', err.message));
  stats = setupStats({ file: DATA('stats.json'), siteKey: pageinfo.siteKey });
  applyDns();
  const ses = ensureSession(PARTITION);
  setupExtensions(ses);
  setupAdblock();
  createWindow();
});
app.on('window-all-closed', () => app.quit());
