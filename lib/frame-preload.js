'use strict';
// Runs at the start of every frame of every page (registered per session). Third-party
// cookie blocking: Float strips cookies from cross-site requests; inside a cross-site
// frame it also makes document.cookie empty, so embedded trackers can't keep an ID there.
const { ipcRenderer, contextBridge } = require('electron');
if (window !== window.top) {
  let block = false;
  try { block = ipcRenderer.sendSync('frame:block-cookies'); } catch {}
  if (block) {
    // Synchronous, before any of the frame's own scripts run.
    contextBridge.executeInMainWorld({
      func: () => Object.defineProperty(document, 'cookie', { configurable: true, get() { return ''; }, set(_v) {} }),
    });
  }
}
