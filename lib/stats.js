'use strict';
// Local-only counters for the start page: how many requests the ad/tracker blocker
// stopped per day, and from which sites (registrable domain). Last 7 days kept, in
// stats.json in the profile folder. Nothing here ever leaves the computer, and
// private windows are not counted.
const fs = require('fs');

const DAYS = 7;

function setupStats({ file, siteKey }) {
  let data = null, timer = 0;
  const load = () => data || (data = (() => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { days: {} }; } })());
  const today = () => new Date().toISOString().slice(0, 10);
  const prune = () => {
    const keep = new Set(Array.from({ length: DAYS }, (_, i) => new Date(Date.now() - i * 864e5).toISOString().slice(0, 10)));
    for (const d of Object.keys(load().days)) if (!keep.has(d)) delete data.days[d];
  };
  const save = () => {
    clearTimeout(timer); timer = 0;
    try { prune(); fs.writeFileSync(file + '.tmp', JSON.stringify(data)); fs.renameSync(file + '.tmp', file); } catch {}
  };

  function blocked(url) {
    const d = load().days[today()] || (data.days[today()] = { blocked: 0, sites: {} });
    d.blocked++;
    const s = siteKey(url);
    if (s) d.sites[s] = (d.sites[s] || 0) + 1;
    if (!timer) timer = setTimeout(save, 30000);
  }

  function week() {
    prune();
    let total = 0, today_ = 0;
    const sites = {};
    for (const [day, d] of Object.entries(load().days)) {
      total += d.blocked;
      if (day === today()) today_ = d.blocked;
      for (const [s, n] of Object.entries(d.sites)) sites[s] = (sites[s] || 0) + n;
    }
    const top = Object.entries(sites).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([site, n]) => ({ site, n }));
    return { total, today: today_, sites: Object.keys(sites).length, top };
  }

  function clear() { data = { days: {} }; save(); }

  return { blocked, week, clear, flush: save };
}

module.exports = { setupStats };
