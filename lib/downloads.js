'use strict';
// Downloads: saved straight to the downloads folder (or asked, if the user prefers),
// listed with live progress in Float's downloads panel. The list (not the files)
// is kept in downloads.json; private windows' downloads are never written there.
const { app, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');

module.exports = function setupDownloads({ send, loadSettings, isPrivateSession, retry }) {
  const FILE = () => path.join(app.getPath('userData'), 'downloads.json');
  const items = new Map(); // id -> record
  const live = new Map(); // id -> DownloadItem
  const reserved = new Set(); // paths claimed by downloads still in progress
  let seq = 0, pushTimer = 0;

  try {
    for (const r of JSON.parse(fs.readFileSync(FILE(), 'utf8'))) {
      if (r.state === 'progressing' || r.state === 'paused') r.state = 'interrupted'; // Float quit mid-download
      items.set(r.id, r);
      seq = Math.max(seq, r.id);
    }
  } catch {}

  const save = () => {
    const list = [...items.values()].filter((r) => !r.private).slice(-200);
    try {
      fs.mkdirSync(path.dirname(FILE()), { recursive: true });
      fs.writeFileSync(FILE() + '.tmp', JSON.stringify(list));
      fs.renameSync(FILE() + '.tmp', FILE());
    } catch (err) { console.error('downloads save failed:', err.message); }
  };
  const list = () => [...items.values()].reverse().map((r) => ({ ...r, exists: r.state === 'completed' ? fs.existsSync(r.path) : undefined }));
  const push = (now) => {
    if (now) { clearTimeout(pushTimer); pushTimer = 0; send('downloads', list()); return; }
    if (!pushTimer) pushTimer = setTimeout(() => { pushTimer = 0; send('downloads', list()); }, 250);
  };

  const folder = () => {
    const d = loadSettings().downloads || {};
    return d.dir && fs.existsSync(d.dir) ? d.dir : app.getPath('downloads');
  };
  // "file.zip", "file (1).zip", … — never overwrite, never collide with a running download.
  function uniquePath(dir, name) {
    const safe = (name || 'download').replace(/[/\\\0]/g, '_').replace(/^\.+/, '') || 'download';
    const ext = path.extname(safe), base = safe.slice(0, safe.length - ext.length);
    for (let i = 0; ; i++) {
      const p = path.join(dir, i ? `${base} (${i})${ext}` : safe);
      if (!fs.existsSync(p) && !reserved.has(p)) return p;
    }
  }

  function attach(ses) {
    ses.on('will-download', (_e, item, wc) => {
      const id = ++seq;
      // A window opened only to fetch this file (a download link opened in a new window)
      // has nothing to show afterwards: close it, as Chrome closes such tabs.
      if (wc && !wc.isDestroyed() && wc.getType() === 'webview' && !wc.getURL() && wc.navigationHistory.length() <= 1) {
        send('cmd', { cmd: 'close', wcId: wc.id });
      }
      const priv = isPrivateSession(ses);
      const ask = !!(loadSettings().downloads || {}).ask;
      const target = uniquePath(folder(), item.getFilename());
      if (ask) item.setSaveDialogOptions({ defaultPath: target });
      else { item.setSavePath(target); reserved.add(target); }
      const r = {
        id, url: item.getURL(), filename: path.basename(target), path: ask ? '' : target,
        received: 0, total: item.getTotalBytes(), state: 'progressing', start: Date.now(), private: priv || undefined,
      };
      items.set(id, r);
      live.set(id, item);
      send('downloads-event', { type: 'started', id, filename: r.filename });
      item.on('updated', (_ev, state) => {
        const p = item.getSavePath();
        if (p && !r.path) { r.path = p; r.filename = path.basename(p); reserved.add(p); }
        r.received = item.getReceivedBytes();
        r.total = item.getTotalBytes();
        r.state = state === 'interrupted' ? 'interrupted' : item.isPaused() ? 'paused' : 'progressing';
        push();
      });
      item.once('done', (_ev, state) => {
        reserved.delete(r.path);
        live.delete(id);
        r.received = item.getReceivedBytes();
        r.end = Date.now();
        // A cancelled save dialog arrives as "cancelled" with no path: just drop it.
        if (state === 'cancelled' && !r.path) { items.delete(id); push(true); return; }
        r.state = state; // completed | cancelled | interrupted
        if (r.path) r.filename = path.basename(r.path);
        save();
        push(true);
        send('downloads-event', { type: state, id, filename: r.filename });
      });
      push(true);
    });
  }

  const rec = (id) => items.get(id);
  ipcMain.handle('downloads:list', () => list());
  ipcMain.handle('downloads:open', async (_e, id) => { const r = rec(id); return r && r.path ? shell.openPath(r.path) : 'not found'; });
  ipcMain.handle('downloads:show', (_e, id) => { const r = rec(id); if (r && r.path) shell.showItemInFolder(r.path); });
  ipcMain.handle('downloads:folder', () => shell.openPath(folder()));
  ipcMain.handle('downloads:cancel', (_e, id) => live.get(id)?.cancel());
  ipcMain.handle('downloads:pause', (_e, id) => { live.get(id)?.pause(); const r = rec(id); if (r && live.has(id)) r.state = 'paused'; push(true); });
  ipcMain.handle('downloads:resume', (_e, id) => { const it = live.get(id); if (it && it.canResume()) it.resume(); const r = rec(id); if (r && it) r.state = 'progressing'; push(true); });
  ipcMain.handle('downloads:remove', (_e, id) => { live.get(id)?.cancel(); items.delete(id); save(); push(true); });
  ipcMain.handle('downloads:clear', () => {
    for (const [id, r] of items) if (!live.has(id)) items.delete(id);
    save(); push(true);
  });
  // Start the same URL again as a new download (in the private session if it was private).
  ipcMain.handle('downloads:retry', (_e, id) => { const r = rec(id); if (r) { items.delete(id); retry(r); push(true); } });

  return { attach, folder };
};
