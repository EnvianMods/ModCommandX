# Mod Command X

A Star Wars themed mod manager and launcher for **STAR WARS: Zero Company**.

Mod Command X is a side-by-side build of Zero Company Mod Command by Envian Mods. It is
distributed **only** through the [Releases page](https://github.com/EnvianMods/ModCommandX/releases)
of this repository — never on Nexus Mods. This repository holds the downloads and the
changelog; the source code is not public.

## What it does

- Installs mods from `.zip`, `.7z` and `.rar` archives, loose pak files or folders —
  drag and drop onto the window, or use the **Mod Manager Download** buttons on
  nexusmods.com.
- Handles every kind of Zero Company mod: pak / IoStore mods, LogicMods, Game Feature
  plugin folders, UE4SS Lua/DLL mods, ZC Unlocked add-ons, Zero Company Mod SDK content
  mods and game-file replacements.
- Switches mods on and off, keeps older versions to roll back to, checks installed mods
  for updates, and shows conflicts between mods (which game assets overlap and which mod
  wins) in Diagnostics.
- Installs UE4SS with one click (the "UE4SS for Star Wars Zero Company" package from
  Nexus Mods) and keeps it up to date.
- Browse and install mods from Nexus Mods and a curated GitHub list in the Holonet tab.

## Requirements

- STAR WARS: Zero Company (Steam; the game is found automatically).
- Windows 10 or 11 (64-bit). A Linux `ModCommandX.AppImage` is also attached to each release.
- Optional: a free Nexus Mods account and your personal API key, for browsing, downloading
  and update checks.

## Download and install

1. Open the [latest release](https://github.com/EnvianMods/ModCommandX/releases/latest)
   and download **`ModCommandX-v<version>.zip`** (Linux: `ModCommandX.AppImage`).
   Ignore the automatic "Source code" downloads — they only contain this README,
   the licence and the changelog.
2. Unzip it somewhere permanent (for example `Documents\ModCommandX`). The zip holds
   `ModCommandX.exe`, `Uninstall Mod Command X.exe`, `README.txt` and `CHANGELOG.md`.
3. Run **`ModCommandX.exe`**. Nothing is installed. Windows SmartScreen may warn because
   the exe is unsigned: click **More info → Run anyway**.
4. Optional but recommended: in **Settings → Nexus Mods** press **Get my API key**, paste
   your personal API key and press **Save**, then **Register handler** so the
   "Mod Manager Download" buttons on nexusmods.com install straight into Mod Command X.

Linux: make the AppImage executable (`chmod +x ModCommandX.AppImage`) and run it.

Mod Command X keeps its settings in `%APPDATA%\ModCommandX` and nothing next to the exe,
so you can move or replace the exe freely.

### Running it beside the regular Mod Command

Mod Command X installs next to the regular Zero Company Mod Command with its own settings
and Nexus login, and shares one mod archive with it (`<game>\ModCommandArchive`), so each
mod is stored once. **Do not run both at the same time** — they deploy into the same game
mod folders. Removing a mod in Mod Command also removes its stored copy for Mod Command X.
Only one app can own the Nexus "Mod Manager Download" buttons at a time.

## Updating

Mod Command X checks this repository's latest release and shows an **update banner** when a
new version is out. Download the new zip from the release page and replace your old
`ModCommandX.exe` (and the uninstaller) with the new ones. Your mods and settings are kept.

## Uninstalling

Run **`Uninstall Mod Command X.exe`** (next to `ModCommandX.exe`), or use
**Settings → Uninstall Mod Command X…**. It lists everything it will remove and keep, and
asks you to confirm. It removes the app's settings, its browser profile and caches, its
temporary folder, the `nxm://` link handler (only if it points at Mod Command X) and the
Steam update freeze (only if Mod Command X set it), then the exe files. Mods installed in
the game stay and keep working. Your stored mod library is kept unless you tick
**Also delete my stored mod library**. Nothing of the regular Mod Command is touched.
On Linux, Settings shows the uninstall command.

## Getting help

- **Diagnostics → Copy support report** (or **Save report…**) creates one text block with
  your game build, tools, mod list, conflicts and the recent session log. Personal paths,
  user names and keys are masked. Include it when you ask for help.
- Report problems on the [Issues page](https://github.com/EnvianMods/ModCommandX/issues)
  of this repository.

## Credits and licences

Mod Command X is © Envian Mods, released under the MIT License (see [LICENSE](LICENSE)).
It is based on Zero Company Mod Command by the same author.

The app ships these third-party components, unmodified, with their own licences (the full
texts are in `resources\tools\licenses` inside the app):

| Component | Source | Licence |
|---|---|---|
| 7-Zip 25.01 (`7z.exe`, `7z.dll`) | https://www.7-zip.org | GNU LGPL + unRAR restriction, BSD parts |
| retoc 0.1.5 (`retoc.exe`) | https://github.com/trumank/retoc | MIT |
| ZCSDK Runtime (offline copy) | https://github.com/EnvianMods/ZCSDK-Runtime-Release | by the author of Zero Company Mod Command |
| Electron, extract-zip | https://www.electronjs.org, npm | MIT |

The Oodle compression library is not bundled. STAR WARS: Zero Company and Star Wars are
trademarks of their respective owners; Mod Command X is a fan-made tool and is not
affiliated with or endorsed by them.

## Changes

See [CHANGELOG.md](CHANGELOG.md) for what changed in each version.
