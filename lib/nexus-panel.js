'use strict';
// The embedded Nexus panel (<webview partition="persist:nexus">), seen from the
// main process: is its session signed in to nexusmods.com, what went wrong in
// it, and a short record of the last panel session for the support report.
//
// Signed in? The renderer reads the page (src/nexus-autoclick.js, pageState);
// this module adds what the page cannot hide: the session's cookies. Only the
// cookie NAMES and domains are ever looked at from outside this file — a value
// is tested in-process for shape (e.g. a member id that is not 0) and never
// logged, returned or stored.
//
// Which cookies mean "signed in". Measured anonymously (2026-09-28, X's own
// session setup, no login) on www.nexusmods.com (home, the game page, a mod
// file page) and users.nexusmods.com/auth/sign_in: a visitor who never signed
// in already carries
//   - Cloudflare's cf_clearance, __cf_bm, __cflb;
//   - `nexusmods_session` (32 chars, once the sign-in page was shown) AND
//     `nexusmods_session_refresh` (once www was visited with that session) —
//     so neither of the users site's session cookies means "signed in";
//   - some 30 ad/analytics cookies (_pubcid, pbjs-*, FC*, mp_*, _hj*, …).
// None of those may count. What is left are the www site's account cookies,
// which never appeared anonymously:
//   member_id   the account id — must be a positive number (a guest is
//               member 0: its header avatar is avatars.nexusmods.com/0/…);
//   pass_hash   the login hash beside it.
// These are the only cookies taken as "signed in", and only as a fallback: a
// cookie never overrides a page that plainly says "Log in" (the page is what
// Nexus serves this session right now); it fills in where the page says
// neither. To confirm the set on real accounts, the names (never values) of
// nexusmods.com cookies OUTSIDE the anonymous set are logged once per run
// when a page shows the account (unknownCookieNames).

const NEXUS_COOKIE_HOSTS = ['nexusmods.com'];

const AUTH_COOKIES = [
  { name: 'member_id', valid: (v) => /^[1-9]\d*$/.test(v) },
  { name: 'pass_hash', valid: (v) => v.length >= 8 && !/^0+$/.test(v) },
];

// Cookie names seen on nexusmods.com without any login (see above).
const ANONYMOUS_COOKIES = new Set([
  'cf_clearance', '__cf_bm', '__cflb', 'nexusmods_session', 'nexusmods_session_refresh',
  'CookieConsent', 'usprivacy', 'ad_clicker', 'ab', 'connectId', 'mako_fpc_id', 'panoramaId_expiry',
  'bounceClientVisit8621v', 'cto_bundle',
]);
const ANONYMOUS_PREFIXES = ['_', 'pbjs-', 'FC', 'mp_', 'panorama'];

// Names of nexusmods.com cookies that are neither anonymous nor already an
// AUTH_COOKIES entry — what a signed-in session has on top (names only).
function unknownCookieNames(cookies, hosts = NEXUS_COOKIE_HOSTS) {
  const known = new Set(AUTH_COOKIES.map((r) => r.name));
  const names = new Set();
  for (const c of cookies || []) {
    if (!c || !domainMatches(c.domain, hosts)) continue;
    const n = String(c.name || '');
    if (!n || ANONYMOUS_COOKIES.has(n) || known.has(n) || ANONYMOUS_PREFIXES.some((p) => n.startsWith(p))) continue;
    names.add(n.slice(0, 40));
  }
  return [...names].sort();
}

// Test harness override: the cookie check runs against a mock host instead
// (e.g. MCX_TEST_NEXUS_COOKIE_HOSTS=nexus.localhost), the same way
// MCX_USER_DATA_DIR / ZC_DATA_DIR point a test run elsewhere.
function cookieHosts() {
  const env = String(process.env.MCX_TEST_NEXUS_COOKIE_HOSTS || '').trim();
  return env ? env.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean) : NEXUS_COOKIE_HOSTS;
}

function domainMatches(domain, hosts) {
  const d = String(domain || '').toLowerCase().replace(/^\./, '');
  return hosts.some((h) => d === h || d.endsWith('.' + h));
}

// cookies: Electron Cookie objects. Returns the NAME of the first auth cookie
// present (in AUTH_COOKIES order), or null.
function authCookieSignal(cookies, hosts = cookieHosts()) {
  for (const rule of AUTH_COOKIES) {
    const hit = (cookies || []).find((c) => c && c.name === rule.name
      && domainMatches(c.domain, hosts) && rule.valid(String(c.value || '')));
    if (hit) return rule.name;
  }
  return null;
}

// Origin + path only (no query, no fragment) — all a log line may carry.
function originPath(u) {
  try { const x = new URL(u); return `${x.origin}${x.pathname}`; } catch (_) { return String(u || '').split(/[?#]/)[0].slice(0, 120); }
}
function originOf(u) {
  try { return new URL(u).origin; } catch (_) { return '?'; }
}

// ------------------------------------------------------------ panel diary
// One record per panel session (opened → closed). State changes are logged
// once each (never per tick); the last few sessions feed the report.
const REPORT_SESSIONS = 3;
function createPanelDiary({ log = () => {} } = {}) {
  let current = null;
  const history = []; // closed sessions, newest first
  let cookieNote = null; // a startup finding about the panel's cookie store
  const subErrors = new Map(); // webContentsId -> Map(origin -> Map(status -> n))

  function fresh(info = {}) {
    return {
      openedAt: new Date().toISOString(), closedAt: null,
      target: info.target ? originPath(info.target) : null,
      modId: info.modId || null, fileId: info.fileId || null, view: !!info.view,
      signedIn: null, signal: null, challenges: 0, challengesPassed: 0,
      signInVisited: false, oops: 0, blocked: 0, autoReloads: 0,
      nxm: 0, clicks: [], subErrors: {},
    };
  }
  function rec() { if (!current) current = fresh(); return current; }
  function keep(r) { history.unshift(r); history.length = Math.min(history.length, REPORT_SESSIONS); }

  function mergeSubErrors(target, errs) {
    for (const [o, byStatus] of Object.entries(errs || {})) {
      const t = target[o] || (target[o] = {});
      for (const [s, n] of Object.entries(byStatus)) t[s] = (t[s] || 0) + n;
    }
  }

  // A panel-side event from the renderer (or main). Returns the record.
  function event(kind, d = {}) {
    if (kind === 'open') {
      if (current) keep(current);
      current = fresh(d);
      log('info', `nexus panel: opened ${current.view ? 'to view' : 'for a download'} ${current.target || ''}`
        + `${current.modId ? ` (mod ${current.modId}${current.fileId ? ` file ${current.fileId}` : ''})` : ''}`);
      return current;
    }
    const r = rec();
    switch (kind) {
      case 'close':
        r.closedAt = new Date().toISOString();
        log('info', `nexus panel: closed (${summaryLine(r)})`);
        keep(r); current = null;
        break;
      case 'signed-in': {
        const val = d.state === 'in' ? true : (d.state === 'out' ? false : null);
        if (val !== r.signedIn || d.signal !== r.signal) {
          r.signedIn = val; r.signal = d.signal || null;
          log('info', `nexus panel: signed-in ${val === true ? 'YES' : (val === false ? 'NO' : 'unknown')}`
            + `${d.signal ? ` (${d.signal})` : ''}${d.url ? ` on ${originPath(d.url)}` : ''}`);
        }
        break;
      }
      case 'challenge':
        r.challenges += 1;
        log('info', `nexus panel: Cloudflare check shown on ${originPath(d.url)}`);
        break;
      case 'challenge-passed':
        r.challengesPassed += 1;
        log('info', `nexus panel: Cloudflare check passed (now ${originPath(d.url)})`);
        break;
      case 'signin-page':
        if (!r.signInVisited) log('info', `nexus panel: sign-in page visited (${originPath(d.url)})`);
        r.signInVisited = true;
        break;
      case 'oops':
        r.oops += 1;
        log('warn', `nexus panel: Nexus error page ("Something went wrong") on ${originPath(d.url)}`);
        break;
      case 'blocked':
        r.blocked += 1;
        log('warn', `nexus panel: page partly blocked — ${d.count || '?'} Nexus subresource(s) refused (${d.detail || '4xx'}) on ${originPath(d.url)}`);
        break;
      case 'auto-reload':
        r.autoReloads += 1;
        log('info', `nexus panel: reloaded once automatically (${d.reason || 'error page'})`);
        break;
      case 'autoclick':
        if (d.action) {
          r.clicks.push(d.action);
          log('info', `nexus panel: auto-click ${d.action}${d.url ? ` on ${originPath(d.url)}` : ''}`);
        }
        break;
      case 'nxm':
        r.nxm += 1;
        log('info', `nexus panel: nxm link caught${d.modId ? ` (mod ${d.modId}${d.fileId ? ` file ${d.fileId}` : ''})` : ''}`);
        break;
      default:
        break;
    }
    return r;
  }

  // Subresource responses of 400+ from the panel (webRequest.onCompleted).
  function subresource(webContentsId, url, status) {
    const o = originOf(url);
    let m = subErrors.get(webContentsId);
    if (!m) { m = new Map(); subErrors.set(webContentsId, m); }
    let s = m.get(o);
    if (!s) { s = new Map(); m.set(o, s); }
    s.set(status, (s.get(status) || 0) + 1);
  }
  // What this panel's current page load saw; `reset` starts a new page load.
  function pageErrors(webContentsId, { reset = false } = {}) {
    const m = subErrors.get(webContentsId);
    const out = {};
    if (m) for (const [o, s] of m) out[o] = Object.fromEntries(s);
    if (reset) {
      subErrors.delete(webContentsId);
      // (After a close the blanked panel's last page belongs to that session.)
      const r = current || history[0];
      if (r && Object.keys(out).length) mergeSubErrors(r.subErrors, out);
    }
    return out;
  }

  function cookieProblem(text) {
    cookieNote = text || null;
  }

  function summaryLine(r) {
    if (!r) return 'no panel session';
    const bits = [
      `signed in: ${r.signedIn === true ? 'yes' : (r.signedIn === false ? 'no' : 'unknown')}${r.signal ? ` (${r.signal})` : ''}`,
      `sign-in page: ${r.signInVisited ? 'visited' : 'no'}`,
      `checks: ${r.challenges} shown / ${r.challengesPassed} passed`,
      `error pages: ${r.oops}`, `partly blocked: ${r.blocked}`,
      `auto-click: ${r.clicks.length ? r.clicks.join(', ') : 'none'}`,
      `nxm caught: ${r.nxm}`,
    ];
    return bits.join(' · ');
  }

  function sessionLines(r, label) {
    const errs = r.subErrors || {};
    const origins = Object.keys(errs);
    return [
      `${label}: ${r.openedAt}${r.closedAt ? ` → ${r.closedAt}` : ' (still open)'}${r.view ? ' (page view)' : ' (download)'}`,
      `  Opened for: ${r.target || '?'}${r.modId ? ` (mod ${r.modId}${r.fileId ? ` file ${r.fileId}` : ''})` : ''}`,
      `  Signed in: ${r.signedIn === true ? 'yes' : (r.signedIn === false ? 'no' : 'unknown')}${r.signal ? ` — signal: ${r.signal}` : ''}`,
      `  Sign-in page visited: ${r.signInVisited ? 'yes' : 'no'}`,
      `  Cloudflare checks: ${r.challenges} shown, ${r.challengesPassed} passed`,
      `  Nexus error pages ("Something went wrong"): ${r.oops}; partly blocked pages: ${r.blocked}; automatic reloads: ${r.autoReloads}`,
      `  Auto-click: ${r.clicks.length ? r.clicks.join(', ') : 'nothing pressed'}`,
      `  nxm links caught: ${r.nxm}`,
      `  Subresource errors: ${origins.length ? origins.map((o) => `${o} ${Object.entries(errs[o]).map(([st, n]) => `${st}×${n}`).join(' ')}`).join('; ') : 'none'}`,
    ];
  }

  // For the support report: the last few panel sessions, newest first.
  function reportLines() {
    const sessions = [current, ...history].filter(Boolean).slice(0, REPORT_SESSIONS);
    const lines = [];
    if (!sessions.length) lines.push('Panel sessions: none this run');
    sessions.forEach((r, i) => lines.push(...sessionLines(r, i ? `Earlier panel session ${i}` : 'Last panel session')));
    lines.push(`Panel cookies: ${cookieNote || 'no problem detected'}`);
    return lines;
  }

  return { event, subresource, pageErrors, cookieProblem, reportLines, summaryLine, get current() { return current; }, get history() { return history.slice(); } };
}

module.exports = {
  AUTH_COOKIES, ANONYMOUS_COOKIES, unknownCookieNames, NEXUS_COOKIE_HOSTS, cookieHosts, domainMatches, authCookieSignal,
  originPath, createPanelDiary,
};
