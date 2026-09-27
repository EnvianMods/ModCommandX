'use strict';
// Mod-archive location handling. The archive (library/backups/versions plus a
// mirrored manifest) lives in the GAME folder by default so mods survive app
// updates and deletions; settings.storageDir overrides with a custom path.
//
// SHARED ARCHIVE. Mod Command X uses the SAME game-side archive as the
// upstream Zero Company Mod Command — <game>\ModCommandArchive — so a user
// running both keeps ONE stored copy of each mod instead of two folders of
// duplicates. Both apps key a stored mod by its record id (library/<id>,
// backups/gamefiles/<id>) and the version vault by the mod's identity
// (versions/<modType-title>/<entry>). The helpers below are what X needs to
// live in that folder without disturbing the main app:
//   - the manifest mirror is MERGED, never clobbered (mergeMirror),
//   - X can tell which stored mods the main app still uses (upstreamRefs),
//   - X's own pre-1.0 archive (ModCommandXArchive) is folded in once
//     (mergeArchiveInto).
// The main app (1.9.14) knows nothing of X: it rewrites the mirror with only
// its own records on every save and deletes library/<id> when IT removes a
// mod — X copes with both (see main.js reconcileSharedArchive).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// The shared archive folder — the upstream Mod Command's own name. (Its
// pre-1.9.0 name, ZeroCompanyModArchive, is the main app's to migrate; X
// leaves it alone.)
const ARCHIVE_DIR_NAME = 'ModCommandArchive';
// Mod Command X's own archive before it shared the main app's. Found beside
// the shared one, its entries are moved in once and the folder removed.
const OLD_X_ARCHIVE_DIR_NAME = 'ModCommandXArchive';
const MIRROR_FILE = 'manager-data.json';
// X's bookkeeping inside the shared mirror. Upstream's Store._load() reads
// only settings/mods/profiles/lastOrderBackup and restoreFromData() only
// mods/profiles, so this extra top-level key is ignored there (and dropped the
// next time upstream saves — which is itself a signal: no block = upstream
// wrote the mirror last).
const X_BLOCK = 'modCommandX';

function resolveStorageRoot(settings, dataDir) {
  if (settings.storageDir) return settings.storageDir;
  if (settings.gamePath) return path.join(settings.gamePath, ARCHIVE_DIR_NAME);
  return dataDir;
}

function countFilesRec(dir) {
  let n = 0;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) n += countFilesRec(path.join(dir, entry.name));
      else n += 1;
    }
  } catch (_) {}
  return n;
}

// Copy-verify-delete each archive entry from one root to another. Merges; an
// entry that already exists at the destination is never clobbered (the source
// copy stays put in that case).
function migrateStorage(fromRoot, toRoot) {
  let moved = 0;
  if (path.resolve(fromRoot) === path.resolve(toRoot)) return { moved };
  for (const sub of ['library', 'backups', 'versions']) {
    const src = path.join(fromRoot, sub);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(toRoot, sub);
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      const s = path.join(src, entry);
      const d = path.join(dst, entry);
      if (fs.existsSync(d)) continue;
      fs.cpSync(s, d, { recursive: true });
      if (countFilesRec(s) === countFilesRec(d)) {
        fs.rmSync(s, { recursive: true, force: true });
        moved += 1;
      }
    }
    try { if (!fs.readdirSync(src).length) fs.rmSync(src, { recursive: true, force: true }); } catch (_) {}
  }
  return { moved };
}

// ------------------------------------------------------------ shared archive

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function samePath(a, b) {
  return !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

// Ids of stored mods the MAIN app references, according to a mirror: every
// record when upstream wrote it last (no X block), else the set X carried
// forward when it last wrote it.
function mirrorUpstreamIds(mirror) {
  if (!mirror || typeof mirror !== 'object') return new Set();
  if (mirror[X_BLOCK]) return new Set(Array.isArray(mirror[X_BLOCK].upstreamIds) ? mirror[X_BLOCK].upstreamIds : []);
  return new Set((Array.isArray(mirror.mods) ? mirror.mods : []).filter((m) => m && m.id).map((m) => String(m.id)));
}

// The archive folder a main-app manifest points at (its own resolveStorageRoot).
function upstreamStorageRoot(manifest, upstreamDataDir) {
  const st = (manifest && manifest.settings) || {};
  if (st.storageDir) return st.storageDir;
  if (st.gamePath) return path.join(st.gamePath, ARCHIVE_DIR_NAME);
  return upstreamDataDir;
}

// What the main app references in THIS archive. Read-only.
//   upstreamDataDir: the main app's own data folder (%APPDATA%\ZeroCompanyModCommand)
//                    or null when unknown.
// Its manifest there is authoritative when it uses this archive; otherwise the
// mirror stands in (a dev run of the main app keeps its manifest elsewhere).
// Returns { ids:Set, records:Map(id -> record), source }.
function upstreamRefs(storageRoot, upstreamDataDir) {
  const records = new Map();
  const manifest = upstreamDataDir ? readJson(path.join(upstreamDataDir, MIRROR_FILE)) : null;
  if (manifest && Array.isArray(manifest.mods)) {
    if (samePath(upstreamStorageRoot(manifest, upstreamDataDir), storageRoot)) {
      for (const m of manifest.mods) if (m && m.id) records.set(String(m.id), m);
      return { ids: new Set(records.keys()), records, source: 'manifest' };
    }
    // The main app keeps its mods in another folder: nothing here is its.
    return { ids: new Set(), records, source: 'elsewhere' };
  }
  const mirror = readJson(path.join(storageRoot, MIRROR_FILE));
  const ids = mirrorUpstreamIds(mirror);
  for (const m of (mirror && Array.isArray(mirror.mods)) ? mirror.mods : []) {
    if (m && m.id && ids.has(String(m.id))) records.set(String(m.id), m);
  }
  return { ids, records, source: mirror ? 'mirror' : 'none' };
}

// The mirror X writes into a (possibly shared) archive. Keeps what isn't X's:
//   - mods: X's records, plus every existing record X doesn't hold that the
//     main app references or whose stored copy is still there (so a mirror is
//     never emptied of anything restorable); records X removed whose stored
//     copy X deleted drop out.
//   - settings / lastOrderBackup: the main app's block is preserved verbatim
//     once it has written one — X's settings never land in the shared mirror
//     over it (and upstream's restore reads neither).
//   - profiles: the main app's are kept, X's replace X's previous ones.
// mine = X's (credential-free) data; extraUpstreamIds = refs X learned at startup.
function mergeMirror(existing, mine, libraryDir, extraUpstreamIds) {
  const myIds = new Set(mine.mods.map((m) => m.id));
  const myProfileIds = new Set((mine.profiles || []).map((p) => p.id));
  if (!existing || typeof existing !== 'object') {
    return {
      ...mine,
      [X_BLOCK]: {
        app: 'Mod Command X', savedAt: new Date().toISOString(), ownsSettings: true,
        modIds: [...myIds], profileIds: [...myProfileIds], upstreamIds: [...(extraUpstreamIds || [])],
      },
    };
  }
  const prev = existing[X_BLOCK] || null;
  const ownsSettings = !!(prev && prev.ownsSettings);
  const upIds = mirrorUpstreamIds(existing);
  for (const id of extraUpstreamIds || []) upIds.add(id);
  const keepMods = (Array.isArray(existing.mods) ? existing.mods : []).filter((m) => m && m.id
    && !myIds.has(m.id)
    && (upIds.has(String(m.id)) || fs.existsSync(path.join(libraryDir, String(m.id)))));
  const prevXProfiles = new Set(prev && Array.isArray(prev.profileIds) ? prev.profileIds : []);
  const keepProfiles = (Array.isArray(existing.profiles) ? existing.profiles : []).filter((p) => p && !myProfileIds.has(p.id) && !prevXProfiles.has(p.id));
  const out = {
    settings: ownsSettings ? mine.settings : (existing.settings || {}),
    mods: [...mine.mods, ...keepMods],
    profiles: [...keepProfiles, ...(mine.profiles || [])],
    lastOrderBackup: ownsSettings ? (mine.lastOrderBackup || null) : (existing.lastOrderBackup || null),
  };
  // Anything else upstream may add later rides along untouched.
  for (const [k, v] of Object.entries(existing)) {
    if (!(k in out) && k !== X_BLOCK) out[k] = v;
  }
  out[X_BLOCK] = {
    app: 'Mod Command X', savedAt: new Date().toISOString(), ownsSettings,
    modIds: [...myIds], profileIds: [...myProfileIds],
    upstreamIds: [...upIds].filter((id) => keepMods.some((m) => String(m.id) === id) || myIds.has(id)),
  };
  return out;
}

// ------------------------------------------------ old X archive -> shared one

function listFilesRel(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) listFilesRel(abs, base, out);
    else out.push(path.relative(base, abs));
  }
  return out;
}

function hashFile(abs) {
  return crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
}

// Same relative files with the same bytes (sizes first, hashes only then).
function sameTree(a, b) {
  try {
    const fa = listFilesRel(a).sort();
    const fb = listFilesRel(b).sort();
    if (fa.length !== fb.length || fa.some((f, i) => f.toLowerCase() !== fb[i].toLowerCase())) return false;
    for (const f of fa) if (fs.statSync(path.join(a, f)).size !== fs.statSync(path.join(b, f)).size) return false;
    for (const f of fa) if (hashFile(path.join(a, f)) !== hashFile(path.join(b, f))) return false;
    return true;
  } catch (_) { return false; }
}

// A deterministic replacement id for a colliding library entry, so a merge
// interrupted after its copy picks the same id again when it re-runs.
function collisionId(id) {
  return crypto.createHash('sha256').update(`mcx-collision:${id}`).digest('hex').slice(0, 16);
}

// Copy, verify by file count, then delete the source. Never clobbers.
function moveEntry(s, d) {
  fs.mkdirSync(path.dirname(d), { recursive: true });
  fs.cpSync(s, d, { recursive: true, errorOnExist: true, force: false });
  if (countFilesRec(s) !== countFilesRec(d)) throw new Error(`copy of ${s} could not be verified`);
  fs.rmSync(s, { recursive: true, force: true });
}

function rmIfEmpty(dir) {
  try { if (fs.existsSync(dir) && !fs.readdirSync(dir).length) fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

// Fold one archive into another, entry by entry, never clobbering:
//   library/<id>           identical at the destination -> source dropped;
//                          different -> moved in under collisionId(id) and
//                          reported in `renamed` so the caller re-points
//                          its records (and backups/gamefiles/<id> follows).
//   backups/gamefiles/<id> same rule, following the library's renames.
//   versions/<key>/<entry> per vault entry (keys are shared by design:
//                          both apps vault the same mod under the same key).
// Idempotent and safe to interrupt: every step is copy-verify-delete and a
// re-run picks up whatever is left.
// Returns { moved, deduped, renamed: Map(oldId -> newId), errors: [] }.
function mergeArchiveInto(fromRoot, toRoot) {
  const res = { moved: 0, deduped: 0, renamed: new Map(), errors: [] };
  if (samePath(fromRoot, toRoot) || !fs.existsSync(fromRoot)) return res;
  const step = (fn, what) => { try { fn(); } catch (err) { res.errors.push(`${what}: ${err.message}`); } };

  const lib = path.join(fromRoot, 'library');
  if (fs.existsSync(lib)) {
    for (const id of fs.readdirSync(lib)) {
      const s = path.join(lib, id);
      step(() => {
        const d = path.join(toRoot, 'library', id);
        if (!fs.existsSync(d)) { moveEntry(s, d); res.moved += 1; return; }
        if (sameTree(s, d)) { fs.rmSync(s, { recursive: true, force: true }); res.deduped += 1; return; }
        const nid = collisionId(id);
        const nd = path.join(toRoot, 'library', nid);
        if (fs.existsSync(nd)) {
          // An interrupted earlier run already copied it.
          if (!sameTree(s, nd)) throw new Error(`library entry ${id} collides twice; left in place`);
          fs.rmSync(s, { recursive: true, force: true });
        } else {
          moveEntry(s, nd);
        }
        res.renamed.set(id, nid);
        res.moved += 1;
      }, `library/${id}`);
    }
    rmIfEmpty(lib);
  }

  const backups = path.join(fromRoot, 'backups');
  if (fs.existsSync(backups)) {
    for (const group of fs.readdirSync(backups)) {
      const gs = path.join(backups, group);
      if (!fs.statSync(gs).isDirectory()) continue;
      for (const id of fs.readdirSync(gs)) {
        const s = path.join(gs, id);
        step(() => {
          const target = res.renamed.get(id) || id;
          const d = path.join(toRoot, 'backups', group, target);
          if (!fs.existsSync(d)) { moveEntry(s, d); res.moved += 1; return; }
          if (sameTree(s, d)) { fs.rmSync(s, { recursive: true, force: true }); res.deduped += 1; return; }
          throw new Error('a different backup already exists there; left in place');
        }, `backups/${group}/${id}`);
      }
      rmIfEmpty(gs);
    }
    rmIfEmpty(backups);
  }

  const versions = path.join(fromRoot, 'versions');
  if (fs.existsSync(versions)) {
    for (const key of fs.readdirSync(versions)) {
      const ks = path.join(versions, key);
      if (!fs.statSync(ks).isDirectory()) continue;
      for (const entry of fs.readdirSync(ks)) {
        const s = path.join(ks, entry);
        step(() => {
          let d = path.join(toRoot, 'versions', key, entry);
          if (fs.existsSync(d)) {
            if (sameTree(s, d)) { fs.rmSync(s, { recursive: true, force: true }); res.deduped += 1; return; }
            d = path.join(toRoot, 'versions', key, `${entry}__x`);
            if (fs.existsSync(d)) {
              if (!sameTree(s, d)) throw new Error('collides twice; left in place');
              fs.rmSync(s, { recursive: true, force: true });
              res.deduped += 1;
              return;
            }
          }
          moveEntry(s, d);
          res.moved += 1;
        }, `versions/${key}/${entry}`);
      }
      rmIfEmpty(ks);
    }
    rmIfEmpty(versions);
  }
  return res;
}

// (The upstream app's pre-1.9.0 app-data migration is intentionally absent:
// X starts from its own empty data folder and never adopts another app's.)

module.exports = {
  ARCHIVE_DIR_NAME, OLD_X_ARCHIVE_DIR_NAME, MIRROR_FILE, X_BLOCK,
  resolveStorageRoot, migrateStorage, countFilesRec,
  readJson, samePath, sameTree, mirrorUpstreamIds, upstreamRefs, mergeMirror, mergeArchiveInto, collisionId,
};
