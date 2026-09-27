'use strict';
// Mod-archive location handling. The archive (library/backups/versions plus a
// mirrored manifest) lives in the GAME folder by default so mods survive app
// updates and deletions; settings.storageDir overrides with a custom path.

const fs = require('fs');
const path = require('path');

// Mod Command X's OWN archive folder. The upstream Mod Command uses
// ModCommandArchive (and, pre-1.9.0, ZeroCompanyModArchive) in the same game
// folder; X never reads, renames, merges or deletes those automatically.
const ARCHIVE_DIR_NAME = 'ModCommandXArchive';

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

// (The upstream app's pre-1.9.0 app-data migration is intentionally absent:
// X starts from its own empty data folder and never adopts another app's.)

module.exports = { ARCHIVE_DIR_NAME, resolveStorageRoot, migrateStorage, countFilesRec };
