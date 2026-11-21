'use strict';
// What a page did, for the site info panel: every request it made (with status, or
// what blocked it), the third-party sites it contacted, and the certificate its
// server presented. Kept in memory per window, reset when the window navigates.
const { webContents } = require('electron');
const { getDomain } = require('tldts-experimental');

const MAX_LOG = 1000;
const logs = new Map(); // wcId -> { page, entries: [] }
const certs = new Map(); // hostname -> certificate summary (latest connection)

const siteKey = (url) => { try { const h = new URL(url).hostname; return getDomain(h) || h; } catch { return ''; } };
const isThirdParty = (url, pageURL) => { const a = siteKey(url), b = siteKey(pageURL); return !!a && !!b && a !== b; };

function log(wcId) {
  let l = logs.get(wcId);
  if (!l) { l = { entries: [] }; logs.set(wcId, l); }
  return l;
}
function reset(wcId, pageURL) { logs.set(wcId, { page: pageURL, entries: [] }); }
function forget(wcId) { logs.delete(wcId); }

function record(d, extra) {
  if (d.webContentsId == null || !/^(https?|wss?):/.test(d.url)) return;
  const l = log(d.webContentsId);
  if (l.entries.length >= MAX_LOG) l.entries.shift();
  l.entries.push({
    t: d.timestamp, method: d.method, url: d.url, type: d.resourceType,
    status: d.statusCode, cache: d.fromCache || undefined, ip: d.ip, ...extra,
  });
}

function attach(ses) {
  ses.webRequest.onCompleted({ urls: ['<all_urls>'] }, (d) => record(d));
  ses.webRequest.onErrorOccurred({ urls: ['<all_urls>'] }, (d) => record(d, {
    error: d.error, blocked: d.error === 'net::ERR_BLOCKED_BY_CLIENT' || undefined,
  }));
  // Note every certificate Chromium checks, then let Chromium decide (-3 = use its verdict).
  ses.setCertificateVerifyProc((req, cb) => {
    const c = req.certificate || {};
    certs.set(req.hostname, {
      host: req.hostname, ok: req.errorCode === 0, error: req.errorCode === 0 ? '' : req.verificationResult,
      subject: c.subjectName, issuer: c.issuerName, validStart: c.validStart, validExpiry: c.validExpiry,
      fingerprint: c.fingerprint, knownRoot: req.isIssuedByKnownRoot, seen: Date.now(),
    });
    cb(-3);
  });
}

// Summary for the panel.
function info(wcId) {
  const wc = webContents.fromId(wcId);
  const page = wc && !wc.isDestroyed() ? wc.getURL() : (logs.get(wcId) || {}).page || '';
  const entries = (logs.get(wcId) || { entries: [] }).entries;
  const domains = new Map();
  for (const e of entries) {
    let host;
    try { host = new URL(e.url).hostname; } catch { continue; }
    const d = domains.get(host) || { host, site: siteKey(e.url), third: isThirdParty(e.url, page), requests: 0, blocked: 0, bytes: 0 };
    d.requests++;
    if (e.blocked) d.blocked++;
    domains.set(host, d);
  }
  let host = '';
  try { host = new URL(page).hostname; } catch {}
  return {
    url: page, host, site: siteKey(page), secure: page.startsWith('https:'),
    cert: certs.get(host) || null,
    domains: [...domains.values()].sort((a, b) => a.third - b.third || b.requests - a.requests),
    requests: entries.slice(-400),
    total: entries.length,
    blocked: entries.filter((e) => e.blocked).length,
  };
}

module.exports = { attach, info, reset, forget, certs, siteKey, isThirdParty };
