'use strict';
// Nexus Mods API client + nxm:// link handling.
// Game domain on Nexus: starwarszerocompany

const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { nexusFetch, setAppIdentity, isNexusUrl } = require('./nexus-http');

// ZC_NEXUS_API_BASE is a test seam only (point the client at a local mock);
// unset it is the live API.
const API_ROOT = process.env.ZC_NEXUS_API_BASE || 'https://api.nexusmods.com';
const API = `${API_ROOT}/v1`;
const GAME_DOMAIN = 'starwarszerocompany';
// The website (not the API). ZC_NEXUS_WEB_BASE is a test seam only, like
// ZC_NEXUS_API_BASE: it points the free-account download page at a local
// fixture server.
const WEB_ROOT = process.env.ZC_NEXUS_WEB_BASE || 'https://www.nexusmods.com';

// The page for ONE file's download: `file_id` selects the file and `nmm=1`
// makes it the mod-manager variant, whose "Slow download" hands back an
// nxm:// link (caught by main.js) instead of a browser download. This is what
// a free account's one-click opens in the embedded panel.
function fileDownloadPage(modId, fileId) {
  return `${WEB_ROOT}/${GAME_DOMAIN}/mods/${Number(modId)}?tab=files&file_id=${Number(fileId)}&nmm=1`;
}

// Nexus Mods' API Acceptable Use Policy requires every API request to identify
// the application by BOTH name and version. Mod Command X identifies as
// itself — never as the upstream Zero Company Mod Command, so Nexus can tell
// the two apps' traffic apart. The version is package.json's, so a release
// bump edits one file; lib/nexus-http.js takes both from here and puts them
// (plus a matching User-Agent) on every outbound request the app makes, to
// any Nexus host: v1, v2, api-router and the download CDN.
const APP_HEADERS = {
  'Application-Name': 'Mod Command X',
  'Application-Version': require('../package.json').version,
};
const { redactSecrets } = require('./redact');
const APP_VERSION = APP_HEADERS['Application-Version'];
setAppIdentity({ name: APP_HEADERS['Application-Name'], version: APP_VERSION });

// nxm://starwarszerocompany/mods/9/files/42?key=...&expires=...&user_id=...
function parseNxm(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch (_) {
    throw new Error(`That is not a usable Nexus Mods link: ${redactSecrets(raw)}`);
  }
  if (url.protocol !== 'nxm:') throw new Error('Not an nxm:// link.');
  const m = url.pathname.match(/^\/mods\/(\d+)\/files\/(\d+)$/);
  const game = url.host;
  if (!m) throw new Error(`That is not a usable Nexus Mods link: ${redactSecrets(raw)}`);
  if (game.toLowerCase() !== GAME_DOMAIN) {
    throw new Error(`That link is for a different game (${game}), not Star Wars: Zero Company.`);
  }
  return {
    game,
    modId: Number(m[1]),
    fileId: Number(m[2]),
    key: url.searchParams.get('key'),
    expires: url.searchParams.get('expires'),
    userId: url.searchParams.get('user_id'),
  };
}

// Mod Command X authenticates with the user's personal Nexus Mods API key
// (Settings -> Nexus Mods), sent as the `apikey` header — the credential both
// the v1 REST API and the v2 GraphQL gateway accept. The key never reaches the
// renderer, the log or a diagnostics report; main.js hands it in per call.
async function apiGet(pathname, apiKey, { background = false } = {}) {
  const res = await nexusFetch(`${API}${pathname}`, {
    kind: 'v1',
    background,
    headers: { apikey: apiKey },
  });
  if (res.status === 401) {
    // A key is not refreshable: a 401 means it was mistyped, regenerated on
    // the Nexus site or revoked. The flag lets callers tell that apart from
    // other failures (the stored key is still kept — the user decides).
    const err = new Error('Nexus Mods rejected the API key. Check it in Settings.');
    err.nexusUnauthorized = true;
    throw err;
  }
  // 429s never get here: nexus-http answers Retry-After itself and throws a
  // QuotaExceededError when it will not wait.
  if (!res.ok) throw new Error(`Nexus Mods replied ${res.status} ${res.statusText}.`);
  return res.json();
}

// Confirm the key works and report who it belongs to; returns
// { name, isPremium }. This is where the premium flag that drives the
// premium-vs-free download split comes from.
async function validateKey(apiKey) {
  const user = await apiGet('/users/validate.json', apiKey);
  return { name: user.name, isPremium: !!user.is_premium };
}

async function modInfo(modId, apiKey) {
  return apiGet(`/games/${GAME_DOMAIN}/mods/${modId}.json`, apiKey);
}

async function fileInfo(modId, fileId, apiKey) {
  return apiGet(`/games/${GAME_DOMAIN}/mods/${modId}/files/${fileId}.json`, apiKey);
}

// Resolve a CDN download URL. Non-premium users need key+expires from the nxm link
// (produced by the "Mod Manager Download" button on the website).
async function downloadLink(link, apiKey) {
  let pathname = `/games/${GAME_DOMAIN}/mods/${link.modId}/files/${link.fileId}/download_link.json`;
  if (link.key && link.expires) {
    pathname += `?key=${encodeURIComponent(link.key)}&expires=${encodeURIComponent(link.expires)}`;
  }
  const list = await apiGet(pathname, apiKey);
  if (!Array.isArray(list) || !list.length || !list[0].URI) {
    throw new Error('Nexus Mods returned no download link. Non-premium downloads must start from the "Mod Manager Download" button on the website.');
  }
  return list[0].URI;
}

async function downloadToFile(uri, destDir, suggestedName, onProgress) {
  fs.mkdirSync(destDir, { recursive: true });
  // The Nexus CDN is a Nexus host too, so the download identifies the app
  // exactly like every other request does. This same helper also fetches
  // GitHub release assets, which are not Nexus traffic and go out plainly.
  const res = isNexusUrl(uri) ? await nexusFetch(uri, { kind: 'cdn' }) : await fetch(uri);
  if (!res.ok || !res.body) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  let name = suggestedName;
  if (!name) {
    // Prefer the server's own filename; fall back to the URL path.
    const cd = res.headers.get('content-disposition') || '';
    const m = cd.match(/filename\*?=(?:UTF-8''|")?([^";]+)/i);
    if (m) { try { name = decodeURIComponent(m[1].trim().replace(/"$/, '')); } catch (_) { name = m[1].trim(); } }
  }
  if (!name) {
    try { name = decodeURIComponent(path.basename(new URL(uri).pathname)); } catch (_) {}
  }
  if (!name || !/\.[A-Za-z0-9]{2,4}$/.test(name)) name = (name || 'download') + '.zip';
  name = name.replace(/[\\/:*?"<>|]+/g, '_');
  const dest = path.join(destDir, name);
  const total = Number(res.headers.get('content-length')) || 0;
  let received = 0;
  const counter = new (require('stream').Transform)({
    transform(chunk, _enc, cb) {
      received += chunk.length;
      if (onProgress) onProgress(received, total);
      cb(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(dest));
  return dest;
}

// ------------------------------------------------- browsing (GraphQL v2, anonymous — no API key needed)

const SORTS = {
  downloads: { downloads: { direction: 'DESC' } },
  endorsements: { endorsements: { direction: 'DESC' } },
  newest: { createdAt: { direction: 'DESC' } },
  updated: { updatedAt: { direction: 'DESC' } },
  name: { name: { direction: 'ASC' } },
};

// One POST to the v2 GraphQL endpoint. `apiKey` is optional: browsing is
// anonymous, but the account-preferences query needs the user's key (the v2
// gateway takes the same `apikey` header as v1 — a bad key is refused there
// with "Please provide a valid API Key").
async function gqlPost(body, { apiKey = null, background = false } = {}) {
  return nexusFetch(`${API_ROOT}/v2/graphql`, {
    kind: 'v2',
    background,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { apikey: apiKey } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function gqlMods(filter, sort, count, offset) {
  const body = {
    query: `query Mods($filter: ModsFilter, $sort: [ModsSort!], $count: Int, $offset: Int) {
      mods(filter: $filter, sort: $sort, count: $count, offset: $offset) {
        totalCount
        nodes {
          modId name summary author version downloads endorsements
          pictureUrl thumbnailUrl updatedAt createdAt adult
          modCategory { name }
        }
      }
    }`,
    variables: { filter, sort, count, offset },
  };
  const res = await gqlPost(body);
  if (!res.ok) throw new Error(`Nexus Mods replied ${res.status} ${res.statusText}.`);
  const json = await res.json();
  if (json.errors && json.errors.length) throw new Error(`Nexus Mods query failed: ${json.errors[0].message}`);
  const mods = (json.data.mods.nodes || []).map((n) => ({
    modId: n.modId,
    name: n.name,
    summary: n.summary || '',
    author: n.author,
    version: n.version,
    downloads: n.downloads,
    endorsements: n.endorsements,
    picture: n.thumbnailUrl || n.pictureUrl || null,
    category: n.modCategory ? n.modCategory.name : null,
    updatedAt: n.updatedAt,
    adult: !!n.adult,
    url: `https://www.nexusmods.com/${GAME_DOMAIN}/mods/${n.modId}`,
  }));
  return { totalCount: json.data.mods.totalCount, mods };
}

// `includeAdult` is NEVER decided here and never by the renderer: main.js's
// adultAllowed() decides it from the key owner's's own Nexus content
// preference, and every listing path is handed the answer. With no key, or with
// that preference off, the filter goes on — for browsing, for category
// listings and for searches alike. (A search used to be a way past it; that is
// gone.) The filter is applied server-side so totalCount and "Load more"
// paging stay honest; `adultContent` is the v2 ModsFilter field, a
// BooleanFilterValue.
function adultFilter(filter, includeAdult) {
  if (!includeAdult) filter.adultContent = { value: false, op: 'EQUALS' };
  return filter;
}

async function browseMods({ query, category, sort, offset = 0, count = 24, includeAdult = false } = {}) {
  const q = query && query.trim() ? query.trim() : '';
  const filter = { gameDomainName: { value: GAME_DOMAIN, op: 'EQUALS' } };
  if (q) filter.name = { value: q, op: 'WILDCARD' };
  if (category) filter.categoryName = { value: category, op: 'EQUALS' };
  adultFilter(filter, includeAdult);
  return gqlMods(filter, [SORTS[sort] || SORTS.downloads], count, offset);
}

// Search by mod TITLE or AUTHOR (both WILDCARD, case-insensitive, run in
// parallel) and merge, title hits first. The mod page title is often nothing
// like the archive a user installed, so author search is the second way in.
async function searchMods(query, count = 10, { includeAdult = false } = {}) {
  const q = String(query || '').trim();
  if (!q) return [];
  const base = adultFilter({ gameDomainName: { value: GAME_DOMAIN, op: 'EQUALS' } }, includeAdult);
  const [byName, byAuthor] = await Promise.allSettled([
    gqlMods({ ...base, name: { value: q, op: 'WILDCARD' } }, [SORTS.downloads], count, 0),
    gqlMods({ ...base, author: { value: q, op: 'WILDCARD' } }, [SORTS.downloads], count, 0),
  ]);
  const byId = new Map();
  for (const r of [byName, byAuthor]) {
    if (r.status !== 'fulfilled') continue;
    for (const m of r.value.mods) if (!byId.has(m.modId)) byId.set(m.modId, m);
  }
  return [...byId.values()];
}

// Every mod in the game's catalog (anonymous, paged). Small for this game —
// used to build the file-name index. Capped so a runaway total can't loop.
//
// This one is deliberately NOT adult-filtered, and that is not a way round the
// policy: nothing it returns is ever shown. It builds an internal index of
// archive file names -> mod ids, so that a mod the user ALREADY HAS on disk
// can be matched to the page it came from. Filtering it would simply leave
// some of the user's own installed mods unidentifiable and un-updatable.
async function catalog() {
  const filter = { gameDomainName: { value: GAME_DOMAIN, op: 'EQUALS' } };
  const out = [];
  const PAGE = 50;
  for (let offset = 0, page = 0; page < 40; offset += PAGE, page += 1) {
    const { totalCount, mods } = await gqlMods(filter, [SORTS.updated], PAGE, offset);
    out.push(...mods);
    if (!mods.length || out.length >= totalCount) break;
  }
  return out;
}

// All Zero Company mods by the given authors (for the promoted/featured strip).
async function modsByAuthors(authors, { includeAdult = false } = {}) {
  const clean = [...new Set((authors || []).map((a) => String(a).trim()).filter(Boolean))];
  if (!clean.length) return [];
  const results = await Promise.allSettled(clean.map((author) =>
    gqlMods(
      adultFilter({ gameDomainName: { value: GAME_DOMAIN, op: 'EQUALS' }, author: { value: author, op: 'EQUALS' } }, includeAdult),
      [SORTS.updated], 20, 0,
    )));
  const byId = new Map();
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    for (const mod of r.value.mods) byId.set(mod.modId, mod);
  }
  return [...byId.values()].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

// The API key owner's own content preferences, straight from Nexus (v2,
// API key). `preferences.adult` is the switch on the user's Nexus account
// page, which Nexus only lets them turn on behind its own age verification —
// so this app takes it as given and never tries to talk it up or down.
// `ageVerificationInfo.verified` is reported for the record only.
//
// Anything unexpected — a query failure, a missing field, no key — is read
// as "no adult content". The safe answer is the strict one.
async function userPreferences(apiKey) {
  const off = { adult: false, adultBlurImages: false, ageVerified: false };
  if (!apiKey) return off;
  try {
    const res = await gqlPost({
      query: `query ContentPreferences {
        preferences { adult adultBlurImages }
        ageVerificationInfo { verified }
      }`,
    }, { apiKey });
    if (!res.ok) return off;
    const json = await res.json();
    if (!json || !json.data || (json.errors && json.errors.length)) return off;
    const p = json.data.preferences || {};
    const age = json.data.ageVerificationInfo || {};
    return {
      adult: p.adult === true,
      adultBlurImages: p.adultBlurImages === true,
      ageVerified: age.verified === true,
    };
  } catch (_) {
    return off;
  }
}

// v1: md5 lookup — identifies a file that matches a Nexus-hosted download.
// Only matches when the local file IS the uploaded file (e.g. a bare pak that
// was uploaded as-is); extracted archive contents usually won't match. Returns
// { modId, modName, version, fileId, fileName } or null.
async function md5Lookup(filePath, apiKey) {
  const crypto = require('crypto');
  const fs = require('fs');
  const md5 = await new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5');
    fs.createReadStream(filePath)
      .on('data', (d) => hash.update(d))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
  const res = await nexusFetch(`${API}/games/${GAME_DOMAIN}/mods/md5_search/${md5}.json`, {
    kind: 'v1',
    headers: { apikey: apiKey },
  });
  if (res.status === 404) return null; // no match
  if (!res.ok) return null;            // best-effort: treat API trouble as no match
  const results = await res.json();
  const hit = Array.isArray(results) && results[0];
  if (!hit || !hit.mod) return null;
  return {
    modId: hit.mod.mod_id,
    modName: hit.mod.name,
    version: hit.mod.version || null,
    fileId: hit.file_details ? hit.file_details.file_id : null,
    fileName: hit.file_details ? hit.file_details.file_name : null,
  };
}

// v1: list a mod's downloadable files (works for all accounts; links need premium or nxm key).
async function filesList(modId, apiKey, opts) {
  const data = await apiGet(`/games/${GAME_DOMAIN}/mods/${modId}/files.json`, apiKey, opts);
  return data.files || [];
}

// The full files payload: { files, updates }. `updates` is the chain the site
// records when an author uploads "as an update of an existing file"
// ({ old_file_id, new_file_id, uploaded_time }) — the authoritative "this file
// replaced that one" signal, independent of how versions are spelled.
async function filesData(modId, apiKey, opts) {
  const data = await apiGet(`/games/${GAME_DOMAIN}/mods/${modId}/files.json`, apiKey, opts);
  return { files: data.files || [], updates: data.file_updates || [] };
}

// Follow the update chain from fileId to its newest successor. Returns that
// file's record, or null when nothing replaced it (or the successor is gone).
function followUpdates(files, updates, fileId) {
  const seen = new Set();
  let cur = fileId;
  let last = null;
  for (;;) {
    if (seen.has(cur)) break; // defensive: a cyclic chain
    seen.add(cur);
    const step = (updates || []).find((u) => u.old_file_id === cur);
    if (!step) break;
    cur = step.new_file_id;
    const rec = files.find((f) => f.file_id === cur);
    if (rec) last = rec;
  }
  return last;
}

// Every file id the update chain reaches from fileId, newest last. Used to
// recognise that an incoming download SUPERSEDES an already-installed optional
// file (so it replaces that child instead of becoming a second one).
function updateChain(updates, fileId) {
  const seen = new Set([fileId]);
  const out = [];
  let cur = fileId;
  for (;;) {
    const step = (updates || []).find((u) => u.old_file_id === cur);
    if (!step || seen.has(step.new_file_id)) break;
    cur = step.new_file_id;
    seen.add(cur);
    out.push(cur);
  }
  return out;
}

// The Nexus file categories that are SIDE downloads of a mod rather than the
// mod itself: they may be installed alongside the main file, as its children.
const OPTIONAL_CATEGORIES = new Set(['OPTIONAL', 'UPDATE', 'MISCELLANEOUS']);

const RETIRED = new Set(['OLD_VERSION', 'ARCHIVED', 'DELETED']);

// Is there a newer file for an installed Nexus file? origin = { fileId,
// version }; compare(a, b) orders version strings (-1/0/1, null = unordered).
// Returns { target, current, via }: target = the file record to update to (or
// null), current = the installed file's version as the site records it.
//  1. Installed file id known → the site's update chain decides. No chain and
//     the file is still live → no update, whatever the page-level "Mod
//     version" field says (authors rarely keep it in sync).
//  2. No file id (linked by name), the file vanished, or it was retired without
//     a chain → the newest main file, but only when STRICTLY newer.
//
// opts.noPrimaryFallback turns rule 2 off. An OPTIONAL / UPDATE / MISCELLANEOUS
// file (an optional-file child, or a top-level entry installed from one) is its
// own line on the mod page: the newest MAIN file is a DIFFERENT download, not a
// newer version of it, so only the update chain may move it.
function resolveUpdate(data, origin, compare, opts = {}) {
  const files = data.files || [];
  const installed = origin && origin.fileId ? files.find((f) => f.file_id === origin.fileId) || null : null;
  const current = (installed && installed.version) || (origin && origin.version) || null;
  if (origin && origin.fileId) {
    const next = followUpdates(files, data.updates, origin.fileId);
    if (next && next.file_id !== origin.fileId) return { target: next, current, via: 'chain' };
    if (installed && !RETIRED.has(installed.category_name)) return { target: null, current, via: 'chain' };
  }
  if (opts.noPrimaryFallback) return { target: null, current, via: 'chain' };
  const primary = pickPrimaryFile(files);
  if (primary && (!installed || primary.file_id !== installed.file_id) && compare(primary.version, current) > 0) {
    return { target: primary, current, via: 'primary' };
  }
  return { target: null, current, via: 'primary' };
}

// The site's MAIN-category file, newest first.
function pickPrimaryFile(files) {
  const usable = files.filter((f) => f.category_name && f.category_name !== 'ARCHIVED' && f.category_name !== 'OLD_VERSION');
  const main = usable.filter((f) => f.is_primary || f.category_name === 'MAIN');
  const pool = main.length ? main : usable;
  pool.sort((a, b) => (b.uploaded_timestamp || 0) - (a.uploaded_timestamp || 0));
  return pool[0] || null;
}

module.exports = {
  GAME_DOMAIN, WEB_ROOT, fileDownloadPage, APP_HEADERS, APP_VERSION, parseNxm, validateKey, userPreferences, modInfo, fileInfo, downloadLink, downloadToFile,
  browseMods, searchMods, catalog, modsByAuthors, filesList, filesData, followUpdates, updateChain,
  OPTIONAL_CATEGORIES, resolveUpdate, pickPrimaryFile, md5Lookup,
};
