'use strict';
// Bridge between the canvas UI and the main process. Exposes only what the UI needs.
const { contextBridge, ipcRenderer } = require('electron');
// Registers <browser-action-list>: the toolbar of installed extensions.
require('electron-chrome-extensions/browser-action').injectBrowserAction();

const invoke = (ch) => (...a) => ipcRenderer.invoke(ch, ...a);
const on = (ch) => (fn) => ipcRenderer.on(ch, (_e, m) => fn(m));

contextBridge.exposeInMainWorld('drift', {
  config: invoke('config'),
  onConfigChanged: on('config-changed'),
  loadSession: invoke('session:load'),
  saveSession: (data) => ipcRenderer.send('session:save', data),
  onCmd: on('cmd'),
  onOpenWindow: on('open-window'),
  // extensions
  extensions: invoke('extensions:list'),
  removeExtension: invoke('extensions:remove'),
  setExtensionEnabled: invoke('extensions:set-enabled'),
  onExtensionsChanged: (fn) => ipcRenderer.on('extensions-changed', () => fn()),
  tabReady: (reqId, wcId) => ipcRenderer.send('tab-ready', { reqId, wcId }),
  tabActive: (wcId) => ipcRenderer.send('tab-active', wcId),
  setMuted: (wcId, muted) => ipcRenderer.send('set-muted', wcId, muted),
  // history
  historyQuery: invoke('history:query'),
  historyClear: invoke('history:clear'),
  historyRemove: invoke('history:remove'),
  // settings
  settings: invoke('settings:get'),
  allSettings: invoke('settings:all'),
  setSettings: invoke('settings:set'),
  setAdblock: invoke('settings:adblock'),
  setHistory: invoke('settings:history'),
  setSite: invoke('settings:site'),
  siteRule: invoke('settings:site-rule'),
  clearSiteCache: invoke('site:clear-cache'),
  resetSitePerms: invoke('site:reset-perms'),
  // site info / privacy
  siteInfo: invoke('site:info'),
  siteCookies: invoke('site:cookies'),
  clearSiteData: invoke('site:clear-data'),
  revokePermission: invoke('site:revoke-perm'),
  setPermission: invoke('site:set-perm'),
  chooseDownloadsFolder: invoke('downloads:choose-folder'),
  storageSites: invoke('site:storage-sites'),
  clearStorageSite: invoke('site:clear-storage-site'),
  privacyOverview: invoke('privacy:overview'),
  clearSiteRules: invoke('privacy:clear-site-rules'),
  clearAllData: invoke('privacy:clear-all'),
  // security
  certError: invoke('security:cert-error'),
  allowCert: invoke('security:allow-cert'),
  httpsFallback: invoke('security:https-fallback'),
  allowHttp: invoke('security:allow-http'),
  // spaces / private
  spaces: invoke('spaces:list'),
  createSpace: invoke('spaces:create'),
  updateSpace: invoke('spaces:update'),
  deleteSpace: invoke('spaces:delete'),
  privateClosed: invoke('private:closed'),
  // downloads
  downloads: invoke('downloads:list'),
  onDownloads: on('downloads'),
  onDownloadEvent: on('downloads-event'),
  openDownload: invoke('downloads:open'),
  showDownload: invoke('downloads:show'),
  openDownloadsFolder: invoke('downloads:folder'),
  cancelDownload: invoke('downloads:cancel'),
  pauseDownload: invoke('downloads:pause'),
  resumeDownload: invoke('downloads:resume'),
  removeDownload: invoke('downloads:remove'),
  clearDownloads: invoke('downloads:clear'),
  retryDownload: invoke('downloads:retry'),
  // shortcuts
  shortcuts: invoke('shortcuts:list'),
  setShortcut: invoke('shortcuts:set'),
  captureKeys: invoke('shortcuts:capture'),
  // places
  places: invoke('places:get'),
  savePlaces: invoke('places:set'),
  // misc
  about: invoke('about'),
  startData: invoke('start:data'),
  startHide: invoke('start:hide'),
  startUnhideAll: invoke('start:unhide-all'),
  updateState: invoke('updates:state'),
  checkUpdates: invoke('updates:check'),
  downloadUpdate: invoke('updates:download'),
  installUpdate: invoke('updates:install'),
  onUpdates: on('updates'),
  openDataFolder: invoke('open-data-folder'),
  print: invoke('print'),
  setPageZoom: invoke('page:zoom'),
  // permissions
  onPermission: on('permission'),
  answerPermission: (id, allow, remember) => ipcRenderer.send('permission-response', { id, allow, remember }),
});
