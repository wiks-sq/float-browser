'use strict';
// Auto-update for packaged builds (AppImage and .deb), via electron-updater.
// Float only ever *checks* on its own: it asks the update feed for its latest
// version once at start and then every 6 hours, and only when update checks are on
// in Settings. Downloading and installing an update always waits for the user.
// Running from source (`npm start`) or without a feed configured, it does nothing.
const { app, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');

const SIX_HOURS = 6 * 60 * 60 * 1000;

function setupUpdates({ send, loadSettings }) {
  const state = { supported: false, status: 'idle', version: null, progress: 0, error: '', checked: 0, feed: '' };
  const emit = () => send('updates', { ...state });

  // electron-builder writes app-update.yml (the feed) next to the app when a
  // `publish` target is configured. No file = no feed = updates unsupported.
  const feedFile = path.join(process.resourcesPath || '', 'app-update.yml');
  let updater = null;
  if (app.isPackaged && fs.existsSync(feedFile)) {
    try {
      ({ autoUpdater: updater } = require('electron-updater'));
      state.supported = true;
      const yml = fs.readFileSync(feedFile, 'utf8');
      const url = /url:\s*(\S+)/.exec(yml), owner = /owner:\s*(\S+)/.exec(yml), repo = /repo:\s*(\S+)/.exec(yml);
      state.feed = url ? url[1] : owner && repo ? `github.com/${owner[1]}/${repo[1]}/releases` : '';
    } catch (err) { state.error = err.message; }
  }

  if (updater) {
    updater.autoDownload = false; // ask first
    updater.autoInstallOnAppQuit = false;
    updater.on('checking-for-update', () => { state.status = 'checking'; emit(); });
    updater.on('update-available', (i) => { state.status = 'available'; state.version = i.version; emit(); });
    updater.on('update-not-available', () => { state.status = 'current'; state.checked = Date.now(); emit(); });
    updater.on('download-progress', (p) => { state.status = 'downloading'; state.progress = p.percent / 100; emit(); });
    updater.on('update-downloaded', (i) => { state.status = 'ready'; state.version = i.version; emit(); });
    updater.on('error', (err) => { state.status = 'error'; state.error = String(err && err.message || err).split('\n')[0]; emit(); });
  }

  const check = () => {
    if (!updater) return Promise.resolve(state);
    state.checked = Date.now();
    return updater.checkForUpdates().then(() => state).catch(() => state);
  };
  const auto = () => { if (loadSettings().updates !== false) check(); };
  if (updater) { setTimeout(auto, 15000); setInterval(auto, SIX_HOURS).unref?.(); }

  ipcMain.handle('updates:state', () => ({ ...state }));
  ipcMain.handle('updates:check', () => check());
  ipcMain.handle('updates:download', () => updater ? updater.downloadUpdate().then(() => true).catch(() => false) : false);
  ipcMain.handle('updates:install', () => { if (updater && state.status === 'ready') updater.quitAndInstall(); });
  return { state };
}

module.exports = { setupUpdates };
