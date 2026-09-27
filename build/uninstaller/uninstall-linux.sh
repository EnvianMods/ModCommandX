#!/bin/sh
# Uninstall Mod Command X — Linux / Steam Deck (AppImage builds).
# The Windows release uses "Uninstall Mod Command X.exe" (Uninstaller.cs);
# this is its conservative Linux counterpart. Settings -> "Uninstall Mod
# Command X…" copies it to /tmp and shows the command to run.
#
# Removes:  ~/.config/ModCommandX (settings, staging, caches — the library
#           sub-folders stay unless --delete-library), ~/.config/Mod Command X
#           (Electron profile, Nexus cookies), the nxm:// handler
#           ~/.local/share/applications/mod-command-x.desktop + its xdg default
#           (only when they are Mod Command X's), the Steam update freeze
#           (undone exactly like Settings -> freeze off), and the AppImage when
#           passed with --appimage.
# Keeps:    every mod installed in the game, UE4SS, mods.txt, *.zcbak, and all
#           of the main Zero Company Mod Command. <game>/ModCommandXArchive is
#           kept unless --delete-library (or it is empty). A mod archive SHARED
#           with the main Mod Command (<game>/ModCommandArchive) is never
#           touched from here — remove X-only entries with the main app.
#
# Usage: sh uninstall-linux.sh [--dry-run] [--yes] [--delete-library]
#                              [--appimage PATH] [--game PATH]
# Honours HOME / XDG_CONFIG_HOME / XDG_DATA_HOME (sandbox tests set them).
set -u

DRY=0; YES=0; DELLIB=0; APPIMAGE_PATH=""; GAME=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --yes) YES=1 ;;
    --delete-library) DELLIB=1 ;;
    --appimage) shift; APPIMAGE_PATH="${1:-}" ;;
    --game) shift; GAME="${1:-}" ;;
    *) echo "unknown option: $1" >&2; exit 64 ;;
  esac
  shift
done

CONF="${XDG_CONFIG_HOME:-$HOME/.config}"
APPS="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
DATA="$CONF/ModCommandX"
PROFILE="$CONF/Mod Command X"
UPSTREAM_DATA="$CONF/ZeroCompanyModCommand"
DESKTOP="$APPS/mod-command-x.desktop"
LOG="${TMPDIR:-/tmp}/ModCommandX-uninstall.log"

log() { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$(printf '%s' "$1" | sed "s#$HOME#~#g")" >> "$LOG" 2>/dev/null; }
json_str() { # json_str FILE KEY -> first string value of "KEY" (settings are flat enough)
  [ -f "$1" ] && sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p" "$1" | head -n 1
}
json_true() { [ -f "$1" ] && grep -Eq "\"$2\"[[:space:]]*:[[:space:]]*true" "$1"; }
size() { du -sh "$1" 2>/dev/null | cut -f1; }

# Guard every delete: must be one of the X-owned roots or directly inside one.
safe_rm() {
  target="$1"; root="$2"
  case "$target" in ""|"/"|"$HOME"|"$HOME/"|"$CONF"|"$CONF/") log "REFUSED $target"; echo "  refused: $target"; return ;; esac
  case "$target" in "$root"|"$root"/*) ;; *) log "REFUSED $target (outside $root)"; echo "  refused: $target"; return ;; esac
  if [ -L "$target" ]; then rm -f "$target"; else rm -rf "$target"; fi
  if [ -e "$target" ] || [ -L "$target" ]; then echo "  could not remove (in use?): $target"; log "FAILED $target"
  else echo "  removed: $target"; log "REMOVED $target"; fi
}

[ -n "$GAME" ] || GAME="$(json_str "$DATA/manager-data.json" gamePath)"
GAME_OK=0
if [ -n "$GAME" ] && [ "$GAME" != "/" ] && [ -f "$GAME/SWZeroCompany/Binaries/Win64/SWZeroCompany.exe" ]; then GAME_OK=1; fi

REMOVE=""; KEEP=""
add_rm() { REMOVE="$REMOVE
$1|$2"; }
add_keep() { KEEP="$KEEP
$1"; }

# --- app data (library sub-folders kept unless --delete-library)
if [ -d "$DATA" ]; then
  libcontent=0
  for s in library backups versions; do
    [ -d "$DATA/$s" ] && [ -n "$(find "$DATA/$s" -type f 2>/dev/null | head -n 1)" ] && libcontent=1
  done
  if [ $libcontent = 0 ] || [ $DELLIB = 1 ]; then add_rm "$DATA" "$DATA"
  else
    for e in "$DATA"/* "$DATA"/.[!.]*; do
      [ -e "$e" ] || continue
      case "$(basename "$e")" in library|backups|versions) add_keep "$e (your mod library)";; manager-data.json) [ $GAME_OK = 1 ] && add_rm "$e" "$DATA" || add_keep "$e (mod list for the library)";; *) add_rm "$e" "$DATA";; esac
    done
  fi
fi
[ -d "$PROFILE" ] && add_rm "$PROFILE" "$PROFILE"
# --- nxm:// handler: only Mod Command X's own .desktop
NXM_OURS=0
if [ -f "$DESKTOP" ] && grep -q '^Name=Mod Command X$' "$DESKTOP"; then add_rm "$DESKTOP" "$APPS"; NXM_OURS=1; fi
DEFAULT_NXM="$(xdg-mime query default x-scheme-handler/nxm 2>/dev/null || true)"
[ -n "$DEFAULT_NXM" ] && [ "$DEFAULT_NXM" != "mod-command-x.desktop" ] && add_keep "nxm:// handler: $DEFAULT_NXM (not Mod Command X, left alone)"
# --- game side
if [ $GAME_OK = 1 ]; then
  XA="$GAME/ModCommandXArchive"
  if [ -d "$XA" ]; then
    if [ -z "$(find "$XA" -type f 2>/dev/null | head -n 1)" ] || [ $DELLIB = 1 ]; then add_rm "$XA" "$XA"
    else add_keep "$XA (Mod Command X's mod archive - a reinstall restores from it)"; fi
  fi
  [ -d "$GAME/ModCommandArchive" ] && add_keep "$GAME/ModCommandArchive (shared with Mod Command - never touched here)"
  add_keep "$GAME (your installed mods, UE4SS, mods.txt, *.zcbak)"
else
  [ -n "$GAME" ] && add_keep "game folder skipped: '$GAME' does not look like the game"
fi
FREEZE=""
if [ $GAME_OK = 1 ] && json_true "$DATA/manager-data.json" updateFreeze; then
  MAN="$(dirname "$(dirname "$GAME")")/appmanifest_2075800.acf"
  if json_true "$UPSTREAM_DATA/manager-data.json" updateFreeze; then add_keep "Steam update freeze (Mod Command also froze the game - turn it off there)"
  elif [ -f "$MAN" ]; then FREEZE="$MAN"; fi
fi
case "$APPIMAGE_PATH" in *ModCommandX*.AppImage|*mod-command-x*.AppImage) [ -f "$APPIMAGE_PATH" ] && add_rm "$APPIMAGE_PATH" "$APPIMAGE_PATH" ;; esac

echo "UNINSTALL MOD COMMAND X"
echo
echo "Will be removed:"
printf '%s\n' "$REMOVE" | while IFS='|' read -r p r; do [ -n "$p" ] && echo "  - $p  [$(size "$p")]"; done
[ -n "$FREEZE" ] && echo "  - Steam update freeze on $FREEZE (the game updates normally again)"
echo
echo "Will be kept:"
printf '%s\n' "$KEEP" | while read -r k; do [ -n "$k" ] && echo "  - $k"; done
echo
[ $DRY = 1 ] && { echo "Dry run - nothing was changed."; exit 0; }

if pgrep -f 'ModCommandX\.AppImage|mod-command-x' >/dev/null 2>&1; then
  echo "Mod Command X is running. Close it first, then run this again."; exit 2
fi
if [ $YES = 0 ]; then
  printf 'Remove the items above? This cannot be undone. [y/N] '
  read -r ans; case "$ans" in y|Y|yes|YES) ;; *) echo "Cancelled."; exit 1 ;; esac
fi

log "uninstall started (library $( [ $DELLIB = 1 ] && echo DELETED || echo kept))"
printf '%s\n' "$REMOVE" | while IFS='|' read -r p r; do [ -n "$p" ] && safe_rm "$p" "$r"; done
if [ -n "$FREEZE" ]; then
  # steam.setUpdateFreeze(gamePath, false): writable manifest, AutoUpdateBehavior "0"
  chmod 644 "$FREEZE"
  if grep -Eq '"AutoUpdateBehavior"[[:space:]]+"[0-9]"' "$FREEZE"; then
    sed -i -E '0,/"AutoUpdateBehavior"[[:space:]]+"[0-9]"/s//"AutoUpdateBehavior"\t\t"0"/' "$FREEZE"
  fi
  echo "  restored: Steam update freeze undone"; log "UNFREEZE $FREEZE"
fi
if [ $NXM_OURS = 1 ] && [ "$DEFAULT_NXM" = "mod-command-x.desktop" ]; then
  for f in "$CONF/mimeapps.list" "${XDG_DATA_HOME:-$HOME/.local/share}/applications/mimeapps.list"; do
    [ -f "$f" ] && sed -i '/^x-scheme-handler\/nxm=mod-command-x\.desktop;*$/d' "$f"
  done
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APPS" >/dev/null 2>&1
  echo "  removed: nxm:// default"; log "REMOVED nxm default"
fi
log "uninstall finished"
echo
echo "Done. Installed mods in the game were not touched. Log: $LOG"
