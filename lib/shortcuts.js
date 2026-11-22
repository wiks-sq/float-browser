'use strict';
// Keyboard shortcuts: Float's defaults plus the user's own bindings
// (settings.shortcuts = { command: ["Ctrl+K", …] }, replacing that command's defaults).

// [command, label, default accelerators]. "nav:left" = command "nav" with arg "left".
const COMMANDS = [
  ['new', 'Spotlight / new window', ['Ctrl+T', 'Ctrl+N']],
  ['private', 'New private window', ['Ctrl+Shift+N']],
  ['reopen', 'Reopen closed window', ['Ctrl+Shift+T']],
  ['close', 'Close window', ['Ctrl+W']],
  ['url', 'Edit address', ['Ctrl+L']],
  ['history', 'History', ['Ctrl+H']],
  ['downloads', 'Downloads', ['Ctrl+J']],
  ['places', 'Places', ['Ctrl+Shift+O']],
  ['place', 'Save this place', ['Ctrl+D']],
  ['bookmark', 'Bookmark this page (again: remove)', ['Ctrl+Shift+D']],
  ['bookmarks', 'Bookmarks', ['Ctrl+Shift+B']],
  ['settings', 'Settings', ['Ctrl+,']],
  ['site-info', 'Site info', []],
  ['find', 'Find in page', ['Ctrl+F']],
  ['full-win', 'Fly to window, then fill the screen with it (again: back to the canvas)', ['Ctrl+Shift+F']],
  ['focus-win', 'Fly to selected window', []],
  ['cycle-next', 'Next window', ['Ctrl+Tab']],
  ['cycle-prev', 'Previous window', ['Ctrl+Shift+Tab']],
  ['nav:left', 'Window to the left', ['Alt+Shift+Left']],
  ['nav:right', 'Window to the right', ['Alt+Shift+Right']],
  ['nav:up', 'Window above', ['Alt+Shift+Up']],
  ['nav:down', 'Window below', ['Alt+Shift+Down']],
  ['back', 'Back', ['Alt+Left']],
  ['forward', 'Forward', ['Alt+Right']],
  ['reload', 'Reload', ['Ctrl+R', 'F5']],
  ['hard-reload', 'Reload, ignoring cache', ['Ctrl+Shift+R', 'Shift+F5']],
  ['fit', 'Show all windows', ['Ctrl+0']],
  ['zoom100', 'Canvas zoom 100%', ['Ctrl+1']],
  ['zoom-in', 'Canvas zoom in', ['Ctrl+=', 'Ctrl+Plus', 'Ctrl+Shift+Plus', 'Ctrl+Shift+=']],
  ['zoom-out', 'Canvas zoom out', ['Ctrl+-', 'Ctrl+Shift+-']],
  ['page-zoom-in', 'Page text bigger', []],
  ['page-zoom-out', 'Page text smaller', []],
  ['page-zoom-reset', 'Page text normal size', []],
  ['print', 'Print', ['Ctrl+P']],
  ['view-source', 'View page source', ['Ctrl+U']],
  ['devtools', 'Developer tools', ['Ctrl+Shift+I', 'F12']],
  ['fullscreen', 'Full screen', ['F11']],
];

const NAMED = { ' ': 'Space', '+': 'Plus', ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down' };

// One canonical string for a key press, e.g. "Ctrl+Shift+T". Letters and digits come
// from the physical key (layout- and Shift-proof); symbols from the character typed,
// so "+" works on keyboards where it has its own key.
function accelOf(input) {
  const code = input.code || '';
  let key;
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit\d$/.test(code)) key = code.slice(5);
  else if (/^Numpad\d$/.test(code)) key = code.slice(6);
  else key = NAMED[input.key] || (input.key.length === 1 ? input.key.toUpperCase() : input.key);
  if (['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'Dead', 'Unidentified'].includes(key)) return null;
  const mods = [];
  if (input.control || input.meta) mods.push('Ctrl');
  if (input.alt) mods.push('Alt');
  if (input.shift) mods.push('Shift');
  return [...mods, key].join('+');
}

// Normalise what a user typed in config ("ctrl+shift+t") to accelOf's form.
function canonical(a) {
  const parts = String(a).split('+').map((p) => p.trim()).filter(Boolean);
  if (String(a).endsWith('++')) parts.push('Plus');
  const key = parts.pop() || '';
  const mods = new Set(parts.map((p) => p.toLowerCase()));
  const out = [];
  if (mods.has('ctrl') || mods.has('control') || mods.has('cmd') || mods.has('cmdorctrl')) out.push('Ctrl');
  if (mods.has('alt') || mods.has('option')) out.push('Alt');
  if (mods.has('shift')) out.push('Shift');
  out.push(key.length === 1 ? key.toUpperCase() : key[0].toUpperCase() + key.slice(1));
  return out.join('+');
}

function bindings(user = {}) {
  return COMMANDS.map(([cmd, label, def]) => ({
    cmd, label, defaults: def,
    keys: Array.isArray(user[cmd]) ? user[cmd].map(canonical) : def,
    custom: Array.isArray(user[cmd]),
  }));
}

function matcher(user) {
  const map = new Map();
  for (const b of bindings(user)) for (const k of b.keys) if (!map.has(k)) map.set(k, b.cmd);
  return (input) => {
    const a = accelOf(input);
    const cmd = a && map.get(a);
    if (!cmd) return null;
    const [c, arg] = cmd.split(':');
    return arg ? { cmd: c, arg } : { cmd: c };
  };
}

module.exports = { COMMANDS, accelOf, canonical, bindings, matcher };
