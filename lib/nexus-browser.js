'use strict';
// The embedded Nexus panel (<webview partition="persist:nexus">) must look like
// the plain Chromium browser it is. Electron's default user agent carries two
// extra tokens — the app's own name/version ("ModCommandX/1.0.0") and
// "Electron/<ver>" — and Cloudflare, which fronts nexusmods.com and the Nexus
// sign-in page, scores that as an automated client.
//
// It is not enough to change the user agent of the persist:nexus SESSION: that
// reaches the panel's top document and its dedicated workers, but NOT a
// cross-site iframe (a separate renderer process — e.g. the Cloudflare
// Turnstile frame from challenges.cloudflare.com), SharedWorkers or
// ServiceWorkers. Those use Electron's app-wide fallback UA. Measured on
// Electron 33: the Turnstile frame's navigator.userAgent and its challenge
// XHRs said "ModCommandX/1.0.0 Chrome/130.0.6723.191 Electron/33.4.11" while
// the page around it said "Chrome/130.0.0.0" — two identities in one check,
// so the check failed ("verification failed") or its clearance cookie did not
// hold for the next request (a challenge loop).
//
// So the app-wide fallback (app.userAgentFallback) is the plain browser UA,
// set before any renderer starts, and the persist:nexus session gets the very
// same string. It is the one the bundled Chromium would send as Chrome itself:
// the Electron and app tokens stripped and the version reduced to
// "Chrome/<major>.0.0.0", exactly as Chrome reports it. Nothing is spoofed
// beyond that — platform, engine version and the Sec-CH-UA client hints stay
// the real bundled Chromium's. The app's own HTTP traffic (lib/nexus-http.js,
// GitHub, update checks) sets its own User-Agent explicitly and keeps
// identifying as Mod Command X.

const NEXUS_PARTITION = 'persist:nexus';

// Electron's UA is "<Mozilla ... (KHTML, like Gecko)> <app name>/<app version>
// Chrome/<full> Electron/<ver> Safari/537.36" — the app name may contain spaces
// ("Mod Command X/1.0.0"), so rebuild from the fixed prefix rather than strip.
function browserUserAgent(ua, chromeVersion = process.versions.chrome) {
  const s = String(ua || '');
  const prefix = s.match(/^Mozilla\/5\.0 \([^)]*\) AppleWebKit\/[\d.]+ \(KHTML, like Gecko\)/);
  const major = String(chromeVersion || '').split('.')[0]
    || ((s.match(/Chrome\/(\d+)/) || [])[1]);
  if (!prefix || !major) return s.replace(/\s+Electron\/\S+/gi, '');
  return `${prefix[0]} Chrome/${major}.0.0.0 Safari/537.36`;
}

// Call at startup, BEFORE app 'ready': renderers, out-of-process iframes and
// workers pick the fallback up when they are created.
function configureBrowserIdentity(app) {
  const ua = browserUserAgent(app.userAgentFallback);
  if (ua && ua !== app.userAgentFallback) app.userAgentFallback = ua;
  return app.userAgentFallback;
}

// ---------------------------------------------------------------- client hints
// Chrome sends the low-entropy client hints (Sec-CH-UA, Sec-CH-UA-Mobile,
// Sec-CH-UA-Platform) on EVERY request to a secure origin. In Electron only
// requests made by a page's own renderer carry them; navigations (the document
// itself, the Turnstile iframe) and worker requests go out without them, which
// no real Chrome does. The values are not invented here: they are the bundled
// Chromium's own navigator.userAgentData, read once from the app window
// (learnClientHints), and they are added only to requests that lack them.
let lowEntropyHints = null;

function hintsFromUserAgentData(d) {
  if (!d || !Array.isArray(d.brands) || !d.brands.length) return null;
  return {
    'sec-ch-ua': d.brands.map((b) => `"${b.brand}";v="${b.version}"`).join(', '),
    'sec-ch-ua-mobile': d.mobile ? '?1' : '?0',
    'sec-ch-ua-platform': `"${d.platform || ''}"`,
  };
}

async function learnClientHints(webContents) {
  try {
    const d = await webContents.executeJavaScript(
      '(() => { const d = navigator.userAgentData; return d ? { brands: d.brands.map((b) => ({ brand: b.brand, version: b.version })), mobile: d.mobile, platform: d.platform } : null; })()');
    const h = hintsFromUserAgentData(d);
    if (h) lowEntropyHints = h;
  } catch (_) {}
  return lowEntropyHints;
}

// Chrome sends client hints to potentially trustworthy origins only.
function sendsHints(url) {
  return /^https:\/\//i.test(url) || /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//i.test(url);
}

function withClientHints(headers, url, hints = lowEntropyHints) {
  if (!hints || !sendsHints(url)) return headers;
  const have = new Set(Object.keys(headers).map((k) => k.toLowerCase()));
  if (have.has('sec-ch-ua')) return headers;
  const out = { ...headers };
  for (const [k, v] of Object.entries(hints)) if (!have.has(k)) out[k] = v;
  return out;
}

// Idempotent. Call after app 'ready'. The session's UA is set to the same
// string as the fallback, so every surface of the panel agrees.
function configureNexusSession(session, app = null) {
  const ses = session.fromPartition(NEXUS_PARTITION);
  const ua = browserUserAgent(app ? app.userAgentFallback : ses.getUserAgent());
  if (ua && ua !== ses.getUserAgent()) ses.setUserAgent(ua);
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    callback({ requestHeaders: withClientHints(details.requestHeaders, details.url) });
  });
  return ua;
}

module.exports = {
  NEXUS_PARTITION, browserUserAgent, configureBrowserIdentity, configureNexusSession,
  learnClientHints, hintsFromUserAgentData, withClientHints,
};
