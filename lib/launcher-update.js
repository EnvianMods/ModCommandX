'use strict';
// Self-update check for Mod Command X, plus where to get the Mod SDK.
//
// Two independent sources, fetched together:
//
// 1. X's OWN releases — the latest GitHub release of EnvianMods/ModCommandX.
//    Its tag (vN.N.N) is compared against package.json's version; when X is
//    behind, the update banner links to that release's page. X is a private
//    build: the repo may not exist yet or may be private, so a 404 — or any
//    other failure (offline, rate-limited, a tag that is not a version) — is
//    silent: no banner, no toast, nothing logged as an error. X never reads
//    the upstream Mod Command's launcher-version.json for this, so it can
//    never show the upstream app's update banner or its Nexus page.
//
// 2. The SDK block only — the upstream owner still publishes where to GET the
//    separate Zero Company Mod SDK in the shared, read-only
//    SWZeroCompanyFeaturedAuthors repo's launcher-version.json:
//      { ..., "sdk": { "url": "<where to get the SDK>", "updateUrl": "<sdk-version.json>" } }
//    X reads ONLY that `sdk` block from it (see lib/sdk-link.js and
//    docs/SDK_LINK.md); its latest/url/notes describe the upstream launcher
//    and are ignored here. `sdk` is built from known keys only, so a key
//    added later is simply ignored.

const RELEASES_URL = 'https://api.github.com/repos/EnvianMods/ModCommandX/releases/latest';
const SDK_LINKS_URL = 'https://raw.githubusercontent.com/EnvianMods/SWZeroCompanyFeaturedAuthors/main/launcher-version.json';
// Test-harness overrides, the same shape as main.js's ZC_DATA_DIR. Read at
// call time so a harness can point either check at a local fixture server.
function releasesUrl() { return process.env.ZC_X_RELEASES_URL || RELEASES_URL; }
function sdkLinksUrl() { return process.env.ZC_LAUNCHER_VERSION_URL || SDK_LINKS_URL; }
const CURRENT_VERSION = require('../package.json').version;

let cache = { info: null, at: 0 };
const TTL_MS = 60 * 60 * 1000;

function isNewer(latest, current) {
  const a = String(latest).replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  const b = String(current).replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) > (b[i] || 0)) return true;
    if ((a[i] || 0) < (b[i] || 0)) return false;
  }
  return false;
}

function httpsOrNull(v) {
  return typeof v === 'string' && /^https:\/\//.test(v) ? v : null;
}

// The optional `sdk` block. Both fields are optional strings and both must be
// https://; anything else is ignored rather than trusted. A block with neither
// usable field is null, so callers only ever test one thing.
function parseSdkBlock(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const url = httpsOrNull(raw.url);
  const updateUrl = httpsOrNull(raw.updateUrl);
  if (!url && !updateUrl) return null;
  return { url, updateUrl };
}

// GET JSON with a short timeout; null on ANY failure (404 included).
async function getJson(url, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(url, { signal: controller.signal, cache: 'no-store', headers });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// X's latest published release -> { latest, url, notes }, or null. Drafts and
// pre-releases never come back from /releases/latest; a tag that is not
// vN.N.N (or N.N.N) is ignored rather than guessed at.
async function latestRelease() {
  const json = await getJson(releasesUrl(), {
    Accept: 'application/vnd.github+json',
    'User-Agent': `ModCommandX/${CURRENT_VERSION}`,
  });
  if (!json || typeof json.tag_name !== 'string') return null;
  const m = json.tag_name.trim().match(/^v?(\d+\.\d+\.\d+)$/i);
  if (!m) return null;
  const url = httpsOrNull(json.html_url);
  // Only ever link to X's own GitHub pages.
  if (!url || !/^https:\/\/github\.com\/EnvianMods\/ModCommandX\//i.test(url)) return null;
  const name = typeof json.name === 'string' ? json.name.trim() : '';
  return { latest: m[1], url, notes: name && name !== json.tag_name ? name.slice(0, 300) : null };
}

async function sdkLinks() {
  const json = await getJson(sdkLinksUrl());
  return json ? parseSdkBlock(json.sdk) : null;
}

// Returns { available, current, latest, url, notes, sdk } — never throws.
// `force` skips the TTL (the on-demand "check now" path and the harness).
async function checkLauncherUpdate({ force = false } = {}) {
  const now = Date.now();
  if (!force && cache.info && now - cache.at < TTL_MS) return cache.info;
  const [rel, sdk] = await Promise.all([
    latestRelease().catch(() => null),
    sdkLinks().catch(() => null),
  ]);
  const info = {
    available: !!(rel && isNewer(rel.latest, CURRENT_VERSION)),
    current: CURRENT_VERSION,
    latest: rel ? rel.latest : null,
    url: rel ? rel.url : null,
    notes: rel ? rel.notes : null,
    sdk,
  };
  cache = { info, at: now };
  return info;
}

// The last answer we have, without touching the network — for the synchronous
// readers (sdk-link's status()). Null until the first check lands.
function cachedInfo() { return cache.info; }

module.exports = { checkLauncherUpdate, cachedInfo, isNewer, parseSdkBlock, CURRENT_VERSION };
