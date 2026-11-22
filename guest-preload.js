'use strict';
// Runs (isolated) inside every web page. Lets the canvas react to input that
// happens inside a page: clicks activate the window, pinch / Ctrl+wheel zooms
// the canvas, Ctrl+Shift+wheel zooms the page's text, and mouse back/forward
// buttons navigate.
const { ipcRenderer } = require('electron');

window.addEventListener('pointerdown', () => ipcRenderer.sendToHost('activate'), true);

window.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  // Shift turns vertical wheel motion into deltaX on Linux, so take whichever moved.
  if (e.shiftKey) return ipcRenderer.sendToHost('textzoom', { dy: e.deltaY || e.deltaX });
  ipcRenderer.sendToHost('zoom', { dy: e.deltaY, mode: e.deltaMode, x: e.clientX, y: e.clientY });
}, { passive: false, capture: true });

window.addEventListener('mouseup', (e) => {
  if (e.button === 3) ipcRenderer.sendToHost('nav', 'back');
  if (e.button === 4) ipcRenderer.sendToHost('nav', 'forward');
}, true);
