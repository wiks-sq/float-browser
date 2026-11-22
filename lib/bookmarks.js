'use strict';
// Bookmarks: a flat list in bookmarks.json, each with the folder path it came from
// ("Bookmarks bar / Dev"). Import reads other browsers' own files directly, read-only:
// Chromium-family "Bookmarks" JSON, Firefox's places.sqlite, or an exported HTML file.
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX = 20000;
const isWebURL = (u) => /^(https?|ftp|file):/i.test(u || '');
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

function setupBookmarks({ ipcMain, dialog, app, getWin, file, onChange }) {
  let list = null;
  const load = () => list || (list = (() => { try { const l = JSON.parse(fs.readFileSync(file(), 'utf8')); return Array.isArray(l) ? l : []; } catch { return []; } })());
  function save() {
    try {
      fs.mkdirSync(path.dirname(file()), { recursive: true });
      fs.writeFileSync(file() + '.tmp', JSON.stringify(list));
      fs.renameSync(file() + '.tmp', file());
    } catch (err) { console.error('bookmarks save failed:', err.message); }
    onChange(list);
  }
  const clean = (b) => ({ id: newId(), url: String(b.url), title: String(b.title || '').slice(0, 500), folder: String(b.folder || '').slice(0, 300), t: b.t || Date.now() });

  // Adds the ones not bookmarked yet; returns how many were new.
  function addMany(items) {
    const have = new Set(load().map((b) => b.url));
    let n = 0;
    for (const b of items) {
      if (!isWebURL(b.url) || have.has(b.url) || list.length >= MAX) continue;
      have.add(b.url); list.push(clean(b)); n++;
    }
    if (n) save();
    return n;
  }

  ipcMain.handle('bookmarks:list', () => load());
  ipcMain.handle('bookmarks:add', (_e, b) => {
    if (!b || !isWebURL(b.url)) return null;
    const old = load().find((x) => x.url === b.url);
    if (old) return old;
    const nb = clean(b);
    list.unshift(nb); save();
    return nb;
  });
  ipcMain.handle('bookmarks:remove', (_e, idOrUrl) => {
    const before = load().length;
    list = list.filter((b) => b.id !== idOrUrl && b.url !== idOrUrl);
    if (list.length !== before) save();
    return before - list.length;
  });
  ipcMain.handle('bookmarks:rename', (_e, id, title) => {
    const b = load().find((x) => x.id === id);
    if (b) { b.title = String(title || '').slice(0, 500); save(); }
    return !!b;
  });
  ipcMain.handle('bookmarks:clear', () => { list = []; save(); return true; });

  ipcMain.handle('bookmarks:sources', () => findSources().map(({ id, name, count }) => ({ id, name, count })));
  ipcMain.handle('bookmarks:import', async (_e, sourceId) => {
    let items, name;
    if (sourceId === 'html') {
      const r = await dialog.showOpenDialog(getWin(), {
        title: 'Import bookmarks', properties: ['openFile'],
        filters: [{ name: 'Bookmarks file', extensions: ['html', 'htm', 'json'] }, { name: 'All files', extensions: ['*'] }],
      });
      if (r.canceled || !r.filePaths[0]) return null;
      const text = fs.readFileSync(r.filePaths[0], 'utf8');
      items = /^\s*\{/.test(text) ? fromChromiumJSON(text) : fromHTML(text);
      name = path.basename(r.filePaths[0]);
    } else {
      const src = findSources().find((s) => s.id === sourceId);
      if (!src) return null;
      items = src.read(); name = src.name;
    }
    return { name, found: items.length, added: addMany(items) };
  });
  ipcMain.handle('bookmarks:export', async () => {
    const r = await dialog.showSaveDialog(getWin(), {
      title: 'Export bookmarks', defaultPath: path.join(app.getPath('documents'), 'float-bookmarks.html'),
      filters: [{ name: 'Bookmarks file', extensions: ['html'] }],
    });
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, toHTML(load()));
    return r.filePath;
  });
}

// ---------------------------------------------------------------- sources on this computer
function configDirs() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), roam = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return { local, roam };
  }
  if (process.platform === 'darwin') { const s = path.join(home, 'Library', 'Application Support'); return { local: s, roam: s }; }
  const c = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  return { local: c, roam: c };
}
function chromiumRoots() {
  const { local, roam } = configDirs(), home = os.homedir();
  if (process.platform === 'win32') return [
    ['Chrome', path.join(local, 'Google', 'Chrome', 'User Data')], ['Chromium', path.join(local, 'Chromium', 'User Data')],
    ['Edge', path.join(local, 'Microsoft', 'Edge', 'User Data')], ['Brave', path.join(local, 'BraveSoftware', 'Brave-Browser', 'User Data')],
    ['Vivaldi', path.join(local, 'Vivaldi', 'User Data')], ['Opera', path.join(roam, 'Opera Software', 'Opera Stable')],
  ];
  if (process.platform === 'darwin') return [
    ['Chrome', path.join(local, 'Google', 'Chrome')], ['Chromium', path.join(local, 'Chromium')], ['Edge', path.join(local, 'Microsoft Edge')],
    ['Brave', path.join(local, 'BraveSoftware', 'Brave-Browser')], ['Vivaldi', path.join(local, 'Vivaldi')], ['Opera', path.join(local, 'com.operasoftware.Opera')],
  ];
  return [
    ['Chrome', path.join(local, 'google-chrome')], ['Chrome Beta', path.join(local, 'google-chrome-beta')],
    ['Chromium', path.join(local, 'chromium')], ['Chromium', path.join(home, 'snap', 'chromium', 'common', 'chromium')],
    ['Edge', path.join(local, 'microsoft-edge')], ['Brave', path.join(local, 'BraveSoftware', 'Brave-Browser')],
    ['Brave', path.join(home, 'snap', 'brave', 'current', '.config', 'BraveSoftware', 'Brave-Browser')],
    ['Vivaldi', path.join(local, 'vivaldi')], ['Opera', path.join(local, 'opera')],
    ['Chrome', path.join(home, '.var', 'app', 'com.google.Chrome', 'config', 'google-chrome')],
    ['Brave', path.join(home, '.var', 'app', 'com.brave.Browser', 'config', 'BraveSoftware', 'Brave-Browser')],
  ];
}
function firefoxRoots() {
  const { roam } = configDirs(), home = os.homedir();
  if (process.platform === 'win32') return [path.join(roam, 'Mozilla', 'Firefox')];
  if (process.platform === 'darwin') return [path.join(roam, 'Firefox')];
  return [path.join(home, '.mozilla', 'firefox'), path.join(home, 'snap', 'firefox', 'common', '.mozilla', 'firefox'),
    path.join(home, '.var', 'app', 'org.mozilla.firefox', '.mozilla', 'firefox'), path.join(home, '.librewolf')];
}
const readDir = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }); } catch { return []; } };
const safe = (fn) => { try { return fn(); } catch (err) { console.error('bookmark import:', err.message); return []; } };

function findSources() {
  const out = [], seen = new Set();
  for (const [browser, root] of chromiumRoots()) {
    let names = {};
    try { names = JSON.parse(fs.readFileSync(path.join(root, 'Local State'), 'utf8')).profile.info_cache || {}; } catch {}
    const dirs = readDir(root).filter((e) => e.isDirectory() && (e.name === 'Default' || /^Profile \d+$/.test(e.name))).map((e) => e.name);
    if (fs.existsSync(path.join(root, 'Bookmarks'))) dirs.push(''); // Opera keeps it in the root
    for (const dir of dirs) {
      const f = path.join(root, dir, 'Bookmarks');
      if (seen.has(f) || !fs.existsSync(f)) continue;
      seen.add(f);
      const read = () => safe(() => fromChromiumJSON(fs.readFileSync(f, 'utf8')));
      const prof = dir && (names[dir]?.name || dir);
      out.push({ id: 'c:' + f, name: browser + (dirs.length > 1 && prof ? ` (${prof})` : ''), read });
    }
  }
  for (const root of firefoxRoots()) {
    const profs = readDir(root).filter((e) => e.isDirectory() && fs.existsSync(path.join(root, e.name, 'places.sqlite')));
    for (const p of profs) {
      const f = path.join(root, p.name, 'places.sqlite');
      if (seen.has(f)) continue;
      seen.add(f);
      const label = p.name.replace(/^[a-z0-9]{8}\./, '');
      out.push({ id: 'f:' + f, name: (root.includes('librewolf') ? 'LibreWolf' : 'Firefox') + (profs.length > 1 ? ` (${label})` : ''), read: () => safe(() => fromFirefox(f)) });
    }
  }
  for (const s of out) s.count = s.read().length;
  return out.filter((s) => s.count > 0);
}

// ---------------------------------------------------------------- formats
function fromChromiumJSON(text) {
  const data = JSON.parse(text), out = [];
  const ROOTS = { bookmark_bar: 'Bookmarks bar', other: 'Other bookmarks', synced: 'Mobile bookmarks' };
  const walk = (node, folder) => {
    if (!node) return;
    if (node.type === 'url') out.push({ url: node.url, title: node.name, folder, t: chromeTime(node.date_added) });
    for (const c of node.children || []) walk(c, c.type === 'folder' ? (folder ? folder + ' / ' : '') + c.name : folder);
  };
  for (const [k, node] of Object.entries(data.roots || {})) if (node && typeof node === 'object') walk(node, ROOTS[k] || node.name || '');
  return out.filter((b) => isWebURL(b.url));
}
// Chromium: microseconds since 1601-01-01.
const chromeTime = (s) => { const n = Number(s); return n > 0 ? Math.round(n / 1000 - 11644473600000) : 0; };

function fromFirefox(file) {
  const { DatabaseSync } = require('node:sqlite');
  // Firefox keeps the database open (and recent changes in the -wal file): read a copy.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'float-ff-'));
  try {
    for (const ext of ['', '-wal']) if (fs.existsSync(file + ext)) fs.copyFileSync(file + ext, path.join(tmp, 'places.sqlite' + ext));
    const db = new DatabaseSync(path.join(tmp, 'places.sqlite'));
    try {
      const rows = db.prepare('SELECT b.id, b.type, b.parent, b.title, b.guid, b.dateAdded, p.url FROM moz_bookmarks b LEFT JOIN moz_places p ON p.id = b.fk ORDER BY b.parent, b.position').all();
      const byId = new Map(rows.map((r) => [r.id, r]));
      const ROOTS = { menu________: 'Bookmarks menu', toolbar_____: 'Bookmarks toolbar', unfiled_____: 'Other bookmarks', mobile______: 'Mobile bookmarks' };
      const folderOf = (id) => {
        const parts = [];
        for (let r = byId.get(id), i = 0; r && i < 50; r = byId.get(r.parent), i++) {
          if (r.guid === 'root________') break;
          if (r.guid === 'tags________') return null; // tags aren't bookmarks
          parts.unshift(ROOTS[r.guid] || r.title || '');
        }
        return parts.filter(Boolean).join(' / ');
      };
      const out = [];
      for (const r of rows) {
        if (r.type !== 1 || !isWebURL(r.url)) continue;
        const folder = folderOf(r.parent);
        if (folder === null) continue;
        out.push({ url: r.url, title: r.title || '', folder, t: r.dateAdded ? Math.round(Number(r.dateAdded) / 1000) : 0 });
      }
      return out;
    } finally { db.close(); }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const unent = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1)) : (ENT[e.toLowerCase()] ?? m));
const ent = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// The "Netscape bookmark file" every browser exports: <DT><H3>folder</H3><DL> … <DT><A HREF>…
function fromHTML(text) {
  const out = [], stack = [];
  let pending = null;
  const re = /<h3[^>]*>([\s\S]*?)<\/h3>|<dl[^>]*>|<\/dl>|<a\s([^>]*)>([\s\S]*?)<\/a>/gi;
  for (let m; (m = re.exec(text));) {
    const tag = m[0].slice(0, 3).toLowerCase();
    if (m[1] != null) pending = unent(m[1].replace(/<[^>]+>/g, '').trim());
    else if (tag === '<dl') { stack.push(pending); pending = null; }
    else if (tag === '</d') stack.pop();
    else {
      const href = /href\s*=\s*"([^"]*)"/i.exec(m[2]) || /href\s*=\s*'([^']*)'/i.exec(m[2]);
      if (!href) continue;
      const added = /add_date\s*=\s*"(\d+)"/i.exec(m[2]);
      out.push({ url: unent(href[1]), title: unent(m[3].replace(/<[^>]+>/g, '').trim()), folder: stack.filter(Boolean).join(' / '), t: added ? +added[1] * 1000 : 0 });
    }
  }
  return out.filter((b) => isWebURL(b.url));
}

function toHTML(list) {
  const groups = new Map();
  for (const b of list) { if (!groups.has(b.folder || '')) groups.set(b.folder || '', []); groups.get(b.folder || '').push(b); }
  const a = (b) => `<DT><A HREF="${ent(b.url)}" ADD_DATE="${Math.floor((b.t || 0) / 1000)}">${ent(b.title || b.url)}</A>`;
  let body = (groups.get('') || []).map((b) => '    ' + a(b)).join('\n');
  for (const [folder, items] of groups) {
    if (!folder) continue;
    body += `\n    <DT><H3>${ent(folder)}</H3>\n    <DL><p>\n${items.map((b) => '        ' + a(b)).join('\n')}\n    </DL><p>`;
  }
  return `<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n<TITLE>Bookmarks</TITLE>\n<H1>Bookmarks</H1>\n<DL><p>\n${body}\n</DL><p>\n`;
}

module.exports = { setupBookmarks, fromHTML, fromChromiumJSON, toHTML };
