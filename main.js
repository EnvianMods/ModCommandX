'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

// ------------------------------------------------- runtime integrity check
// The portable exe unpacks the whole Electron runtime into
// %TEMP%\ModCommandX (see package.json build.portable.unpackDirName)
// and runs it from there. Antivirus products have been seen quarantining files
// straight out of that folder — ffmpeg.dll most often — which leaves the app
// dead at launch or silently broken. Check the runtime DLLs before anything
// else runs so the user gets an explanation and a folder to whitelist instead
// of a bare Windows error box.
//
// LIMITATION: ffmpeg.dll is imported by the Electron executable itself, so when
// THAT is the quarantined file Windows fails the launch before any JavaScript
// runs and this check never executes. It catches the lazily loaded graphics
// DLLs (and reports ffmpeg.dll too, for the cases where we do get to run).
// The DLLs the Electron runtime ships next to the exe (Electron 44: ANGLE is
// linked into the exe, so libEGL.dll / libGLESv2.dll no longer exist — listing
// them made every packaged launch report them "missing").
const RUNTIME_DLLS = ['ffmpeg.dll', 'd3dcompiler_47.dll', 'dxcompiler.dll', 'dxil.dll', 'vk_swiftshader.dll', 'vulkan-1.dll'];

function checkRuntimeFiles() {
  if (process.platform !== 'win32' || !app.isPackaged) return;
  const dir = path.dirname(process.execPath);
  let missing = [];
  try {
    missing = RUNTIME_DLLS.filter((name) => !fs.existsSync(path.join(dir, name)));
  } catch {
    return; // never let the check itself stop the app
  }
  if (missing.length === 0) return;
  const message = [
    'Part of the app runtime is missing from the folder it was unpacked into:',
    '',
    dir,
    '',
    'Missing: ' + missing.join(', '),
    '',
    'This is almost always antivirus: the portable exe unpacks itself into that',
    'folder on every launch, and the security software quarantined the file(s)',
    'again right after they were written. Reinstalling or re-downloading will',
    'not help on its own.',
    '',
    'To fix it:',
    '  1. Restore the listed file(s) from your antivirus quarantine, and',
    '  2. Add the folder above to your antivirus exclusions (it keeps the same',
    '     name every launch, so one exclusion is enough), then',
    '  3. Run Mod Command X again.',
  ].join('\n');
  try {
    dialog.showErrorBox('Mod Command X — runtime files missing', message);
  } catch {
    // showErrorBox can throw on a headless/broken session; exiting is still right
  }
  app.exit(1);
}
checkRuntimeFiles();

// Test harness override (like ZC_DATA_DIR below): a separate Electron userData —
// its own persist:nexus cookies and single-instance lock — so a test run never
// touches the user's real %APPDATA%\Mod Command X.
if (process.env.MCX_USER_DATA_DIR) app.setPath('userData', process.env.MCX_USER_DATA_DIR);

const { Store } = require('./lib/store');
const steam = require('./lib/steam');
const { ModEngine, compareVersions, MODS_REL, LOGIC_MODS_REL, WIN64_REL, UE4SS_MODS_REL, GAME_MODS_REL } = require('./lib/mods');
const { findSevenZip, bundledSevenZip } = require('./lib/archive');
const nexus = require('./lib/nexus');
const nexusHttp = require('./lib/nexus-http');
const ue4ssDl = require('./lib/ue4ss');
const zcsdkRt = require('./lib/zcsdk');
const retocDl = require('./lib/retoc');
const configs = require('./lib/configs');
const { getPromotedAuthors } = require('./lib/featured');
const github = require('./lib/github');
const ea = require('./lib/ea');
const { checkLauncherUpdate, cachedInfo: cachedLauncherInfo } = require('./lib/launcher-update');
const { log, logText } = require('./lib/log');
const report = require('./lib/report');
// SDK LINK: Mod Command hosts the Zero Company Mod SDK's OWN UI when one is
// installed. It carries no copy of that UI — see lib/sdk-link.js and
// docs/SDK_LINK.md.
const sdkLink = require('./lib/sdk-link');
const { configureBrowserIdentity, configureNexusSession, learnClientHints } = require('./lib/nexus-browser');
const { configureWebPermissions, lockWebContentsDevices } = require('./lib/web-permissions');
// Before 'ready': every renderer, out-of-process iframe and worker (the Nexus
// panel's Cloudflare Turnstile frame included) presents the plain Chrome user
// agent, not Electron's — see lib/nexus-browser.js.
configureBrowserIdentity(app);

// App data (settings, staging, indexes) lives in the OS per-user app-data
// folder — %APPDATA%\ModCommandX on Windows — never beside the exe.
// (The mod ARCHIVE is separate: it lives in the game folder, see below.)
// Running from source keeps using ./data so a dev checkout stays self-contained.
//
// Mod Command X installs side by side with the upstream Zero Company Mod
// Command: its own data folder here (settings, credentials, staging), its own
// Electron userData (%APPDATA%\Mod Command X, from package.json productName —
// so its own single-instance lock and its own persist:nexus cookies). It does
// NOT migrate the upstream app's %APPDATA%\ZeroCompanyModCommand or its older
// ZeroCompanyModCommand-data folder. The one thing both apps share is the
// game-side mod ARCHIVE, <game>\ModCommandArchive — one stored copy of each
// mod, see "mod archive location" below.
const APPDATA_DIR_NAME = 'ModCommandX';

function resolveDataDir() {
  if (process.env.ZC_DATA_DIR) return process.env.ZC_DATA_DIR; // test harness override
  if (!app.isPackaged && !process.env.PORTABLE_EXECUTABLE_DIR) return path.join(__dirname, 'data');
  return path.join(app.getPath('appData'), APPDATA_DIR_NAME);
}

const store = new Store(resolveDataDir());
const engine = new ModEngine(store);
let win = null;

// ---------------------------------------------------------- mod archive location
// The archive (library/backups/versions + a mirrored manifest) lives in the
// GAME folder by default — <game>\ModCommandArchive — so mods survive app
// updates and deletions, and a fresh install can restore everything from it.
// settings.storageDir overrides with a custom location.
//
// SHARED WITH THE MAIN MOD COMMAND. <game>\ModCommandArchive is the upstream
// Zero Company Mod Command's archive too: both apps reference the SAME stored
// copy of each mod (library/<id>), so nothing is kept twice. Rules X follows
// (the main app 1.9.14 knows nothing of X and follows none of them):
//   - startup: mods the main app installed are adopted in place — X adds the
//     records, pointing at the same library/<id>; no file is copied
//     (reconcileSharedArchive). Only mod records: never its settings,
//     credentials or theme.
//   - the mirror (manager-data.json in the archive) is merged, never
//     clobbered: the main app's records, settings block and profiles stay.
//   - removing a mod here leaves its stored copy when the main app still
//     lists it (a toast says so). The main app removing a mod DOES delete the
//     copy X uses; X then shows the mod as missing (re-download or remove).
//   - X's own pre-1.0 archive, <game>\ModCommandXArchive, is folded in once.
//   - don't run both apps at once: X shows a banner while the main app is open.

const storageLib = require('./lib/storage');
const { ARCHIVE_DIR_NAME, OLD_X_ARCHIVE_DIR_NAME, MIRROR_FILE, X_BLOCK } = storageLib;

function resolveStorageRoot() {
  return storageLib.resolveStorageRoot(store.settings, store.dataDir);
}

// The archive is in use (not the app-data fallback before a game is set).
function archiveActive() {
  return path.resolve(store.storageRoot) !== path.resolve(store.dataDir);
}

// The main Mod Command's own data folder — %APPDATA%\ZeroCompanyModCommand
// (packaged and portable builds alike; a dev run keeps ./data, which the
// archive mirror stands in for). Only ever READ. Test runs (ZC_DATA_DIR) never
// look at the real one unless MCX_UPSTREAM_DATA_DIR names a folder.
function upstreamDataDir() {
  if (process.env.MCX_UPSTREAM_DATA_DIR) return process.env.MCX_UPSTREAM_DATA_DIR;
  if (process.env.ZC_DATA_DIR) return null;
  try { return path.join(app.getPath('appData'), 'ZeroCompanyModCommand'); } catch (_) { return null; }
}

// What the main app references in the current archive (short cache: a batch
// of uninstalls or an orphan scan reads the manifest once).
let sharedRefsCache = null;
function sharedRefs(fresh) {
  if (!archiveActive()) return { ids: new Set(), records: new Map(), source: 'none' };
  const now = Date.now();
  if (!fresh && sharedRefsCache && sharedRefsCache.root === store.storageRoot && now - sharedRefsCache.at < 3000) {
    return sharedRefsCache.refs;
  }
  const refs = storageLib.upstreamRefs(store.storageRoot, upstreamDataDir());
  sharedRefsCache = { at: now, root: store.storageRoot, refs };
  return refs;
}

// Stored copies a removal here left in place because the main app uses them:
// never re-adopted at the next startup (the user removed them from X).
function dismissShared(id) {
  const list = Array.isArray(store.settings.sharedArchiveDismissed) ? store.settings.sharedArchiveDismissed : [];
  if (!list.includes(id)) list.push(id);
  store.settings.sharedArchiveDismissed = list;
}

let keptSharedNames = [];
engine.shared = {
  isReferenced: (id) => sharedRefs().ids.has(String(id)),
  kept: (id, mod) => {
    dismissShared(String(id));
    keptSharedNames.push((mod && mod.name) || id);
    log('info', `kept the stored copy of "${(mod && mod.name) || id}" (library/${id}) — Mod Command still uses it`);
  },
};

// Notices from archive setup, shown once the window is up.
const archiveNotices = [];
let windowLoaded = false;
function archiveNotice(message, kind) {
  if (windowLoaded) sendEvent({ type: 'toast', kind: kind || 'info', message });
  else archiveNotices.push({ message, kind });
}

// Leaving an archive for another folder (a custom location picked, or the
// game folder changed): X copies ITS OWN stored mods over. A copy the main
// Mod Command still uses is copied and left in place; one only X used is
// moved. Nothing else in the old archive is X's to move.
function leaveArchive(fromRoot, toRoot) {
  let moved = 0;
  const refs = storageLib.upstreamRefs(fromRoot, upstreamDataDir());
  const copyEntry = (s, d, keep) => {
    if (!fs.existsSync(s)) return;
    if (fs.existsSync(d)) {
      // Already there (the same bytes): the source copy is surplus unless kept.
      if (!keep && storageLib.sameTree(s, d)) fs.rmSync(s, { recursive: true, force: true });
      return;
    }
    fs.mkdirSync(path.dirname(d), { recursive: true });
    fs.cpSync(s, d, { recursive: true });
    if (storageLib.countFilesRec(s) !== storageLib.countFilesRec(d)) return;
    if (!keep) fs.rmSync(s, { recursive: true, force: true });
    moved += 1;
  };
  for (const m of store.mods) {
    const shared = refs.ids.has(String(m.id));
    copyEntry(path.join(fromRoot, 'library', m.id), path.join(toRoot, 'library', m.id), shared);
    copyEntry(path.join(fromRoot, 'backups', 'gamefiles', m.id), path.join(toRoot, 'backups', 'gamefiles', m.id), shared);
    const key = engine._vaultKey(m);
    const vsrc = path.join(fromRoot, 'versions', key);
    try {
      for (const entry of fs.readdirSync(vsrc)) copyEntry(path.join(vsrc, entry), path.join(toRoot, 'versions', key, entry), true);
    } catch (_) {}
  }
  return { moved };
}

// X's own archive from before it shared the main app's: fold its entries into
// the shared one (copy-verify-delete, never clobbering; an id that collides
// with different content moves in under a new id and X's records follow),
// then remove the old folder once nothing but its mirror is left. Safe to
// interrupt — the next start picks up what is left.
function foldOldXArchive(desired) {
  if (!store.settings.gamePath) return null;
  const old = path.join(store.settings.gamePath, OLD_X_ARCHIVE_DIR_NAME);
  if (!fs.existsSync(old) || storageLib.samePath(old, desired)) return null;
  const oldMirrorFile = path.join(old, MIRROR_FILE);
  const oldMirror = storageLib.readJson(oldMirrorFile);
  let restored = 0;
  // X's own data folder was reset but its old archive remembers the mods:
  // those records are X's own, bring them back before the files move.
  if (!store.mods.length && oldMirror && Array.isArray(oldMirror.mods)) {
    for (const rec of oldMirror.mods) {
      if (!rec || !rec.id || !Array.isArray(rec.files) || !fs.existsSync(path.join(old, 'library', rec.id))) continue;
      store.data.mods.push({ ...rec, updateInfo: null });
      restored += 1;
    }
    if (!store.profiles.length && Array.isArray(oldMirror.profiles)) store.data.profiles.push(...oldMirror.profiles);
  }
  const res = storageLib.mergeArchiveInto(old, desired);
  for (const [oldId, newId] of res.renamed) {
    const m = store.getMod(oldId);
    if (!m) continue;
    m.id = newId;
    engine._remapId(oldId, newId);
  }
  const leftover = storageLib.countFilesRec(old) - (fs.existsSync(oldMirrorFile) ? 1 : 0);
  let removed = false;
  if (leftover === 0 && !res.errors.length) {
    try { fs.rmSync(old, { recursive: true, force: true }); removed = true; } catch (_) {}
  }
  log(res.errors.length ? 'warn' : 'info', `folded ${OLD_X_ARCHIVE_DIR_NAME} into ${ARCHIVE_DIR_NAME}: `
    + `${res.moved} entr(y/ies) moved, ${res.deduped} already there, ${res.renamed.size} re-numbered, ${restored} record(s) restored`
    + `${removed ? ', old folder removed' : `, old folder kept (${leftover} file(s) left)`}`
    + `${res.errors.length ? ` — ${res.errors.join('; ')}` : ''}`);
  if (res.moved || res.deduped || removed) {
    archiveNotice(`Mod Command X now shares Mod Command's mod archive (${ARCHIVE_DIR_NAME}). `
      + `Moved ${res.moved} stored item(s) over from ${OLD_X_ARCHIVE_DIR_NAME}${res.deduped ? ` (${res.deduped} were already there)` : ''}`
      + `${res.renamed.size ? `, ${res.renamed.size} kept under a new id` : ''}`
      + `${removed ? ' and removed the old folder.' : `; ${OLD_X_ARCHIVE_DIR_NAME} still holds ${leftover} file(s) — see the log.`}`,
    res.errors.length ? 'warn' : 'info');
  }
  return { moved: res.moved, deduped: res.deduped, renamed: res.renamed.size, restored, errors: res.errors, removed };
}

// Startup (and whenever the archive moves): bring X's mod list in line with
// the shared archive.
//   - adopt: a stored mod the main app (or an earlier X data folder) lists in
//     the mirror/its manifest that X doesn't know becomes an X record pointing
//     at the SAME library/<id> — no copy. Its enabled state is what is really
//     in the game: on only when its deployed files are there.
//   - re-link: an X record whose stored copy vanished, when the main app now
//     holds the same mod under another id (it re-installed it), follows that id.
//   - sync: a shared mod the main app switched off (files gone from the game)
//     is shown off here too, and one it switched on is shown on.
//   - skip: ids removed here earlier (dismissed) and runtime entries.
function reconcileSharedArchive() {
  const summary = { adopted: [], relinked: [], synced: [], missing: [] };
  if (!archiveActive()) return summary;
  const refs = sharedRefs(true);
  store.sharedUpstreamIds = [...refs.ids];
  const mirror = storageLib.readJson(path.join(store.storageRoot, MIRROR_FILE));
  const wasEmpty = !store.mods.length;
  const cand = new Map(refs.records);
  for (const m of (mirror && Array.isArray(mirror.mods)) ? mirror.mods : []) {
    if (m && m.id && !cand.has(String(m.id))) cand.set(String(m.id), m);
  }
  const dismissed = new Set((Array.isArray(store.settings.sharedArchiveDismissed) ? store.settings.sharedArchiveDismissed : [])
    .filter((id) => refs.ids.has(id)));
  const known = new Set(store.mods.map((m) => m.id));
  const gameHas = (rel) => { try { return fs.existsSync(engine.gameAbs(rel)); } catch (_) { return false; } };
  const reflect = (rec) => {
    const deployed = Array.isArray(rec.deployed) ? rec.deployed : [];
    if (rec.enabled && store.settings.gamePath && deployed.some(gameHas)) {
      return { enabled: true, deployed, deployedHashes: rec.deployedHashes || {} };
    }
    return { enabled: false, deployed: [], deployedHashes: {} };
  };
  const missingByKey = new Map();
  for (const m of store.mods) if (engine.storedCopyMissing(m)) missingByKey.set(engine._vaultKey(m), m);

  const toAdopt = [...cand.values()].filter((r) => {
    const id = String(r.id);
    return !known.has(id) && !dismissed.has(id) && r.modType && r.modType !== 'ue4ss-runtime' && !r.runtime
      && Array.isArray(r.files) && fs.existsSync(store.modLibraryDir(id));
  }).sort((a, b) => ((a.loadPriority != null ? a.loadPriority : 9e9) - (b.loadPriority != null ? b.loadPriority : 9e9)));
  const adoptIds = new Set(toAdopt.map((r) => String(r.id)));
  for (const rec of toAdopt) {
    const id = String(rec.id);
    const clean = {
      metaTitle: null, parentId: null, grouping: null, warnings: [], backups: [], origin: { type: 'local' },
      ...rec,
      id,
      ...reflect(rec),
      updateInfo: null,
    };
    if (clean.parentId && !known.has(clean.parentId) && !adoptIds.has(clean.parentId)) { clean.parentId = null; clean.grouping = null; }
    if (!Array.isArray(clean.packages)) {
      try { clean.packages = engine._listPackages(store.modLibraryDir(id), clean.files); } catch (_) { clean.packages = []; }
    }
    const stale = missingByKey.get(engine._vaultKey(clean));
    if (stale) {
      const idx = store.data.mods.indexOf(stale);
      store.data.mods[idx] = { ...clean, name: stale.name };
      engine._remapId(stale.id, id);
      missingByKey.delete(engine._vaultKey(clean));
      summary.relinked.push(stale.name);
    } else {
      store.data.mods.push(clean);
      summary.adopted.push(clean.name);
    }
    known.add(id);
  }

  for (const m of store.mods) {
    if (adoptIds.has(m.id) || engine.storedCopyMissing(m)) continue;
    const up = refs.records.get(m.id);
    if (!up || !store.settings.gamePath) continue;
    const mine = Array.isArray(m.deployed) ? m.deployed : [];
    const theirs = Array.isArray(up.deployed) ? up.deployed : [];
    if (m.enabled && !up.enabled && mine.length && !mine.some(gameHas)) {
      m.enabled = false; m.deployed = []; m.deployedHashes = {};
      summary.synced.push(m.name);
    } else if (!m.enabled && up.enabled && theirs.some(gameHas)) {
      m.enabled = true; m.deployed = theirs; m.deployedHashes = up.deployedHashes || {};
      summary.synced.push(m.name);
    }
  }

  // A fresh X data folder: X's own squad profiles come back from the mirror.
  if (wasEmpty && mirror && mirror[X_BLOCK] && Array.isArray(mirror.profiles)) {
    const own = new Set(Array.isArray(mirror[X_BLOCK].profileIds) ? mirror[X_BLOCK].profileIds : []);
    for (const p of mirror.profiles) {
      if (!p || !own.has(p.id)) continue;
      if (store.profiles.some((x) => (x.name || '').toLowerCase() === (p.name || '').toLowerCase())) continue;
      store.data.profiles.push(p);
    }
  }

  summary.missing = store.mods.filter((m) => engine.storedCopyMissing(m)).map((m) => m.name);
  store.settings.sharedArchiveDismissed = [...dismissed];
  store.save();
  if (summary.adopted.length || summary.relinked.length || summary.synced.length || summary.missing.length) {
    log('info', `shared archive: adopted ${summary.adopted.length} (${summary.adopted.join(', ')}), `
      + `re-linked ${summary.relinked.length}, synced ${summary.synced.length}, missing ${summary.missing.length}`
      + ` (main app refs: ${refs.ids.size} via ${refs.source})`);
  }
  if (summary.adopted.length) {
    archiveNotice(`Added ${summary.adopted.length} mod(s) from the shared mod archive (installed with Mod Command) — `
      + 'the same stored copies, nothing duplicated.');
  }
  if (summary.missing.length) {
    archiveNotice(`${summary.missing.length} mod(s) have no stored copy any more (${summary.missing.slice(0, 3).join(', ')}`
      + `${summary.missing.length > 3 ? '…' : ''}) — removed in Mod Command? Download again or uninstall them here.`, 'warn');
  }
  return summary;
}

// Re-point (and migrate) the archive whenever the resolved location changes —
// at startup, when the game folder is set, or when the user picks a custom dir.
function ensureStorage() {
  const desired = resolveStorageRoot();
  if (path.resolve(desired) === path.resolve(store.storageRoot)) return null;
  // The main Mod Command's pre-1.9.0 ZeroCompanyModArchive is its own to
  // migrate: X never renames, merges, prunes or deletes it.
  fs.mkdirSync(desired, { recursive: true });
  // From X's private app-data folder everything is X's: move it all. From an
  // archive (possibly the shared one) only X's own stored mods go.
  const res = archiveActive()
    ? leaveArchive(store.storageRoot, desired)
    : storageLib.migrateStorage(store.storageRoot, desired);
  try { foldOldXArchive(desired); } catch (err) { log('error', `could not fold ${OLD_X_ARCHIVE_DIR_NAME}: ${err.message}`); }
  store.setStorageRoot(desired);
  sharedRefsCache = null;
  try { reconcileSharedArchive(); } catch (err) { log('error', `shared archive reconcile failed: ${err.message}`); }
  store.save(); // also merges the mirrored manifest into the new root
  log('info', `mod archive at ${desired} (${res.moved} entr(y/ies) migrated)`);
  return { root: desired, moved: res.moved };
}

// ------------------------------------------------ the main Mod Command running
// Both apps change the same archive and the same game folders, and the main
// app follows none of X's sharing rules, so they should not run at the same
// time. X can't stop it — it warns (a banner) while it is open. Signals:
//   - Chromium's single-instance "lockfile" in the main app's userData
//     (%APPDATA%\Zero Company Mod Command) — it exists only while that app
//     runs (packaged, portable or dev run alike);
//   - its process names (portable launcher + unpacked app).
// An advisory lock of X's own in the archive would be pointless: the main
// app would never look at it, and X is single-instance already.
function upstreamUserDataDir() {
  if (process.env.MCX_UPSTREAM_USER_DATA_DIR) return process.env.MCX_UPSTREAM_USER_DATA_DIR;
  if (process.env.ZC_DATA_DIR) return null;
  try { return path.join(app.getPath('appData'), 'Zero Company Mod Command'); } catch (_) { return null; }
}
const UPSTREAM_PROCESS_NAMES = ['zerocompanymodcommand.exe', 'zero company mod command.exe'];
let upstreamRunning = false;
function detectUpstreamRunning() {
  return new Promise((resolve) => {
    const ud = upstreamUserDataDir();
    if (ud && fs.existsSync(path.join(ud, 'lockfile'))) return resolve(true);
    if (process.platform !== 'win32' || process.env.MCX_UPSTREAM_NO_TASKLIST) return resolve(false);
    require('child_process').execFile('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 8000 }, (err, stdout) => {
      if (err) return resolve(false);
      const names = String(stdout).split(/\r?\n/).map((l) => (l.split('","')[0] || '').replace(/^"/, '').toLowerCase());
      resolve(names.some((n) => UPSTREAM_PROCESS_NAMES.includes(n)));
    });
  });
}
async function refreshUpstreamRunning() {
  const now = await detectUpstreamRunning().catch(() => false);
  if (now === upstreamRunning) return;
  upstreamRunning = now;
  log(now ? 'warn' : 'info', now ? 'Mod Command is running — both apps share one mod archive' : 'Mod Command closed');
  sendEvent({ type: 'shared-archive', upstreamRunning: now });
}

// ---------------------------------------------------------- Nexus API key at rest
// Mod Command X authenticates with the user's own personal Nexus Mods API key
// (Settings -> Nexus Mods -> "Get my API key"). The rule is simple: the key is
// NEVER written to disk in plain text.
//   - With a secure OS key store (DPAPI on Windows, Keychain on macOS, a real
//     keyring — libsecret/kwallet — on Linux) it is stored encrypted through
//     Electron safeStorage as settings.nexusApiKeyEncrypted.
//   - Without one (safeStorage unavailable, or Linux's `basic_text` fallback,
//     which is only obfuscation with a hard-coded password) it is kept in
//     memory for this session only; the user re-enters it next time.
//   - A plaintext settings.nexusApiKey left by an older build is migrated on
//     startup (encrypted, or moved into memory) and deleted from settings.json
//     and from the game-side archive mirror.
// The decrypted key never reaches the renderer, the log (lib/redact.js masks
// it anywhere it might appear) or a diagnostics report. A stored key is only
// removed by the user's own "Clear".

const { redactSecrets, registerSecret, forgetSecrets } = require('./lib/redact');

const KEY_REQUIRED = 'Add your Nexus Mods API key in Settings first.';

// Settings fields that hold (or held, in upstream/older builds) a credential.
// None of them ever reaches the renderer, a report or the archive mirror.
const SECRET_SETTING_KEYS = ['nexusApiKey', 'nexusApiKeyEncrypted', 'nexusOAuth', 'nexusOAuthEncrypted'];

function publicSettings() {
  const out = { ...store.settings };
  for (const k of SECRET_SETTING_KEYS) delete out[k];
  return out;
}

// Linux: ask Chromium for a real keyring instead of letting it fall back to
// `basic_text` on a desktop it does not recognise (tiling WMs, gamescope…).
// KDE is auto-detected to kwallet already; an explicit --password-store wins.
if (process.platform === 'linux' && !app.commandLine.hasSwitch('password-store')) {
  const desktop = String(process.env.XDG_CURRENT_DESKTOP || '').toLowerCase();
  if (!/kde|plasma/.test(desktop)) app.commandLine.appendSwitch('password-store', 'gnome-libsecret');
}

// Is there a SECURE place to keep the key? isEncryptionAvailable() alone is not
// enough on Linux, where it is also true for the obfuscation-only basic_text
// backend. MCX_TEST_NO_SECURE_STORE=1 simulates "no store" in dev runs only.
function secureKeyStore() {
  if (!app.isPackaged && process.env.MCX_TEST_NO_SECURE_STORE === '1') return { available: false, backend: 'test-disabled' };
  let available = false;
  let backend = null;
  try { available = safeStorage.isEncryptionAvailable(); } catch (_) {}
  if (process.platform === 'linux') {
    try { backend = safeStorage.getSelectedStorageBackend(); } catch (_) {}
    if (!backend || backend === 'basic_text' || backend === 'unknown') available = false;
  }
  return { available, backend };
}

// The decrypted key, held in memory so the many sync nexusSignedIn() gates
// (fullState runs one per state push) do not each go through DPAPI.
// undefined = not read yet; storeNexusKey/clear reset it.
let nexusKeyCache;
// A key that has no secure home on this system lives here, for this session
// only — it is never written anywhere.
let sessionOnlyKey = null;

function nexusKey() {
  if (nexusKeyCache === undefined) {
    nexusKeyCache = readNexusKey();
    if (nexusKeyCache) registerSecret(nexusKeyCache);
  }
  return nexusKeyCache;
}

function readNexusKey() {
  if (sessionOnlyKey) return sessionOnlyKey;
  const blob = store.settings.nexusApiKeyEncrypted;
  if (!blob) return null; // a plaintext nexusApiKey is never read — migrateNexusKey moves it
  try {
    if (secureKeyStore().available) return safeStorage.decryptString(Buffer.from(blob, 'base64'));
  } catch (_) { /* wrong OS user / corrupted blob / keyring locked — treat as no key */ }
  return null;
}

// key = the new key, or null to clear (both stored fields AND the in-memory
// copies). Returns 'encrypted' | 'session' | 'cleared'.
function storeNexusKey(key) {
  nexusKeyCache = undefined;
  sessionOnlyKey = null;
  store.settings.nexusApiKey = null;
  let how = 'cleared';
  if (!key) {
    store.settings.nexusApiKeyEncrypted = null;
    forgetSecrets();
  } else if (secureKeyStore().available) {
    store.settings.nexusApiKeyEncrypted = safeStorage.encryptString(key).toString('base64');
    how = 'encrypted';
  } else {
    store.settings.nexusApiKeyEncrypted = null;
    sessionOnlyKey = key;
    how = 'session';
  }
  if (key) registerSecret(key);
  store.save();
  return how;
}

function migrateNexusKey() {
  const s = store.settings;
  let changed = false;
  // Credentials of the upstream OAuth build: X has no use for them — drop them.
  for (const k of ['nexusOAuth', 'nexusOAuthEncrypted']) {
    if (k in s) { delete s[k]; changed = true; }
  }
  if (s.nexusApiKey) {
    const plain = String(s.nexusApiKey);
    registerSecret(plain);
    s.nexusApiKey = null;
    changed = true;
    if (s.nexusApiKeyEncrypted) {
      log('info', 'nexus: removed a leftover plaintext API key (an encrypted one is already stored)');
    } else if (secureKeyStore().available) {
      s.nexusApiKeyEncrypted = safeStorage.encryptString(plain).toString('base64');
      log('info', 'nexus: plaintext API key migrated to the OS key store and removed from settings.json');
    } else {
      sessionOnlyKey = plain;
      log('info', 'nexus: plaintext API key removed from settings.json; no secure key store on this system, so it is kept for this session only — enter it again next session');
    }
    nexusKeyCache = undefined;
  }
  if (changed) store.save();
  scrubSecretsFromDisk();
}

// Remove credential fields from every settings copy this app itself writes:
// a leftover atomic-write .tmp and the manager-data.json mirror in the mod
// archive (Store.save() writes the mirror without them, but its empty-store
// guard can skip a rewrite, so an old mirror is cleaned here explicitly).
// The encrypted blob is also kept out of the mirror: it belongs to this
// machine's OS account and has no use in a game-folder backup.
function scrubSecretsFromDisk() {
  const files = [store.file + '.tmp'];
  if (store.storageRoot && path.resolve(store.storageRoot) !== path.resolve(store.dataDir)) {
    files.push(path.join(store.storageRoot, 'manager-data.json'));
  }
  for (const file of files) {
    try {
      if (!fs.existsSync(file)) continue;
      if (file.endsWith('.tmp')) { fs.rmSync(file, { force: true }); continue; }
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      const st = raw && raw.settings;
      if (!st || !SECRET_SETTING_KEYS.some((k) => k in st)) continue;
      // The shared archive's mirror: a settings block the main Mod Command
      // wrote is ITS own (X never writes settings over it) — leave it as is.
      if (!(raw[X_BLOCK] && raw[X_BLOCK].ownsSettings)) continue;
      for (const k of SECRET_SETTING_KEYS) delete st[k];
      fs.writeFileSync(file, JSON.stringify(raw, null, 2));
      log('info', 'removed stored credentials from the archive manifest mirror');
    } catch (err) {
      log('error', `could not scrub credentials from a settings copy: ${err.message}`);
    }
  }
}

// The Nexus website panel (<webview partition="persist:nexus">) keeps the
// user's nexusmods.com login in this Electron profile. Release builds encrypt
// its cookies at rest (EnableCookieEncryption fuse, build/after-pack.js); this
// wipes the whole partition — cookies, localStorage, IndexedDB, cache.
async function signOutNexusWebsite() {
  const { session } = require('electron');
  const ses = session.fromPartition('persist:nexus');
  await ses.clearStorageData();
  await ses.clearCache();
  try { await ses.clearAuthCache(); } catch (_) {}
  try { ses.flushStorageData(); } catch (_) {}
}

// --------------------------------------------------------- adult content
//
// THE one place that decides whether adult-tagged mods are listed. There is no
// in-app opt-in and no way to reach them without a key: the answer is the key
// owner's own Nexus content preference (v2 GraphQL `preferences { adult }`,
// read with the API key), which Nexus itself gates behind its age
// verification. This app never second-guesses it in the other direction, and
// every listing path (browse, category, search, the featured strip and its
// backfill, the Link wizard) is handed this answer rather than deciding for
// itself.
function adultAllowed() {
  return !!(nexusSignedIn() && nexusUser && nexusUser.adult === true);
}

// Fold what /users/validate.json says into the cached user WITHOUT losing the
// content preferences already read from the account.
function mergeNexusUser(patch) {
  nexusUser = {
    adult: false, adultBlurImages: false, ageVerified: false,
    ...(nexusUser || {}),
    ...(patch || {}),
  };
  return nexusUser;
}

// Ask Nexus what this account's content preferences are and cache them on
// nexusUser. Any failure leaves adult content hidden.
async function refreshNexusPreferences() {
  if (!nexusSignedIn() || !nexusUser) return null;
  let prefs;
  try {
    prefs = await nexus.userPreferences(await nexusAccessToken());
  } catch (_) {
    prefs = { adult: false, adultBlurImages: false, ageVerified: false };
  }
  if (!nexusUser) return null;
  const changed = nexusUser.adult !== prefs.adult || nexusUser.adultBlurImages !== prefs.adultBlurImages;
  Object.assign(nexusUser, prefs);
  if (changed) {
    log('info', `nexus account preferences: adult content ${prefs.adult ? 'shown' : 'hidden'}`
      + `${prefs.adult && prefs.adultBlurImages ? ', images blurred' : ''}`);
    try { sendEvent({ type: 'state', state: fullState() }); } catch (_) {}
  }
  return prefs;
}

// Validate a key against /users/validate.json (unless the caller just did),
// then read the account's content preferences with it. Used on Save, on
// "Verify" and once at startup.
async function loadNexusUser(key, validated = null) {
  const who = validated || await nexus.validateKey(key); // throws on a bad key
  // Adult content stays hidden until the account's own preferences answer.
  nexusUser = { name: who.name, isPremium: who.isPremium, adult: false, adultBlurImages: false, ageVerified: false };
  await refreshNexusPreferences();
  return nexusUser;
}

// Compatibility shims — the ~25 call sites that gate features and fetch the
// credential keep the names they had in the upstream OAuth build:
//   nexusSignedIn()      sync "have we got a key?"
//   nexusAccessToken()   the key itself (async), or throws KEY_REQUIRED
//   withNexusToken(fn)   one call with the key; a key cannot be refreshed, so a
//                        401 simply surfaces "rejected the API key"
function nexusSignedIn() {
  return !!nexusKey();
}

async function nexusAccessToken() {
  const key = nexusKey();
  if (!key) throw new Error(KEY_REQUIRED);
  return key;
}

async function withNexusToken(fn) {
  return fn(await nexusAccessToken());
}

function initNexusAuth() {
  try { migrateNexusKey(); } catch (_) {}
  const key = nexusKey();
  if (!key) return;
  // Who the key belongs to (name, premium) comes from validate.json. Offline or
  // a rejected key just leaves nexusUser empty — the key is KEPT either way;
  // the next call that needs the user retries, and Settings shows the error.
  loadNexusUser(key).then((u) => {
    log('info', `nexus: API key belongs to ${u.name}${u.isPremium ? ' (premium)' : ''}`);
    try { sendEvent({ type: 'state', state: fullState() }); } catch (_) {}
  }).catch((err) => log('info', `nexus: stored API key could not be validated at startup (${err.message})`));
}

// ---------------------------------------------------------- single instance / nxm

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

function nxmFromArgv(argv) {
  return argv.find((a) => typeof a === 'string' && a.startsWith('nxm://')) || null;
}

app.on('second-instance', (_e, argv) => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
  const url = nxmFromArgv(argv);
  if (url) handleNxm(url);
});

// Sends push events (toasts, state refreshes, progress) to the renderer.
function sendEvent(payload) {
  if (win && !win.isDestroyed()) win.webContents.send('zc-event', payload);
}

// A download that turned out to carry a FOMOD script: hand the wizard job to
// the renderer (its answers come back through fomod-complete, with the origin
// riding the engine session).
function forwardFomod(result, sourceLabel) {
  sendEvent({
    type: 'fomod-pending',
    job: {
      sessionId: result.sessionId, moduleXml: result.moduleXml,
      info: result.info, name: result.name, source: sourceLabel,
    },
  });
}

// engine.install result → array of installed mod records (empty for pendingFomod).
function installedMods(res) {
  if (res.pendingFomod) return [];
  return res.multi ? res.mods : [res];
}

// ---------------------------------------------------------- optional files
// A Nexus mod page offers several downloads. The MAIN file IS the mod; the
// OPTIONAL / UPDATE / MISCELLANEOUS files are extras meant to sit ALONGSIDE it.
// So where a download lands depends on its category:
//
//   MAIN, OLD_VERSION (a version switch)  → replaces the mod's PARENT entries
//   OPTIONAL / UPDATE / MISCELLANEOUS     → installs as a CHILD of the parent
//                                           (replacing the child it supersedes),
//                                           or, with no parent installed, as an
//                                           ordinary top-level entry.
//
// Every Nexus install records origin.category + origin.fileName from here on;
// records written before this feature have no category and count as MAIN.
function planNexusInstall(modId, fileId, data, fileMeta) {
  const files = (data && data.files) || [];
  const file = fileMeta || files.find((f) => f.file_id === fileId) || null;
  const category = (file && file.category_name) || 'MAIN';
  const base = {
    category,
    fileName: (file && file.file_name) || null,
    fileLabel: (file && file.name) || null,
    version: (file && file.version) || null,
    parentId: null, childId: null, childFileId: null,
  };
  const entries = store.mods.filter((m) => m.origin && m.origin.type === 'nexus' && m.origin.modId === modId);
  const parents = entries.filter((m) => !m.parentId);
  if (!nexus.OPTIONAL_CATEGORIES.has(category)) {
    return { ...base, mode: parents.length ? 'replace-parent' : 'top-level' };
  }
  const parent = parents[0] || null;
  if (!parent) return { ...base, mode: 'top-level' };
  const child = entries.find((m) => m.parentId === parent.id && (
    m.origin.fileId === fileId
    || (m.origin.fileId != null && nexus.updateChain(data && data.updates, m.origin.fileId).includes(fileId))
  )) || null;
  return {
    ...base,
    mode: child ? 'replace-child' : 'child',
    parentId: parent.id,
    childId: child ? child.id : null,
    childFileId: child ? child.origin.fileId : null,
  };
}

// An optional file is named after the FILE ("Extra Skins"), not after the mod
// page — the parent row already carries the mod's name.
function nameOptionalChild(mods, plan) {
  if (mods.length !== 1 || !mods[0].id) return;
  const label = plan.fileLabel || (plan.fileName || '').replace(/\.(zip|7z|rar)$/i, '');
  if (!label) return;
  try { engine.rename(mods[0].id, label); } catch (_) {}
}

// Nexus file descriptions are light HTML ("<br />" and entities) — the modal
// shows them as plain text.
function plainText(html, limit = 320) {
  const s = String(html || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#0?39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > limit ? `${s.slice(0, limit - 1)}…` : s;
}

const protocolArgs = () => {
  // Portable builds must register the on-disk exe, not the temp-extracted one.
  if (process.env.PORTABLE_EXECUTABLE_FILE) return { exe: process.env.PORTABLE_EXECUTABLE_FILE, args: [] };
  if (app.isPackaged) return { exe: process.execPath, args: [] };
  return { exe: process.execPath, args: [app.getAppPath()] };
};

// ---------------------------------------------------------- free-account one-click
// A free Nexus account cannot get a download link from the API: the website
// has to start the download. Every install / update / version / optional-file
// / UE4SS button therefore answers a free account with the embedded Nexus
// panel pointed at the EXACT file's download page (nexus.fileDownloadPage),
// and the renderer's auto-click (src/nexus-autoclick.js) presses "Slow
// download" once the site enables it. The nxm:// link the site then emits is
// caught in web-contents-created below and installed by handleNxm.
//
// What the click was FOR travels separately: an optional file pressed on a
// particular mod row must land under that row, and the nxm:// link cannot say
// so. Entries expire, so a stale one never re-parents a later download.
const pendingWebDownloads = new Map(); // `${modId}:${fileId}` -> { parentId, at }
const PENDING_WEB_TTL_MS = 60 * 60 * 1000;

function embedDownload(modId, fileId, name, extra = {}) {
  if (extra.parentId) pendingWebDownloads.set(`${modId}:${fileId}`, { parentId: extra.parentId, at: Date.now() });
  return {
    opened: 'embed',
    url: nexus.fileDownloadPage(modId, fileId),
    name,
    auto: { modId: Number(modId), fileId: Number(fileId) },
  };
}

function takePendingWebDownload(modId, fileId) {
  const key = `${modId}:${fileId}`;
  const hit = pendingWebDownloads.get(key) || null;
  pendingWebDownloads.delete(key);
  return hit && Date.now() - hit.at < PENDING_WEB_TTL_MS ? hit : null;
}

// The user pressed the button on a specific mod row — that row is the parent,
// even when another entry of the same Nexus mod is installed too. A child of
// that row which IS this file (or an older one on its update chain) is
// replaced rather than joined by a second copy.
function pinPlanToParent(plan, modId, fileId, updates, parentMod) {
  if (!parentMod || plan.parentId === parentMod.id) return plan;
  const child = store.mods.find((m) => m.parentId === parentMod.id
    && m.origin && m.origin.type === 'nexus' && m.origin.modId === modId
    && (m.origin.fileId === fileId
      || (m.origin.fileId != null && nexus.updateChain(updates, m.origin.fileId).includes(fileId)))) || null;
  return {
    ...plan, parentId: parentMod.id, mode: child ? 'replace-child' : 'child',
    childId: child ? child.id : null, childFileId: child ? child.origin.fileId : null,
  };
}

async function handleNxm(rawUrl) {
  try {
    const link = nexus.parseNxm(rawUrl);
    // Resolves the renderer's "Waiting for Nexus download…" chip for this file
    // (free downloads finished in the user's own web browser).
    sendEvent({ type: 'nxm-received', modId: link.modId, fileId: link.fileId });
    const token = await nexusAccessToken();
    sendEvent({ type: 'toast', message: `Nexus download requested (mod ${link.modId})…` });
    let info = null;
    try { info = await nexus.modInfo(link.modId, token); } catch (_) {}
    // Authoritative filename + version from the file API — CDN URLs aren't
    // reliable for the name, and the page-level mod version is free text. The
    // whole files payload (not just this file) comes along because the file's
    // CATEGORY and the update chain decide whether this download replaces the
    // mod or joins it as an optional file.
    let filesData = { files: [], updates: [] };
    try { filesData = await nexus.filesData(link.modId, token); } catch (_) {}
    let fileMeta = filesData.files.find((f) => f.file_id === link.fileId) || null;
    if (!fileMeta) { try { fileMeta = await nexus.fileInfo(link.modId, link.fileId, token); } catch (_) {} }
    const fileName = (fileMeta && fileMeta.file_name) || null;
    const uri = await nexus.downloadLink(link, token);
    const dest = await nexus.downloadToFile(uri, store.stagingDir, fileName, (got, total) => {
      sendEvent({ type: 'progress', key: `nexus:${link.modId}`, label: info ? info.name : `mod ${link.modId}`, received: got, total });
    });
    try {
      // Where does this file belong — is it the mod itself, or an extra that
      // rides alongside the installed main file? (see planNexusInstall)
      let plan = planNexusInstall(link.modId, link.fileId, filesData, fileMeta);
      // A free account's one-click from a specific mod row (optional files,
      // an optional file's update): that row is the parent, exactly as on the
      // premium path.
      const pending = takePendingWebDownload(link.modId, link.fileId);
      const pinnedParent = pending && pending.parentId ? store.getMod(pending.parentId) : null;
      if (pinnedParent) plan = pinPlanToParent(plan, link.modId, link.fileId, filesData.updates, pinnedParent);
      const version = (fileMeta && fileMeta.version) || (info ? info.version : null);
      const origin = { type: 'nexus', modId: link.modId, fileId: link.fileId, version, category: plan.category, fileName };
      // The UE4SS compatibility page: keep the current runtime first, and
      // record the install so the Settings card can track this source.
      const isUe4ssPage = link.modId === ue4ssDl.NEXUS_MOD_ID;
      if (isUe4ssPage) {
        const cur = store.settings.ue4ssInstalled || null;
        const kept = engine.ue4ssSnapshot(ue4ssLabel(cur), cur);
        if (kept) log('info', `UE4SS runtime kept before update: ${kept}`);
      }
      if (plan.mode === 'replace-parent' || plan.mode === 'replace-child') {
        const isChild = plan.mode === 'replace-child';
        const match = isChild
          ? { type: 'nexus', modId: link.modId, fileId: plan.childFileId }
          : { type: 'nexus', modId: link.modId };
        const res = await engine.replaceOrigin(match, dest, origin, version, { parentId: plan.parentId });
        if (res.pendingFomod) {
          forwardFomod(res, info ? info.name : `mod ${link.modId}`);
        } else {
          const names = installedMods(res).map((m) => m.name).join('”, “');
          sendEvent({ type: 'toast', message: isChild
            ? `Updated the optional file “${names}”${version ? ` to v${version}` : ''}.`
            : `Updated “${names}” to ${version ? 'v' + version : 'the latest version'}.` });
        }
      } else {
        const res = await engine.install(dest, { origin, version, parentId: plan.parentId });
        if (res.pendingFomod) {
          forwardFomod(res, info ? info.name : `mod ${link.modId}`);
        } else if (res.modType === 'ue4ss-runtime') {
          if (isUe4ssPage) recordNexusUe4ss({ fileId: link.fileId, version, asset: fileName, publishedAt: fileMeta && fileMeta.uploaded_timestamp ? new Date(fileMeta.uploaded_timestamp * 1000).toISOString() : null });
          sendEvent({ type: 'toast', message: `UE4SS runtime installed from Nexus${version ? ` (v${version})` : ''}. Your UE4SS mods and start order are unchanged.` });
        } else if (plan.mode === 'child') {
          const mods = installedMods(res);
          nameOptionalChild(mods, plan);
          const parentName = (store.getMod(plan.parentId) || {}).name || (info ? info.name : `mod ${link.modId}`);
          sendEvent({ type: 'toast', message: `Installed the optional file “${(plan.fileLabel || mods[0].name)}” under “${parentName}”.` });
        } else {
          const mods = installedMods(res);
          if (mods.length === 1 && mods[0].id && info && info.name) {
            try { engine.rename(mods[0].id, info.name); } catch (_) {}
          }
          const label = mods.length === 1
            ? `Installed “${info && info.name ? info.name : mods[0].name}” from Nexus Mods.`
            : `Installed ${mods.length} mods from “${info && info.name ? info.name : path.basename(dest)}” — each is its own entry.`;
          sendEvent({ type: 'toast', message: label });
        }
      }
    } finally {
      fs.rmSync(dest, { force: true });
    }
    sendEvent({ type: 'state', state: fullState() });
  } catch (err) {
    log('error', `nxm install failed: ${err.message}`);
    sendEvent({ type: 'toast', kind: 'error', message: err.message });
  }
}

// ---------------------------------------------------------- update checks

// One v1 request per Nexus-linked mod, so this is exactly the kind of loop
// that must not eat the user's quota. `background` (the startup/hourly run)
// keeps the reserve; the Hangar's "Check updates" button is the user asking,
// so it spends freely — but it still refuses to start when Nexus has already
// said there is nothing left, and it still honours Retry-After.
async function checkForUpdates({ background = false } = {}) {
  const results = { checked: 0, updates: 0, errors: [], limited: null, skippedNexus: null };
  const nexusMods = store.mods.filter((m) => m.origin && m.origin.type === 'nexus');
  // Would this run leave the user without a reserve? Then don't start it.
  let skipNexus = false;
  if (background && nexusSignedIn() && nexusMods.length) {
    // One v1 request per linked mod: if that would not fit above the reserve,
    // the whole Nexus pass waits for the reset rather than half-running.
    const plan = nexusHttp.backgroundPlan(nexusMods.length);
    if (!plan.ok) {
      skipNexus = true;
      results.skippedNexus = { reason: plan.reason, retryAt: plan.retryAt || null };
      log('info', `update check: skipping the Nexus part for ${nexusMods.length} linked mod(s) — ${plan.reason}`);
    }
  }
  for (const mod of store.mods) {
    const origin = mod.origin;
    if (!origin || origin.type === 'local') continue;
    if (origin.type === 'nexus' && skipNexus) continue;
    results.checked += 1;
    try {
      if (origin.type === 'nexus' && nexusSignedIn()) {
        // Re-check the reserve every time round: another part of the app may
        // have spent the quota while this loop was running.
        if (background) {
          const allowed = nexusHttp.backgroundAllowed();
          if (!allowed.ok) {
            results.checked -= 1;
            skipNexus = true;
            results.skippedNexus = { reason: allowed.reason, retryAt: allowed.retryAt || null };
            log('info', `update check: stopping the Nexus part — ${allowed.reason}`);
            continue;
          }
        }
        // The site's file-update chain decides (see nexus.resolveUpdate) — the
        // page-level "Mod version" field is free text authors rarely maintain.
        const data = await withNexusToken((t) => nexus.filesData(origin.modId, t, { background }));
        // An optional/update/misc file is its own line on the mod page: only
        // the site's update chain may move it. Falling back to the newest MAIN
        // file would "update" an optional extra into the mod's main download.
        const optional = !!(origin.category && origin.category !== 'MAIN');
        const r = nexus.resolveUpdate(data, origin, compareVersions, { noPrimaryFallback: optional });
        if (r.target) {
          mod.updateInfo = {
            available: true, latest: r.target.version || r.target.name, current: r.current,
            fileId: r.target.file_id, fileName: r.target.file_name || null,
            auto: !!(nexusUser && nexusUser.isPremium), source: 'nexus',
            url: `https://www.nexusmods.com/${nexus.GAME_DOMAIN}/mods/${origin.modId}?tab=files`,
          };
          results.updates += 1;
        } else {
          mod.updateInfo = null;
        }
      } else if (origin.type === 'github') {
        const release = await github.latestReleaseFor(origin.repo);
        // Only a NEWER tag counts; unorderable tags fall back to "different".
        const cmp = release && origin.tag ? compareVersions(release.tag, origin.tag) : null;
        if (release && origin.tag && (cmp === null ? release.tag !== origin.tag : cmp > 0)) {
          mod.updateInfo = {
            available: true, latest: release.tag, current: origin.tag,
            auto: true, source: 'github',
            url: `https://github.com/${origin.repo}/releases`,
          };
          results.updates += 1;
        } else {
          mod.updateInfo = null;
        }
      }
    } catch (err) {
      // Out of quota / a 429 we would not wait out: stop the whole Nexus pass
      // and let the caller reschedule for when Nexus says to come back.
      if (err && err.quota) {
        skipNexus = true;
        results.checked -= 1;
        results.limited = { message: err.message, retryAt: err.retryAt || null };
        log('info', `update check: ${err.message}`);
        continue;
      }
      results.errors.push(`${mod.name}: ${err.message}`);
    }
  }
  // The UE4SS runtime rides along: refresh the rolling build and report when
  // the installed build is behind it (counted separately from mod updates).
  try {
    await Promise.all([ue4ssDl.refreshLatest(true), ue4ssDl.refreshNexusLatest(true), retocDl.refreshLatest(true)]);
    const u = ue4ssDl.updateInfo(store.settings.ue4ssInstalled);
    results.ue4ssUpdate = u.available ? { source: u.source, currentBuild: u.currentBuild, latestBuild: u.latestBuild, latestDate: u.latestDate } : null;
    const ru = retocDl.updateInfo(engine.retocStatus().version);
    results.retocUpdate = ru.available ? { installed: ru.installed, latest: ru.latest } : null;
  } catch (_) { results.ue4ssUpdate = null; results.retocUpdate = null; }
  store.settings.lastUpdateCheck = new Date().toISOString();
  store.save();
  log('info', `update check: ${results.checked} checked, ${results.updates} update(s), ${results.errors.length} error(s)`
    + `${results.ue4ssUpdate ? ', UE4SS build update available' : ''}`
    + `${results.limited ? ', cut short by the Nexus request limit' : ''}`
    + `${results.skippedNexus ? ', Nexus part skipped' : ''}`);
  return results;
}

// Themes (Settings -> Theme): id -> the window background shown before the
// page paints, which matches each theme's --bg. The page itself learns the
// theme from the preload's synchronous 'theme-sync' read (src/theme-boot.js
// sets <html data-theme> before the stylesheet renders), so neither theme
// ever flashes the other.
const THEMES = { modcommandx: '#15171a', modcommand: '#05080f' };
const DEFAULT_THEME = 'modcommandx';
function currentTheme() {
  const t = store.settings.theme;
  return Object.prototype.hasOwnProperty.call(THEMES, t) ? t : DEFAULT_THEME;
}
ipcMain.on('theme-sync', (e) => { e.returnValue = currentTheme(); });

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: THEMES[currentTheme()],
    autoHideMenuBar: true,
    title: 'Mod Command X',
    icon: path.join(__dirname, 'src', 'assets', 'app-icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Enables the in-app <webview> that hosts the Holonet Nexus download panel
      // (the free-account path: the user browses the real Nexus page and clicks
      // "Mod Manager Download"; we catch the nxm:// it emits — see below).
      webviewTag: true,
    },
  });
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  // The Nexus panel's navigations and worker requests carry the same Sec-CH-UA
  // client hints Chrome sends (read from this window's own Chromium; see
  // lib/nexus-browser.js).
  win.webContents.once('did-finish-load', () => { learnClientHints(win.webContents); });

  // The SDK link hosts a WebContentsView inside THIS window, so it can only be
  // configured once the window exists. Linking itself is deferred to the
  // renderer's first `sdk-link-status` call (see below) — nothing about the
  // link is allowed to slow down or break app start.
  sdkLink.configure({
    window: win,
    appDir: __dirname,
    // The SDK manifest's minModCommand speaks the UPSTREAM Mod Command's
    // version line (1.9.x). X restarted its own numbering at 1.0.0 but carries
    // the upstream feature set it forked from, recorded in package.json as
    // modCommandCompat — so that, not X's own version, is what an SDK is
    // checked against. (package.json, not app.getVersion(): the latter reports
    // Electron's own when the app is started from a script.)
    hostVersion: (() => {
      try {
        const pkg = require('./package.json');
        return pkg.modCommandCompat || pkg.version;
      } catch (_) { return app.getVersion(); }
    })(),
    log,
    getGamePath: () => store.settings.gamePath || null,
    getSdkPath: () => store.settings.sdkPath || null,
    setSdkPath: (p) => { store.settings.sdkPath = p || null; store.save(); },
    // Where to GET the SDK — the asset file's `sdk` block, or the last copy of
    // it we saved. Nothing about the destination is written in this app.
    getAssetLinks: () => getAssetLinks(),
    // The SDK's own two settings, in OUR store. Note the panel's "SDK folder"
    // is sdkCliPath, NOT the link: pointing the CLI at a second checkout must
    // never tear down the UI the user is looking at. null = same folder.
    getSdkSettings: () => ({
      sdkPath: store.settings.sdkCliPath || store.settings.sdkPath || null,
      showCommand: !!store.settings.sdkShowCommand,
    }),
    setSdkSettings: (patch) => {
      if (Object.prototype.hasOwnProperty.call(patch, 'sdkPath')) store.settings.sdkCliPath = patch.sdkPath || null;
      if (Object.prototype.hasOwnProperty.call(patch, 'showCommand')) store.settings.sdkShowCommand = !!patch.showCommand;
      store.save();
      return {
        sdkPath: store.settings.sdkCliPath || store.settings.sdkPath || null,
        showCommand: !!store.settings.sdkShowCommand,
      };
    },
    browseFolder: async (title, defaultPath) => {
      const res = await dialog.showOpenDialog(win, { title, properties: ['openDirectory'], defaultPath: defaultPath || undefined });
      return res.canceled || !res.filePaths.length ? null : res.filePaths[0];
    },
    openPath: (p) => shell.openPath(p),
    openExternal: (url) => shell.openExternal(url),
    // The SDK's update answer is cached in OUR store, so the host badge and
    // the hosted page's own line read one cache and cost one fetch an hour.
    getUpdateCache: () => store.settings.sdkUpdate || null,
    setUpdateCache: (c) => { store.settings.sdkUpdate = c; store.save(); },
  });

  // A window resize must not leave the hosted view at yesterday's size; the
  // renderer re-measures and pushes a new rect.
  win.on('resize', () => { try { sendEvent({ type: 'sdk-link-remeasure' }); } catch (_) {} });
  win.on('closed', () => { try { sdkLink.teardown(); } catch (_) {} });
}

// The embedded Nexus <webview> is untrusted remote content. We never expose app
// IPC to it; instead the MAIN process watches every webview's navigations for the
// nxm:// link the "Mod Manager Download" button emits, and routes it into the
// same install pipeline the OS protocol handler uses (handleNxm). This is what
// lets a non-premium user download without leaving the app — the website mints
// the signed nxm link from their logged-in session, exactly as in a real browser.
app.on('web-contents-created', (_e, contents) => {
  // No page — ours, the SDK's or Nexus's — gets to pick a Bluetooth device.
  lockWebContentsDevices(contents);
  if (contents.getType() !== 'webview') return;
  const catchNxm = (url) => {
    if (typeof url === 'string' && url.startsWith('nxm://')) {
      handleNxm(url);
      return true;
    }
    return false;
  };
  contents.on('will-navigate', (e, url) => { if (catchNxm(url)) e.preventDefault(); });
  contents.on('will-redirect', (e, url) => { if (catchNxm(url)) e.preventDefault(); });
  contents.setWindowOpenHandler(({ url }) => {
    if (catchNxm(url)) return { action: 'deny' };
    // Keep navigation inside the panel; never spawn OS/native windows from Nexus.
    if (/^https?:\/\/([a-z0-9-]+\.)?nexusmods\.com/i.test(url)) {
      contents.loadURL(url);
    }
    return { action: 'deny' };
  });
});

app.whenReady().then(() => {
  log('info', `app start v${app.getVersion()} on ${process.platform} ${require('os').release()}`);
  // The Nexus panel's session uses the same plain Chrome user agent as the
  // app-wide fallback set above. See lib/nexus-browser.js.
  try { configureNexusSession(session, app); } catch (err) { log('error', `nexus panel session setup failed: ${err.message}`); }
  // Deny-by-default web permissions for the Nexus panel and the app window
  // (Electron grants everything otherwise). An nxm:// that reaches the OS
  // handoff instead of will-navigate is routed to handleNxm in-process. See
  // lib/web-permissions.js.
  try { configureWebPermissions(session, { log, onNxm: (url) => handleNxm(url) }); } catch (err) { log('error', `web permission setup failed: ${err.message}`); }
  // Load the stored Nexus API key (migrating a plaintext one to the OS store)
  // and look up who it belongs to in the background.
  try { initNexusAuth(); } catch (err) { log('error', `Nexus API key could not be read: ${err.message}`); }
  // Archive lives in the game folder (or the custom location) — migrate any
  // app-side content there, then restore from it when this store is fresh.
  try { ensureStorage(); } catch (err) { log('error', `archive setup failed: ${err.message}`); }
  try { scrubSecretsFromDisk(); } catch (_) {} // the archive mirror is known only now
  // Warn while the main Mod Command is open (it shares the archive).
  refreshUpstreamRunning().catch(() => {});
  setInterval(() => { refreshUpstreamRunning().catch(() => {}); }, 10 * 1000);
  try { eaAppDetected = ea.eaAppPresent(); } catch (_) {}
  // EA-compat community list: fetch now and refresh every 30 minutes; a state
  // push follows so freshly flagged mods surface without a restart.
  const refreshCompat = () => ea.refreshCompat().then(() => sendEvent({ type: 'state', state: fullState() })).catch(() => {});
  setTimeout(refreshCompat, 3000);
  setInterval(() => refreshCompat(), 30 * 60 * 1000);
  // Auto-detect game on first run.
  if (!store.settings.gamePath) {
    const det = steam.detectGame(null);
    if (det.found) {
      store.settings.gamePath = det.gamePath;
      store.save();
      // The archive follows the game folder (and adopts the shared one's mods).
      try { ensureStorage(); } catch (err) { log('error', `archive setup failed: ${err.message}`); }
    }
  }
  createWindow();
  win.webContents.once('did-finish-load', () => {
    windowLoaded = true;
    for (const n of archiveNotices.splice(0)) sendEvent({ type: 'toast', kind: n.kind || 'info', message: n.message });
  });
  // Handle an nxm:// link this instance was launched with.
  const url = nxmFromArgv(process.argv);
  if (url) win.webContents.once('did-finish-load', () => handleNxm(url));
  // Launcher self-update banner — and, from the same file, where to GET the
  // Mod SDK (refreshLauncherUpdate persists the `sdk` block and pushes it to
  // the renderer). Re-run hourly, the same cadence as every other check, so a
  // link the operator flips lands without a restart.
  win.webContents.once('did-finish-load', () => refreshLauncherUpdate({ banner: true }).catch(() => {}));
  setInterval(() => {
    if (win && !win.isDestroyed()) refreshLauncherUpdate({ force: true, banner: true }).catch(() => {});
  }, UPDATE_CHECK_MS);
  // ZCSDK Runtime: learn the newest GitHub release (the Settings card and the
  // install path use it); nudge once per version when an installed runtime is
  // behind it.
  win.webContents.once('did-finish-load', async () => {
    const remote = await zcsdkRt.latestRuntime();
    if (!remote) return;
    const st = engine.zcsdkStatus();
    if (st.available && st.available.source === 'github') sendEvent({ type: 'state', state: fullState() });
    if (st.installed && st.updateAvailable && store.settings.zcsdkNoticedVersion !== remote.version) {
      store.settings.zcsdkNoticedVersion = remote.version;
      store.save();
      sendEvent({ type: 'toast', message: `ZCSDK Runtime ${remote.version} is available — update it from Settings → ZCSDK Runtime.` });
    }
  });
  // UE4SS: learn the newest rolling build; the Settings card compares the
  // installed build against it. Nudge once per new build.
  win.webContents.once('did-finish-load', async () => {
    const [latest, nx] = await Promise.all([ue4ssDl.refreshLatest(), ue4ssDl.refreshNexusLatest(), retocDl.refreshLatest()]);
    {
      const ru = retocDl.updateInfo(engine.retocStatus().version);
      if (ru.available && store.settings.retocNoticedVersion !== ru.latest) {
        store.settings.retocNoticedVersion = ru.latest;
        store.save();
        sendEvent({ type: 'toast', message: `retoc ${ru.latest} is out (you have ${ru.installed}) — update it from Settings → retoc.` });
      }
    }
    if (!latest && !nx) { sendEvent({ type: 'state', state: fullState() }); return; }
    const u = ue4ssDl.updateInfo(store.settings.ue4ssInstalled);
    sendEvent({ type: 'state', state: fullState() });
    if (u.available && store.settings.ue4ssNoticedBuild !== u.latest) {
      store.settings.ue4ssNoticedBuild = u.latest;
      store.save();
      sendEvent({ type: 'toast', message: u.source === 'nexus'
        ? `A newer UE4SS compatibility build is on Nexus (${u.latestBuild}, ${new Date(u.latestDate).toLocaleDateString()}) — you have ${u.currentBuild}. Update from Settings → UE4SS.`
        : `A newer UE4SS build is out (${u.latestBuild}, ${new Date(u.latestDate).toLocaleDateString()}) — you have ${u.currentBuild}. Update from Settings → UE4SS.` });
    }
  });
  // (A fresh store's mods come back from the archive in ensureStorage():
  // reconcileSharedArchive adopts every stored mod in place. The old
  // re-install-and-prune auto-restore would give the main Mod Command's
  // stored copies new ids and delete the originals it still uses.)
  win.webContents.once('did-finish-load', async () => {
    // One-time automatic existing-mods scan after the first game connection —
    // the review dialog opens by itself when there is anything to adopt.
    if (!store.settings.firstScanDone && store.settings.gamePath) {
      store.settings.firstScanDone = true;
      store.save();
      try {
        const found = engine.scanUnmanaged().length
          + engine.scanOrphanLibraries().length
          + detectManagerSources().length;
        if (found > 0) {
          log('info', `first scan found ${found} existing mod source(s)`);
          sendEvent({ type: 'first-scan', found });
        }
      } catch (err) {
        log('error', `first scan failed: ${err.message}`);
      }
    }
  });
  // Re-assert an update freeze the user turned on (Steam may have rewritten
  // the manifest while it was briefly writable, e.g. during a verify).
  win.webContents.once('did-finish-load', () => {
    if (!store.settings.updateFreeze || !store.settings.gamePath) return;
    try {
      const status = steam.updateFreezeStatus(store.settings.gamePath);
      if (status.supported && (!status.frozen || status.behavior !== '1')) {
        steam.setUpdateFreeze(store.settings.gamePath, true);
        log('warn', 'update freeze re-asserted at startup (manifest had been unlocked)');
        sendEvent({ type: 'toast', kind: 'warn', message: 'Game update freeze re-applied — Steam had unlocked the manifest.' });
      }
    } catch (_) {}
  });
  // Startup recovery: redeploy enabled mods whose deployed files went missing.
  win.webContents.once('did-finish-load', () => {
    if (!store.settings.gamePath) return;
    try {
      const repaired = engine.repairDeployments();
      if (repaired.length) {
        log('warn', `startup recovery redeployed: ${repaired.join(', ')}`);
        sendEvent({ type: 'state', state: fullState() });
        sendEvent({ type: 'toast', kind: 'warn', message: `Recovered missing deployed files for: ${repaired.join(', ')}.` });
      }
    } catch (_) {}
  });
  // Background mod update check: at startup when the last one is over an
  // hour old, then every hour while the app stays open (one Nexus files call
  // per linked mod, one GitHub call per GitHub-linked mod). The Hangar's
  // "Check updates" button runs the same check on demand.
  win.webContents.once('did-finish-load', () => maybeCheckUpdates());
  setInterval(() => { if (win && !win.isDestroyed()) maybeCheckUpdates(); }, UPDATE_CHECK_MS);
  // The linked SDK's own update check, on the SAME hourly cadence and with
  // the same 60-minute cache. One small JSON fetch, only when an SDK is
  // linked, and a failure is a state ('unknown'), never a toast.
  win.webContents.once('did-finish-load', () => maybeCheckSdkUpdate());
  setInterval(() => { if (win && !win.isDestroyed()) maybeCheckSdkUpdate(); }, UPDATE_CHECK_MS);
});

// WHERE TO GET THE SDK. Mod Command X hard-codes no destination: the upstream
// operator publishes one in the shared asset repo's launcher-version.json
// `sdk` block. X reads ONLY that block from it — X's own updates come from its
// own GitHub releases (lib/launcher-update.js), never from that file.
//
// Two sources, in order, and the answer says which it used:
//   'asset-file' — the check that ran this session carried a block
//   'cache'      — settings.sdkAssetLinks, the last block a fetch ever carried
//   'none'       — never fetched one and nothing was saved: no button at all
// Synchronous by contract (sdkLink.status() must never wait on the network).
function getAssetLinks() {
  try {
    const live = cachedLauncherInfo();
    if (live && live.sdk) return { sdk: live.sdk, source: 'asset-file' };
  } catch (_) { /* fall through to the saved copy */ }
  const saved = store.settings.sdkAssetLinks;
  if (saved && saved.sdk && (saved.sdk.url || saved.sdk.updateUrl)) {
    return { sdk: { url: saved.sdk.url || null, updateUrl: saved.sdk.updateUrl || null }, source: 'cache' };
  }
  return { sdk: null, source: 'none' };
}

// The launcher check, plus everything that rides on it: the update banner, the
// persisted copy of the SDK block (so an offline restart still has the last
// good link), and a push so the "Get the SDK" pitch repaints without a restart.
async function refreshLauncherUpdate({ force = false, banner = false } = {}) {
  const info = await checkLauncherUpdate({ force });
  if (banner && info.available) sendEvent({ type: 'launcher-update', info });
  if (info.sdk) {
    store.settings.sdkAssetLinks = { sdk: info.sdk, at: Date.now() };
    store.save();
  }
  try { sendEvent({ type: 'sdk-links', links: getAssetLinks() }); } catch (_) {}
  return info;
}

async function maybeCheckSdkUpdate() {
  try {
    if (!sdkLink.status().linked) return;
    const info = await sdkLink.checkUpdate({ force: false });
    sdkLink.pushUpdateToView(info);
    sendEvent({ type: 'sdk-update', info });
  } catch (_) { /* never surfaces */ }
}

const UPDATE_CHECK_MS = 60 * 60 * 1000;
let lastUpdateSignature = null;
let updateRetryTimer = null;
let updateHoldUntil = 0;

// Come back when Nexus said to, instead of retrying into a closed door.
function rescheduleUpdateCheck(retryAt, why) {
  const at = Number(retryAt) || 0;
  const delay = Math.min(Math.max(at - Date.now(), 60 * 1000), UPDATE_CHECK_MS);
  updateHoldUntil = Date.now() + delay;
  log('info', `update check: rescheduled for ${nexusHttp.hhmm(updateHoldUntil)} — ${why}`);
  if (updateRetryTimer) clearTimeout(updateRetryTimer);
  updateRetryTimer = setTimeout(() => {
    updateRetryTimer = null;
    if (win && !win.isDestroyed()) maybeCheckUpdates();
  }, delay);
  if (updateRetryTimer.unref) updateRetryTimer.unref();
}

async function maybeCheckUpdates() {
  if (Date.now() < updateHoldUntil) return;
  const last = store.settings.lastUpdateCheck ? Date.parse(store.settings.lastUpdateCheck) : 0;
  if (Date.now() - last < UPDATE_CHECK_MS) return;
  if (!store.mods.some((m) => m.origin && m.origin.type !== 'local')) return;
  try {
    const results = await checkForUpdates({ background: true });
    const held = results.limited || results.skippedNexus;
    if (held) rescheduleUpdateCheck(held.retryAt, held.reason || held.message);
    // Badges refresh every time; the toast only when the set of available
    // updates changed, so an hourly re-check never nags about the same ones.
    const signature = store.mods
      .filter((m) => m.updateInfo && m.updateInfo.available)
      .map((m) => `${m.id}:${m.updateInfo.latest}`)
      .sort()
      .join('|');
    sendEvent({ type: 'state', state: fullState() });
    if (results.updates > 0 && signature !== lastUpdateSignature) {
      sendEvent({ type: 'toast', kind: 'warn', message: `${results.updates} mod update(s) available — see the Hangar Bay.` });
    }
    lastUpdateSignature = signature;
  } catch (_) {}
}

app.on('window-all-closed', () => app.quit());

// ------------------------------------------------------------------ helpers

// { name, isPremium } from /users/validate.json for the stored API key,
// plus { adult, adultBlurImages, ageVerified } from the account's own Nexus
// content preferences. adult/adultBlurImages reach the renderer in
// fullState().nexus.user; the policy itself lives in adultAllowed().
let nexusUser = null;
let eaAppDetected = false; // probed once at startup (reg.exe is too slow per-state)

// The quota Nexus reports, trimmed for the renderer: counts, and the reset
// times as plain ISO strings. `known` is false until a v1 call has answered.
function compactQuota() {
  const q = nexusHttp.quotaState();
  const win = (w) => ({
    limit: w.limit, remaining: w.remaining,
    resetAt: w.resetAt ? new Date(w.resetAt).toISOString() : null,
  });
  return { known: q.known, hourly: win(q.hourly), daily: win(q.daily), updatedAt: q.updatedAt };
}
const promotedCache = { mods: null, at: 0, authors: [], adult: false };

function fullState() {
  const detection = steam.detectGame(store.settings.gamePath);
  const ue4ssHooks = store.settings.gamePath ? engine.scanUe4ssHooks() : { entries: [], conflicts: [] };
  const conflicts = store.settings.gamePath ? engine.conflicts(ue4ssHooks) : [];
  const { exe, args } = protocolArgs();
  // Per-mod EA-compat verdicts from the last-fetched community list + modinfo.
  const compat = ea.compatSync();
  const modCompat = {};
  for (const m of store.mods) modCompat[m.id] = ea.evaluateMod(m, compat);
  return {
    // The API key NEVER crosses into the renderer — only whether we have one.
    settings: { ...publicSettings(), hasNexusKey: nexusSignedIn() },
    profiles: store.profiles,
    lastOrderBackup: store.data.lastOrderBackup
      ? { at: store.data.lastOrderBackup.at }
      : null,
    nexus: {
      hasKey: nexusSignedIn(),
      keyEncrypted: !!store.settings.nexusApiKeyEncrypted,
      // No secure OS key store: a key is held for this session only.
      keySessionOnly: !!sessionOnlyKey,
      secureStore: secureKeyStore().available,
      // Premium drives the premium-vs-free download split; it is only known
      // once validate.json has answered for the stored key.
      premium: !!(nexusUser && nexusUser.isPremium),
      user: nexusUser ? {
        name: nexusUser.name,
        isPremium: !!nexusUser.isPremium,
        // The account's own Nexus content preferences, for display only.
        adult: !!nexusUser.adult,
        adultBlurImages: !!nexusUser.adultBlurImages,
        ageVerified: !!nexusUser.ageVerified,
      } : null,
      // The one policy answer, decided in main by adultAllowed(). The renderer
      // reads it to describe the state; it never gets to change it.
      adultAllowed: adultAllowed(),
      nxmRegistered: app.isDefaultProtocolClient('nxm', exe, args),
      // What Nexus's own x-rl-* headers last said about the request quota.
      quota: compactQuota(),
    },
    detection: {
      found: detection.found,
      gamePath: detection.gamePath,
      buildId: detection.buildId,
      source: detection.source,
      launcher: detection.launcher,
      proton: detection.proton,
    },
    platform: process.platform,
    eaAppPresent: eaAppDetected,
    storage: {
      root: store.storageRoot,
      custom: !!store.settings.storageDir,
      inGameFolder: !!store.settings.gamePath
        && path.resolve(store.storageRoot) === path.resolve(path.join(store.settings.gamePath, ARCHIVE_DIR_NAME)),
    },
    updateFreeze: {
      wanted: !!store.settings.updateFreeze,
      ...steam.updateFreezeStatus(store.settings.gamePath),
    },
    modCompat,
    // Shared mod archive with the main Mod Command (see ensureStorage).
    sharedArchive: {
      upstreamRunning,
      shared: archiveActive() && path.basename(store.storageRoot) === ARCHIVE_DIR_NAME,
    },
    ue4ssOrder: store.settings.gamePath ? engine.ue4ssOrderState() : { managed: [], others: [], applied: false },
    // storedMissing: the mod's library copy is gone (the main Mod Command
    // removed it from the shared archive) — the row offers re-download/remove.
    mods: store.mods.map((m) => (engine.storedCopyMissing(m) ? { ...m, storedMissing: true } : m)),
    conflicts,
    ue4ssHooks,
    // release = the GitHub release this app installed (null for a copy the
    // user placed by hand or one installed before 1.9.8 recorded it).
    ue4ss: { ...engine.ue4ssStatus(), release: store.settings.ue4ssInstalled || null, update: ue4ssDl.updateInfo(store.settings.ue4ssInstalled) },
    zcsdk: engine.zcsdkStatus(),
    retoc: (() => { const r = engine.retocStatus(); return { ...r, update: retocDl.updateInfo(r.version), installedRecord: store.settings.retocInstalled || null }; })(),
    sevenZip: !!findSevenZip(store.settings.sevenZipPath),
    sevenZipBundled: !store.settings.sevenZipPath && findSevenZip(null) === bundledSevenZip() && !!bundledSevenZip(),
    appId: steam.APP_ID,
    paths: {
      mods: MODS_REL,
      logicMods: LOGIC_MODS_REL,
      win64: WIN64_REL,
      ue4ssMods: UE4SS_MODS_REL,
      // Game Feature plugin mods: SWZeroCompany\Mods\<Plugin>\
      gameMods: GAME_MODS_REL,
      library: store.libraryDir,
    },
  };
}

// Best-effort md5 lookup of a mod's library files against Nexus. Returns the
// hit ({modId, modName, version, fileId, fileName}) or null and applies nothing.
// Only matches files uploaded to Nexus as-is (in practice loose paks); UE4SS
// mods are skipped because their Lua/DLL files never hash-match a Nexus archive.
async function md5Match(mod) {
  // Game Feature plugin mods are skipped for the same reason as UE4SS mods:
  // their files (.uplugin, AssetRegistry.bin, the paks inside Content/Paks) are
  // only ever uploaded inside an archive, so they never hash-match a Nexus file.
  if (!mod || !nexusSignedIn() || mod.modType === 'ue4ss-mod' || mod.modType === 'gfp') return null;
  for (const f of mod.files.slice(0, 4)) {
    try {
      const hit = await withNexusToken((t) => nexus.md5Lookup(path.join(store.modLibraryDir(mod.id), f.libraryRelative), t));
      if (hit) return hit;
    } catch (_) {}
  }
  return null;
}

// Best-effort Nexus identity via md5. Used by adoption, orphan recovery, and
// foreign-library imports: on a hit it attaches the origin and renames in place.
async function identifyOnNexus(modId) {
  const mod = store.getMod(modId);
  const hit = await md5Match(mod);
  if (!hit) return null;
  engine.setOrigin(mod.id, { type: 'nexus', modId: hit.modId, fileId: hit.fileId, version: hit.version, adopted: true });
  const stored = store.getMod(mod.id);
  stored.version = hit.version;
  if (hit.modName) { try { engine.rename(mod.id, hit.modName); } catch (_) {} }
  store.save();
  return hit;
}

// ---- Name-based matching (fallback for UE4SS mods md5 can't identify) --------
// Split CamelCase and letter/digit runs so glued names ("ZCUnlocked") tokenize.
function deCamel(s) {
  return String(s || '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Za-z])(\d)/g, '$1 $2')
    .replace(/(\d)([A-Za-z])/g, '$1 $2');
}
// Normalize a mod title for comparison: drop a trailing "by <author>", version
// numbers, punctuation, glued ZC/ZCOM prefixes, and low-signal / game words.
function normTitle(s) {
  return deCamel(s).toLowerCase()
    .replace(/\bby\s+.+$/, ' ')
    .replace(/\bv?\d+(?:\.\d+)+\b/g, ' ')
    .replace(/\b(?:zc|zcom|swzc)(?=[a-z])/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\b(?:the|for|and|mod|mods|zero|company|zc|zcom|swzc)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function titleTokens(s) { return normTitle(s).split(' ').filter(Boolean); }
// A single distinctive query term to feed Nexus's WILDCARD name search (best
// recall from one token); falls back to the whole normalized title.
function searchQuery(name) {
  const toks = titleTokens(name).filter((t) => t.length >= 3);
  if (!toks.length) return normTitle(name);
  return toks.sort((a, b) => b.length - a.length)[0];
}
// 0..1 similarity of two titles: exact-normalized = 1, a multi-token phrase
// contained in the other = 0.85, otherwise the Dice coefficient of the tokens.
function titleScore(a, b) {
  const na = normTitle(a), nb = normTitle(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const ta = titleTokens(a), tb = titleTokens(b);
  const sa = new Set(ta), sb = new Set(tb);
  if (!sa.size || !sb.size) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter += 1;
  const dice = (2 * inter) / (sa.size + sb.size);
  // Containment counts as strong only for a substantial (multi-token) phrase, so
  // a single shared generic word ("unlocked") can't masquerade as a likely match.
  const shorterTokens = na.length <= nb.length ? sa.size : sb.size;
  if (shorterTokens >= 2 && (na.includes(nb) || nb.includes(na))) return Math.max(dice, 0.85);
  return dice;
}
function confOf(score) {
  if (score >= 0.999) return 'exact';
  if (score >= 0.6) return 'strong';
  return 'weak';
}
// ---- File-name matching ------------------------------------------------------
// The loader names an adopted mod after the ARCHIVE it came from ("ZCUnlocked"),
// which is usually nothing like the Nexus page title ("Full Customization Mod…")
// but IS the display name of the mod's uploaded file. So a Nexus file whose
// stem equals the local name identifies the page precisely.
const { FileIndex, stem: fileStem, stemsMatch } = require('./lib/file-index');
function fileStemMatches(localName, file) {
  const want = fileStem(localName);
  if (want.length < 4) return false;
  return [file && file.name, file && file.file_name].some((c) => stemsMatch(fileStem(c), want));
}
// Catalog-wide file-name index (lib/file-index.js), cached in the data dir.
let fileIndex = null;
function getFileIndex() {
  if (!fileIndex) fileIndex = new FileIndex(path.join(store.dataDir, 'nexus-file-index.json'));
  return fileIndex;
}

// A Nexus download is named "<file name> <modId> <version> <ISO stamp> <hash>.zip"
// ("ZCUnlocked 34 1.3.5.1 2026-09-04T05-11Z kZivb0EtP.zip"). When a mod was
// installed from such an archive, the mod id is right there — the single most
// reliable identification we have, and it costs no API call.
function parseNexusArchive(sourceArchive) {
  const m = String(sourceArchive || '').match(/^(.*?)\s+(\d+)\s+(\S+)\s+\d{4}-\d\d-\d\dT\d\d-\d\dZ\s+\S+\.\w+$/);
  return m ? { stem: m[1], modId: Number(m[2]), version: m[3] } : null;
}

// ---- Unified candidate scoring ----------------------------------------------
// Reads everything the record knows — its local name, the archive it came
// from, its author — pulls candidates from every route (md5, archive id, the
// file-name index, title search, author search), then scores each candidate
// by ADDING UP the independent evidence for it. The strongest reason becomes
// its label; the total decides the order. Returns candidates best-first.
const EVIDENCE = {
  md5: 3.0,       // identical file hash
  archive: 3.0,   // Nexus download name carries the mod id
  file: 2.0,      // an uploaded file is named exactly like the local mod/archive
  filepart: 0.7,  // …or similarly
  author: 1.0,    // same author as the record says
  exact: 1.0,     // page title equals the local name
  strong: 0.6,    // title mostly overlaps
  weak: 0.3,      // title partly overlaps
};
const LABEL_RANK = ['md5', 'archive', 'file', 'exact', 'author', 'strong', 'filepart', 'weak'];

async function scoreCandidates(m, index, fileCache) {
  const byId = new Map(); // modId -> { modId, name, author, version, score, reasons:Set }
  const note = (r, reason, weight) => {
    if (!r || !r.modId) return;
    let c = byId.get(r.modId);
    if (!c) { c = { modId: r.modId, name: r.name || `mod ${r.modId}`, author: r.author || '', version: r.version || null, score: 0, reasons: new Set() }; byId.set(r.modId, c); }
    if (c.reasons.has(reason)) return;
    c.reasons.add(reason);
    c.score += weight != null ? weight : EVIDENCE[reason];
    if (!c.name.startsWith('mod ') || !r.name) return;
    c.name = r.name; c.author = c.author || r.author || ''; c.version = c.version || r.version || null;
  };
  const entry = (modId) => (index.entries && index.entries[String(modId)]) || null;

  // Signals from the record itself.
  const localName = m.name || '';
  const archive = m.sourceArchive || '';
  const nexusArchive = parseNexusArchive(archive);
  const archiveStem = archive.replace(/\.(zip|7z|rar|pak)$/i, '');
  const author = (m.author && String(m.author).trim()) || authorFromName(localName);

  // 1) Archive name carries the Nexus mod id.
  if (nexusArchive) {
    const e = entry(nexusArchive.modId);
    if (e) note(e, 'archive');
    else if (nexusSignedIn()) {
      try { const info = await withNexusToken((t) => nexus.modInfo(nexusArchive.modId, t)); note({ modId: nexusArchive.modId, name: info.name, author: info.author, version: info.version }, 'archive'); } catch (_) {}
    }
  }
  // 2) md5 of the library files (loose paks only).
  try { const hit = await md5Match(m); if (hit) note({ modId: hit.modId, name: hit.modName, version: hit.version }, 'md5'); } catch (_) {}
  // 3) File-name index, on the archive name and on the local name.
  for (const q of new Set([nexusArchive ? nexusArchive.stem : archiveStem, localName])) {
    for (const e of index.find(q)) note(e, e.exact ? 'file' : 'filepart');
  }
  // 4) Title search on the local name.
  try {
    const q = searchQuery(localName);
    if (q && q.length >= 2) {
      const res = await nexus.browseMods({ query: q, sort: 'downloads', count: 25, includeAdult: adultAllowed() });
      for (const r of (res.mods || [])) {
        const s = titleScore(localName, r.name);
        if (s >= 0.34) note(r, confOf(s));
      }
    }
  } catch (_) {}
  // 5) Author: the record's author (modinfo) or a trailing "By <name>" — their
  //    mods are few, so each gets a live file check for a name match too.
  if (author) {
    try {
      for (const r of (await nexus.modsByAuthors([author], { includeAdult: adultAllowed() })).slice(0, 10)) {
        note(r, 'author');
        if (!byId.get(r.modId).reasons.has('file') && await modHasMatchingFile(r.modId, localName, fileCache)) note(r, 'file');
      }
    } catch (_) {}
  }
  // Credit author agreement on any candidate found another way.
  if (author) {
    const want = author.toLowerCase();
    for (const c of byId.values()) if (c.author && c.author.toLowerCase() === want) note(c, 'author');
  }

  return [...byId.values()]
    .map((c) => ({ modId: c.modId, name: c.name, author: c.author, version: c.version, score: c.score,
      confidence: LABEL_RANK.find((k) => c.reasons.has(k)) || 'weak', reasons: [...c.reasons] }))
    .sort((a, b) => b.score - a.score);
}
// "ZCUnlocked By SmexyXey" -> "SmexyXey"; null when the name carries no author.
function authorFromName(name) {
  const m = String(name || '').match(/\bby\s+([^()[\]]+?)\s*$/i);
  return m ? m[1].trim() : null;
}
// Does any of this Nexus mod's files stem-match the local name? Best-effort
// (v1 filesList needs an API key; any failure = no match); memoised per run so the
// same mod is never fetched twice while one scan/search is underway.
async function modHasMatchingFile(modId, localName, cache) {
  if (!nexusSignedIn()) return false;
  try {
    if (!cache.has(modId)) cache.set(modId, withNexusToken((t) => nexus.filesList(modId, t)));
    const files = await cache.get(modId);
    return (files || []).some((f) => fileStemMatches(localName, f));
  } catch (_) { return false; }
}

// Auto-detected import sources: a previous app-side data folder (pre-archive
// layout), and known locations other managers keep their libraries in.
function detectManagerSources() {
  const out = [];
  const seen = new Set([path.resolve(store.storageRoot).toLowerCase()]);
  const consider = (p, label) => {
    try {
      const resolved = path.resolve(p).toLowerCase();
      if (seen.has(resolved) || !fs.existsSync(p)) return;
      seen.add(resolved);
      const isModCommand = fs.existsSync(path.join(p, 'manager-data.json'));
      let root = p;
      for (const sub of ['library', 'mods', 'Mods']) {
        if (fs.existsSync(path.join(p, sub))) { root = path.join(p, sub); break; }
      }
      let subdirs = 0;
      try { subdirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).length; } catch (_) {}
      if (!isModCommand && !subdirs) return;
      out.push({ path: p, label, kind: isModCommand ? 'modcommand' : 'library', entries: subdirs });
    } catch (_) {}
  };
  // The app-side data folder, when the archive has moved to the game folder.
  if (path.resolve(store.dataDir) !== path.resolve(store.storageRoot)
    && fs.existsSync(path.join(store.dataDir, 'library'))) {
    consider(store.dataDir, 'Previous Mod Command X data (app folder)');
  }
  const la = process.env.LOCALAPPDATA;
  if (la) {
    for (const name of ['zcom-mod-manager', 'ZCOM Mod Manager', 'ZCOMModManager']) {
      consider(path.join(la, name), 'ZCOM Mod Manager data');
    }
  }
  return out;
}

function ok(data) { return { ok: true, data }; }
// Error text crossing to the renderer goes through the secret redactor too.
function fail(err) { return { ok: false, error: redactSecrets(err && err.message ? err.message : String(err)) }; }

const handlers = {
  'get-state': async () => fullState(),

  'browse-game-path': async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Locate the Star Wars Zero Company folder',
      properties: ['openDirectory'],
      defaultPath: store.settings.gamePath || 'G:\\SteamLibrary\\steamapps\\common',
    });
    if (res.canceled || !res.filePaths.length) return fullState();
    const p = res.filePaths[0];
    if (!steam.isValidGamePath(p)) {
      throw new Error('That folder does not contain SWZeroCompany\\Binaries\\Win64\\SWZeroCompany.exe.');
    }
    store.settings.gamePath = p;
    store.save();
    ensureStorage(); // the auto archive location follows the game folder
    return fullState();
  },

  'browse-tool-path': async (_e, { key, title, filterName }) => {
    const res = await dialog.showOpenDialog(win, {
      title,
      properties: ['openFile'],
      filters: [{ name: filterName, extensions: ['exe'] }],
    });
    if (!res.canceled && res.filePaths.length) {
      store.settings[key] = res.filePaths[0];
      store.save();
    }
    return fullState();
  },

  'save-settings': async (_e, patch) => {
    delete patch.promotedAuthors; // owner-controlled (lib/featured.js), not a user setting
    // The API key only changes through set-nexus-key / clear-nexus-key (which
    // validate and encrypt it); a settings patch can never write or blank it.
    delete patch.nexusApiKey;
    delete patch.nexusApiKeyEncrypted;
    delete patch.hasNexusKey;
    if ('theme' in patch && !Object.prototype.hasOwnProperty.call(THEMES, patch.theme)) delete patch.theme;
    if ('nexusDownloadVia' in patch && !['panel', 'browser'].includes(patch.nexusDownloadVia)) delete patch.nexusDownloadVia;
    Object.assign(store.settings, patch);
    store.save();
    if (patch.theme && win && !win.isDestroyed()) win.setBackgroundColor(THEMES[patch.theme]);
    return fullState();
  },

  'install-mods': async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Install mods (archives or extracted folders)',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Mod archives', extensions: ['zip', '7z', 'rar', 'pak', 'utoc', 'ucas'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (res.canceled || !res.filePaths.length) return { state: fullState(), results: [] };
    return installPaths(res.filePaths);
  },

  'install-folder': async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Install a mod from an extracted folder',
      properties: ['openDirectory'],
    });
    if (res.canceled || !res.filePaths.length) return { state: fullState(), results: [] };
    return installPaths(res.filePaths);
  },

  'install-dropped': async (_e, paths) => installPaths(paths),

  'set-mod-enabled': async (_e, { id, enabled, force }) => {
    const mod = engine.setEnabled(id, enabled, force);
    log('info', `${enabled ? 'enabled' : 'disabled'} "${mod.name}"${force ? ' (forced past ownership check)' : ''}`);
    return fullState();
  },
  'uninstall-mod': async (_e, { id, force }) => {
    const name = (store.getMod(id) || {}).name;
    // Optional files go with the mod they belong to.
    const kids = engine.childrenOf(id).length;
    keptSharedNames = [];
    engine.uninstall(id, force);
    log('info', `uninstalled "${name}"${kids ? ` and its ${kids} optional file(s)` : ''}`);
    if (keptSharedNames.length) {
      store.save();
      sendEvent({
        type: 'toast',
        message: `Removed “${name}” from Mod Command X. Its stored copy was kept — Mod Command still uses it (the two apps share one mod archive).`,
      });
    }
    keptSharedNames = [];
    return fullState();
  },
  'rename-mod': async (_e, { id, name }) => { engine.rename(id, name); return fullState(); },
  'apply-load-order': async (_e, { orderedIds }) => {
    engine.applyLoadOrder(orderedIds);
    log('info', `pak load order applied (${orderedIds.length} mod(s))`);
    return fullState();
  },
  'preview-load-order': async (_e, { orderedIds }) => engine.previewLoadOrder(orderedIds),
  'rollback-load-order': async () => { engine.rollbackLoadOrder(); return fullState(); },
  'apply-ue4ss-order': async (_e, { orderedIds }) => {
    engine.applyUe4ssOrder(orderedIds);
    log('info', `UE4SS start order applied (${orderedIds.length} mod(s))`);
    return fullState();
  },
  'confirm-mod-build': async (_e, { id }) => { engine.confirmBuild(id); return fullState(); },

  'fomod-complete': async (_e, { sessionId, selections }) => {
    const mod = await engine.completeFomod(sessionId, selections);
    log('info', `guided install completed: "${mod.name}" (${selections.length} file rule(s))`);
    return { state: fullState(), name: mod.name, modType: mod.modType, warnings: mod.warnings || [] };
  },
  'fomod-cancel': async (_e, { sessionId }) => { engine.cancelFomod(sessionId); return true; },
  'fomod-image': async (_e, { sessionId, path: rel }) => {
    const session = engine.fomodSession(sessionId);
    const fomod = require('./lib/fomod');
    return fomod.readImage(session.root, session.fomodBase, rel);
  },

  'launch-game': async () => {
    const detection = steam.detectGame(store.settings.gamePath);
    if (!detection.found) throw new Error('Game not located. Set the game folder in Settings.');
    if (detection.launcher === 'ea') {
      // EA App edition: no steam:// route. Launch the exe directly (the EA App
      // background service handles online features when it is running).
      if (process.platform !== 'win32') throw new Error('The EA App edition can only be launched on Windows.');
      const child = spawn(detection.exePath, [], { detached: true, stdio: 'ignore', cwd: path.dirname(detection.exePath) });
      child.unref();
    } else {
      // Always a real Steam launch (overlay/cloud saves; correct under Proton
      // on Linux/Steam Deck). Steam runs its update check on this path — with
      // the update freeze on and an update pending it fails with "Disk write
      // error". DIRECT LAUNCH is the no-update path.
      if (store.settings.updateFreeze && detection.launcher === 'steam') {
        sendEvent({ type: 'toast', kind: 'warn', message: 'Update freeze is on — Steam will run its update check now (it shows "Disk write error" while an update is pending). Use DIRECT LAUNCH to play without updating.' });
      }
      await shell.openExternal(`steam://run/${steam.APP_ID}`);
    }
    if (store.settings.closeOnLaunch) setTimeout(() => app.quit(), 1500);
    return fullState();
  },

  'launch-game-direct': async () => {
    const detection = steam.detectGame(store.settings.gamePath);
    if (!detection.found) throw new Error('Game not located. Set the game folder in Settings.');
    if (process.platform === 'linux') {
      throw new Error('The game is a Windows build — on Linux, launch it through Steam (Proton) instead.');
    }
    spawnGameExe(detection);
    if (store.settings.closeOnLaunch) setTimeout(() => app.quit(), 1500);
    return fullState();
  },

  'open-managed-path': async (_e, { kind }) => {
    const map = {
      game: store.settings.gamePath,
      mods: store.settings.gamePath && path.join(store.settings.gamePath, MODS_REL),
      logicMods: store.settings.gamePath && path.join(store.settings.gamePath, LOGIC_MODS_REL),
      ue4ssMods: store.settings.gamePath && path.join(store.settings.gamePath, UE4SS_MODS_REL),
      gameMods: store.settings.gamePath && path.join(store.settings.gamePath, GAME_MODS_REL),
      library: store.libraryDir,
      data: store.dataDir,
    };
    const p = map[kind];
    if (!p || !fs.existsSync(p)) throw new Error('That folder does not exist yet.');
    await shell.openPath(p);
    return true;
  },

  // Settings -> "Where to finish free downloads" = My web browser: the exact
  // file's download page in the system browser (where the user is normally
  // signed in already); its Slow download comes back through nxm://.
  'open-nexus-file-page': async (_e, { modId, fileId }) => {
    if (!(Number(modId) > 0) || !(Number(fileId) > 0)) throw new Error('Unknown Nexus file.');
    await shell.openExternal(nexus.fileDownloadPage(modId, fileId));
    return true;
  },

  'open-external': async (_e, { url }) => {
    if (!/^https:\/\/(www\.|next\.)?(nexusmods\.com|github\.com|discord\.gg)\//.test(url)) throw new Error('Blocked URL.');
    await shell.openExternal(url);
    return true;
  },

  // Also refreshes where-to-get-the-SDK, because it is the same published file.
  'launcher-update-status': async (_e, opts) => refreshLauncherUpdate({ force: !!(opts && opts.force) }),

  'run-diagnostics': async () => diagnostics(),

  'suggest-load-order': async () => engine.suggestLoadOrder(),

  'save-profile': async (_e, { name }) => { engine.saveProfile(name); return fullState(); },
  'apply-profile': async (_e, { id }) => {
    const { profile, warnings } = await engine.applyProfile(id);
    log('info', `profile "${profile.name}" applied (${warnings.length} note(s))`);
    return { state: fullState(), profileName: profile.name, warnings };
  },

  'set-all-enabled': async (_e, { enabled, force }) => {
    const result = engine.setAllEnabled(enabled, force);
    log('info', `${enabled ? 'enabled' : 'disabled'} all mods (${result.changed} changed, ${result.errors.length} error(s))`);
    return { state: fullState(), result };
  },

  'mod-versions': async (_e, { id }) => engine.listVersions(id),
  'rollback-version': async (_e, { id, entryId }) => {
    const mod = await engine.rollbackVersion(id, entryId);
    log('info', `rolled "${mod.name}" to v${mod.version || 'unversioned'}`);
    return { state: fullState(), name: mod.name, version: mod.version };
  },

  'set-update-freeze': async (_e, { freeze }) => {
    const status = steam.setUpdateFreeze(store.settings.gamePath, freeze);
    store.settings.updateFreeze = !!freeze;
    store.save();
    log('info', `game update freeze ${freeze ? 'ENABLED' : 'disabled'} (manifest ${status.frozen ? 'locked' : 'writable'}, AutoUpdateBehavior=${status.behavior})`);
    return fullState();
  },
  'delete-profile': async (_e, { id }) => { engine.deleteProfile(id); return fullState(); },

  // Save a personal API key: trimmed, proven against /users/validate.json, and
  // only THEN stored — a key Nexus refuses is never written to disk.
  'set-nexus-key': async (_e, { key } = {}) => {
    const trimmed = String(key || '').trim();
    if (!trimmed) throw new Error('The API key is empty.');
    const who = await nexus.validateKey(trimmed); // throws "rejected the API key" on a bad one
    const how = storeNexusKey(trimmed);
    await loadNexusUser(trimmed, who);
    promotedCache.mods = null; // the adult answer may have changed
    log('info', `nexus: API key saved for ${nexusUser.name}${nexusUser.isPremium ? ' (premium)' : ''}${how === 'encrypted' ? ' (encrypted with the OS key store)' : ' (session only — no secure OS key store, nothing written to disk)'}`);
    return fullState();
  },
  // The user's own "Clear" — the only way a stored key is ever removed. Wipes
  // the encrypted field, any plaintext leftover and the in-memory copies.
  'clear-nexus-key': async () => {
    storeNexusKey(null);
    nexusUser = null;
    promotedCache.mods = null;
    log('info', 'nexus: API key cleared');
    return fullState();
  },
  // Settings -> "Sign out of the Nexus website panel": forget the nexusmods.com
  // login the embedded panel keeps (cookies, site storage, cache).
  'nexus-web-signout': async () => {
    await signOutNexusWebsite();
    log('info', 'nexus: signed out of the Nexus website panel (persist:nexus session cleared)');
    return { cleared: true };
  },
  'validate-nexus-key': async () => {
    await loadNexusUser(await nexusAccessToken());
    return fullState();
  },

  // What Nexus's rate-limit headers last reported, for Settings.
  'nexus-quota': async () => compactQuota(),

  // "Verify": ask the API itself who this key belongs to, and re-read the
  // account's content preferences while we are there.
  'nexus-refresh-user': async () => {
    await loadNexusUser(await nexusAccessToken());
    return fullState();
  },
  'register-nxm': async () => {
    const { exe, args } = protocolArgs();
    if (process.platform === 'linux') {
      // Linux: a .desktop entry with the nxm scheme handler, made default via xdg-mime.
      const { execFileSync } = require('child_process');
      const appsDir = path.join(app.getPath('home'), '.local', 'share', 'applications');
      fs.mkdirSync(appsDir, { recursive: true });
      const target = process.env.APPIMAGE || exe;
      const desktop = [
        '[Desktop Entry]', 'Type=Application', 'Name=Mod Command X',
        `Exec="${target}" %u`, 'Terminal=false', 'NoDisplay=true',
        'MimeType=x-scheme-handler/nxm;', '',
      ].join('\n');
      fs.writeFileSync(path.join(appsDir, 'mod-command-x.desktop'), desktop);
      try { execFileSync('xdg-mime', ['default', 'mod-command-x.desktop', 'x-scheme-handler/nxm'], { stdio: 'ignore' }); } catch (_) {}
      try { execFileSync('update-desktop-database', [appsDir], { stdio: 'ignore' }); } catch (_) {}
      app.setAsDefaultProtocolClient('nxm');
      return fullState();
    }
    const okReg = app.setAsDefaultProtocolClient('nxm', exe, args);
    if (!okReg) throw new Error('Windows refused the nxm:// handler registration.');
    // Friendly name for browser "Open …?" dialogs (AssocQueryString checks the
    // FriendlyAppName value before falling back to exe metadata).
    try {
      const { execFileSync } = require('child_process');
      const set = (key, value, data) => execFileSync('reg',
        ['add', key, ...(value ? ['/v', value] : ['/ve']), '/d', data, '/f'], { stdio: 'ignore' });
      // Browser "Open …?" dialogs pull the name from these (which one varies by
      // browser/version) or from the exe's FileDescription.
      set('HKCU\\Software\\Classes\\nxm', null, 'URL:Mod Command X Link');
      set('HKCU\\Software\\Classes\\nxm', 'FriendlyTypeName', 'in Mod Command X');
      set('HKCU\\Software\\Classes\\nxm\\shell\\open', 'FriendlyAppName', 'in Mod Command X');
      set('HKCU\\Software\\Classes\\nxm\\shell\\open\\command', 'FriendlyAppName', 'in Mod Command X');
      set('HKCU\\Software\\Classes\\nxm\\Application', 'ApplicationName', 'in Mod Command X');
      set('HKCU\\Software\\Classes\\nxm\\Application', 'ApplicationDescription', 'Mod Command X');
    } catch (_) { /* cosmetic only */ }
    return fullState();
  },
  'unregister-nxm': async () => {
    const { exe, args } = protocolArgs();
    app.removeAsDefaultProtocolClient('nxm', exe, args);
    return fullState();
  },

  'nexus-browse': async (_e, opts) => {
    // Browsing itself needs no API key. Whether adult-tagged mods are in the
    // listing is NEVER the renderer's call: adultAllowed() decides, and any
    // includeAdult that arrived from the renderer is discarded here.
    const result = await nexus.browseMods({ ...(opts || {}), includeAdult: adultAllowed() });
    // Premium accounts can pull download links straight from the API.
    if (nexusSignedIn() && !nexusUser) {
      try { mergeNexusUser(await withNexusToken((t) => nexus.validateKey(t))); } catch (_) {}
    }
    return { ...result, signedIn: nexusSignedIn(), isPremium: !!(nexusUser && nexusUser.isPremium) };
  },

  'nexus-promoted': async () => {
    // Session cache — the featured pool rarely changes. It is also keyed on
    // the adult answer, so saving or clearing the key never serves a stale mix.
    const now = Date.now();
    const adult = adultAllowed();
    if (promotedCache.mods && promotedCache.adult === adult && now - promotedCache.at < 5 * 60 * 1000) return promotedCache;
    const roster = await getPromotedAuthors();
    const mods = await nexus.modsByAuthors(roster, { includeAdult: adult });
    // When the roster can't fill all 3 slots, backfill from the game's top mods.
    let fillers = [];
    if (mods.length < 3) {
      try {
        const top = await nexus.browseMods({ sort: 'downloads', count: 12, includeAdult: adult });
        const promotedIds = new Set(mods.map((m) => m.modId));
        fillers = top.mods.filter((m) => !promotedIds.has(m.modId));
      } catch (_) { /* strip just shows what it has */ }
    }
    Object.assign(promotedCache, { mods, fillers, at: now, authors: roster, adult });
    return promotedCache;
  },

  'nexus-install-remote': async (_e, { modId, name }) => {
    const token = await nexusAccessToken();
    if (!nexusUser) {
      try { mergeNexusUser(await nexus.validateKey(token)); } catch (err) { throw new Error(err.message); }
    }
    // Both account types pick the file the same way: the newest MAIN file.
    const files = await nexus.filesList(modId, token);
    const file = nexus.pickPrimaryFile(files);
    if (!file) throw new Error('That mod has no downloadable main file.');
    // Nexus policy: non-premium downloads must start on the website — the
    // embedded panel opens at exactly this file (see embedDownload).
    if (!nexusUser.isPremium) return embedDownload(modId, file.file_id, name);
    const uri = await nexus.downloadLink({ modId, fileId: file.file_id }, token);
    const dest = await nexus.downloadToFile(uri, store.stagingDir, file.file_name, (got, total) => {
      sendEvent({ type: 'progress', key: `nexus:${modId}`, label: name || `mod ${modId}`, received: got, total });
    });
    try {
      const origin = {
        type: 'nexus', modId, fileId: file.file_id, version: file.version || null,
        category: file.category_name || 'MAIN', fileName: file.file_name || null,
      };
      const res = await engine.install(dest, { origin, version: file.version || null });
      if (res.pendingFomod) {
        forwardFomod(res, name || `mod ${modId}`);
        return { pendingFomod: true, state: fullState() };
      }
      const mods = installedMods(res);
      if (mods.length === 1 && mods[0].id && name) {
        try { engine.rename(mods[0].id, name); } catch (_) {}
      }
      return { installed: true, count: mods.length, state: fullState() };
    } finally {
      fs.rmSync(dest, { force: true });
    }
  },

  'config-list': async () =>
    configs.listConfigFiles(store.settings.gamePath, store.settings.customConfigFiles || []),

  'config-read': async (_e, { path: filePath }) => ({
    content: configs.readConfig(filePath, store.settings.gamePath, store.settings.customConfigFiles || []),
  }),

  'config-save': async (_e, { path: filePath, content }) => {
    const result = configs.saveConfig(filePath, content, store.settings.gamePath, store.settings.customConfigFiles || []);
    return { ...result, list: configs.listConfigFiles(store.settings.gamePath, store.settings.customConfigFiles || []) };
  },

  'config-add-custom': async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Add a config file to the Config Editor',
      properties: ['openFile'],
      filters: [
        { name: 'Config files', extensions: ['ini', 'json', 'txt', 'cfg'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (!res.canceled && res.filePaths.length) {
      const custom = store.settings.customConfigFiles || [];
      const p = res.filePaths[0];
      if (!custom.some((c) => path.resolve(c).toLowerCase() === path.resolve(p).toLowerCase())) {
        custom.push(p);
        store.settings.customConfigFiles = custom;
        store.save();
      }
    }
    return configs.listConfigFiles(store.settings.gamePath, store.settings.customConfigFiles || []);
  },

  'config-remove-custom': async (_e, { path: filePath }) => {
    store.settings.customConfigFiles = (store.settings.customConfigFiles || [])
      .filter((c) => path.resolve(c).toLowerCase() !== path.resolve(filePath).toLowerCase());
    store.save();
    return configs.listConfigFiles(store.settings.gamePath, store.settings.customConfigFiles || []);
  },

  'config-open-folder': async (_e, { path: filePath }) => {
    await shell.showItemInFolder(filePath);
    return true;
  },

  'scan-unmanaged': async () => engine.scanUnmanaged(),

  'scan-manager-sources': async () => ({
    orphans: engine.scanOrphanLibraries(),
    sources: detectManagerSources(),
  }),

  'adopt-mods': async (_e, { ids }) => {
    const results = [];
    // Orphaned entries in our own library (lost store) re-import directly.
    for (const oid of ids.filter((i) => i.startsWith('orphan:'))) {
      const dirName = oid.slice('orphan:'.length);
      try {
        const mod = await engine.adoptOrphan(dirName);
        const identified = await identifyOnNexus(mod.id);
        results.push({ ok: true, name: store.getMod(mod.id).name, identified: identified ? identified.modName : null });
      } catch (err) {
        results.push({ ok: false, name: dirName, error: err.message });
      }
    }
    const candidates = engine.scanUnmanaged().filter((c) => ids.includes(c.id));
    for (const candidate of candidates) {
      try {
        const mod = engine.adopt(candidate);
        const identified = await identifyOnNexus(mod.id);
        results.push({ ok: true, name: store.getMod(mod.id).name, identified: identified ? identified.modName : null });
      } catch (err) {
        results.push({ ok: false, name: candidate.name, error: err.message });
      }
    }
    return { results, state: fullState() };
  },

  'choose-storage-dir': async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Choose the mod archive folder',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: store.storageRoot,
    });
    if (res.canceled || !res.filePaths.length) return fullState();
    store.settings.storageDir = res.filePaths[0];
    store.save();
    const moved = ensureStorage();
    if (moved) sendEvent({ type: 'toast', message: `Mod archive moved to ${moved.root}.` });
    return fullState();
  },

  'reset-storage-dir': async () => {
    store.settings.storageDir = null;
    store.save();
    ensureStorage();
    return fullState();
  },

  'import-manager-folder': async (_e, payload) => {
    let dir = payload && payload.path;
    if (!dir) {
      const res = await dialog.showOpenDialog(win, {
        title: 'Import mods from a mod manager folder',
        properties: ['openDirectory'],
      });
      if (res.canceled || !res.filePaths.length) return { cancelled: true, state: fullState() };
      dir = res.filePaths[0];
    }
    let results;
    if (fs.existsSync(path.join(dir, 'manager-data.json'))) {
      // A Mod Command data/archive folder — full restore with metadata.
      results = await engine.restoreFromData(dir);
      log('info', `restored from ${dir}: ${results.imported.length} mod(s), ${results.profiles} profile(s)`);
    } else {
      // Another manager's library: import each mod folder, then try to
      // reattach Nexus identities so names and updates come back.
      results = await engine.importForeignLibrary(dir);
      let identified = 0;
      for (const id of results.importedIds || []) {
        if (await identifyOnNexus(id)) identified += 1;
      }
      results.identified = identified;
      log('info', `imported ${results.imported.length} mod(s) from foreign library ${dir} (${identified} identified on Nexus)`);
    }
    return { results, state: fullState() };
  },

  'nexus-file-versions': async (_e, { modId }) => {
    const token = await nexusAccessToken();
    const files = await nexus.filesList(modId, token);
    const usable = files
      .filter((f) => !['ARCHIVED', 'DELETED'].includes(f.category_name || ''))
      .sort((a, b) => (b.uploaded_timestamp || 0) - (a.uploaded_timestamp || 0))
      .map((f) => ({
        fileId: f.file_id,
        name: f.name,
        version: f.version || null,
        category: f.category_name || 'MAIN',
        sizeKb: f.size_kb || f.size || 0,
        uploaded: f.uploaded_timestamp ? new Date(f.uploaded_timestamp * 1000).toISOString() : null,
      }));
    if (!nexusUser) { try { mergeNexusUser(await nexus.validateKey(token)); } catch (_) {} }
    return { files: usable, isPremium: !!(nexusUser && nexusUser.isPremium) };
  },

  'nexus-install-file': async (_e, { modId, fileId, name }) => {
    const token = await nexusAccessToken();
    if (!nexusUser) { try { mergeNexusUser(await nexus.validateKey(token)); } catch (err) { throw new Error(err.message); } }
    // Free accounts: the website mints the link — the embedded panel opens at
    // exactly this version's download page and the nxm handoff installs it
    // (handleNxm applies the same planNexusInstall rules as below).
    if (!nexusUser.isPremium) return embedDownload(modId, fileId, name);
    const data = await nexus.filesData(modId, token);
    const file = data.files.find((f) => f.file_id === fileId);
    if (!file) throw new Error('That file is no longer listed on the mod page.');
    const plan = planNexusInstall(modId, fileId, data, file);
    const uri = await nexus.downloadLink({ modId, fileId }, token);
    const dest = await nexus.downloadToFile(uri, store.stagingDir, file.file_name, (got, total) => {
      sendEvent({ type: 'progress', key: `nexus:${modId}`, label: `${name || `mod ${modId}`} ${file.version || ''}`, received: got, total });
    });
    try {
      const origin = { type: 'nexus', modId, fileId, version: file.version || null, category: plan.category, fileName: file.file_name || null };
      const replacing = plan.mode === 'replace-parent' || plan.mode === 'replace-child';
      const res = replacing
        ? await engine.replaceOrigin(
          plan.mode === 'replace-child'
            ? { type: 'nexus', modId, fileId: plan.childFileId }
            : { type: 'nexus', modId },
          dest, origin, file.version || null, { parentId: plan.parentId })
        : await engine.install(dest, { origin, version: file.version || null, parentId: plan.parentId });
      if (res.pendingFomod) {
        forwardFomod(res, name || `mod ${modId}`);
        return { pendingFomod: true, state: fullState() };
      }
      if (plan.mode === 'child') nameOptionalChild(installedMods(res), plan);
      log('info', `installed ${plan.category} file ${fileId} (v${file.version || '?'}) of nexus mod ${modId}` +
        `${plan.parentId ? ` as an optional file of ${plan.parentId}` : ''}${replacing ? ' (replaced in place — old one vaulted)' : ''}`);
      return {
        installed: true, switched: replacing, optional: !!plan.parentId,
        version: file.version || null, state: fullState(),
      };
    } finally {
      fs.rmSync(dest, { force: true });
    }
  },

  // The optional / update / miscellaneous downloads a mod page offers, with the
  // ones already installed under this mod marked. Never lists MAIN or
  // OLD_VERSION files — those are version switches, and the ⧗ picker owns them.
  'nexus-optional-files': async (_e, { modId }) => {
    const token = await nexusAccessToken();
    const data = await nexus.filesData(modId, token);
    let modName = null;
    try { modName = (await nexus.modInfo(modId, token)).name || null; } catch (_) {}
    const entries = store.mods.filter((m) => m.origin && m.origin.type === 'nexus' && m.origin.modId === modId);
    const parent = entries.find((m) => !m.parentId) || null;
    const children = parent ? entries.filter((m) => m.parentId === parent.id) : [];
    // A child counts as "this file installed" when it IS that file, or when
    // this file is further along the same update chain.
    const installedAs = (fileId) => {
      const hit = children.find((c) => c.origin.fileId === fileId
        || (c.origin.fileId != null && nexus.updateChain(data.updates, c.origin.fileId).includes(fileId)));
      return hit ? hit.id : null;
    };
    const files = data.files
      .filter((f) => nexus.OPTIONAL_CATEGORIES.has(f.category_name || ''))
      .sort((a, b) => (b.uploaded_timestamp || 0) - (a.uploaded_timestamp || 0))
      .map((f) => ({
        fileId: f.file_id,
        name: f.name,
        version: f.version || null,
        category: f.category_name,
        sizeKb: f.size_kb || f.size || 0,
        uploaded: f.uploaded_timestamp ? new Date(f.uploaded_timestamp * 1000).toISOString() : null,
        description: plainText(f.description),
        installedAs: installedAs(f.file_id),
      }));
    if (!nexusUser) { try { mergeNexusUser(await nexus.validateKey(token)); } catch (_) {} }
    return {
      mod: { name: modName || (parent ? parent.name : `mod ${modId}`) },
      parentId: parent ? parent.id : null,
      files,
      isPremium: !!(nexusUser && nexusUser.isPremium),
    };
  },

  // Install one optional file under an installed mod. Premium downloads
  // directly; a free account gets the mod's Files page in the embedded panel,
  // and the nxm:// its "Mod Manager Download" emits lands as a child through
  // handleNxm (same planNexusInstall rules).
  'nexus-install-optional': async (_e, { modId, fileId, parentId }) => {
    const token = await nexusAccessToken();
    if (!nexusUser) { try { mergeNexusUser(await nexus.validateKey(token)); } catch (err) { throw new Error(err.message); } }
    const parentMod = parentId ? store.getMod(parentId) : null;
    if (!nexusUser.isPremium) {
      return embedDownload(modId, fileId, parentMod ? parentMod.name : `mod ${modId}`,
        { parentId: parentMod ? parentMod.id : null });
    }
    const data = await nexus.filesData(modId, token);
    const file = data.files.find((f) => f.file_id === fileId);
    if (!file) throw new Error('That file is no longer listed on the mod page.');
    const plan = pinPlanToParent(planNexusInstall(modId, fileId, data, file), modId, fileId, data.updates, parentMod);
    const uri = await nexus.downloadLink({ modId, fileId }, token);
    const dest = await nexus.downloadToFile(uri, store.stagingDir, file.file_name, (got, total) => {
      sendEvent({ type: 'progress', key: `nexus:${modId}:${fileId}`, label: `${file.name || file.file_name}${file.version ? ` v${file.version}` : ''}`, received: got, total });
    });
    try {
      const origin = { type: 'nexus', modId, fileId, version: file.version || null, category: plan.category, fileName: file.file_name || null };
      const replaced = plan.mode === 'replace-child' || plan.mode === 'replace-parent';
      const res = replaced
        ? await engine.replaceOrigin(
          plan.mode === 'replace-child'
            ? { type: 'nexus', modId, fileId: plan.childFileId }
            : { type: 'nexus', modId },
          dest, origin, file.version || null, { parentId: plan.parentId })
        : await engine.install(dest, { origin, version: file.version || null, parentId: plan.parentId });
      if (res.pendingFomod) {
        forwardFomod(res, file.name || `mod ${modId}`);
        return { pendingFomod: true, parentId: plan.parentId, state: fullState() };
      }
      const mods = installedMods(res);
      if (plan.parentId) nameOptionalChild(mods, plan);
      log('info', `optional file ${fileId} (${plan.category}, v${file.version || '?'}) of nexus mod ${modId} ` +
        `${replaced ? 'replaced' : 'installed'}${plan.parentId ? ` under ${plan.parentId}` : ' as a top-level entry'}`);
      return {
        installed: true, replaced, parentId: plan.parentId,
        name: plan.fileLabel || (mods[0] && mods[0].name) || file.name,
        count: mods.length, state: fullState(),
      };
    } finally {
      fs.rmSync(dest, { force: true });
    }
  },

  // ------------------------------------------------- grouping mods by hand
  // Not every mod comes from Nexus. A mod the user downloaded and installed
  // themselves can be grouped under another installed mod, and from then on it
  // looks and behaves exactly like an optional file off a mod page: nested row,
  // own switch, off when the parent is off, gone when the parent is uninstalled.
  // Purely local bookkeeping — no Nexus call, no API key.

  // Which installed mods may be grouped under this one.
  'groupable-mods': async (_e, { parentId }) => {
    const parent = store.getMod(parentId);
    if (!parent) throw new Error('That mod is no longer installed.');
    // Optional files nest one level deep, so anything that is already a child,
    // or already has children of its own, is out.
    const isParent = new Set(store.mods.filter((m) => m.parentId).map((m) => m.parentId));
    const parentNexusId = parent.origin && parent.origin.type === 'nexus' ? parent.origin.modId : null;
    return store.mods
      .filter((m) => {
        if (m.id === parent.id) return false;
        if (m.parentId) return false;
        if (isParent.has(m.id)) return false;
        // Another MAIN file from the SAME Nexus page is a VERSION of this mod
        // (the ⧗ version picker's business), not an extra that rides alongside
        // it — grouping one under the other would be nonsense.
        if (parentNexusId != null && m.origin && m.origin.type === 'nexus'
          && m.origin.modId === parentNexusId
          && (m.origin.category || 'MAIN') === 'MAIN') return false;
        return true;
      })
      .map((m) => ({
        id: m.id,
        name: m.name,
        modType: m.modType,
        version: m.version || null,
        enabled: !!m.enabled,
        origin: {
          type: (m.origin && m.origin.type) || 'local',
          category: (m.origin && m.origin.category) || null,
        },
      }));
  },

  'group-optional': async (_e, { childId, parentId }) => {
    const child = engine.attachChild(childId, parentId);
    const parent = store.getMod(parentId);
    log('info', `grouped "${child.name}" as an optional file of "${parent ? parent.name : parentId}"` +
      `${child.enabled ? '' : ' (switched off — the mod it is grouped under is disabled)'}`);
    return fullState();
  },

  'ungroup-optional': async (_e, { childId }) => {
    const child = engine.detachChild(childId);
    log('info', `ungrouped "${child.name}" — it is a mod of its own again`);
    return fullState();
  },

  // On-demand: find Nexus source candidates for every still-unlinked installed
  // mod and RETURN them for review — nothing is linked here (the renderer walks
  // them one at a time in a wizard and links each pick via 'link-origin'). Two
  // matchers per mod: md5 (the adoption path, loose paks only) and a name search
  // (GraphQL WILDCARD, catches UE4SS mods md5 can't). Scored, sorted best-first.
  'link-mods': async () => {
    const targets = store.mods.filter((m) => !m.origin || m.origin.type === 'local');
    const total = targets.length;
    if (!total) return { checked: 0, suggestions: [], state: fullState() };
    const signedIn = nexusSignedIn();
    const suggestions = [];
    const fileCache = new Map(); // modId -> Promise<files>, shared across the run
    // Catalog-wide file-name index: the one matcher that finds a page from a
    // bare archive name. First build fetches every mod's file list (once a day
    // at most); later runs only refresh mods that changed.
    const index = getFileIndex();
    try {
      const token = signedIn ? await nexusAccessToken() : null;
      await index.refresh(
        token,
        (done, all) => sendEvent({ type: 'progress', label: 'Indexing Nexus file names', received: done, total: all }),
        // One v1 request per changed mod: it stands down the moment Nexus's
        // remaining quota reaches the reserve kept for the user's own actions.
        { shouldContinue: () => nexusHttp.backgroundAllowed() },
      );
      if (index.stoppedEarly) {
        log('info', `file-name index: stopped early — ${index.stoppedEarly.reason}; the next run picks up the rest`);
        sendEvent({ type: 'toast', kind: 'warn', message: 'Nexus Mods request limit reached while indexing file names — matching continues with what is already known.' });
      }
    } catch (_) { /* index stays as it was; the other matchers still run */ }
    let i = 0;
    for (const m of targets) {
      i += 1;
      sendEvent({ type: 'progress', label: 'Matching mods on Nexus', received: i, total });
      let candidates = [];
      try { candidates = await scoreCandidates(m, index, fileCache); } catch (_) { /* one mod failing never stops the scan */ }
      suggestions.push({ id: m.id, name: m.name, modType: m.modType, candidates: candidates.slice(0, 5) });
    }
    const withCands = suggestions.filter((s) => s.candidates.length).length;
    log('info', `link-mods: ${withCands}/${total} unlinked mod(s) have candidate source(s)${signedIn ? '' : ' (no API key — linking needs a Nexus API key)'}`);
    return { checked: total, signedIn, suggestions, state: fullState() };
  },

  // Wizard search box: title OR author (anonymous), then flag results whose
  // uploaded file is named like the local mod so the right page stands out.
  'link-search': async (_e, { query, modId } = {}) => {
    const mods = await nexus.searchMods(query, 10, { includeAdult: adultAllowed() });
    const local = modId ? store.getMod(modId) : null;
    const fileCache = new Map();
    const out = [];
    const seen = new Set();
    // The typed term may itself be an archive name ("zcunlocked"): the file
    // index answers that even when no title or author contains it.
    for (const e of getFileIndex().find(query)) {
      seen.add(e.modId);
      out.push({ modId: e.modId, name: e.name, author: e.author, version: e.version, fileMatch: e.exact, filePart: !e.exact });
    }
    for (const r of mods) {
      if (seen.has(r.modId)) continue;
      seen.add(r.modId);
      const fileMatch = local && out.length < 8 ? await modHasMatchingFile(r.modId, local.name, fileCache) : false;
      out.push({ modId: r.modId, name: r.name, author: r.author || '', version: r.version || null, fileMatch });
    }
    out.sort((a, b) => Number(b.fileMatch) - Number(a.fileMatch));
    return out;
  },

  // Detach a mod from its update source (back to LOCAL). setOrigin also clears
  // any pending updateInfo, so a wrong link can't keep prompting for updates.
  'unlink-origin': async (_e, { id }) => {
    const mod = store.getMod(id);
    if (!mod) throw new Error('That mod is no longer installed.');
    const was = mod.origin && mod.origin.type !== 'local'
      ? (mod.origin.type === 'nexus' ? `Nexus mod ${mod.origin.modId}` : mod.origin.repo)
      : null;
    engine.setOrigin(id, { type: 'local' });
    log('info', `unlink-origin: ${mod.name} detached from ${was || 'no source'}`);
    return { unlinked: was, state: fullState() };
  },

  'link-origin': async (_e, { id, type, ref }) => {
    const mod = store.getMod(id);
    if (!mod) throw new Error('That mod is no longer installed.');
    if (type === 'nexus') {
      const m = String(ref).match(/mods\/(\d+)/) || String(ref).match(/^(\d+)$/);
      if (!m) throw new Error('Enter a Nexus mod ID or mod page URL.');
      const modId = Number(m[1]);
      const info = await withNexusToken((t) => nexus.modInfo(modId, t));
      // Assume the installed copy is current; future version bumps get flagged.
      engine.setOrigin(id, { type: 'nexus', modId, fileId: null, version: info.version || null, linked: true });
      const stored = store.getMod(id);
      stored.version = info.version || null;
      store.save();
      return { linked: info.name || `mod ${modId}`, state: fullState() };
    }
    if (type === 'github') {
      if (!/^[\w.-]+\/[\w.-]+$/.test(String(ref))) throw new Error('Pick a repository from the curated list.');
      const release = await github.latestReleaseFor(String(ref));
      engine.setOrigin(id, { type: 'github', repo: String(ref), tag: release ? release.tag : null, linked: true });
      const stored = store.getMod(id);
      if (release) { stored.version = release.tag; store.save(); }
      return { linked: String(ref), state: fullState() };
    }
    throw new Error('Unknown source type.');
  },

  'github-browse': async (_e, opts) => github.listCurated(opts || {}),

  'github-install': async (_e, { fullName }) => {
    const release = await github.latestReleaseFor(fullName);
    if (!release) throw new Error('That repository has no installable release.');
    const choice = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Install', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      title: 'Install from GitHub?',
      message: `Install ${release.assetName} (${(release.size / 1048576).toFixed(1)} MB)?`,
      detail: `From ${fullName} — release ${release.tag}.\n\nGitHub mods aren't moderated. This repo is on the curated list, but install only from authors you trust.`,
    });
    if (choice.response !== 0) return { cancelled: true };
    const dest = await nexus.downloadToFile(release.assetUrl, store.stagingDir, release.assetName, (got, total) => {
      sendEvent({ type: 'progress', key: `github:${fullName}`, label: fullName, received: got, total });
    });
    try {
      const res = await engine.install(dest, {
        origin: { type: 'github', repo: fullName, tag: release.tag },
        version: release.tag,
      });
      if (res.pendingFomod) {
        forwardFomod(res, fullName);
        return { pendingFomod: true, state: fullState() };
      }
      return { installed: true, count: installedMods(res).length, state: fullState() };
    } finally {
      fs.rmSync(dest, { force: true });
    }
  },

  'check-updates': async () => {
    const results = await checkForUpdates();
    return { results, state: fullState() };
  },

  'update-mod': async (_e, { id }) => {
    const mod = store.getMod(id);
    if (!mod || !mod.updateInfo || !mod.updateInfo.available) throw new Error('No update is available for that mod.');
    const origin = mod.origin;
    if (origin.type === 'github') {
      const release = await github.latestReleaseFor(origin.repo);
      if (!release) throw new Error('The new release has no installable archive.');
      const dest = await nexus.downloadToFile(release.assetUrl, store.stagingDir, release.assetName, (got, total) => {
        sendEvent({ type: 'progress', key: `github:${origin.repo}`, label: mod.name, received: got, total });
      });
      try {
        const res = await engine.replaceOrigin(
          { type: 'github', repo: origin.repo }, dest,
          { type: 'github', repo: origin.repo, tag: release.tag }, release.tag);
        if (res.pendingFomod) { forwardFomod(res, mod.name); return { pendingFomod: true, state: fullState() }; }
      } finally {
        fs.rmSync(dest, { force: true });
      }
      return { updated: true, state: fullState() };
    }
    if (origin.type === 'nexus') {
      if (nexusUser && nexusUser.isPremium) {
        // The file the update chain pointed at (so a mod with several file
        // lines never jumps lines); newest main file only as a fallback.
        const token = await nexusAccessToken();
        const data = await nexus.filesData(origin.modId, token);
        const file = (mod.updateInfo.fileId && data.files.find((f) => f.file_id === mod.updateInfo.fileId))
          || nexus.pickPrimaryFile(data.files);
        if (!file) throw new Error('The updated mod has no downloadable main file.');
        const uri = await nexus.downloadLink({ modId: origin.modId, fileId: file.file_id }, token);
        const dest = await nexus.downloadToFile(uri, store.stagingDir, file.file_name, (got, total) => {
          sendEvent({ type: 'progress', key: `nexus:${origin.modId}`, label: mod.name, received: got, total });
        });
        try {
          const newVersion = file.version || mod.updateInfo.latest;
          // An optional file (a child, or a top-level entry installed from one)
          // is matched by its FILE id, so updating it never disturbs the mod's
          // main file — and updating the main file never disturbs it.
          const optional = !!(mod.parentId || (origin.category && origin.category !== 'MAIN'));
          const match = optional
            ? { type: 'nexus', modId: origin.modId, fileId: origin.fileId }
            : { type: 'nexus', modId: origin.modId };
          const res = await engine.replaceOrigin(
            match, dest,
            {
              type: 'nexus', modId: origin.modId, fileId: file.file_id, version: newVersion,
              category: file.category_name || origin.category || 'MAIN', fileName: file.file_name || null,
            },
            newVersion, { parentId: mod.parentId || null });
          if (res.pendingFomod) { forwardFomod(res, mod.name); return { pendingFomod: true, state: fullState() }; }
        } finally {
          fs.rmSync(dest, { force: true });
        }
        return { updated: true, state: fullState() };
      }
      // Free account: the embedded panel opens at the update's own download
      // page (the file the update chain points at); the nxm:// it hands back
      // replaces the mod in place through handleNxm. An optional-file row
      // keeps its parent.
      let fileId = mod.updateInfo.fileId || null;
      if (!fileId) {
        const data = await withNexusToken((t) => nexus.filesData(origin.modId, t));
        const primary = nexus.pickPrimaryFile(data.files);
        if (!primary) throw new Error('The updated mod has no downloadable main file.');
        fileId = primary.file_id;
      }
      return embedDownload(origin.modId, fileId, mod.name, { parentId: mod.parentId || null });
    }
    throw new Error('That mod has no update source.');
  },

  // UE4SS runtime. With NO payload this installs the game-specific package —
  // Nexus mod 9 "UE4SS for Star Wars Zero Company" (stock UE4SS plus this
  // game's signatures, loader settings and helpers). That is what a Zero
  // Company install needs; the stock upstream build from GitHub carries none of
  // it and stops working after a game patch, so it is only ever a deliberate
  // fallback: { source:'github' } (the explicit "stock build" choice),
  // { tag } (one published release — Settings → UE4SS → ⧗ Versions, for a user
  // who has frozen game updates), or the automatic fallback below when the
  // Nexus page cannot be read. { nexusFileId } installs one specific Nexus file.
  //
  // Default result, by account: premium → downloaded and installed here; free →
  // { opened:'embed', url, name, hint } for the embedded Nexus page (its "Mod
  // Manager Download" comes back as nxm:// into handleNxm); no API key →
  // { needsChoice, nexus, github } so the renderer can offer adding a key or the
  // stock build.
  'install-ue4ss': async (_e, payload) => {
    if (!store.settings.gamePath) throw new Error('Locate the game folder in Settings first.');
    if (payload && payload.nexusFileId) return installUe4ssFromNexus(Number(payload.nexusFileId));
    const tag = payload && payload.tag ? String(payload.tag) : null;
    const wantsGithub = !!(payload && payload.source === 'github');
    if (!tag && !wantsGithub) {
      let nx = ue4ssDl.cachedNexusLatest();
      if (!nx) { try { nx = await ue4ssDl.refreshNexusLatest(); } catch (_) { nx = null; } }
      if (nx && nx.fileId) {
        if (!nexusSignedIn()) {
          let gh = ue4ssDl.cachedLatest();
          if (!gh) { try { gh = await ue4ssDl.refreshLatest(); } catch (_) { gh = null; } }
          return {
            needsChoice: true,
            nexus: { version: nx.version || null, testedBuild: nx.testedBuild || null, date: nx.publishedAt || null },
            github: gh ? { build: ue4ssDl.shortBuild(gh.name), date: gh.publishedAt || null } : null,
          };
        }
        return installUe4ssFromNexus(Number(nx.fileId));
      }
      // Offline, or the Nexus page/API changed: GitHub still gets UE4SS onto
      // the disk, but the user is told exactly what they are getting.
      sendEvent({
        type: 'toast', kind: 'warn',
        message: 'The Nexus page for “UE4SS for Star Wars Zero Company” could not be read, so Mod Command X is installing the stock upstream build from GitHub instead — it has no Zero Company signatures and may not work after a game patch.',
      });
    }
    const asset = tag ? await ue4ssDl.runtimeByTag(tag) : await ue4ssDl.latestRuntime();
    // Keep the build that is there now, so it can be restored from ⧗ Versions.
    const cur = store.settings.ue4ssInstalled || null;
    const kept = engine.ue4ssSnapshot(ue4ssLabel(cur), cur);
    if (kept) log('info', `UE4SS runtime kept before update: ${kept}`);
    sendEvent({ type: 'toast', message: `Downloading ${asset.name} (${(asset.size / 1048576).toFixed(1)} MB) from GitHub…` });
    const dest = await nexus.downloadToFile(asset.url, store.stagingDir, asset.name, (got, total) => {
      sendEvent({ type: 'progress', key: 'ue4ss', label: `UE4SS ${asset.releaseName}`, received: got, total });
    });
    try {
      const result = await engine.install(dest);
      if (result.modType !== 'ue4ss-runtime') {
        throw new Error('The downloaded archive did not contain a UE4SS runtime layout.');
      }
    } finally {
      fs.rmSync(dest, { force: true });
    }
    store.settings.ue4ssInstalled = {
      source: 'github', tag: asset.tag, name: asset.releaseName, asset: asset.name, prerelease: !!asset.prerelease,
      publishedAt: asset.publishedAt || null, installedAt: new Date().toISOString(),
    };
    store.settings.ue4ssNoticedBuild = asset.name;
    store.save();
    log('info', `UE4SS ${asset.releaseName} (${asset.tag}) installed from GitHub (stock upstream build)`);
    return { state: fullState(), version: asset.releaseName, tag: asset.tag, source: 'github' };
  },

  // Every UE4SS release that carries a runtime zip, newest build first, plus
  // the builds kept on this PC (the version swap for frozen game versions).
  'ue4ss-versions': async () => {
    let releases = [];
    let releasesError = null;
    try { releases = await ue4ssDl.listRuntimes(30); } catch (e) { releasesError = e.message; }
    const installed = store.settings.ue4ssInstalled || null;
    const latest = releases.find((r) => r.recommended) || null;
    const [, nexusLatest] = await Promise.all([latest ? ue4ssDl.refreshLatest(true) : null, ue4ssDl.refreshNexusLatest(true)]);
    const signedIn = nexusSignedIn();
    if (signedIn && !nexusUser) { try { mergeNexusUser(await withNexusToken((t) => nexus.validateKey(t))); } catch (_) {} }
    const det = steam.detectGame(store.settings.gamePath);
    return {
      releases, releasesError, installed, status: engine.ue4ssStatus(), vault: engine.ue4ssListVault(),
      update: ue4ssDl.updateInfo(installed, latest || undefined),
      nexus: nexusLatest, nexusUrl: ue4ssDl.NEXUS_URL, signedIn, isPremium: !!(nexusUser && nexusUser.isPremium),
      gameBuild: det.found ? det.buildId : null,
    };
  },

  // Put a kept UE4SS build back (the current one is kept first).
  'ue4ss-restore': async (_e, { entryId }) => {
    if (!store.settings.gamePath) throw new Error('Locate the game folder in Settings first.');
    const cur = store.settings.ue4ssInstalled || null;
    const m = engine.ue4ssRestore(entryId, ue4ssLabel(cur), cur);
    store.settings.ue4ssInstalled = m.tag || m.asset
      ? { tag: m.tag || null, name: m.name || m.label, asset: m.asset || null, publishedAt: m.publishedAt || null, installedAt: new Date().toISOString(), restored: true }
      : null;
    store.save();
    log('info', `UE4SS runtime restored from the kept build ${entryId}`);
    return { state: fullState(), label: m.name || m.label };
  },

  // One-click prerequisite for content mods built with the Zero Company Mod
  // SDK: installs the ZCSDK Runtime (two UE4SS mods) — the newest release from
  // the EnvianMods/ZCSDK-Runtime-Release repo when GitHub is reachable, else
  // the copy bundled in tools/.
  'install-zcsdk-runtime': async () => {
    if (!store.settings.gamePath) throw new Error('Locate the game folder in Settings first.');
    await zcsdkRt.latestRuntime(); // cached for an hour; makes the pick below current
    const pkg = zcsdkRt.availableRuntime();
    if (!pkg) throw new Error('No ZCSDK Runtime package is available — GitHub is unreachable and this build ships without tools/ZCSDKRuntime.zip.');
    let zipPath = pkg.zip || null;
    let version = pkg.version;
    let source = pkg.source;
    let downloaded = null;
    if (pkg.source === 'github') {
      try {
        sendEvent({ type: 'toast', message: `Downloading ZCSDK Runtime ${pkg.version} from GitHub…` });
        downloaded = await nexus.downloadToFile(pkg.url, store.stagingDir, pkg.asset, (got, total) => {
          sendEvent({ type: 'progress', label: 'ZCSDK Runtime', received: got, total });
        });
        zipPath = downloaded;
      } catch (e) {
        const bundled = zcsdkRt.bundledRuntime();
        if (!bundled) throw new Error(`Could not download ZCSDK Runtime ${pkg.version} from GitHub: ${e.message}`);
        log('warn', `ZCSDK Runtime ${pkg.version} download failed (${e.message}) — installing the bundled ${bundled.version || 'copy'} instead`);
        sendEvent({ type: 'toast', kind: 'warn', message: `GitHub download failed — installing the bundled ZCSDK Runtime ${bundled.version || ''} instead.` });
        zipPath = bundled.zip;
        version = bundled.version;
        source = 'bundled';
      }
    }
    let res;
    try {
      res = await engine.installZcsdkRuntime(zipPath, version);
    } finally {
      if (downloaded) fs.rmSync(downloaded, { force: true });
    }
    store.settings.zcsdkNoticedVersion = version || null;
    store.save();
    log('info', `ZCSDK Runtime ${version || ''} installed from ${source} (${res.replaced} previous cop${res.replaced === 1 ? 'y' : 'ies'} replaced)`);
    return { state: fullState(), version, source, replaced: res.replaced };
  },

  // Settings → retoc: check GitHub now / install the newest release into
  // <dataDir>/tools (preferred over the bundled copy from then on).
  'check-retoc': async () => {
    const latest = await retocDl.refreshLatest(true);
    return { state: fullState(), latest, update: retocDl.updateInfo(engine.retocStatus().version) };
  },
  'install-retoc': async () => {
    if (process.platform !== 'win32') throw new Error('retoc updates are Windows-only in this app.');
    const bundledTools = fs.existsSync(path.join(__dirname, 'tools')) ? path.join(__dirname, 'tools')
      : (process.resourcesPath ? path.join(process.resourcesPath, 'tools') : null);
    const r = await retocDl.installLatest(store.dataDir, bundledTools, nexus.downloadToFile, (got, total) => {
      sendEvent({ type: 'progress', label: 'retoc', received: got, total });
    });
    store.settings.retocInstalled = { tag: r.tag, version: r.version, asset: r.asset, publishedAt: r.publishedAt, installedAt: new Date().toISOString(), path: r.path };
    store.settings.retocNoticedVersion = r.version;
    if (store.settings.retocPath) store.settings.retocPath = null; // the fresh copy wins over an old manual path
    store.save();
    log('info', `retoc ${r.version} installed from GitHub into ${r.path}`);
    return { state: fullState(), version: r.version, path: r.path };
  },

  // Settings → ZCSDK Runtime → Check for updates: re-reads latest.json now.
  'check-zcsdk-runtime': async () => {
    const remote = await zcsdkRt.latestRuntime({ force: true });
    return { state: fullState(), remote, status: engine.zcsdkStatus() };
  },
};

// Start the game exe directly, bypassing Steam's launch path (and therefore
// its update check). The game calls SteamAPI_RestartAppIfNecessary() on boot;
// without Steam's app-id environment that returns true, the exe exits and
// asks Steam to relaunch it — which runs the update check we wanted to skip
// (measured 2026-09-09: the spawned pid died in <5s and a steam.exe-parented
// copy appeared). With SteamAppId/SteamGameId set, as the Steam client itself
// sets them, the check returns false and the game keeps running under our pid.
function spawnGameExe(detection) {
  const env = detection.launcher === 'steam'
    ? { ...process.env, SteamAppId: String(steam.APP_ID), SteamGameId: String(steam.APP_ID) }
    : process.env;
  const child = spawn(detection.exePath, [], { detached: true, stdio: 'ignore', cwd: path.dirname(detection.exePath), env });
  child.unref();
  return child;
}

// Install the game-specific UE4SS compatibility build from its Nexus page.
// Premium: direct download. Free: the embedded Nexus page — its Mod Manager
// Download button hands the file to handleNxm, which recognises the runtime.
async function installUe4ssFromNexus(fileId) {
  if (!nexusSignedIn()) throw new Error('Add your Nexus Mods API key in Settings first, or install the GitHub build.');
  const token = await nexusAccessToken();
  if (!nexusUser) { try { mergeNexusUser(await nexus.validateKey(token)); } catch (err) { throw new Error(err.message); } }
  if (!nexusUser.isPremium) return embedDownload(ue4ssDl.NEXUS_MOD_ID, fileId, 'UE4SS for Star Wars Zero Company');
  const files = await nexus.filesList(ue4ssDl.NEXUS_MOD_ID, token);
  const file = files.find((f) => f.file_id === fileId);
  if (!file) throw new Error('That file is no longer listed on the Nexus page.');
  const cur = store.settings.ue4ssInstalled || null;
  const kept = engine.ue4ssSnapshot(ue4ssLabel(cur), cur);
  if (kept) log('info', `UE4SS runtime kept before update: ${kept}`);
  const uri = await nexus.downloadLink({ modId: ue4ssDl.NEXUS_MOD_ID, fileId }, token);
  const dest = await nexus.downloadToFile(uri, store.stagingDir, file.file_name, (got, total) => {
    sendEvent({ type: 'progress', key: 'ue4ss', label: `UE4SS (Nexus) ${file.version || ''}`, received: got, total });
  });
  try {
    const result = await engine.install(dest);
    if (result.modType !== 'ue4ss-runtime') throw new Error('The downloaded archive did not contain a UE4SS runtime layout.');
  } finally {
    fs.rmSync(dest, { force: true });
  }
  recordNexusUe4ss({ fileId, version: file.version || null, asset: file.file_name, publishedAt: file.uploaded_timestamp ? new Date(file.uploaded_timestamp * 1000).toISOString() : null });
  log('info', `UE4SS compatibility build v${file.version || '?'} (Nexus file ${fileId}) installed`);
  return { state: fullState(), version: `Nexus v${file.version || '?'}`, source: 'nexus' };
}

function recordNexusUe4ss({ fileId, version, asset, publishedAt }) {
  // Remember the game build the package states it was tested on, so Settings
  // and Diagnostics can compare it with the installed game even while the Nexus
  // page is unreachable.
  const page = ue4ssDl.cachedNexusLatest();
  const testedBuild = page && Number(page.fileId) === Number(fileId) ? (page.testedBuild || null) : null;
  store.settings.ue4ssInstalled = {
    source: 'nexus', modId: ue4ssDl.NEXUS_MOD_ID, fileId, tag: null, name: 'UE4SS for Star Wars Zero Company',
    version: version || null, asset: asset || null, publishedAt: publishedAt || null, testedBuild,
    installedAt: new Date().toISOString(),
  };
  store.settings.ue4ssNoticedBuild = String(fileId);
  store.save();
}

// Human label for the runtime build a settings record describes.
function ue4ssLabel(rec) {
  if (!rec) return 'unknown build';
  return (rec.asset && rec.asset.replace(/\.zip$/i, '')) || rec.name || rec.tag || 'unknown build';
}

async function installPaths(paths) {
  const results = [];
  for (const p of paths) {
    try {
      const res = await engine.install(p);
      if (res.pendingFomod) {
        // The renderer runs the guided steps and finishes via fomod-complete.
        results.push({
          source: path.basename(p), ok: true, pendingFomod: true,
          sessionId: res.sessionId, moduleXml: res.moduleXml, info: res.info, name: res.name,
        });
        continue;
      }
      for (const mod of installedMods(res)) {
        log('info', `installed "${mod.name}" (${mod.modType}) from ${path.basename(p)}`);
        results.push({ source: path.basename(p), ok: true, name: mod.name, modType: mod.modType, warnings: mod.warnings || [] });
        // Same mod (modinfo title + author) at another version — it joined the
        // existing line instead of becoming a new entry; say what happened.
        const va = mod.versionAction;
        if (va) {
          const v = (x) => (x ? `v${x}` : 'an unversioned copy');
          const message = va.action === 'archived'
            ? `“${mod.name}”: ${v(va.version)} is older than the installed ${v(va.current)}, so it was archived as an alternate version — pick it any time from the ⧗ versions button.`
            : va.action === 'updated'
              ? `“${mod.name}” updated ${v(va.previous)} → ${v(va.version)}; the previous version is kept in ⧗ versions.`
              : `“${mod.name}” ${v(va.version)} reinstalled; the previous copy is kept in ⧗ versions.`;
          log('info', `version-aware install: ${message}`);
          results.push({ source: path.basename(p), ok: true, note: true, name: mod.name, modType: mod.modType, message });
        }
        // SDK-built content needs the ZCSDK Runtime to be discovered by the game.
        if (mod.zcsdk) {
          const rt = engine.zcsdkStatus();
          if (!rt.healthy) {
            results.push({
              source: path.basename(p), ok: true, note: true, needsZcsdk: true, name: mod.name, modType: mod.modType,
              message: `“${mod.name}” is built with the Zero Company Mod SDK and needs the ZCSDK Runtime, which is ${rt.installed ? 'not active' : 'not installed'}.`,
            });
          }
        }
      }
      if (res.multi) {
        for (const e of res.errors || []) results.push({ source: path.basename(p), ok: false, error: e });
        results.push({
          source: path.basename(p), ok: true, note: true,
          name: path.basename(p), modType: 'multi',
          message: `${res.mods.length} mods found in one archive — each installed as its own entry.`,
        });
      }
    } catch (err) {
      log('error', `install of ${path.basename(p)} failed: ${err.message}`);
      results.push({ source: path.basename(p), ok: false, error: err.message });
    }
  }
  return { state: fullState(), results };
}

function diagnostics() {
  const items = [];
  const add = (level, title, message) => items.push({ level, title, message });
  // Pick up asset lists for IoStore mods installed while retoc was unavailable.
  try {
    const rescanned = engine.refreshPackages();
    if (rescanned) add('info', 'Package scan', `Scanned asset lists for ${rescanned} previously unscanned mod(s).`);
  } catch (_) {}
  const detection = steam.detectGame(store.settings.gamePath);
  if (detection.found) {
    add('good', 'Game installation', `Valid Zero Company layout at ${detection.gamePath}`);
    const launcherLabel = { steam: 'Steam', ea: 'EA App', manual: 'manual / unknown' }[detection.launcher] || 'unknown';
    add(detection.launcher === 'manual' ? 'info' : 'good', 'Game launcher',
      `${launcherLabel} edition${detection.launcher === 'ea' ? (eaAppDetected ? ' (EA App detected on this system)' : ' (EA App itself not detected — launches go directly to the exe)') : ''}`);
    if (detection.manifest) {
      add('good', 'Steam manifest', `Build ID ${detection.buildId}`);
    } else {
      add(detection.buildId ? 'info' : 'warning', 'Game build',
        detection.buildId
          ? `No Steam manifest — tracking the game build by exe fingerprint (${detection.buildId}).`
          : 'Build identity unavailable — compatibility cannot be assessed.');
    }
    // Mods installed under a different game build than the one on disk now.
    const stale = store.mods.filter((m) => m.installedBuild && detection.buildId && m.installedBuild !== detection.buildId);
    if (stale.length) {
      add('warning', 'Game build changed',
        `${stale.length} mod(s) were installed under a different game build and may be incompatible: ` +
        `${stale.map((m) => m.name).join(', ')}. If a mod still works, use its build chip in the Hangar Bay to mark it verified.`);
    } else if (detection.buildId) {
      add('good', 'Game build', 'Every mod was installed (or verified) under the current game build.');
    }
    // EA App compatibility flags.
    const compat = ea.compatSync();
    const flagged = store.mods
      .map((m) => ({ m, v: ea.evaluateMod(m, compat) }))
      .filter((x) => x.v.status === 'incompatible');
    if (detection.launcher === 'ea') {
      const active = flagged.filter((x) => x.m.enabled);
      if (active.length) {
        for (const { m, v } of active) {
          add('warning', 'EA compatibility', `"${m.name}" is flagged as not working on the EA App edition (${v.source === 'modinfo' ? 'per its author' : 'community report'}${v.note ? `: ${v.note}` : ''}).`);
        }
      } else {
        add('good', 'EA compatibility', flagged.length
          ? `No enabled mod is flagged EA-incompatible (${flagged.length} disabled mod(s) are).`
          : 'No installed mod is flagged as EA-incompatible.');
      }
    } else if (flagged.length) {
      add('info', 'EA compatibility', `${flagged.length} installed mod(s) are flagged as Steam-only — relevant if you share your setup with EA App players: ${flagged.map((x) => x.m.name).join(', ')}.`);
    }
    const modsDir = path.join(detection.gamePath, MODS_REL);
    add(fs.existsSync(modsDir) ? 'good' : 'info', '~mods folder',
      fs.existsSync(modsDir) ? 'Present' : 'Created on first packaged-mod install');
    // Game Feature plugin mods: whole folders in SWZeroCompany\Mods, mounted by
    // the game itself. Count the plugin folders there and say how many Mod
    // Command manages, so hand-copied ones are visible (Import can adopt them).
    {
      const gameModsDir = path.join(detection.gamePath, GAME_MODS_REL);
      if (!fs.existsSync(gameModsDir)) {
        add('info', 'Mods folder (plugins)', 'Not present — created on the first Game Feature plugin install.');
      } else {
        let folders = [];
        try {
          folders = fs.readdirSync(gameModsDir, { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .filter((d) => {
              try {
                return fs.readdirSync(path.join(gameModsDir, d.name))
                  .some((f) => f.toLowerCase().endsWith('.uplugin'));
              } catch (_) { return false; }
            })
            .map((d) => d.name);
        } catch (_) {}
        const managedNames = new Set(store.mods
          .filter((m) => m.modType === 'gfp' && m.enabled)
          .map((m) => engine.gfpFolderName(m).toLowerCase()));
        const managed = folders.filter((f) => managedNames.has(f.toLowerCase()));
        const unmanaged = folders.filter((f) => !managedNames.has(f.toLowerCase()));
        if (!folders.length) {
          add('good', 'Mods folder (plugins)', `Present, no plugin folders yet (${GAME_MODS_REL}).`);
        } else {
          add(unmanaged.length ? 'info' : 'good', 'Mods folder (plugins)',
            `Present with ${folders.length} plugin folder${folders.length === 1 ? '' : 's'}: ` +
            `${managed.length} managed by Mod Command X, ${unmanaged.length} unmanaged` +
            (unmanaged.length ? ` (${unmanaged.join(', ')}) — Hangar Bay → Import can adopt them so enable/disable, updates and removal are handled here.` : '.'));
        }
      }
    }
    // Update freeze state vs the user's intent.
    const freeze = steam.updateFreezeStatus(store.settings.gamePath);
    if (store.settings.updateFreeze) {
      if (freeze.supported && freeze.frozen && freeze.behavior === '1') {
        add('warning', 'Game update freeze', 'ACTIVE — the game will not auto-update. Play with DIRECT LAUNCH (local exe, no update check). LAUNCH GAME and Steam\'s own Play button run Steam\'s update check, which fails with "Disk write error – appmanifest_2075800.acf" while an update is pending (the freeze blocking the update, not damage). Turn the freeze off to let Steam update; unfreeze before online modes that need the current build.');
      } else if (freeze.supported) {
        add('warning', 'Game update freeze', 'Enabled in Settings but the manifest is not fully locked — toggle it off and on again to re-apply.');
      } else {
        add('info', 'Game update freeze', 'Enabled, but this is not a Steam-manifest install. EA App users: disable automatic game updates in the EA App settings.');
      }
    }
  } else {
    add('error', 'Game installation', 'Not detected. Locate the game folder in Settings (Steam and EA App installs are both scanned).');
  }
  // Linux / Proton / Steam Deck.
  if (process.platform === 'linux') {
    const compatdata = detection.proton && detection.proton.compatdata;
    add(compatdata ? 'good' : 'warning', 'Proton prefix',
      compatdata
        ? `Compat prefix present (${compatdata}).`
        : 'No compatdata prefix for the game yet — run the game once through Steam to create it.');
    const ue4ssState = engine.ue4ssStatus();
    if (ue4ssState.installed) {
      add('info', 'Proton DLL override',
        'UE4SS needs its loader DLL to win over the built-in one under Proton. In Steam → Zero Company → Properties → Launch Options, set: WINEDLLOVERRIDES="dwmapi=n,b" %command% (the manager never edits launch options itself).');
    }
    add('info', 'Steam Deck', 'On Steam Deck, run the manager in Desktop Mode; mods deployed here work in Gaming Mode.');
  }
  const ue4ss = engine.ue4ssStatus();
  {
    const u = ue4ssDl.updateInfo(store.settings.ue4ssInstalled);
    const rec = store.settings.ue4ssInstalled;
    const fromNexus = u.source === 'nexus';
    const gameBuild = detection.found ? detection.buildId : null;
    let tail = '';
    if (ue4ss.installed && rec) {
      // Which build, and — for the game-specific package — whether the build it
      // was tested on is the build this PC is actually running.
      tail = fromNexus
        ? ` Installed: the Zero Company package from Nexus${u.currentBuild ? ` ${u.currentBuild}` : ''}.`
        : ` Installed: GitHub build ${u.currentBuild || rec.asset || rec.name} — stock upstream build, not game-specific.`;
      const tested = fromNexus ? (rec.testedBuild || (u.nexus && u.nexus.testedBuild) || null) : null;
      if (tested) {
        tail += ` Tested on game build ${tested}${gameBuild ? (String(gameBuild) === String(tested) ? ' — matches yours' : ` — yours is ${gameBuild}`) : ''}.`;
      }
      if (u.available) tail += ` Newer ${fromNexus ? 'Zero Company package' : 'stock build'} available: ${u.latestBuild} (you have ${u.currentBuild}) — Settings → UE4SS.`;
      else if (u.latest) tail += ' Current.';
      if (!fromNexus) tail += ' The Zero Company package on Nexus is the tested one — Settings → UE4SS.';
    } else if (ue4ss.installed) {
      tail = ' Build unknown (not installed by Mod Command X) — reinstall from Settings → UE4SS to get the Zero Company package from Nexus.';
    }
    add(u.available ? 'warning' : (ue4ss.healthy ? 'good' : (ue4ss.installed ? 'warning' : 'info')), 'UE4SS runtime', ue4ss.message + tail);
  }
  const zc = engine.zcsdkStatus();
  if (zc.installed || zc.neededBy.length) {
    const needed = zc.neededBy.some((n) => n.enabled);
    add(zc.healthy ? (zc.updateAvailable ? 'info' : 'good') : (needed ? 'warning' : 'info'), 'ZCSDK Runtime', zc.message);
  }
  const retoc = engine.retocStatus();
  {
    const ru = retocDl.updateInfo(retoc.version);
    const tail = ru.latest ? (ru.available ? ` Newer release on GitHub: ${ru.latest} — Settings → retoc → Update.` : ` Latest GitHub release: ${ru.latest} — current.`) : '';
    add(retoc.found ? (ru.available ? 'warning' : 'good') : 'info', 'retoc',
      (retoc.found ? `Found at ${retoc.path}${retoc.version ? ` (${retoc.version})` : ''}` : 'Not found (optional — used for IoStore package inspection).') + tail);
  }
  {
    const sz = findSevenZip(store.settings.sevenZipPath);
    add(sz ? 'good' : 'info', '7-Zip',
      sz ? `Available for .7z/.rar archives (${sz === bundledSevenZip() ? 'bundled with Mod Command X' : sz})` : 'Not found — only .zip archives can be installed.');
  }
  const missing = store.settings.gamePath ? engine.auditDeployedFiles() : [];
  if (missing.length) {
    add('warning', 'Deployed files', `${missing.length} deployed file(s) are missing: ${missing.map((m) => m.file).join(', ')}`);
  } else {
    add('good', 'Deployed files', 'All enabled mods are fully deployed.');
  }
  const duplicates = store.settings.gamePath ? engine.scanDuplicateMods() : [];
  if (duplicates.length) {
    for (const dup of duplicates) {
      const list = dup.members
        .map((m) => `"${m.folder}" (${m.managed ? 'managed' : 'unmanaged'})`)
        .join(' and ');
      add('warning', 'Duplicate mod',
        `The same mod is active under ${dup.members.length} folders: ${list}. ` +
        `Both load at once (double hooks/loops) and can cause frame stutter — keep one and disable/delete the rest.`);
    }
  } else if (store.settings.gamePath) {
    add('good', 'Duplicate mods', 'No mod is installed under more than one active folder.');
  }
  const hookReport = store.settings.gamePath ? engine.scanUe4ssHooks() : { entries: [], conflicts: [] };
  const conflicts = store.settings.gamePath ? engine.conflicts(hookReport) : [];
  const confirmed = conflicts.filter((c) => c.certainty === 'confirmed').length;
  add(conflicts.length ? 'warning' : 'good', 'Conflicts',
    conflicts.length
      ? `${conflicts.length} conflicting mod pair(s) (${confirmed} confirmed by asset overlap) — details below.`
      : 'No incompatibilities detected between enabled mods.');
  if (hookReport.entries.length) {
    const totalHooks = hookReport.entries.reduce((n, e) => n + e.hooks.length, 0);
    const totalKeys = hookReport.entries.reduce((n, e) => n + e.keybinds.length, 0);
    add(hookReport.conflicts.length ? 'warning' : 'good', 'UE4SS hooks',
      hookReport.conflicts.length
        ? `${hookReport.conflicts.length} shared hook/keybind target(s) across active UE4SS mods — see the hook report below.`
        : `${hookReport.entries.length} active UE4SS mod(s) scanned (${totalHooks} hooks, ${totalKeys} keybinds) — no shared targets.`);
  }
  return { items, generatedAt: new Date().toISOString() };
}

// Everything a bug report needs, gathered fresh and scrubbed of personal data.
function buildSupportReport() {
  const detection = steam.detectGame(store.settings.gamePath);
  const hookReport = store.settings.gamePath ? engine.scanUe4ssHooks() : { entries: [], conflicts: [] };
  const conflicts = (store.settings.gamePath ? engine.conflicts(hookReport) : [])
    .map((c) => ({
      ...c,
      aName: (store.getMod(c.aId) || {}).name,
      bName: (store.getMod(c.bId) || {}).name,
    }));
  const compat = ea.compatSync();
  const modCompat = {};
  for (const m of store.mods) modCompat[m.id] = ea.evaluateMod(m, compat);
  return report.buildReport({
    appVersion: app.getVersion(),
    platform: process.platform,
    osRelease: require('os').release(),
    generatedAt: new Date().toISOString(),
    detection,
    eaAppPresent: eaAppDetected,
    // The key itself never enters the report — not even encrypted.
    settings: publicSettings(),
    hasNexusKey: nexusSignedIn(),
    keyEncrypted: !!store.settings.nexusApiKeyEncrypted,
    keySessionOnly: !!sessionOnlyKey,
    mods: store.mods,
    modCompat,
    conflicts,
    hookConflicts: hookReport.conflicts,
    duplicates: store.settings.gamePath ? engine.scanDuplicateMods() : [],
    missingDeployed: store.settings.gamePath ? engine.auditDeployedFiles() : [],
    ue4ssStatus: engine.ue4ssStatus(),
    zcsdkStatus: engine.zcsdkStatus(),
    retoc: (() => { const r = engine.retocStatus(); return { ...r, update: retocDl.updateInfo(r.version), installedRecord: store.settings.retocInstalled || null }; })(),
    sevenZip: !!findSevenZip(store.settings.sevenZipPath),
    sevenZipBundled: !store.settings.sevenZipPath && findSevenZip(null) === bundledSevenZip() && !!bundledSevenZip(),
    diagItems: diagnostics().items,
    logText: logText(250),
    paths: { gamePath: store.settings.gamePath, dataDir: store.dataDir },
  });
}

handlers['support-report'] = async () => ({ text: buildSupportReport() });

handlers['save-support-report'] = async () => {
  const res = await dialog.showSaveDialog(win, {
    title: 'Save support report',
    defaultPath: `ModCommandX-report-${new Date().toISOString().slice(0, 10)}.txt`,
    filters: [{ name: 'Text report', extensions: ['txt'] }],
  });
  if (res.canceled || !res.filePath) return { saved: false };
  fs.writeFileSync(res.filePath, buildSupportReport());
  log('info', 'support report saved');
  return { saved: true, file: path.basename(res.filePath) };
};

// ----------------------------------------------------------- SDK LINK
// Nine small channels, all of them ABOUT the link. Everything the SDK panel
// itself does travels on the SDK's own `sdk:<contract>:*` channels, which
// lib/sdk-link.js registers out of the linked folder — this host does not
// know or care what they are.

// The link is established on the renderer's first status call rather than at
// app start, so a broken or half-installed SDK can never delay the window.
let sdkLinkRestored = false;
function sdkLinkEnsure() {
  if (sdkLinkRestored) return sdkLink.status();
  sdkLinkRestored = true;
  try { return sdkLink.restore(); }
  catch (err) { log('error', `sdk-link restore: ${err.message}`); return sdkLink.status(); }
}

handlers['sdk-link-status'] = async () => sdkLinkEnsure();

handlers['sdk-link-detect'] = async () => {
  sdkLinkRestored = true;
  return sdkLink.detect();
};

handlers['sdk-link-browse'] = async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Locate the Zero Company Mod SDK folder',
    properties: ['openDirectory'],
    defaultPath: store.settings.sdkPath || undefined,
  });
  if (res.canceled || !res.filePaths.length) return sdkLink.status();
  sdkLinkRestored = true;
  return sdkLink.link(res.filePaths[0]);
};

handlers['sdk-link-unlink'] = async () => {
  sdkLinkRestored = true;
  return sdkLink.unlink();
};

// The renderer owns the layout, so it measures the content area and hands the
// rect over; showing/hiding rides the same call as the view switch.
handlers['sdk-link-view'] = async (_e, { visible, bounds } = {}) => sdkLink.setVisible(!!visible, bounds || null);

handlers['sdk-link-devtools'] = async () => sdkLink.openDevTools();

// The ◆ SDK card's "Paths & dependencies…": ask the hosted page to open its
// own Settings view ({ type: 'open-settings', key? } on the SDK's event
// channel — the same path the sdk-update push takes).
handlers['sdk-link-open-settings'] = async (_e, { key } = {}) => {
  sdkLinkEnsure();
  return sdkLink.openSettings(key);
};

// The ◆ SDK card's "What's new in the SDK": the linked SDK's own
// docs/CHANGELOG.md through the host's openPath. No path crosses the IPC —
// lib/sdk-link.js resolves it inside the linked tree.
handlers['sdk-link-open-changelog'] = async () => {
  sdkLinkEnsure();
  return sdkLink.openChangelog();
};

// The SDK's update check, for the host's own badge and Settings line.
// { force: true } is the "Check now" button; everything else is cached.
handlers['sdk-link-check-update'] = async (_e, { force } = {}) => {
  sdkLinkEnsure();
  const info = await sdkLink.checkUpdate({ force: !!force });
  sdkLink.pushUpdateToView(info);
  return info;
};

// ----------------------------------------------------------- UNINSTALL
// Settings -> "Uninstall Mod Command X…" starts the standalone uninstaller
// (build/uninstaller: a ~140 KB .NET Framework exe, see README "Uninstalling")
// and quits, so nothing of the app is running or locked while it removes the
// app's files. A Windows release carries it twice: next to ModCommandX.exe,
// and embedded in resources/uninstaller/bin for users who kept only the exe.
// The embedded copy is started from %TEMP%\ModCommandX-uninstaller — never
// from %TEMP%\ModCommandX, which is one of the folders it deletes. Linux gets
// uninstall-linux.sh, copied out of the AppImage (whose mount disappears when
// the app quits) for the user to run in a terminal.
const UNINSTALLER_EXE = 'Uninstall Mod Command X.exe';

function uninstallerSource() {
  if (!app.isPackaged) return null;
  if (process.platform === 'linux') {
    const sh = path.join(process.resourcesPath, 'uninstaller', 'uninstall-linux.sh');
    return fs.existsSync(sh) ? { script: sh } : null;
  }
  if (process.platform !== 'win32') return null;
  const sibling = process.env.PORTABLE_EXECUTABLE_DIR && path.join(process.env.PORTABLE_EXECUTABLE_DIR, UNINSTALLER_EXE);
  if (sibling && fs.existsSync(sibling)) return { exe: sibling, copy: false };
  const embedded = path.join(process.resourcesPath, 'uninstaller', 'bin', UNINSTALLER_EXE);
  return fs.existsSync(embedded) ? { exe: embedded, copy: true } : null;
}

handlers['launch-uninstaller'] = async () => {
  if (!app.isPackaged) {
    return {
      launched: false,
      dev: true,
      message: 'The uninstaller comes with the release build (next to ModCommandX.exe). This is a source run: build it with "npm run build-uninstaller" and start build\\uninstaller\\bin\\Uninstall Mod Command X.exe yourself once the app is closed.',
    };
  }
  const src = uninstallerSource();
  if (!src) throw new Error('The uninstaller is missing from this build. Download the release zip again: it has "Uninstall Mod Command X.exe" next to ModCommandX.exe.');
  const os = require('os');
  if (src.script) {
    const dest = path.join(os.tmpdir(), 'mod-command-x-uninstall.sh');
    fs.copyFileSync(src.script, dest);
    fs.chmodSync(dest, 0o755);
    log('info', 'uninstaller script copied out for the user to run');
    const appImage = process.env.APPIMAGE ? ` --appimage "${process.env.APPIMAGE}"` : '';
    return { launched: false, linux: true, command: `sh "${dest}"${appImage}` };
  }
  let exe = src.exe;
  if (src.copy) {
    const dir = path.join(os.tmpdir(), 'ModCommandX-uninstaller');
    fs.mkdirSync(dir, { recursive: true });
    exe = path.join(dir, UNINSTALLER_EXE);
    fs.copyFileSync(src.exe, exe);
  }
  const args = ['--wait-pid', String(process.pid)];
  if (process.env.PORTABLE_EXECUTABLE_FILE) args.push('--app-exe', process.env.PORTABLE_EXECUTABLE_FILE);
  const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
  log('info', 'uninstaller started; quitting');
  setTimeout(() => app.quit(), 300);
  return { launched: true };
};

for (const [channel, fn] of Object.entries(handlers)) {
  ipcMain.handle(channel, async (event, payload) => {
    try {
      return ok(await fn(event, payload));
    } catch (err) {
      log('error', `${channel}: ${err && err.message ? err.message : err}`);
      return fail(err);
    }
  });
}
