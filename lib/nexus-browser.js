'use strict';
// The embedded Nexus panel (<webview partition="persist:nexus">) must look like
// the plain Chromium browser it is. Electron's default user agent carries two
// extra tokens — the app's own name/version ("mod-command-x/1.0.0") and
// "Electron/33.x" — and Cloudflare, which fronts nexusmods.com and the Nexus
// sign-in page, scores that as an automated client: the Turnstile check on
// users.nexusmods.com never renders and the user cannot sign in.
//
// So for the persist:nexus session ONLY, the user agent is the one the bundled
// Chromium would send as Chrome itself: the Electron and app tokens stripped
// and the version reduced to "Chrome/<major>.0.0.0", exactly as Chrome reports
// it. Nothing is spoofed beyond that — the platform, the engine version and the
// Sec-CH-UA client hints stay the real, bundled Chromium's. The app's own API
// traffic (lib/nexus-http.js) keeps identifying itself as Mod Command X.

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

// Idempotent. Call after app 'ready'.
function configureNexusSession(session) {
  const ses = session.fromPartition(NEXUS_PARTITION);
  const ua = browserUserAgent(ses.getUserAgent());
  if (ua && ua !== ses.getUserAgent()) ses.setUserAgent(ua);
  return ua;
}

module.exports = { NEXUS_PARTITION, browserUserAgent, configureNexusSession };
