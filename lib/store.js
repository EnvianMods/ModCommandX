'use strict';
// Portable JSON data store. Lives in <appRoot>/data/manager-data.json so the
// whole manager (settings + mod library) can be moved as one folder.

const fs = require('fs');
const path = require('path');
const { MIRROR_FILE, readJson, mergeMirror } = require('./storage');

const DEFAULTS = {
  settings: {
    gamePath: null,
    retocPath: null,
    sevenZipPath: null,
    reducedMotion: false,
    closeOnLaunch: false,
    // Look of the app: 'modcommandx' (the black-market bounty-hunter theme,
    // default) or 'modcommand' (the original holo-terminal look). Applied
    // before first paint (preload -> src/theme-boot.js) and live on change.
    theme: 'modcommandx',
    // The user's personal Nexus Mods API key: only ever nexusApiKeyEncrypted
    // (OS key store, DPAPI on Windows). nexusApiKey is a legacy plaintext slot
    // that main.js migrates away on startup and never writes (see main.js).
    nexusApiKey: null,
    nexusApiKeyEncrypted: null,
    customConfigFiles: [],
    // Free Nexus accounts: the one-click download opens the embedded Nexus
    // panel at the exact file and presses "Slow download" for the user once
    // the site enables it (src/nexus-autoclick.js). Off = the panel only opens.
    autoClickNexus: true,
    // First-run setup assistant: shown once until finished/skipped (or until
    // both the Nexus API key and the nxm handler are already in place).
    onboarded: false,
    // Custom mod-archive location; null = auto (<game>\ModCommandArchive — the
    // SAME archive the main Mod Command uses; one stored copy per mod).
    storageDir: null,
    // One-time automatic existing-mods scan after the first game connection.
    firstScanDone: false,
    // SDK LINK (lib/sdk-link.js): the Zero Company Mod SDK folder whose own UI
    // we host in the Forge view. null = no SDK linked, ◆ Forge dimmed ("Get the SDK").
    sdkPath: null,
    // The SDK panel's own two settings. They are the SDK's, not ours; they
    // live here only because the SDK's handler map asks its host to store
    // them. sdkCliPath is the checkout the SDK's CLI runs against and is
    // normally the SAME folder as sdkPath (null means exactly that) — they
    // are separate keys so that pointing the panel at another checkout, which
    // a developer with more than one does, cannot break the link.
    sdkCliPath: null,
    sdkShowCommand: false,
    // The SDK update check's cached answer and when it was taken —
    // { info, at } — so the 60-minute TTL survives a restart, exactly as the
    // launcher check's lastUpdateCheck does. Written by lib/sdk-link.js.
    sdkUpdate: null,
  },
  // mods: [{ id, name, version, modType, enabled, installedAt, installedBuild,
  //          loadPriority, sourceArchive, files: [{ libraryRelative, destination, size }] }]
  mods: [],
  // profiles: [{ id, name, savedAt, entries: [{ modId, enabled }], order: [modId] }]
  profiles: [],
  // Snapshot of the pak load order taken just before the last Apply, for rollback.
  lastOrderBackup: null, // { at, order: [modId] }
};

class Store {
  constructor(dataDir) {
    dataDir = path.resolve(dataDir);
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'manager-data.json');
    this.stagingDir = path.join(dataDir, 'staging');
    fs.mkdirSync(this.stagingDir, { recursive: true });
    this.data = this._load();
    // Mod storage (library/backups/versions) starts beside the settings and is
    // re-pointed by setStorageRoot() once the game folder is known — the
    // default archive home is <game>\ModCommandArchive (shared with the main
    // Mod Command) so the mods survive app updates and deletions.
    this.setStorageRoot(dataDir);
    // Ids of stored mods the main Mod Command references, learned at startup
    // (main.js reconcileSharedArchive); carried in the mirror's X block.
    this.sharedUpstreamIds = [];
  }

  // Point the mod archive at a folder (creates the subdirs). The settings file
  // itself stays in dataDir so the app can find its configuration first.
  setStorageRoot(root) {
    this.storageRoot = path.resolve(root);
    this.libraryDir = path.join(this.storageRoot, 'library');
    this.backupsDir = path.join(this.storageRoot, 'backups');
    this.versionsDir = path.join(this.storageRoot, 'versions');
    for (const d of [this.storageRoot, this.libraryDir, this.backupsDir, this.versionsDir]) {
      fs.mkdirSync(d, { recursive: true });
    }
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return {
        settings: { ...DEFAULTS.settings, ...(raw.settings || {}) },
        mods: Array.isArray(raw.mods) ? raw.mods : [],
        profiles: Array.isArray(raw.profiles) ? raw.profiles : [],
        lastOrderBackup: raw.lastOrderBackup || null,
      };
    } catch (_) {
      return JSON.parse(JSON.stringify(DEFAULTS));
    }
  }

  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
    // Mirror the manifest into the archive itself, so a fresh install pointed
    // at (or finding) the archive can restore everything — names, origins,
    // enabled states, priorities, profiles. The archive is SHARED with the
    // main Mod Command (<game>\ModCommandArchive), so the mirror is merged,
    // never clobbered: the main app's records, settings block and profiles
    // stay as it wrote them (lib/storage.js mergeMirror). That also covers the
    // old empty-store guard — a fresh, empty X keeps every restorable record.
    if (this.storageRoot && this.storageRoot !== this.dataDir) {
      try {
        const mirrorFile = path.join(this.storageRoot, MIRROR_FILE);
        const existing = fs.existsSync(mirrorFile) ? readJson(mirrorFile) : null;
        // A mirror that exists but cannot be parsed is left alone rather than
        // replaced by X's records only.
        if (fs.existsSync(mirrorFile) && !existing) return;
        const merged = mergeMirror(existing, withoutSecrets(this.data), this.libraryDir, this.sharedUpstreamIds);
        const mtmp = mirrorFile + '.mcx.tmp';
        fs.writeFileSync(mtmp, JSON.stringify(merged, null, 2));
        fs.renameSync(mtmp, mirrorFile);
      } catch (_) { /* archive drive briefly unavailable — next save retries */ }
    }
  }

  get settings() { return this.data.settings; }
  get mods() { return this.data.mods; }
  get profiles() { return this.data.profiles; }

  getMod(id) { return this.data.mods.find((m) => m.id === id) || null; }

  addMod(mod) { this.data.mods.push(mod); this.save(); }

  removeMod(id) {
    this.data.mods = this.data.mods.filter((m) => m.id !== id);
    this.save();
  }

  modLibraryDir(id) { return path.join(this.libraryDir, id); }

  // Originals of game files a game-folder mod replaced, kept for restore.
  modBackupsDir(id) { return path.join(this.backupsDir, 'gamefiles', id); }

  // Archived versions of a mod (the version vault), keyed by mod identity.
  modVaultDir(key) { return path.join(this.versionsDir, key); }

  nextLoadPriority(types) {
    const prios = this.data.mods
      .filter((m) => types.includes(m.modType))
      .map((m) => m.loadPriority || 0);
    return (prios.length ? Math.max(...prios) : 0) + 1;
  }
}

// The archive mirror lives in the GAME folder: it never carries a credential,
// not even the OS-encrypted Nexus key (that stays in the app's own data dir).
const SECRET_SETTINGS = ['nexusApiKey', 'nexusApiKeyEncrypted', 'nexusOAuth', 'nexusOAuthEncrypted'];
function withoutSecrets(data) {
  const settings = { ...data.settings };
  for (const k of SECRET_SETTINGS) delete settings[k];
  return { ...data, settings };
}

module.exports = { Store };
