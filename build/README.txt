MOD COMMAND X v1.0.0
A private side-by-side build of Zero Company Mod Command
for STAR WARS: Zero Company

Mod Command X is distributed only through the releases of
https://github.com/EnvianMods/ModCommandX (never on Nexus Mods). It installs
next to the regular Zero Company Mod Command and shares nothing with it: its
own settings, its own mod archive, its own Nexus identity and its own update
check. Do not run both against the same game install at the same time - they
deploy into the same game mod folders.

QUICK START
-----------
1. Put ModCommandX.exe anywhere you like (somewhere permanent is best) and run
   it. Windows SmartScreen may warn because the exe is unsigned: click
   "More info" -> "Run anyway".
2. The game is found automatically through Steam. If not, set the game folder
   in Settings.
3. Optional but recommended: in Settings -> Nexus Mods, press "Get my API key".
   On the Nexus page (log in if asked) scroll to "Personal API Key", press
   "Request an API key" if you don't have one yet, copy it, paste it into the
   field and press Save. The key is checked with Nexus first, then stored
   encrypted with your Windows account and only ever sent to nexusmods.com.
   Then press "Register handler". After that, the "Mod Manager Download"
   buttons on nexusmods.com install mods straight into Mod Command X. (Only one
   app can own those buttons at a time: registering here takes them from the
   regular Mod Command, and vice versa.)
4. Browse mods in the Holonet tab, or drag & drop mod archives onto the window.

Mod Command X keeps its settings in %APPDATA%\ModCommandX and your mod archive
(library, backups, archived versions) in the game folder under
"ModCommandArchive" - the same archive the regular Mod Command uses, so each mod
is stored once. Don't run both apps at the same time, and note that removing a
mod in Mod Command removes its stored copy for Mod Command X too. Nothing is
written next to the exe, so you can move or replace the exe freely. Reinstalling a mod at another version joins the same
entry: use its "versions" button to roll back or try an archived version.

NOTES
-----
- The Holonet has two tabs: Nexus Mods, and GitHub - GitHub mods curated
  by Envian Mods. Installed mods are checked for updates automatically.
- The Forge tab in the side rail hosts the Zero Company Mod SDK (a separate
  download for making mods) once you point Mod Command X at it in
  Settings -> SDK. Without the SDK it explains what it is and where to get it.
- Adult-rated content follows your Nexus Mods account preference (read with
  your API key); there is no separate switch in the app.
- .zip, .7z and .rar archives all work out of the box (7-Zip ships with the app).
- UE4SS (needed for Lua/DLL mods) installs with one click in Settings, using
  the "UE4SS for Star Wars Zero Company" package from Nexus Mods - never the
  stock GitHub build. A stock or unknown UE4SS already in the game is spotted
  and switched with one click (your UE4SS mods, mods.txt and settings are
  kept), and a newer file on Nexus is installed automatically while the game
  is closed (Settings -> UE4SS, "Keep UE4SS up to date automatically").
- Diagnostics shows conflicts between your mods, including which game assets
  overlap and which mod wins.

THIRD-PARTY COMPONENTS SHIPPED WITH THE APP
--------------------------------------------
Everything below is downloaded unmodified from its official source by the
build script (build/fetch-tools.js in the source repository) and placed in the
app's resources\tools folder. None of it is part of the app's own source code.
- 7-Zip 25.01 (x64) command-line build (7z.exe, 7z.dll) from
  https://www.7-zip.org - archive extraction. License: LGPL + unRAR restriction
  (see tools\7-Zip\License.txt).
- retoc 0.1.5 (retoc.exe, with the oo2core_9_win64.dll it ships with) from
  https://github.com/trumank/retoc - reads IoStore containers for conflict
  detection.
- ZCSDK Runtime (ZCSDKRuntime.zip, offline copy) from
  https://github.com/EnvianMods/ZCSDK-Runtime-Release - the UE4SS-based runtime
  that Zero Company Mod SDK content mods need; the app installs the newest
  release from that repository when online.
- Electron (the application framework) and the npm package extract-zip, both
  declared in package.json.

Source code and releases: https://github.com/EnvianMods/ModCommandX
