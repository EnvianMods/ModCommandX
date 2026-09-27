'use strict';
// OWNER TOOL — publishes a Mod Command X release to GitHub:
//   1. creates a GitHub Release (tag vX.Y.Z) on github.com/EnvianMods/ModCommandX
//   2. uploads the shipping zip (plus any extra files given) as release assets
//
// X is a private build distributed ONLY through those GitHub releases (never
// on Nexus Mods). Publishing the release IS the announcement: installed copies
// of X read /releases/latest of that repo (lib/launcher-update.js) and show
// their update banner from it. X never publishes to the upstream Zero Company
// Mod Command's repos, its Nexus page or the shared featured-authors files —
// the guard below refuses those targets even when passed with --repo.
//
// Usage (run after building and zipping):
//   node publish-release.js [--repo Owner/Name] <version> <path-to-zip> [more assets...] [--notes "..." | --notes-file notes.md]
//   node publish-release.js [--repo Owner/Name] --show
//   node publish-release.js --check-only <path-to-zip>   (guard only, no GitHub)
//
// --repo targets another of the owner's repos (default: EnvianMods/ModCommandX).
// Auth: release-token.txt (preferred) or token.txt next to this script, or
// GITHUB_TOKEN — needs Contents read/write on the target repo.
//
// PRIVACY GUARD: HANDOFF.md (internal working notes) is untracked in the public
// repo and lives only in the archive repo. Before any asset is uploaded, a .zip
// is listed and refused if it contains anything matching /HANDOFF/i.
//
// COMPLETENESS GUARD: the shipping zip (ModCommandX-v<version>.zip) must carry
// both ModCommandX.exe and "Uninstall Mod Command X.exe" (built next to it by
// electron-builder, see build/after-all-artifacts.js); a zip without the
// uninstaller is refused.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DEFAULT_REPO = 'EnvianMods/ModCommandX';
// --repo Owner/Name targets another repo; default is X's own.
const repoArg = (() => {
  const i = process.argv.indexOf('--repo');
  return i !== -1 ? process.argv[i + 1] : null;
})();
const REPO_FULL = repoArg || DEFAULT_REPO;
// The upstream project's publishing targets. X must never write to them.
const UPSTREAM_TARGETS = /^EnvianMods\/(ZeroCompanyModCommand(Archive)?|SWZeroCompanyFeaturedAuthors)$/i;
if (UPSTREAM_TARGETS.test(REPO_FULL)) {
  console.error(`Refusing: ${REPO_FULL} belongs to the upstream Zero Company Mod Command. Mod Command X publishes only to its own repos.`);
  process.exit(1);
}
const API = `https://api.github.com/repos/${REPO_FULL}`;

function getToken() {
  // Prefer the dedicated release-shipping token, then the shared token, then env.
  for (const f of ['release-token.txt', 'token.txt']) {
    const tokenFile = path.join(__dirname, f);
    if (fs.existsSync(tokenFile)) {
      const t = fs.readFileSync(tokenFile, 'utf8').trim();
      if (t) return t;
    }
  }
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim();
  // Recommended: no token file at all — `gh auth login` once, and the GitHub
  // CLI's own credential store (the OS keyring) supplies it. Never printed.
  return ghCliToken();
}

let ghTokenCache;
function ghCliToken() {
  if (ghTokenCache === undefined) {
    ghTokenCache = null;
    try {
      const r = require('child_process').spawnSync('gh', ['auth', 'token'], { encoding: 'utf8', windowsHide: true });
      if (r.status === 0 && String(r.stdout || '').trim()) ghTokenCache = String(r.stdout).trim();
    } catch (_) { /* gh not installed */ }
  }
  return ghTokenCache;
}

// ---------------------------------------------------------------- zip guard
const FORBIDDEN_IN_ASSETS = /HANDOFF/i;

function find7z() {
  const candidates = [
    path.join(__dirname, '..', '..', 'tools', '7-Zip', '7z.exe'),
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

// Returns { tool, lines } — the raw listing lines of the zip. Throws when no
// lister is available or the lister fails, so the guard fails CLOSED.
function listZip(zipPath) {
  const sevenZip = find7z();
  if (sevenZip) {
    const r = spawnSync(sevenZip, ['l', '-ba', zipPath], { encoding: 'utf8' });
    if (r.error) throw new Error(`could not run 7z.exe (${r.error.message})`);
    if (r.status !== 0) throw new Error(`7z.exe l failed (exit ${r.status}): ${String(r.stderr || r.stdout).trim().slice(0, 300)}`);
    return { tool: sevenZip, lines: String(r.stdout).split(/\r?\n/).filter((l) => l.trim()) };
  }
  const r = spawnSync('unzip', ['-l', zipPath], { encoding: 'utf8' });
  if (r.error) throw new Error('no zip lister available (bundled tools\\7-Zip\\7z.exe missing and `unzip` not on PATH) — cannot verify the asset');
  if (r.status !== 0) throw new Error(`unzip -l failed (exit ${r.status}): ${String(r.stderr || r.stdout).trim().slice(0, 300)}`);
  return { tool: 'unzip', lines: String(r.stdout).split(/\r?\n/).filter((l) => l.trim()) };
}

// Refuses to let an asset out of the door if it carries the internal working
// notes. Non-.zip assets are passed through (nothing to list). Throws on a hit.
function assertAssetIsPublishable(assetPath) {
  if (!/\.zip$/i.test(assetPath)) return { checked: false, entries: 0 };
  const { tool, lines } = listZip(assetPath);
  const hits = lines.filter((l) => FORBIDDEN_IN_ASSETS.test(l));
  if (hits.length) {
    throw new Error(
      `REFUSING TO UPLOAD ${path.basename(assetPath)} — it contains internal working notes:\n`
      + hits.map((h) => `    ${h.trim()}`).join('\n')
      + '\n  HANDOFF.md must never be published. Rebuild the zip without it'
      + ' (it is gitignored; the archive repo holds it at docs/HANDOFF.md).'
    );
  }
  return { checked: true, tool, entries: lines.length };
}

// The shipping zip must contain the app AND its uninstaller.
const SHIPPING_ZIP = /^ModCommandX-v\d+\.\d+\.\d+\.zip$/i;
const REQUIRED_IN_SHIPPING_ZIP = ['ModCommandX.exe', 'Uninstall Mod Command X.exe'];

function assertShippingZipComplete(assetPath) {
  if (!SHIPPING_ZIP.test(path.basename(assetPath))) return { checked: false };
  const { lines } = listZip(assetPath);
  const missing = REQUIRED_IN_SHIPPING_ZIP.filter((name) =>
    !lines.some((l) => l.trim().toLowerCase().endsWith(name.toLowerCase())
      && /(^|[\s\\/])$/.test(l.trim().slice(0, l.trim().length - name.length))));
  if (missing.length) {
    throw new Error(`REFUSING TO UPLOAD ${path.basename(assetPath)} — it is missing ${missing.join(' and ')}.
`
      + '  The shipping zip carries ModCommandX.exe and "Uninstall Mod Command X.exe" (both in release/ after npm run dist), README.txt and CHANGELOG.md.');
  }
  return { checked: true };
}

module.exports = { assertAssetIsPublishable, assertShippingZipComplete, listZip, FORBIDDEN_IN_ASSETS, REQUIRED_IN_SHIPPING_ZIP };

async function gh(url, options = {}) {
  return fetch(url, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'zc-release-tool',
      Authorization: `Bearer ${getToken()}`,
      ...(options.headers || {}),
    },
  });
}

async function main() {
  const args = process.argv.slice(2);

  // --check-only <zip>: run the privacy guard on a zip and exit. No GitHub calls.
  const checkIdx = args.indexOf('--check-only');
  if (checkIdx !== -1) {
    const target = args[checkIdx + 1];
    if (!target || !fs.existsSync(target)) { console.error('Usage: node publish-release.js --check-only <path-to-zip>'); process.exit(1); }
    try {
      const r = assertAssetIsPublishable(target);
      const c = assertShippingZipComplete(target);
      console.log(r.checked
        ? `OK — ${path.basename(target)} is clean (${r.entries} entries listed with ${r.tool})${c.checked ? ', app + uninstaller present' : ''}.`
        : `OK — ${path.basename(target)} is not a .zip, nothing to list.`);
    } catch (e) {
      console.error('BLOCKED:', e.message);
      process.exit(1);
    }
    return;
  }

  if (!getToken()) {
    console.error('No GitHub token found (release-token.txt / token.txt / GITHUB_TOKEN). It needs Contents read/write on', REPO_FULL + '.');
    process.exit(1);
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(REPO_FULL)) { console.error('Bad --repo (expected Owner/Name):', REPO_FULL); process.exit(1); }

  if (args.includes('--show')) {
    const res = await gh(`${API}/releases?per_page=10`);
    if (!res.ok) { console.error(`GitHub replied ${res.status} — does ${REPO_FULL} exist and does the token cover it?`); process.exit(1); }
    const releases = await res.json();
    if (!releases.length) console.log(`No releases in ${REPO_FULL} yet.`);
    for (const r of releases) {
      console.log('-', r.tag_name, '|', r.name, '|', (r.assets || []).map((a) => a.name).join(', ') || 'no assets');
    }
    return;
  }

  const notesIdx = args.indexOf('--notes');
  // --notes-file <path>: multi-line Markdown notes (a --notes "..." string
  // cannot carry line breaks through a .bat).
  const notesFileIdx = args.indexOf('--notes-file');
  const notesFile = notesFileIdx !== -1 ? args[notesFileIdx + 1] : null;
  if (notesFileIdx !== -1 && (!notesFile || !fs.existsSync(notesFile))) { console.error('--notes-file: file not found:', notesFile || '(none)'); process.exit(1); }
  const notes = notesFile ? fs.readFileSync(notesFile, 'utf8').trim() : (notesIdx !== -1 ? args[notesIdx + 1] || '' : '');
  const skipIdx = new Set([notesIdx + 1, notesFileIdx + 1, args.indexOf('--repo') + 1].filter((i) => i > 0));
  const positional = args.filter((a, i) => !a.startsWith('--') && !skipIdx.has(i));
  const [version, zipPath, ...extraAssets] = positional;
  const assets = [zipPath, ...extraAssets];
  if (!version || !/^\d+\.\d+\.\d+$/.test(version) || !zipPath || assets.some((a) => !fs.existsSync(a))) {
    console.error('Usage: node publish-release.js [--repo Owner/Name] <version like 1.2.0> <path-to-zip> [more assets...] [--notes "..." | --notes-file notes.md]');
    process.exit(1);
  }

  // 0. privacy + completeness guards — never let internal working notes reach
  //    the release page, never ship the app without its uninstaller
  try {
    for (const a of assets) {
      const g = assertAssetIsPublishable(a);
      if (g.checked) console.log(`Asset check: ${path.basename(a)} clean, no HANDOFF entries (${g.entries} entries listed with ${g.tool}).`);
      if (assertShippingZipComplete(a).checked) console.log(`Asset check: ${path.basename(a)} carries ModCommandX.exe and Uninstall Mod Command X.exe.`);
    }
  } catch (e) {
    console.error('BLOCKED:', e.message);
    process.exit(1);
  }

  // 1. create the release (or reuse it, so re-runs can refresh assets)
  const releaseName = `${REPO_FULL === DEFAULT_REPO ? 'Mod Command X' : REPO_FULL.split('/')[1].replace(/([a-z])([A-Z])/g, '$1 $2')} v${version}`;
  const defaultBody = `Release v${version}. See CHANGELOG.md for details.`;
  let release;
  let existingRes = await gh(`${API}/releases/tags/v${version}`);
  if (existingRes.status !== 200) {
    console.log(`Creating release v${version} on ${REPO_FULL}…`);
    const createRes = await gh(`${API}/releases`, {
      method: 'POST',
      body: JSON.stringify({ tag_name: `v${version}`, name: releaseName, body: notes || defaultBody }),
    });
    if (createRes.ok) {
      release = await createRes.json();
    } else if (createRes.status === 422) {
      // The tag's Linux CI job (.github/workflows/build-linux.yml) created the
      // release between the lookup and the POST — reuse it below.
      existingRes = await gh(`${API}/releases/tags/v${version}`);
    }
    if (!release && existingRes.status !== 200) {
      console.error(`Release creation failed (${createRes.status}):`, (await createRes.text()).slice(0, 400));
      console.error(`Is the repo created (github.com/${REPO_FULL}) and the token scoped to it?`);
      process.exit(1);
    }
  }
  if (!release) {
    release = await existingRes.json();
    console.log(`Release v${version} already exists on ${REPO_FULL} — adding assets to it.`);
    // The Linux CI job creates the release with a placeholder title and body
    // when it finishes first (a pushed tag): give it the real name and notes.
    const ciPlaceholder = !release.body || /^Automated Linux AppImage build\./.test(release.body);
    const patch = {};
    if (release.name !== releaseName) patch.name = releaseName;
    if (notes || ciPlaceholder) patch.body = notes || defaultBody;
    if (Object.keys(patch).length) {
      const patchRes = await gh(`${API}/releases/${release.id}`, { method: 'PATCH', body: JSON.stringify(patch) });
      if (!patchRes.ok) {
        console.error(`Updating the release title/notes failed (${patchRes.status}):`, (await patchRes.text()).slice(0, 400));
        process.exit(1);
      }
      release = await patchRes.json();
      console.log(`Release v${version}: ${Object.keys(patch).join(' and ')} updated.`);
    }
  }
  // 2. upload the assets (the zip first); re-runs skip what is already there
  for (const asset of assets) {
    const assetName = path.basename(asset);
    if ((release.assets || []).some((a) => a.name === assetName)) {
      console.log(`skip ${assetName} (already uploaded)`);
      continue;
    }
    console.log(`Uploading ${assetName} (${(fs.statSync(asset).size / 1048576).toFixed(1)} MB)…`);
    const uploadUrl = release.upload_url.replace(/\{.*\}$/, '') + `?name=${encodeURIComponent(assetName)}`;
    const uploadRes = await gh(uploadUrl, {
      method: 'POST',
      headers: { 'Content-Type': /\.zip$/i.test(assetName) ? 'application/zip' : 'application/octet-stream' },
      body: fs.readFileSync(asset),
    });
    if (!uploadRes.ok) {
      console.error(`Asset upload failed (${uploadRes.status}):`, (await uploadRes.text()).slice(0, 400));
      process.exit(1);
    }
  }
  console.log('GitHub release published:', release.html_url);
  if (REPO_FULL === DEFAULT_REPO) {
    console.log('Installed copies of Mod Command X will offer it on their next hourly update check.');
  }
}

if (require.main === module) {
  main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
}
