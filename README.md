# Mod Command X

A Star Wars themed mod manager and launcher for **STAR WARS: Zero Company**, built as an
Electron app with a holo-terminal aesthetic.

**Mod Command X is a private side-project build** forked from the upstream Zero Company Mod Command 1.9.14. It is
distributed **only** through the releases of
[github.com/EnvianMods/ModCommandX](https://github.com/EnvianMods/ModCommandX/releases) —
never on Nexus Mods — and differs from the upstream app in two ways:

- **Its own identity, side by side.** X installs next to the upstream app and shares
  nothing with it: its own app data (`%APPDATA%\ModCommandX`), its own Electron profile
  (`%APPDATA%\Mod Command X` — single-instance lock, embedded-Nexus cookies, caches),
  its own game-side archive (`<game>\ModCommandXArchive`), its own Nexus
  identification (`Application-Name: Mod Command X`) and its own update check (the
  GitHub releases above). It never migrates, imports or deletes the upstream app's data
  or archive on its own — use Import existing → "Import from a manager folder…" if you
  want to copy mods over deliberately.
- **Nexus access by personal API key.** X authenticates with your own Nexus Mods API
  key (Settings → Nexus Mods) instead of the upstream app's OAuth sign-in.

> **Do not run both apps against the same game install at the same time.** Both deploy
> into the same game mod folders (`~mods`, `LogicMods`, `ue4ss\Mods`, UE4SS
> `mods.txt`), so each would see the other's files as unmanaged and undo the other's
> load order. One game install, one active manager — switch by disabling all mods in
> one before enabling them in the other. That is not supported beyond this note.

## Run it

Double-click **`Mod Command X.bat`**, or from this folder:

```
npm start
```

First run auto-detects the game through Steam (library folders + `appmanifest_2075800.acf`).
A copy of [retoc](https://github.com/trumank/retoc) (0.1.5) ships in `tools/` and is used
automatically for IoStore package inspection; a different copy can be selected in Settings.

## Features

- **Command Deck** — game detection (path, Steam build ID), mod/conflict counts,
  UE4SS / retoc / 7-Zip status, quick actions, Steam launch (`steam://run/2075800`).
- **Hangar Bay** — install mods from `.zip` (native), `.7z`/`.rar` (7-Zip, bundled on Windows), loose
  `.pak`/`.utoc`/`.ucas` files (same-name siblings are picked up automatically), or
  extracted folders. Drag & drop anywhere in the window. Enable/disable, rename, uninstall.
- **Mod types** (auto-classified):
  - `pak` / `iostore` → deployed to `SWZeroCompany/Content/Paks/~mods` with
    `pakchunk99-P###_Name` priority naming (matched basenames across pak/utoc/ucas).
  - Content mods built with the **Zero Company Mod SDK** ship two sidecars beside
    the pak trio (`<Mod>.AssetRegistry.bin` + `<Mod>.zcsdk.lua`); they deploy to
    `~mods` too, keeping their exact names, and the row gets a ◆ SDK chip. They
    need the **ZCSDK Runtime** (see below) or the game can't discover the content.
  - `gfp` (PLUGIN) — **Game Feature plugin** mods: a folder holding
    `<Mod>.uplugin`, `AssetRegistry.bin` at its root and `Content/Paks/<Mod>_P.pak`
    (+ `.utoc`/`.ucas`), optionally `Config/Tags/GameplayTags.ini`. The whole
    folder is installed, unrenamed, as `SWZeroCompany/Mods/<Mod>/` — the name
    comes from the `.uplugin`, never from the display name, so renaming the mod
    here never moves the folder. The game's own loader mounts every folder in
    `SWZeroCompany/Mods` at startup and appends its `AssetRegistry.bin` itself,
    so these mods need no runtime, no load-order prefix and no `~mods` (putting
    their paks in `~mods` mounts the content but hides everything the mod ADDS).
    Disabling removes the folder, which is exactly how the game "forgets" the
    mod — unequip its gear in game and save first, because saves record modded
    gear by file location. Plugin folders you copied in by hand are found by the
    existing-mods scan (Hangar Bay → **Import**) and adopted in place. The
    display name comes from `modinfo.json` `title`, else the `.uplugin`'s
    `FriendlyName`; version/author fall back to `VersionName`/`CreatedBy`.
  - `logicmods` → `SWZeroCompany/Content/Paks/LogicMods`.
  - UE4SS Lua/DLL mods (folders with `Scripts/main.lua` or `dlls/main.dll`) →
    `SWZeroCompany/Binaries/Win64/ue4ss/Mods/<Name>` with `enabled.txt`. The
    display name defaults to the folder name; a `modinfo.json` in the mod folder
    can override it with a friendly title (see **Mod metadata** below). A mod's
    own `paks/` folder travels with it into `ue4ss/Mods/<Name>/paks/`, unrenamed
    — the mod mounts those containers itself at startup, so they are never moved
    into `~mods`.
  - UE4SS runtime archives (dwmapi.dll + ue4ss folder) → installed into `Binaries/Win64`.
  - `gamefolder` (GAMEFILES) — archives laid out against the game root
    (`SWZeroCompany/...`, `Engine/...`, e.g. replacement movies) deploy over the
    game's own files. The original of every replaced file is backed up to
    `data/backups/gamefiles/<id>/` first and restored on disable/uninstall.
- **Multi-mod archives** — an archive holding several mods installs each as its
  own entry (separate enable/order/update/remove): UE4SS mod folders split per
  folder, Game Feature plugin folders split per `.uplugin` (their inner
  `Content/Paks` stays with them), pak containers split by containing folder
  (multiple paks in ONE folder stay one mod), LogicMods subfolders keep their
  deployment, and each
  entry reads its own `modinfo.json`. Nexus/GitHub origin tracking covers every
  entry; updating one replaces all siblings from a fresh download, preserving
  enabled state and priorities by name.
- **Guided installers (FOMOD)** — an archive shipping `fomod/ModuleConfig.xml`
  installs by answering the author's own steps: option groups with descriptions,
  images and recommended answers, flags/conditional steps, and a Back button.
  Scripts are read, never executed; every source/destination path is re-validated
  in the main process (no traversal, no absolute paths). Titles/versions come from
  `fomod/info.xml`. Conditions on other game plugins or tool versions don't exist
  for Zero Company — they're surfaced as a warning and treated as unmet.
- **Load Order** — drag to reorder pak/IoStore mods; applying renumbers the deployed
  `P###` prefixes (later = wins conflicts). **Suggest order** proposes an ordering
  (broad mods first, targeted patches later so the focused mod wins) and lists which
  confirmed conflicts the ordering decides. **Review & apply** previews every
  conflict pair and which winners change before anything moves; **Undo last apply**
  rolls back to the pre-apply order (press again to redo). On startup, enabled mods
  whose deployed files went missing are redeployed automatically from the library.
- **SHA-256 ownership** — every installed and deployed file's hash is recorded.
  Disable/uninstall/reorder verify the deployed files first: a file changed outside
  the manager stops the operation and asks before anything is deleted. Archive
  extraction rejects path traversal and strips symlinks.
- **UE4SS start order** — a second panel in Load Order for enabled UE4SS mods.
  Applying writes ONE managed block into `ue4ss/Mods/mods.txt`, placed just
  before the runtime's `Keybinds` entry with its "do not move up" warning kept
  attached; runtime entries, comments and hand-added mods are preserved, a
  hand-placed managed entry moves into the block, and `enabled.txt` markers are
  retired once the block is authoritative. Rows carry DLL PASS / LUA PASS tags —
  UE4SS starts every DLL mod during runtime init and Lua mods once scripting
  exists, so order applies within each pass.
- **Game-build warnings** — each install/adoption records the game build it
  happened under (Steam manifest buildid, or an exe fingerprint for EA/manual
  installs). After a game update, affected mods show a "game updated" chip and
  a Diagnostics warning; clicking the chip marks the mod verified on the
  current build.
- **EA App support** — the EA-launcher edition is detected (registry + EA Games
  folder scan + `__Installer` signature) and mods deploy identically for EA
  players; Launch starts the exe directly for EA installs. Per-mod EA
  compatibility comes from the mod's `modinfo.json` (`"eaCompatible": false`
  or `"launchers": ["steam"]`) and an owner-curated live list (`ea-compat.json`
  in the remote-config repo, edited with `update-ea-compat.js`); EA users get a
  red chip + enable-time confirm, Steam users an FYI chip, and Diagnostics
  reports both directions.
- **Linux / Proton / Steam Deck** — Steam library discovery covers native,
  classic and flatpak Linux locations; Proton compat prefixes are detected and
  Diagnostics carries the `WINEDLLOVERRIDES="dwmapi=n,b" %command%` guidance
  UE4SS needs (never applied automatically). nxm:// registers via a .desktop
  entry + xdg-mime; 7-Zip is found via p7zip. The AppImage is built by the
  `build-linux.yml` GitHub workflow (Windows can't cross-build it — the
  AppImage tooling needs symlinks).
- **Compatibility matrix** — Diagnostics shows an N×N grid of enabled mods:
  ✔ compatible, ▲ suspected overlap, ✖ confirmed asset overlap (hover for details).
- **UE4SS hook scan** — statically scans the Lua scripts of every *active* UE4SS mod
  (manager-installed and unmanaged folders in `ue4ss/Mods`, built-ins excluded) for
  `RegisterHook`/`RegisterCustomEvent` targets and `RegisterKeyBind` keys. Two mods
  hooking the same UFunction or binding the same key (modifiers respected, comments
  ignored) are reported in Diagnostics' UE4SS Hook Report; managed pairs also surface
  in the pairwise conflict report and matrix. Hook callbacks stack in UE4SS load
  order, so the report explains rather than picks a "winner".
- **Squad profiles** — save the current enabled set + load order under a name
  (Hangar Bay profile bar), then apply/delete. Profiles pin each mod's version;
  applying swaps pinned versions back in from the version vault. Mods installed
  after a profile was saved are appended last with a warning; missing mods are
  skipped. Enable all / Disable all buttons cover the whole hangar.
- **Version vault** — every mod update archives the outgoing version under
  `data/versions/<modType-name>/` (newest 5 kept). The ⧗ button on a Hangar row
  lists archived versions; rolling back archives the current version first, so
  roll-forward works too. Identity is modType+name, so renames start fresh
  history.
- **Game update freeze** — opt-in Settings toggle (Steam installs only): sets
  `AutoUpdateBehavior "1"` in the appmanifest, locks the manifest read-only,
  and (since 1.9.6) leaves LAUNCH GAME as a real Steam launch — DIRECT LAUNCH is the no-update path. Re-asserted
  at startup, reported in Diagnostics, fully reversible. EA App has no per-game
  mechanism — users are pointed at the EA App's global auto-update setting.
  While frozen, play with the slimmer DIRECT LAUNCH button (local exe, started with
  Steam's app-id environment so the game does not relaunch itself through Steam — no
  update check). LAUNCH GAME always goes through Steam; it and Steam's own Play button
  fail with "Disk write error – appmanifest_2075800.acf" whenever an update is pending —
  that is the freeze working, and turning it off lets Steam update.
- **Installed badges in Holonet/GitHub** — cards for mods already in the hangar
  show a green IN HANGAR tag; the Install button becomes ✓ Installed, or
  ⬆ Update when one is waiting.
- **Featured transmissions** — the Holonet opens with a rotating 3-slot promo strip of
  mods by the featured-creator roster. The roster is owner-controlled, not a user
  setting: the baked-in list lives in `lib/featured.js` (ships with launcher updates),
  and an optional `REMOTE_ROSTER_URL` there can point at an owner-hosted JSON
  (`{"promotedAuthors": [...]}`) that every installed launcher fetches live — edit
  that one file to change the roster for everyone without shipping an update. Slots
  cycle every 6s (pause on hover, off with reduced motion). Roster mods carry an amber
  PROMOTED tag; slots the roster can't fill are backfilled with random top-downloaded
  mods, tagged TOP RATED in cyan and reshuffled each cycle.
- **Config Editor** (opened from a button on the Command Deck) — edit game and mod config files in-app: the UE user
  configs (`%LOCALAPPDATA%\SWZeroCompany\Saved\Config\Windows\` — Engine.ini,
  GameUserSettings.ini, Input.ini, Scalability.ini; missing ones are created on first
  save), UE4SS-settings.ini and mods.txt, config files found anywhere inside a UE4SS
  mod folder (4 levels deep, `dlls\` and `Scripts\` included — .ini/.cfg/.json/.txt/
  .toml/.yml, plus .lua whose name says config such as `config.lua` / `settings.lua`;
  enabled.txt, modinfo.json, README/.md and .log never), plus any file added via
  "Add file…" (right-click a custom entry to remove it).
  INI files get a structured section/key/value view that preserves comments, ordering
  and duplicate keys exactly (only values are editable); Raw view edits the full text.
  The original file is backed up to `.zcbak` on first save.
- **Adult content follows your Nexus account** — there is no "show adult content"
  switch in Mod Command X, by design. With no API key, adult-rated mods are filtered out
  of every listing: browsing, categories, search, the featured strip and the Link
  wizard (a search by name is not a way past it). With a key, the app reads the key
  owner's own Nexus content preference (v2 GraphQL `preferences { adult adultBlurImages }`,
  sent with the `apikey` header — the one behind Nexus's age verification) and follows
  it, blurring adult thumbnails when your account asks for that (hover to reveal). Any
  failure to read it counts as "hidden".
  Adult-rated mods always carry an **18+** chip. Settings → Nexus Mods states what is
  in force and links to your Nexus content-preferences page to change it.
- **◆ Forge — the Mod SDK's workbench, hosted** — point Mod Command X at an installed
  Zero Company Mod SDK (Settings → ◆ SDK; Detect looks beside the install and beside
  the game folder) and the Forge view hosts the SDK's own UI, loaded from the SDK
  folder against its embed contract (`<sdk>/tools/sdk-ui/manifest.json`; the host's
  side is `lib/sdk-link.js`, design in `docs/SDK_LINK.md`). Mod Command X ships no copy
  of the panel, so an SDK update needs no Mod Command X release. With no SDK linked the
  Forge item stays in the rail, dimmed, and opens the "Get the SDK" page (what it is,
  what it needs — including Node.js 22.12+ — one **Get** button, "point at an installed SDK", and a note that the SDK is not open source). That button's
  destination is **not hard-coded**: it comes from the `sdk` block of the shared asset
  repo's `launcher-version.json` (X reads only that block; its own updates come from
  its GitHub releases) — fetched at startup and hourly, cached in `sdkAssetLinks` so it survives offline, and
  labelled from the url's own host (Nexus / GitHub); with nothing ever fetched it shows
  a dim "could not be fetched" line instead of a dead link. Detect also reads the SDK
  workbench's own settings (`%APPDATA%\Zero Company Mod SDK\sdk-ui-settings.json`); once
  linked, the ◆ SDK card's **Paths & dependencies…** button opens the Forge view's Settings,
  where the SDK's Unreal, game, retoc and reflection paths live. The SDK's own update file
  (`sdk-version.json`, URL from its manifest) puts a badge on Forge when a newer SDK is
  published.
  The ◆ SDK card names the installed SDK version with its public name and links the SDK's own
  `docs/CHANGELOG.md` ("What's new in the SDK"). Against SDK 1.0.3 the hosted workbench also brings
  its first-run walkthrough, build stepper, mod-def editor, asset drop zone and Test / Conflicts /
  Publish views, with no change to Mod Command X.
- **Holonet browser** — an in-app Nexus Mods browser for Zero Company: grid of mods
  with thumbnails, author/version/category, download & endorsement counts, live search,
  category filter, and sorting (downloads / endorsements / newest / updated / name),
  with paging. Powered by the Nexus GraphQL v2 API (browsing needs no API key). The
  Install button is one click for every account — see **One-click downloads** below.
- **Nexus Mods integration** — paste your personal Nexus Mods API key in Settings →
  Nexus Mods (**Get my API key ↗** opens https://next.nexusmods.com/settings/api-keys;
  scroll to *Personal API Key*, press *Request an API key* if you have none, copy it)
  and press **Save**. The key is checked against `/v1/users/validate.json` before it
  is stored — that is also where your name and premium status come from, and premium
  decides direct download vs. starting it on the website (One-click downloads, below) — then kept
  encrypted with your OS user credentials (Windows DPAPI via Electron safeStorage;
  plaintext only when the OS store is unavailable). It is never shown to the UI,
  never written to the log or the diagnostics report, only ever sent to
  nexusmods.com as the `apikey` header, and never deleted by the app — only your
  own **Clear** removes it. **Verify** re-checks it. Register the `nxm://` handler and "Mod Manager
  Download" buttons on nexusmods.com install straight into the manager, with
  download progress, auto naming/version from Nexus mod info. Non-premium
  accounts must start downloads from the website button (the nxm link carries the
  required key/expires). Every request to Nexus — v1, GraphQL and the download CDN —
  goes out through one helper (`lib/nexus-http.js`) that identifies the app as
  `Mod Command X` with its version and a `ModCommandX/<version>` User-Agent.
- **One-click downloads** — every Nexus download button is a single click:
  Holonet ⭳ Install and ⬆ Update, the Command Deck's ⬆ Update, ⧗ Versions
  "Install this version", ⊕ Optional files ⭳ Install / Reinstall, and UE4SS
  (Settings card and its ⧗ Versions). **Premium**: the file is downloaded through
  the API and installed with no dialog in between; the button itself shows the
  percentage, and several downloads can run at once (within the shared Nexus
  request limits of `lib/nexus-http.js`). **Free accounts**: Nexus requires the
  download to start on its website, so the click opens the in-app Nexus panel
  straight at *that file's* download page
  (`/{game}/mods/{modId}?tab=files&file_id={fileId}&nmm=1`, the file chosen
  exactly as premium chooses it) and, with Settings → Nexus Mods → **Auto-click
  Nexus download for free accounts** on (the default), presses **Slow download**
  for you as soon as the site enables it. The nxm:// link the site hands back is
  caught in the main process and installed; the panel closes itself. A status
  strip says what is happening. The page stays fully visible (ads included),
  Nexus's wait is never skipped, each button is pressed at most once per page
  load, a bot check / CAPTCHA stops the automation and is left to you, and if
  nothing usable shows up within ~20 s the strip asks you to click "Slow
  download" yourself. Not signed in? Sign in inside the panel — the download
  continues by itself afterwards. It runs only on the file page the one-click
  opened, never on anything else you browse to there. Further free-account
  downloads wait in a queue ("N queued ✕" cancels them) and open one after
  another. Everything that knows what the Nexus page looks like — selectors,
  button texts, countdown and challenge markers — lives in
  `src/nexus-autoclick.js`; that is the one file to update when Nexus changes
  its page. GitHub installs keep their confirmation, because it is the "GitHub
  mods aren't moderated" trust warning.
- **Request allowance, read from Nexus** — Settings → Nexus Mods shows the quota
  Nexus reports on every reply ("API requests: 1,950 of 2,000 this hour (resets
  16:00) · 19,900 of 20,000 today (resets 00:00 UTC)"). When it runs out the app
  stops instead of retrying, with a readable "try again after HH:MM"; it honours
  `Retry-After` on a 429, keeps at most two requests in flight, and background
  work (the hourly update check, the file-name index) leaves a reserve for your
  own clicks and reschedules itself rather than spending it.
- **Optional files** *(experimental — `feat/optional-files`)* — a Nexus page
  usually offers more than its main download: alternative textures, patches,
  hotfixes. Every Nexus-linked row on the Command Deck has an **⊕ Optional
  files** button that lists the mod's OPTIONAL / UPDATE / MISCELLANEOUS files
  (never its MAIN or old versions — the ⧗ picker owns those) with size, date and
  the author's description, marking the ones already installed. Installing one
  keeps it as a *child* of the mod: a full mod record of its own (`parentId` on
  the record, plus `origin.category` and `origin.fileName`), so it has its own
  files, load-order slot, conflict detection, version vault and update line —
  but it is shown nested under the mod behind a "▸ N optional files" caret
  instead of as a mod of its own, with its own enable/disable switch and remove
  button. Updating the mod's main file leaves the optional files alone (and vice
  versa: an optional file only ever follows the site's own update chain, never
  the newest main file). Turning the mod off turns its optional files off,
  turning it back on leaves them as they were, and uninstalling the mod removes
  them with it. Free accounts get the same one click through the embedded
  Nexus panel, opened at that optional file's own download page — what comes
  back lands under the mod row the button was pressed on.
- **Grouping mods you installed yourself** *(experimental — `feat/optional-files`)*
  — nothing about that nesting needs Nexus. The **⊕ Optional files** button is on
  every mod, linked or not, with an API key or not, and its second section, **ALREADY
  INSTALLED**, lists the other installed mods that can be grouped under this one:
  press **⇲ Group under &lt;mod&gt;** and the row moves into the mod's nested list
  straight away. A mod grouped this way is marked `grouping:"manual"` (downloads
  from a mod page are `"nexus"`, as are records written before the field existed)
  and is indistinguishable on the deck — same OPTIONAL chip, same indent, same
  switch, same cascade rules: off when the mod is off, uninstalled when the mod
  is uninstalled. The one difference is how it leaves: a hand-grouped mod has a
  **⇱ Ungroup** button that returns it to a row of its own, keeping its on/off
  state, while a downloaded optional file keeps ✕ remove as its only exit (so a
  later re-download cannot land beside it as a duplicate). Eligible mods exclude
  anything already grouped, anything that already has optional files (nesting is
  one level deep), and another MAIN file from the *same* Nexus page — that is a
  version of the mod, which the ⧗ picker owns. New IPC: `groupable-mods`,
  `group-optional`, `ungroup-optional`; engine: `attachChild` / `detachChild`.
- **UE4SS one-click install** — Settings → UE4SS → Download & install fetches
  **the Zero Company package**: Nexus mod 9 "UE4SS for Star Wars Zero Company"
  (stock UE4SS plus this game's signatures, loader settings and helpers; its page
  states the game build it was tested on). That is the default for every one-click
  path — the Settings card, the ZCSDK-runtime prompt and `install-ue4ss` with no
  payload. Premium accounts download it directly; free accounts get the embedded
  Nexus panel at that file's download page (the one-click flow above), whose
  nxm:// comes back into `handleNxm`, which recognises the runtime; users without an API key are offered adding one or, on
  confirmation, the stock upstream build. The page is read anonymously via
  GraphQL (`refreshNexusLatest()`), and the tested build is recorded with the
  install (`settings.ue4ssInstalled.testedBuild`) and compared with the installed
  game's build id in the card and in Diagnostics ("matches yours" / "yours is N").
  The **stock upstream build** from GitHub (UE4SS-RE/RE-UE4SS) stays available as
  a fallback — `{ source:'github' }` or `{ tag }` from ⧗ Versions, and
  automatically, with a warning toast, when the Nexus page cannot be read. It has
  no Zero Company signatures and is labelled that way everywhere. Every runtime
  install snapshots the build it replaces (dwmapi.dll + ue4ss\* minus Mods/logs)
  into `versions/ue4ss-runtime/` (5 kept); ⧗ Versions restores any kept build (the
  current one is kept first) and lists both sources — Nexus marked *recommended*,
  the GitHub section carrying the stock-build warning (only the rolling
  experimental builds use the ue4ss\ layout this manager deploys — stable 3.0.x
  zips are flat and shown as not installable). Because the experimental channel is
  rolling (same tag, new zip every CI build), a GitHub install's recorded build id
  (from the zip name, e.g. `g2bfa839f`) is compared with the current asset at
  startup / in the update check; a Nexus install compares file ids. Update
  detection follows the installed source (`settings.ue4ssInstalled.source`), with
  "Update to …" on the card and a once-per-build toast.
- **retoc update check** — Settings → retoc compares the installed
  `retoc --version` with the newest GitHub release (trumank/retoc, Windows zip
  asset) and installs it into `<dataDir>/tools/retoc.exe` (+ the bundled Oodle
  dll), which `retocPath()` prefers over the copy bundled in `tools/`
  (`settings.retocInstalled`). Reported at startup, in the update check and in
  Diagnostics.
- **ZCSDK Runtime one-click install** — Settings → ZCSDK Runtime installs the two
  UE4SS mods (ZCSDKBridge + ZCSDKLoader) that SDK-built content mods need. The SDK
  publishes every runtime build to `github.com/EnvianMods/ZCSDK-Runtime-Release`
  (a Release zip + `latest.json` at the repo root); Mod Command X reads `latest.json`
  at startup (and on "Check for updates"), downloads the newest release, and offers
  "Update to x" when the installed copy is behind — no Mod Command X release needed
  for a runtime update. `tools/ZCSDKRuntime.zip` (+ `tools/zcsdk-runtime.json`)
  stays bundled as the offline fallback. Existing copies are vaulted and replaced
  by name; installing an SDK-built mod without a working runtime offers the install
  immediately, and UE4SS is fetched first when it is missing.
- **Incompatibility check** — pairwise conflict detection between enabled mods:
  **CONFIRMED** pairs modify the same game assets (asset paths extracted from each mod's
  `.utoc` via `retoc list --path`); **SUSPECTED** pairs ship identically named files.
  Each conflicting mod shows a clickable "⚠ N conflicts" chip in the Hangar Bay that
  expands to the opposing mod, the overlapping asset paths, and which mod wins (loads
  later). The full report also appears in Diagnostics, which additionally rescans any
  IoStore mods installed while retoc was unavailable.
- **Support reports** — Diagnostics → Copy support report / Save report…:
  a single sanitized text block (game/launcher/build, tools, full mod list
  with origins and priorities, conflicts, hook collisions, duplicates, health
  scan, session log). Paths, usernames and machine names are scrubbed by
  `lib/report.js`; the in-memory session log lives in `lib/log.js`.
- **Diagnostics** — installation health scan: game layout, Steam manifest/build,
  `~mods` presence, the `SWZeroCompany/Mods` plugin folder (how many plugin folders
  are there and how many Mod Command X manages, so hand-copied ones are visible),
  UE4SS layout, retoc/7-Zip availability, deployed-file audit, conflicts.
  Also flags **duplicate mods** — the same UE4SS mod active under two folders in
  `ue4ss/Mods` (e.g. a manager install plus a leftover from a manual/one-click
  install under a different name). Two active copies run at once (double
  hooks/loops) and cause frame stutter; folders are matched by `modinfo.json`
  title or identical entry script, so a copy with a manifest and one without
  still pair up. The report names each folder and whether it's managed.
- **Settings** — game/retoc/7z paths, close-on-launch, reduced motion.

## Mod metadata (`modinfo.json`)

A UE4SS Lua/DLL mod can ship an optional `modinfo.json` in its mod folder (next
to `Scripts/` or `dlls/`) to control how it appears in the manager:

```json
{
  "title": "Envian's Movement Patch"
}
```

- `title` — the display name shown in the Hangar Bay (1–120 chars; spaces and
  punctuation are fine). Without it, the mod falls back to its folder name run
  through the filesystem sanitizer (so `My Cool Mod` would show as `My_Cool_Mod`).
- The **deployed folder** on disk is always the sanitized name regardless of
  `title`, so the on-disk layout stays filesystem-safe. `title` is display-only.
- The convention is opt-in: mods without a `modinfo.json` behave exactly as before.
- Read at install/import time (`classifyFolder` in `lib/mods.js`); a malformed
  manifest is ignored and the folder name is used.

Only `title` is consumed today; unknown keys are ignored, so the file is a safe
place to stash other metadata (author, version, notes) for future use.

## Layout

```
main.js            Electron main process (IPC, dialogs, launch, diagnostics)
preload.js         contextBridge API (window.zc)
lib/steam.js       Steam library scan + appmanifest parsing (AppID 2075800)
lib/store.js       portable JSON store  → data/manager-data.json
lib/mods.js        mod engine: classify/install/deploy/order/conflicts/UE4SS
lib/archive.js     zip (bsdtar / extract-zip) + 7z/rar (7-Zip CLI — tools/7-Zip on Windows, system copy on Linux)
src/               UI (index.html / styles.css / app.js) — holo-terminal theme
src/nexus-autoclick.js  free-account one-click: every Nexus download-page selector + the in-page auto-click
data/              settings when running from source (shipped builds use %APPDATA%\ModCommandX)
```

Mods keep their canonical files in the **mod archive** — by default
`<game>\ModCommandXArchive\` (library/ + backups/ + versions/ + a mirrored
manifest), so mods survive app updates and deletions; Settings → Paths can move
it anywhere (copy-verify-delete migration) or reset it. The upstream app's
`ModCommandArchive` / `ZeroCompanyModArchive` folders beside it are never read,
renamed, merged or deleted automatically.
Enabling copies files into the game, disabling removes them, uninstalling
deletes the library copy. A fresh install that finds an archive restores
everything from it automatically (only X's own archive), and a one-time scan after the first game
connection offers any unmanaged/orphaned/other-manager mods for adoption (also
on demand: Import existing → "Import from a manager folder…"). The settings
file itself lives in the per-user app-data folder —
`%APPDATA%\ModCommandX` on Windows — never beside the exe
(`data/manager-data.json` when running from source).

Installs are **version-aware**: a mod whose `modinfo.json` names the same
title (and author) as an installed mod joins that mod's line instead of
becoming a new entry. A newer version replaces the install and vaults the old
one; an older version is vaulted as an alternate without touching the install;
the same version is a reinstall. The ⧗ versions button then offers every
archived version for rollback or testing.

## Releases

```
npm run dist
```

produces `release/ModCommandX.exe` — a single portable executable. When run, it keeps
its settings in `%APPDATA%\ModCommandX` and the mod archive in the game folder under
`ModCommandXArchive` — nothing is written beside the exe (the dev `data/` folder is
separate). Nothing from the upstream app is migrated.
The `nxm://` registration from a portable exe points at the exe's on-disk location, so
keep it somewhere permanent. Only one app can own `nxm://` at a time: registering it in
X takes it from the upstream app, and vice versa.
On every launch the portable stub unpacks the app into `%TEMP%\ModCommandX` (a fixed
name, set by `build.portable.unpackDirName`, wiped and re-extracted each run and deleted
again on exit) and runs it from there — so a user whose antivirus quarantines a runtime
file such as `ffmpeg.dll` has one stable path to add to their exclusions, and the app
names that folder in an error dialog if part of the runtime is missing when it starts.

Shipping structure:
- version lives in `package.json` (X restarted at 1.0.0; `modCommandCompat` records the
  upstream feature level, 1.9.14, which SDK manifests' `minModCommand` is checked
  against); per-version notes in `CHANGELOG.md`
- the release asset is `ModCommandX-v<version>.zip`, containing `ModCommandX.exe` +
  `README.txt` + `CHANGELOG.md` (the exe filename stays constant across versions so
  nxm:// registrations survive updates)

## Releasing

Mod Command X is published **only** as GitHub releases of
`github.com/EnvianMods/ModCommandX` — never on Nexus Mods, and never to any of the
upstream project's repos or files. The local repo has no remote by default.

1. Bump `version` in package.json and `RELEASE_VERSION.txt`, add a CHANGELOG entry, commit.
2. `npm run dist`, zip exe + README.txt + CHANGELOG.md as `ModCommandX-v<version>.zip`;
   optionally `node owner-tools/update-featured-authors/package-source-release.js` for a
   binary-free `ModCommandX-Source-v<version>.zip`.
3. `"Publish Release.bat" <version> <path-to-zip>` — creates tag/release `v<version>`
   on EnvianMods/ModCommandX and uploads the zip. That **is** the announcement:
   installed copies check `/releases/latest` hourly and show their update banner,
   linking to that release page. (A missing or private repo is simply no banner.)
4. Optionally `"Archive Release.bat" <version> <build-zip> <source-zip> --notes "..."`
   — pushes the version archive to github.com/EnvianMods/ModCommandXArchive.

The remaining owner tools (`publish-release.js`, `archive-release.js`,
`push-handoff.js`) refuse the upstream targets (`EnvianMods/ZeroCompanyModCommand`,
`…Archive`, `SWZeroCompanyFeaturedAuthors`) even when passed with `--repo`. The
upstream tools that publish shared files (featured authors, GitHub allowlist, EA
compat, launcher version) and upload to Nexus are not part of X.

- **HANDOFF.md is never published.** Internal working notes are untracked (listed in
  `.gitignore`); `push-handoff.js` / `"Push Handoff.bat"` keeps a copy in the private
  archive repo at `docs/HANDOFF.md`. As a backstop, `publish-release.js` lists each
  .zip before uploading it and refuses any zip with an entry matching `/HANDOFF/i`
  (`node publish-release.js --check-only <zip>` runs that check alone).

## Third-party components in the shipped build

The packaged app contains this repository's code (`main.js`, `preload.js`,
`lib/`, `src/`, `package.json`) inside `resources/app.asar`, plus the npm
dependency `extract-zip` declared in `package.json`. Beside the bundle,
`resources/tools/` holds binaries that are **not** in this repository: they are
downloaded unmodified from their official sources by `build/fetch-tools.js` at
build time (the CI workflow and `npm run build` both run it):

| Component | Version | Source | Purpose |
|---|---|---|---|
| 7-Zip command-line build (`7z.exe`, `7z.dll`) | 25.01 x64 | https://www.7-zip.org (official MSI, unpacked) | `.7z`/`.rar` extraction; `tools/7-Zip/BUNDLED.txt` + `License.txt` record it |
| retoc (`retoc.exe` + the `oo2core_9_win64.dll` it ships with) | 0.1.5 | https://github.com/trumank/retoc release asset | IoStore container listing for conflict detection |
| ZCSDK Runtime (`ZCSDKRuntime.zip`, `zcsdk-runtime.json`) | per `latest.json` | https://github.com/EnvianMods/ZCSDK-Runtime-Release | offline copy of the UE4SS-based runtime for SDK content mods |
| `elevate.exe` | — | electron-builder's portable stub | added by the packager, not by this project |

To verify a shipped build against the source: unzip the release, run
`npx @electron/asar extract resources/app.asar out` on the unpacked app and
diff `out/` against the tagged commit; everything outside `node_modules/`
should match, and `resources/tools/` should contain only the items above.
The packaged `README.txt` comes from `build/README.txt` in this repository.

## Shared, read-only rosters

X reads the same community files the upstream app does, and never writes them:
`featured.json` (Featured Transmissions), `github-mods.json` (the curated GitHub tab),
`ea-compat.json` and the `sdk` block of `launcher-version.json` from
`EnvianMods/SWZeroCompanyFeaturedAuthors`, and the ZCSDK Runtime's `latest.json`.

## Ideas for later

- Conflict-aware profile switching (warn when a profile enables a confirmed-conflicting pair)
- Linux/Proton/Steam Deck support (Electron builds cross-platform, but deploy paths,
  nxm registration, and 7-Zip/tar handling are Windows-specific today)
