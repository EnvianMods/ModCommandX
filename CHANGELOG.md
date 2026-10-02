# Mod Command X — Changelog

## Mod Command X 1.0.3 — 2026-10-01

**Fixed: changes could go through while the game was running**
- Mod Command X checks that Star Wars Zero Company is closed before it switches
  mods on or off, removes or updates them, installs or repairs the ZCSDK
  Runtime, switches UE4SS, or renames pak files. On some PCs that check
  took so long that it gave up — and then counted the game as closed, so
  changes were made under a running game.
- The check now looks at whether the game's own files are in use, which takes
  a few milliseconds, and only asks Windows for the running programs when that
  can't tell.
- If it still can't be sure, nothing is changed: you see "Couldn't confirm Star
  Wars Zero Company is closed — close it and try again" with a **Check again**
  button, which repeats what you were doing once the game is confirmed closed.
  Automatic repairs at startup wait instead.

**Fixed: renaming a UE4SS mod moved its folder**
- A UE4SS mod now always lives in its own folder name from its archive
  (`ue4ss\Mods\CoolMod`), whatever you call it in Mod Command X. Before, the
  folder was named after the display name, so a rename — or the automatic
  rename to the Nexus page name after a one-click install — moved it to
  `ue4ss\Mods\My_Cool_Mod`. That broke mods that depend on their folder:
  addons that look for their parent mod, Lua mods that build paths from their
  own folder, and `mods.txt` lines written by other tools.
- Renaming is now only a new label: nothing in the game moves, `mods.txt`
  stays as it is, and the mod stays on. Updates and rollbacks keep the folder
  too.
- Mods already deployed under a renamed folder are left exactly where they are.
  Their row shows "Deployed as 'X' — the mod's own folder name is 'Y'" with
  **Use original name** (moves the folder, anything the mod saved in it, and
  its `mods.txt` line; close the game first) and **Keep as is**.
- Two UE4SS mods with the same folder name can no longer be installed side by
  side: the second one is refused with a message naming the first.

**New: Settings → Behavior → Keep original pak file names** (off by default)
- Pak and IoStore files are still renamed to `pakchunk99-P001_<Mod>_…` in
  `~mods` by default, so the load order decides which mod wins and two mods'
  generic file names never overwrite each other.
- Turn the setting on to deploy every file under the name it shipped with (an
  IoStore .pak/.utoc/.ucas set keeps its shared name). The load order list then
  no longer decides which mod wins — the game goes alphabetically by file name —
  so the list is marked "not applied" and can't be dragged. Two mods that ship a
  file with the same name can't both be enabled: the second one is refused with
  the other mod's name.
- Switching renames the files of every enabled pak mod at once (close the game
  first). If anything gets in the way, nothing is changed.
- Diagnostics → Deployed files checks the names for the mode you picked.

**Fixed: startup recovery could replace a newer build with an older copy**
- When a mod's files went missing from the game, Mod Command X put the
  stored copy back at the next start, over everything that was still there.
  A mod built with the Zero Company Mod SDK, deployed straight into
  `SWZeroCompany\Mods\<Name>\` with a different set of files, was replaced
  by the older copy in the mod archive — a newer build lost on startup. The
  shared mod archive made this likelier: a mod taken over from Mod Command
  uses Mod Command's stored copy, which can be older than what is in the
  game.
- Startup recovery now only puts back missing files when everything still in
  the game is exactly what Mod Command X deployed (sizes, then checksums) and
  nothing else was added to a plugin mod's folder. Otherwise the mod's files
  are left as they are, a toast says "Not restored", and the log says why.
  To bring such a mod up to date in Mod Command X, install that build with
  Hangar Bay → ⊕ Install archive.
- Diagnostics shows a "Deployed files" warning for enabled mods whose files
  were changed outside Mod Command X.
- The ZCSDK Runtime self-heal follows the same rule: a runtime part whose
  files in the game were changed outside Mod Command X (e.g. a newer runtime
  build) is not switched back on, redeployed or silently reinstalled over —
  a toast points to Settings → ZCSDK Runtime → Update / Reinstall. Editing a
  UE4SS mod's `enabled.txt` never counts as a change.
- A restore from a mod archive that runs without a click can now leave a mod
  switched off instead of deploying it over different files already in the
  game (Import, which you start yourself, works as before).
- Very large files (multi-GB `.ucas`) are checked in chunks instead of being
  read into memory whole.
- The check looks where each mod really is: a UE4SS mod in its own folder,
  pak files under the names your "Keep original pak file names" setting gives
  them.

**ZCSDK Runtime v0.12.1 bundled**
- The copy of the ZCSDK Runtime used for offline installs is now v0.12.1
  (ZCSDKBridge 0.5.3, ZCSDKLoader 1.8.30). It ships three UE4SS signature
  files (ConsoleManager, FName_ToString, GUObjectHashTables) instead of six.
- Updating from v0.12 removes the three signature files the runtime no longer
  ships — only the runtime's own, unchanged copies. A signature file of yours
  that the runtime had replaced is put back, and one you edited since is left
  as it is. Online, the newest runtime release is installed as before.

## Mod Command X 1.0.2 — 2026-10-01

**Fixed: UE4SS mods did not run after installing the ZCSDK Runtime**
- The ZCSDK Runtime now installs its UE4SS signature files into
  `ue4ss\UE4SS_Signatures`. Without them, UE4SS can't find what it needs in the
  current game build, so none of your UE4SS mods ran — including the runtime's
  own loader.
- If you installed the runtime with Mod Command X 1.0.1, it is missing these
  files. Mod Command X 1.0.2 puts them back by itself when SDK mods are
  installed, or press Settings → ZCSDK Runtime → Update / Reinstall.
- A signature file of yours with the same name is kept and put back if you
  remove the runtime. Your other signature files are never touched.
- The signatures stay through runtime updates, reinstalls and rollbacks, and
  when other mods are switched off or removed. Installing, updating or
  restoring UE4SS never overwrites them. Only Settings → ZCSDK Runtime →
  Remove takes them out.
- The ZCSDK Runtime bundled for offline installs is now v0.12 (ZCSDKBridge
  0.5.3, ZCSDKLoader 1.8.29), with its signature files.

**Fixed: Import could delete or switch off the ZCSDK Runtime**
- Hangar Bay → Import ticked an old copy of ZCSDKBridge from the mod archive
  for you, and adopting it replaced — or deleted — your installed runtime, so
  every mod built with the Zero Company Mod SDK stopped working.
- The ZCSDK Runtime (ZCSDKBridge + ZCSDKLoader) is now protected. Only
  Settings → ZCSDK Runtime installs, updates or removes it. While SDK mods are
  installed, its Hangar rows say "◆ Required by N SDK mods" and can't be
  switched off, uninstalled, rolled back or renamed; Disable all, squad
  profiles and Apply start order leave it on.
- Import and cleanup never adopt, replace or remove it. An old runtime copy
  in the archive shows in Import as "Old ZCSDK Runtime copy — safe to clean
  up".
- New: Settings → ZCSDK Runtime → **Remove** takes both parts out together,
  after listing the SDK mods that will stop working.
- Self-heal: if SDK mods are installed and the runtime is missing, incomplete
  or switched off, Mod Command X puts it back and tells you (it asks first if
  that needs a download, and waits until the game is closed). If you removed
  the runtime yourself, it stays removed.

**Safer mod changes**
- Import no longer pre-ticks anything. Each archive entry says what adopting
  it does ("installs as a new mod", "added to ⧗ Versions only", or "REPLACES
  your installed …"), and a replacement asks once more.
- Switching off or removing a mod removes only the files Mod Command X put
  there; files the mod wrote or you added are kept.
- If an update, adoption, rollback or reinstall fails part way, the version
  you had is put back exactly as it was.
- A mod that was off stays off through an update, adoption, rollback or
  restore.
- No mod changes while Star Wars Zero Company is running: switching,
  removing, updating, rolling back, renaming, reordering, squad profiles and
  Import wait for you to close the game, with a clear message.

## Mod Command X 1.0.1 — 2026-09-29

**Nexus panel: signing in works again**
- Fixed: after signing in to Nexus in the built-in Nexus panel, Mod Command X
  kept saying "Sign in to download" and never started the download. Nexus
  changed how its pages show that you are signed in, so the panel no longer
  recognised it. The panel now checks the page's own signed-in state, your
  account picture and name in the header, and its saved Nexus sign-in — and
  it never mistakes the guest profile Nexus shows to signed-out visitors for
  an account.
- "◈ Sign in to Nexus" now opens Nexus's sign-in page with a link back to the
  exact file, the way Nexus's own "Log in" buttons do, so you land on the file
  right after signing in and the download continues by itself. If Nexus
  sends you somewhere else, the panel still takes you back to the file.
- While the page says you are signed out, auto-click waits (it only presses
  "Slow download" once you are signed in), and the strip tells you to sign in.
- Nexus's "Oops! Something went wrong" page — or a page whose own styles and
  fonts Nexus refused — is recognised: the panel reloads it once by itself,
  and if it happens again the strip offers a Reload button and points to
  "Open in browser ↗" and Settings → Nexus Mods → "My web browser". It never
  keeps reloading on its own.

**Support reports**
- New "Nexus panel" section: your Nexus account type (Premium / Free) and what
  the last panel sessions saw — signed in or not and how that was decided,
  whether the sign-in page was visited, Cloudflare checks shown and passed,
  Nexus error pages, refused page parts by site, what auto-click pressed and
  whether the download link reached Mod Command X. The same events now appear
  in the session log (page addresses only, never sign-in cookies).
- Privacy: the report and the log no longer show your Nexus account name — it
  appears as its first two letters followed by `***`, as the report's footer
  promises.
- If the panel's saved cookies cannot be read back at start (for example when
  Windows can no longer decrypt them, which signs you out of the panel at every
  start), the log and the report now say so.

**Download progress**
- Download progress no longer jumps around: the bottom strip and the Nexus
  panel follow each download on its own (name, or "Downloading 2 files" with
  one total), label and bar always show the same number, and the same file
  handed over twice by Nexus downloads once. A dropped connection resumes
  where it stopped when the server allows it, else restarts, and the strip
  says so.

## Mod Command X 1.0.0 — 2026-09-27

Mod Command X is a private side-project build of Zero Company Mod Command,
forked from upstream 1.9.14 and distributed only through the releases of
github.com/EnvianMods/ModCommandX. Numbering restarts at 1.0.0; the upstream
feature level it carries is recorded as `modCommandCompat: 1.9.14` in
package.json (the version Mod SDK manifests are checked against).

**Its own identity — installs side by side, shares only the mod archive**
- Named Mod Command X everywhere: window, dialogs, the portable
  `ModCommandX.exe` (unpacked to `%TEMP%\ModCommandX`), the AppImage, the
  support-report file name and the `nxm://` handler's friendly names (Linux:
  `mod-command-x.desktop`).
- Own app data in `%APPDATA%\ModCommandX` and own Electron profile in
  `%APPDATA%\Mod Command X` — a separate single-instance lock, separate
  embedded-Nexus cookies, separate caches. The upstream app's
  `ZeroCompanyModCommand` data (and its older `ZeroCompanyModCommand-data`)
  is never migrated.
- **One mod archive with Mod Command: `<game>\ModCommandArchive`.** X uses the
  upstream app's own archive folder, so each mod is stored once:
  - On start X adopts the mods Mod Command installed (from the archive mirror
    and, read-only, Mod Command's own manifest) in place — the same
    `library/<id>`, no copies; only mod records, never its settings or
    credentials. Enabled state follows what is actually deployed in the game.
  - The mirror is merged, not overwritten: Mod Command's records, settings
    block and profiles are kept as written; X adds its records and a
    `modCommandX` block Mod Command 1.9.14 ignores (verified against 1.9.14: an
    existing install keeps all its mods; a fresh one restores X's mods too).
  - Uninstalling in X keeps a stored copy Mod Command still uses (toast), and
    deletes X-only ones. Uninstalling in Mod Command removes the copy for X as
    well: X marks the mod "stored copy missing" (re-download or uninstall),
    and X follows a mod Mod Command re-installed under a new id.
  - Updating a shared mod in X stores the new version under a new id; Mod
    Command's copy stays.
  - X's earlier `<game>\ModCommandXArchive` is folded in on first start
    (copy-verify-delete, never clobbering; an id collision keeps both, X's
    under a new id) and removed once empty; one toast summarises it.
  - A banner warns while Mod Command is running — don't run both at once.
  - The old re-install-and-prune auto-restore is gone (on a shared archive it
    would have renumbered and deleted Mod Command's stored copies).
  - The pre-1.9.0 `ZeroCompanyModArchive` is left to Mod Command.
- Identifies itself to Nexus Mods as `Mod Command X` (User-Agent
  `ModCommandX/<version> (+github.com/EnvianMods/ModCommandX)`).
- Update check reads the latest GitHub release of EnvianMods/ModCommandX
  (tag `vN.N.N`) and links only to that release page; a missing or private
  repo, or being offline, is silent. The "Get the SDK" link still comes from
  the `sdk` block of the shared launcher-version.json — nothing else in that
  file is read, so the upstream update banner never appears.
- Owner tools publish only to EnvianMods/ModCommandX and
  EnvianMods/ModCommandXArchive and refuse the upstream repos; the tools that
  write shared upstream files or upload to Nexus are removed.
- Running X and the upstream app at the same time is not supported: they
  share the mod archive and deploy into the same game mod folders.

**Nexus Mods: personal API key instead of OAuth sign-in**
- Settings → Nexus Mods and first-run setup step 2 take your personal API key
  again (password field, **Get my API key ↗**, Save / Verify / Clear, with the
  walkthrough for finding the key on next.nexusmods.com).
- The key is validated against `/v1/users/validate.json` before it is stored,
  encrypted with your OS account (DPAPI via safeStorage; never in plain text —
  see below), sent only to nexusmods.com as the `apikey`
  header, and never shown, logged or put in a diagnostics report. X never
  deletes a stored key — only Clear does.
- Name and premium status come from validate.json; premium still decides
  direct download vs. starting it on the website (now one click either way —
  see below).
- Adult content still follows your Nexus account: the v2 GraphQL
  `preferences { adult }` query is sent with the API key; with no key, or if
  it cannot be read, adult-rated mods stay hidden.
- Kept from upstream 1.9.13/1.9.14: shared Nexus quota and rate-limit handling
  (`lib/nexus-http.js`), UE4SS from Nexus by default, UE4SS mods with their
  own paks.

### Also in 1.0.0 — work that followed upstream 1.9.14

**Credentials: encrypted at rest, never in plain text**
- The Nexus API key is never written to disk in plain text. The old fallback
  that stored it unencrypted when the OS key store was unavailable is gone:
  without a secure store (including Linux's `basic_text`) the key is kept for
  the session only, and Settings → Nexus Mods says so. On Linux X asks for a
  real keyring (libsecret) where Chromium would otherwise fall back.
- Startup migration: a plaintext `nexusApiKey` is encrypted (or moved into
  memory) and deleted from `manager-data.json`, a leftover `.tmp` copy and the
  game-side archive mirror. Leftover upstream OAuth fields are dropped. The
  archive mirror never carries the key, not even encrypted.
- Clear wipes both stored fields and the in-memory copy.
- One redactor (`lib/redact.js`) for the session log, the support report and
  error messages sent to the UI: the key, `apikey` headers, nxm
  `key=`/`expires=` and signed download-URL query strings are masked. An
  unusable nxm link in an error no longer echoes its key.
- Release builds encrypt the Nexus website panel's cookies at rest
  (`EnableCookieEncryption` fuse via an electron-builder afterPack hook,
  `@electron/fuses` 1.8.0) and disable `NODE_OPTIONS` and `--inspect`.
  `RunAsNode` stays on for the Mod SDK workbench. Dev runs keep cookies
  unencrypted.
- Settings → Nexus Mods → **Sign out of the Nexus website panel** clears the
  panel's login (cookies, site data, cache).
- Owner tools fall back to `gh auth token` (the GitHub CLI's credential store)
  instead of needing a token file.
- Web permissions are deny-by-default (`lib/web-permissions.js`). Electron
  otherwise grants every request, so the Nexus website panel's ad frames could
  use the camera, microphone, location, notifications, MIDI, HID/serial/USB,
  clipboard reading, screen capture or external protocol handlers. The panel
  now allows only clipboard writes from nexusmods.com and fullscreen for
  nexusmods.com / YouTube video; the app window allows only clipboard writes
  (Copy support report, the SDK's copy buttons). Device choosers are
  cancelled. An `nxm://` link never leaves the app — it goes straight to the
  installer — and other external protocols are refused. Denials are logged
  once per origin at debug level (origin only) in the session log.

**One click to download — premium or free**
- Every Nexus download button is now one click: Holonet ⭳ Install and
  ⬆ Update, the Command Deck's ⬆ Update, ⧗ Versions "Install this version",
  ⊕ Optional files ⭳ Install / Reinstall, and UE4SS (Settings card and ⧗
  Versions).
- Premium: downloaded and installed straight away, no dialogs, with the
  percentage shown on the button you pressed. Several can run at once.
- Free accounts: Nexus needs those downloads to start on its website, so the
  click opens the in-app Nexus panel directly on **that file's** download page
  (no more hunting through the Files tab — and the ⧗ Versions and ⊕ Optional
  files buttons no longer send you to your browser). Mod Command X then presses
  **Slow download** for you as soon as Nexus enables it, catches the file Nexus
  hands over, installs it and closes the panel. A strip at the top of the
  panel says what it is doing, including Nexus's own countdown.
- It plays fair: the page stays fully visible, Nexus's wait is never skipped,
  each button is pressed at most once per page load, and a bot check or
  CAPTCHA is always left to you. If it finds nothing to press within about 20
  seconds it asks you to click "Slow download" yourself. Not signed in to
  Nexus in the panel? Sign in there and the download carries on by itself.
- Pressed Install on several mods? They queue and open one after another
  ("N queued ✕" in the panel cancels the rest).
- Settings → Nexus Mods → **Auto-click Nexus download for free accounts**
  (on by default). Off, the panel still opens on the exact file and you press
  the button.
- GitHub installs keep their confirmation — it is the "GitHub mods aren't
  moderated, install only from authors you trust" warning.
- For maintainers: everything that knows the Nexus page (selectors, button
  texts, countdown and challenge markers) is in `src/nexus-autoclick.js`.

**Install a mod's optional files — and switch them on and off one by one**
- Most Nexus pages offer more than the main download: alternative textures, a
  compatibility patch, a hotfix. Until now installing one of those *replaced*
  the mod, because Mod Command X treated every file on a page as the same mod.
- Every Nexus-linked mod on the Command Deck now has an **⊕ Optional files**
  button. It opens the mod's page files — the optional, update and
  miscellaneous ones — with their size, date and the author's own description,
  and marks anything you already have. Press **⭳ Install** and it is added
  *alongside* the mod, not over it. (No API key? The button asks you to add
  one first. Free account? It is the same one click as every other download —
  see below.)
- Installed optional files fold away under the mod they belong to: the row shows
  **▸ 2 optional files**, and opening it lists each one indented, with its own
  on/off switch, its own version and its own ✕ to remove just that file.
- They behave the way you would expect: turning the mod off turns its optional
  files off with it; turning it back on leaves them however you had them; a
  file cannot be switched on while the mod itself is off; uninstalling the mod
  removes its optional files too (the confirmation says how many).
- Updates stay in their own lanes. Updating the mod's main file no longer
  disturbs the optional files sitting under it, and an optional file only
  updates when the author uploads a replacement *for that file* — it will never
  be quietly swapped for the mod's newest main download.
- **Installed a mod's extras yourself? Group them the same way.** None of this
  needs Nexus. **⊕ Optional files** is now on *every* mod on the Command Deck,
  whether or not it came from Nexus and whether or not you have an API key, and it
  has a second half — **ALREADY INSTALLED** — listing the other mods you have.
  Press **⇲ Group under &lt;mod&gt;** and that mod slides into the nested list
  right there, looking and behaving exactly like a file downloaded from a mod
  page: the same OPTIONAL chip, the same indent, its own switch, off when the
  mod is off, and removed when you uninstall the mod. That sameness is the
  point — a mod you installed by hand is not a second-class row.
- Changed your mind? A mod you grouped yourself has a **⇱ Ungroup** button that
  puts it back on a row of its own, still installed and still however you had it
  switched. (Files downloaded *from* a mod page keep ✕ as their only exit, so
  downloading that file again can't leave you with two copies side by side.)
- Sensible limits: a mod can only be grouped under one other mod, the nesting
  never goes more than one level deep, and a mod's own other versions from the
  same Nexus page are not offered — those belong to the ⧗ version picker.

**Themes — a bounty-hunter look by default, the original one a click away**
- Settings → Behavior → **Theme**: **Mod Command X** (the new default) or
  **Mod Command** (the holo-terminal look, exactly as before — same pixels).
  The change applies instantly, is remembered, and the app opens in the saved
  theme from its very first frame (no flash of the other one).
- **Mod Command X** keeps every screen's layout and restyles it after Boba
  Fett's kit, as a grimy black-market bounty board: scorched gunmetal
  backgrounds (`#15171a`, `#1d2022`) under olive-tinted armor plates;
  weathered Mandalorian green for accents, headings and active items
  (`#a9bb86`, worn `#879766`); dented ochre gold for highlights, the launch
  button and primary buttons (`#c3953a`, solid gold with dark ink); oxidised
  rust for danger and errors (`#e5704f` text, `#8e2b20` fills and the tag on
  every card title); fresh armor green for success (`#8fc160`); bone text
  (`#ebe3cf`) and khaki flight-suit secondary text (`#b9ad8f`). Neon glows
  become soot shadows; badges, switches and scrollbars go square; headings use
  a condensed stencil-like system face (Bahnschrift, else Agency FB / Roboto,
  Ubuntu or DejaVu Condensed / Arial Narrow — nothing is downloaded).
- Sparing accents: a T-visor rule under every view title and a visor stem
  under the active Holonet tab, a hazard band above LAUNCH GAME,
  hazard-striped progress bars and drop zone, a gold edge on dialogs and the
  Nexus panel, an ochre focus ring, and a faint CSS-only scuffed texture that
  never moves (no images, no filters over the scrolling lists). Mod cards
  without a picture get their own "no image" art in the same palette.
- Readable by the numbers: every text colour and button label meets WCAG AA
  contrast on its surface — body text 12.3–14.0:1, secondary text 7.1–8.1:1,
  green / ochre / rust text 5.0–8.7:1, dark ink on the gold buttons 4.8–8.0:1.
- Not themed: the Nexus website inside the download panel and, when an SDK is
  linked, the SDK's own Forge workbench (both bring their own look), and the
  operating system's own menus and dialogs.

**An uninstaller that removes the app and leaves your mods playing**
- The release ships **`Uninstall Mod Command X.exe`** next to
  `ModCommandX.exe`; **Settings → Uninstall Mod Command X…** (last card, in
  danger colours in both themes) starts it and closes the app. A source run
  shows a note instead — the uninstaller comes with the release build.
- Before anything happens it lists what it removes and what it keeps, with
  sizes, and asks you to confirm. It will not run while Mod Command X is open
  (it offers to close it), retries files in use and then lists any it had to
  leave, and ends with a summary; a short log (no keys, your profile path
  shortened) goes to `%TEMP%\ModCommandX-uninstall.log`.
- Removed: settings and app data (`%APPDATA%\ModCommandX`: the encrypted API
  key, download staging, the file-index cache, retoc), the browser profile
  with the Nexus panel's cookies (`%APPDATA%\Mod Command X`), the portable
  unpack folder `%TEMP%\ModCommandX`, `ModCommandX.exe` and the uninstaller
  itself (deleted right after it closes), a source checkout's dev `data\`.
- Undone: the **Steam update freeze**, if X set it — exactly as Settings →
  freeze off does (left on when the main Mod Command also froze the game);
  the **`nxm://` handler**, only when it points at Mod Command X — one that
  belongs to the main Mod Command or another manager is left alone and the
  list says so.
- Kept: every mod installed in the game (`~mods`, `LogicMods`,
  `SWZeroCompany\Mods`, `ue4ss\Mods`, UE4SS itself), UE4SS `mods.txt` with its
  start-order block, `*.zcbak` config originals, and everything of the main
  Zero Company Mod Command.
- **Your mod library is kept by default**, so reinstalling restores every
  mod. Tick *"Also delete my stored mod library (mods you switched off live
  only here and would be lost)"* to delete it; the warning names the
  switched-off mods that would be lost and the game-file mods whose original
  files are backed up there. In the archive shared with the main Mod Command
  (`<game>\ModCommandArchive`) only the entries X alone uses are deleted —
  whatever the main app's own settings or the shared mod list name stays,
  and so do the archive folder and its `manager-data.json`, from which only
  Mod Command X's own block, profiles and X-only records are taken out (the
  main app's records keep their exact bytes).
- Safe by construction: deletes only inside an allow-list of Mod Command X's
  own folders, every path resolved and checked, links removed as links and
  never followed, never a drive root, the game folder, `%APPDATA%` or
  `%TEMP%` themselves; a game path from the settings that does not look like
  the game skips every game-side step.
- Tiny and dependency-free: a ~140 KB program compiled with the C# compiler
  that is part of Windows' .NET Framework 4.x — no admin rights, nothing to
  install. The build makes it automatically (`Build.bat`, `npm run dist`);
  `npm run build-uninstaller` builds it alone. Linux AppImage builds get
  `uninstall-linux.sh` with the same rules (Settings shows the command).

**UE4SS comes from one place — and stays up to date** *(ported from upstream
v1.9.15, adapted to X's API key and one-click downloads)*
- Mod Command X installs, updates and repairs exactly one UE4SS: **"UE4SS for
  Star Wars Zero Company"** on Nexus Mods — UE4SS plus this game's signatures,
  loader settings and helpers. The general-purpose build from GitHub is gone
  from the app: no GitHub section in ⧗ Versions, no "install the GitHub build
  instead?" prompt without an API key, and no silent fallback to it when Nexus
  cannot be reached (the install says so and you try again later).
- Every UE4SS button (Download & install, Update, Switch, ⧗ Versions,
  Diagnostics) is one click like the rest of the app: premium accounts
  download straight away with progress on the button; free accounts get that
  exact file's download page in the Nexus panel, queued, with Slow download
  pressed for you (or in your own browser, per "Where to finish free
  downloads"). Without an API key, the button offers to take you to
  Settings → Nexus Mods to add it; say no and it shows you the page instead.
- **Already have a UE4SS?** Mod Command X now tells you which one. If it is the
  stock build (no Zero Company signatures, or installed from GitHub — by an
  older build, or by Mod Command for this game) or one it cannot identify,
  Settings → UE4SS, the dashboard and Diagnostics say *"UE4SS installed is the
  stock build — switch to the Star Wars Zero Company UE4SS (Nexus)"*, with a
  one-click **Switch to the Nexus build**. The Settings item in the rail shows
  **!** until you do. A Nexus build Mod Command installed is recognised by its
  UE4SS.dll and tracked for updates from then on.
- **Your UE4SS setup survives every install, update and switch.** Only UE4SS's
  own files are replaced: your UE4SS mods are untouched, a built-in you
  switched off stays off, `mods.txt` keeps every line you had (including the
  managed start order) and only gains entries the new build adds, and the
  settings you changed in `UE4SS-settings.ini` — the console, the GUI console,
  anything you edited — are carried into the new build's file. Files the
  previous package shipped and the new one does not are cleared away; nothing
  else in the `ue4ss` folder is — the Mod SDK's logs and state, `.jmap` and
  header dumps stay where they are and are not copied into ⧗ Versions either.
  The build that was there before is always kept in ⧗ Versions (in X's own
  `versions/ue4ss-runtime-mcx` of the shared archive, apart from Mod Command's
  kept builds), one click to put back.
- **Kept up to date.** Mod Command X checks the Nexus page at startup and every
  hour, like mod updates (or press **Check now**). When a newer file is up,
  Settings shows **Update to …** and the rail shows **⬆**. With the new
  **Keep UE4SS up to date automatically** setting (on by default) and a
  premium account, the update just happens — but never under a running game:
  while Zero Company is open, you are told and it installs a few minutes after
  you close the game. Turn the setting off, or use a free account, and you get
  one heads-up per new file; on a free account the one click on Update opens
  the file's download page and starts it — nothing opens by itself.
- ⧗ Versions now lists every file on that Nexus page — the current main file
  first, then older uploads — for anyone keeping the game on an older build.
- A UE4SS copied over the Nexus build by hand is noticed (Diagnostics offers
  the switch back), and installing or restoring UE4SS while the game is
  running now stops with a clear "close the game first".

**UE4SS switches, updates and restores touch UE4SS's own files only** *(ported
from upstream, before its release)*
- ⧗ Versions snapshots, retirements and restores are bounded by a fixed list
  of UE4SS's own files (dwmapi.dll, UE4SS.dll/.pdb, the settings file, its
  license and docs, its signature and layout-template folders) plus exactly
  what the installed package shipped, which Mod Command X records. Dumps,
  `.jmap` files, logs, crash dumps and the Mod SDK's files are never kept,
  removed or overwritten, and old kept builds that still hold the whole
  `ue4ss` folder put back only UE4SS's own files.
- Files the Mod SDK generated in `UE4SS_Signatures` are never removed. If a
  package (or a restore) would overwrite one of the same name, the SDK's file
  is kept in ⧗ Versions first — if that copy cannot be made, nothing is
  changed — and it comes back when you restore the build before it; an
  older copy never replaces the SDK's current one.
- Kept builds remember what they were installed with (the shipped-file list
  and the shipped `UE4SS-settings.ini`), so settings carry over correctly
  after a restore; a restored stock build is tracked as the stock build.
- Signature files alone no longer count as proof of the Nexus build (the Mod
  SDK writes them too): a UE4SS Mod Command X has no record of installing is
  shown as one it cannot identify, with the switch offered.
- The first update check after startup reads your API key's account before
  deciding, so a premium account gets the automatic update (and the right
  notices) rather than the free-account ones.
- Restoring the oldest kept build no longer removes it from ⧗ Versions before
  it is put back.

**Bundled tools**
- The Oodle DLL (`oo2core_9_win64.dll`) is no longer bundled with retoc.
  Conflict detection is unaffected: listing a mod's containers does not need it.
- The license texts of the bundled tools (7-Zip, retoc) and a source note for
  the ZCSDK Runtime now ship in `resources\tools\licenses`, and the README
  lists each bundled tool with its version, source and license.

**Source**
- The repository and the source package hold only what is needed to
  understand, build and run Mod Command X; the README covers installing,
  running from source and building the exe.

---

# Inherited history — Zero Company Mod Command up to 1.9.14

Everything below is the upstream Zero Company Mod Command's own changelog,
kept as it was written. "Mod Command" there means the upstream app; its OAuth
sign-in (1.9.13) is replaced in X by the API key described above.

## v1.9.14 (2026-09-23)

Ships together with v1.9.13 below as public 1.0.9.

**◆ Forge: the Zero Company Mod SDK's workbench, inside Mod Command**
- Mod Command installs and manages mods. The **Zero Company Mod SDK** is the
  other half — the toolkit that *makes* them — and it is a separate download
  (Mod Command's Get-the-SDK page always points at wherever it is currently
  published). Point Mod Command at an installed
  SDK — Settings → ◆ SDK, where **Detect** looks beside the Mod Command install,
  beside the game folder, and wherever the SDK's own workbench last pointed — and
  the new **◆ Forge** view hosts the SDK's own
  workbench in this window: scaffold a mod from a recipe, check it, build it,
  deploy it, run its doctor, browse its templates, read the real build log.
- Mod Command carries **no copy** of that panel. It loads the SDK's own UI
  straight out of the SDK folder, so a new SDK release shows up in Forge the
  moment you update the SDK — no Mod Command update needed. The SDK declares
  the embed contract it speaks (`tools/sdk-ui/manifest.json`); an SDK that is
  too new or too old for this Mod Command says so on the ◆ SDK card, and
  nothing else in the app changes.
- With **no SDK linked**, ◆ Forge is still in the rail, dimmed. It opens a
  page that explains what the SDK is, what it needs on your machine (Unreal
  Engine 5.6.x, MSVC + the Windows SDK, the .NET 4.8.1 Developer Pack, retoc —
  which Mod Command already bundles — Node.js 22.12 or newer, Python, and the game), and one
  **Get** button, plus "point Mod Command at a folder you already have". Mod
  Command hard-codes **no download address** for the SDK: the address is
  published alongside Mod Command's own update announcement and read at
  startup and hourly, so when the SDK's download moves the button follows it
  with no Mod Command update. The button says where it is about to send you —
  *on Nexus*, *on GitHub* — written from the address itself, so it can never
  name one place and open another. It remembers the last address it was
  given, so it still works offline; if it has never managed to fetch one it
  says so instead of showing a dead link. A modder who has never heard of the
  SDK can now find out it exists without leaving the app.
- Once linked, Mod Command also reads the SDK's own small update file (the
  URL is the SDK's, from its manifest). When a newer SDK is published, ◆ Forge
  gets a badge and the ◆ SDK card names the version and where to get it. The
  check runs at startup and hourly, like mod updates; offline it stays quiet.
- The SDK keeps its own paths — Unreal, the game, retoc, the reflection
  dump — in its own settings, and Mod Command stores none of them. Once an
  SDK is linked, the ◆ SDK card has a **Paths & dependencies…** button that
  jumps straight to the Forge view's Settings. **Detect** now also finds an
  SDK you have already opened in the SDK's own workbench — it reads where
  the workbench last pointed.
- Current with the SDK's 1.0.3 workbench. Inside ◆ Forge the SDK now walks a
  first-time modder through a guided first mod, shows a build stepper that
  explains failures, and adds an editor for the mod's definition, an asset
  drop zone (type or drop a file's path — this window offers no file picker),
  and Test / Conflicts / Publish pages; **Paths & dependencies…** now lands
  directly on the SDK's Settings card (or on one row). The ◆ SDK card shows
  the installed SDK version and its public name (for example 1.29.6 — public
  1.0.3) and a **What's new in the SDK** link that opens the SDK's own
  changelog. The Get-the-SDK page now asks for Node.js 22.12 or newer and
  says plainly that the SDK is not open source (all rights reserved; the mods
  you make with it are yours).
- A word on trust: linking an SDK runs that SDK's build tooling from the
  folder you chose, with the same privileges as running its build script
  yourself. Link only a folder you downloaded from the SDK's own release pages.

**The Holonet's curated-GitHub tab is now labelled GitHub**
- It used to be called The Forge. That name now belongs to the SDK view, so the
  Holonet tab says what it is: the GitHub mods curated by Envian Mods. Nothing
  else about it changed — same list, same Install buttons, same IN HANGAR
  badges.

## v1.9.13 (2026-09-14)

**Signing in to Nexus Mods replaces the personal API key**
- Nexus Mods requires apps like this one to sign you in with your Nexus account
  instead of asking for a personal API key, so the key box is gone from Settings
  and from the first-run assistant.
- What you do now: Settings → Nexus Mods → **Sign in with Nexus Mods**. Your
  browser opens on nexusmods.com, you approve Mod Command there, and the app
  picks it up. That's the whole thing — the app never sees your password.
- Mod Command stores only the tokens Nexus hands back, encrypted with your
  Windows/OS account, and only ever sends them to nexusmods.com. Settings shows
  who you are signed in as, whether the account is Premium, and a **Sign out**
  button. You can also revoke the app's access at any time from your Nexus
  account page.
- Any API key you had saved is **discarded** when this version first starts —
  it is no longer used for anything. One-click downloads, update checking,
  version pickers and mod linking all work again as soon as you sign in.

**Adult content now follows your Nexus account**
- The Holonet's "Show adult content" checkbox is gone. Whether adult-rated mods
  appear is decided by the **content preference on your own Nexus account** —
  the one behind Nexus's age verification — and nothing else.
- Signed out, adult-rated mods are hidden everywhere: browsing, categories,
  searching, the featured strip and the Link wizard alike. (Searching by name
  used to slip past the filter; it no longer does.)
- Signed in, Mod Command asks Nexus what your account says and follows it. If
  your account also asks for adult images to be blurred, those thumbnails are
  blurred here too — hover a card to reveal it. Adult-rated mods always carry
  an **18+** chip either way.
- Settings → Nexus Mods shows what is in force and links straight to your Nexus
  content-preferences page to change it.

**Nexus's request limits are respected**
- Mod Command now reads the request allowance Nexus sends back with every reply
  and shows it in Settings → Nexus Mods: how many requests are left this hour
  and today, and when each resets.
- When the allowance runs out, the app stops rather than hammering, and tells
  you plainly: *"Nexus Mods request limit reached — try again after 16:00."*
  If Nexus asks it to wait a moment, it waits and tries once more.
- Background work — the hourly update check and the file-name index — keeps a
  reserve so your own clicks always have requests to spend, spaces itself out,
  and quietly reschedules for when the allowance refills. Nothing you press has
  to queue behind it.

**Mod Command identifies itself to Nexus Mods**
- Every request to Nexus now carries the app's registered name and version, so
  Nexus can see what its API is being used by. Nothing else changed for you.

**UE4SS now installs the version made for Zero Company**
- Download & install used to fetch the general-purpose UE4SS from its own
  GitHub page. That build knows nothing about this game: it has none of Zero
  Company's signatures, and since the game's last patch it often does nothing
  at all — which is why Lua and DLL mods stopped loading for some of you.
- Settings → UE4SS → **Download & install (Nexus package)** now fetches
  **"UE4SS for Star Wars Zero Company"** by Vercadi from Nexus Mods — the same
  UE4SS plus this game's signatures, loader settings and helpers, tested against
  the current game build on both the Steam and EA App editions. Every one-click
  path uses it now, including the prompt that offers UE4SS before the ZCSDK
  Runtime.
- Premium accounts get it downloaded and installed straight away. Free accounts
  get the file list in the download panel — press **Mod Manager Download** and
  Mod Command takes it from there. Signed out, Mod Command offers to sign you in
  first, and tells you plainly what the GitHub build is if you'd rather have that.
- The Settings card and Diagnostics now say which of the two you have, and for
  the Zero Company package whether the build it was tested on matches the game
  you have installed.
- The stock build from GitHub is still there — ⧗ Versions lists it under a
  warning, and Mod Command falls back to it (and says so) if the Nexus page
  cannot be reached.

**UE4SS mods that bring their own paks install correctly again**
- A UE4SS mod can ship a `paks` folder next to its dll and mount that content
  itself. Mod Command used to spot those pak files first, scatter them into
  `~mods` under new names and throw the dll away, so the mod installed but did
  nothing. Now the whole mod folder goes down intact — dll, settings and its
  `paks` folder — into `ue4ss/Mods/<Mod>`, exactly where the mod expects it.
- ZCUnlocked 1.4.5 is the mod that hit this; reinstall it and it lands right.
  Archives that really are loose paks, LogicMods, plugin mods or a UE4SS runtime
  build are unaffected, and an archive holding both a UE4SS mod and separate
  loose paks still installs each part as its own entry.

## v1.9.12 (2026-09-13)

**Mods that install as a folder in `SWZeroCompany\Mods` now install properly**
- A growing number of mods ship as a **Game Feature plugin**: a folder with a
  `.uplugin` file, an `AssetRegistry.bin` and its paks tucked inside
  `Content\Paks`. Their readmes tell you to copy the whole folder to
  `...\Star Wars Zero Company\SWZeroCompany\Mods\<Name>\` — never into `~mods`.
  "Accurate Clone Commando - Delta Squad" (Nexus mod 174) is one of them.
- Mod Command used to see only the paks inside and treat the download like any
  packaged mod: it renamed them with a `pakchunk99-P###` prefix and dropped them
  into `~mods`. The result was a mod that half-worked — the files mounted, so
  replacements of existing things could show up, but the game never read the
  plugin's own registry, so everything the mod ADDS (new outfits, new weapons)
  simply never appeared in the armoury. That is exactly the failure the mod's
  own readme warns about, and it was easy to mistake for a broken mod.
- These now install as their own type, **PLUGIN**. The whole folder goes to
  `SWZeroCompany\Mods\<Name>\` exactly as shipped — nothing renamed, no load
  order prefix, the `.uplugin` and `AssetRegistry.bin` at the folder root and
  `Content\Paks` untouched — which is what makes the game mount it and read its
  registry. Nothing is put in `~mods`. An archive holding several plugin folders
  installs each as its own mod.
- Everything else works as usual: enable, disable (the folder is removed),
  uninstall, updates from Nexus or GitHub, the version vault, squad profiles and
  conflict detection. Renaming a plugin mod changes only the name you see — the
  folder on disk must keep the plugin's own name, so it stays put. Plugin mods
  are not in the Load Order list, because the game does not order them.
- **Already copied some in by hand?** The existing-mods scan (Hangar Bay →
  Import) now finds every plugin folder in `SWZeroCompany\Mods` that Mod Command
  doesn't already manage and offers to adopt it, right where it is, with its
  name and version read from its own files. Diagnostics has a new row for the
  folder: how many plugin folders are there, and how many are managed here.
- One caution, from the mod authors themselves: **unequip anything from a plugin
  mod in game and save before you disable or remove it.** Saves record modded
  gear by where its files live, so pulling the folder out while a squaddie is
  wearing it can upset the save. Mod Command now says so when you disable or
  uninstall one.

**The portable exe now unpacks to a folder you can whitelist**
- Every launch, the portable exe unpacks the app into a temporary folder and
  runs it from there. That folder used to have a different random name each
  time, so when antivirus quarantined a file out of it (`ffmpeg.dll` was the
  usual victim, giving "ffmpeg.dll was not found" at launch) there was nothing
  you could add to your exclusions, and re-downloading never helped.
- The folder is now always `%TEMP%\ZeroCompanyModCommand` (normally
  `C:\Users\<you>\AppData\Local\Temp\ZeroCompanyModCommand`). Add that one path
  to your antivirus exclusions and the problem stays fixed. Nothing else moves:
  settings still live in `%APPDATA%\ZeroCompanyModCommand` and mods still live
  in the game folder.
- If part of the runtime is missing when the app starts, it now says so — a
  message naming the folder, listing the missing files and explaining that
  antivirus most likely quarantined them — instead of failing silently or
  opening a broken window.

**Adult-rated mods are out of the Holonet listing by default**
- Browsing the Holonet — the default listing and any category — no longer
  turns up mods Nexus has flagged as adult, and the Featured Transmissions
  strip leaves them out too. Search still finds them: type a name and you get
  every match, adult or not, each marked with an **18+** tag. A "Show adult
  content" checkbox beside the Holonet's search box puts them back in the
  listing, and the app remembers your choice.

**Mod updates are checked in the background every hour**
- Mod update checks now also run while the app is open, once an hour, instead
  of only when it starts. Leave Mod Command running and the Hangar Bay's
  update badges keep themselves current on their own.
- The startup check now runs when the last one is over an hour old — it used
  to wait twelve. Badges refresh on every check, so one that has been taken
  care of stops showing as available.
- The "updates available" toast only appears when the set of available updates
  actually changes, so an hourly re-check never nags you about the same ones
  again. "Check updates" in the Hangar Bay still runs the check on demand.

## v1.9.11 (2026-09-10)

**UE4SS from two sources: Nexus compatibility build and GitHub**
- The "UE4SS for Star Wars Zero Company" page on Nexus ships a game-specific
  compatibility build (stock UE4SS plus signatures for a tested game build),
  which is often the only UE4SS that works right after a game patch. Mod
  Command now reads that page too and offers the newest build from BOTH
  sources: the Settings card names the other source, and ⧗ Versions has a
  Nexus section (with the tested game build, marked when it matches yours)
  above the GitHub section.
- Installing from Nexus: premium accounts download directly; free accounts
  are taken to the page in the embedded Nexus panel, and the Mod Manager
  Download button installs it here. The runtime it replaces is kept, and
  UE4SS mods and their start order are untouched.
- Update detection follows the source you installed from: GitHub installs
  compare build ids, Nexus installs compare the page's current file. Toasts,
  the button label, Diagnostics and the update check say which source.

**retoc updates from GitHub**
- Settings → retoc now shows the installed version against the newest
  release on GitHub (trumank/retoc), with "⟳ Check GitHub" and "Update from
  GitHub" buttons. An updated copy lives in Mod Command's data folder and is
  preferred over the bundled one, so a new retoc never waits for a Mod Command
  release. The startup check, the update check and Diagnostics report it too.
  (Today the bundled 0.1.5 is the latest release; the card says so.)

## v1.9.10 (2026-09-10)

**UE4SS tells you when a newer build is out**
- UE4SS's experimental channel is a rolling release: the tag never changes,
  only the build inside it. Mod Command now records the exact build it
  installed (from the zip's name) and compares it with the current build at
  startup, in the update check, and in Settings → UE4SS. When you are behind,
  the card says so with both build ids and dates, the button becomes "Update
  to build …", the ⧗ Versions picker marks your row, and a toast appears once
  per new build. Diagnostics reports the installed build too.
- Copies not installed by Mod Command have no recorded build; the card says
  so and offers a reinstall to get current.

## v1.9.9 (2026-09-10)

**Config Editor finds a mod's settings wherever the mod keeps them**
- The editor used to skip a UE4SS mod's `dlls` and `Scripts` folders and stop
  two levels deep, so settings a mod ships next to its code — `dlls\settings.ini`
  (ZCUnlocked 1.4.2), `Scripts\config.lua`, `MXM\settings.lua` — never appeared.
  Every folder of a mod is now scanned, four levels deep.
- Lua settings files are editable too: a `.lua` counts when its name says
  config (`config.lua`, `settings.lua`, `options.lua`, `prefs.lua`…), so `main.lua`
  and other code stays out of the list. `.toml`, `.yml` and `.yaml` are accepted
  as well. `enabled.txt`, `modinfo.json`, mods.txt/mods.json, README/.md and
  .log files are never listed.

## v1.9.8 (2026-09-09)

**Swap UE4SS builds**
- Settings → UE4SS gained a ⧗ Versions button. Every UE4SS install now keeps
  the build it replaces (Binaries\Win64\dwmapi.dll + ue4ss\*, never your
  mods), and the picker restores any kept build in one click — so a frozen
  game version can keep the UE4SS that worked with it. Restoring keeps the
  current build too, so every swap is reversible. Up to five builds are kept.
- The picker also lists the GitHub releases, newest build first, with the
  recommended rolling experimental build marked. The stable 3.0.x zips are
  shown but not installable: they use a flat layout this manager cannot
  deploy and predate UE 5.6 support.
- The Settings card shows which build Mod Command installed. "Download &
  install" still fetches the recommended build.

## v1.9.7 (2026-09-09)

- With the update freeze on, LAUNCH GAME now stops and explains before going
  to Steam: Steam will run its update check and, while an update is pending,
  refuse with "Disk write error – appmanifest_2075800.acf" (the freeze at
  work, not a broken install). OK launches through Steam exactly as before;
  Cancel keeps you on your current build and points at DIRECT LAUNCH.

## v1.9.6 (2026-09-09)

**Two launch buttons, two clear jobs**
- LAUNCH GAME always launches through Steam now, even with the update freeze
  on (it used to switch to a direct start silently). Steam runs its update
  check on that path; with the freeze on and an update pending it shows
  "Disk write error", and Mod Command warns you first.
- DIRECT LAUNCH is the no-update path: local exe, Steam's app-id environment
  set, no relaunch through Steam, no update check.
- The freeze card, its confirmation, Diagnostics and the README say which
  button does what.

## v1.9.5 (2026-09-09)

**Direct launches now really bypass Steam**
- Measured while building 1.9.4: the game calls Steam's "restart if
  necessary" check on boot, so an exe started directly exited within five
  seconds and Steam relaunched it — through Steam's normal launch path,
  update check included. Every direct launch since the update freeze was
  introduced (1.5.0) behaved this way.
- Direct launches (the DIRECT LAUNCH button, the Settings shortcut, and the
  frozen LAUNCH GAME path) now start the exe with Steam's own app-id
  environment set, exactly as the Steam client does. The check then passes,
  the game keeps running under Mod Command's launch, and no update check
  runs. Verified: the launched process stays alive with no Steam-parented
  copy appearing.

## v1.9.4 (2026-09-09)

**Backup launch button + a clear explanation of the update-freeze error**
- New DIRECT LAUNCH button under LAUNCH GAME in the sidebar: starts the game's
  local exe with no Steam update check. Slimmer and muted so it reads as the
  backup option. Hidden on Linux (Proton launches go through Steam) and for
  the EA App edition (whose main button already starts the exe).
- The game's first patch showed what the update freeze looks like from
  Steam's side: pressing Play in Steam while the manifest is locked fails
  with "An error occurred while launching this game: Disk write error –
  appmanifest_2075800.acf". That is the freeze blocking the update, not a
  broken install. The freeze card, its confirmation, the status line, the
  Diagnostics entry and the launch toast now say so and tell you the two ways
  out: turn the freeze off to let Steam update, or keep launching from Mod
  Command to stay on your current build.

## v1.9.3 (2026-09-07)

**7-Zip ships with the app**
- `.7z` and `.rar` mod archives no longer need a separate 7-Zip install on
  Windows: the unmodified 7-Zip 25.01 command-line build (7z.exe + 7z.dll,
  LGPL, license included) rides along in `tools/7-Zip`. A path you set in
  Settings still wins, then the bundled copy, then an installed 7-Zip, then
  PATH. Settings and Diagnostics say which copy is in use.
- Linux builds keep using the system 7-Zip (p7zip / 7zz) for now.

## v1.9.2 (2026-09-07)

**Update checks follow the file you actually installed**
- A Nexus-linked mod is flagged for update only when the site's own
  "update of an existing file" chain says a newer file replaced the one you
  installed. The page-level "Mod version" field (free text that authors rarely
  keep in sync) is no longer consulted, so a page whose field still says 1.0.1
  can't offer a "downgrade" from 1.0.2, and an old file line's number can't
  masquerade as an update for a different line.
- Mods linked by name without a file id, or whose file was retired without a
  chain, fall back to the newest main file — and only when it is strictly newer.
- Premium in-place updates download the file the chain points at, never a
  different file line. Installs via a Nexus download link record the file's
  version instead of the page's.
- GitHub-linked mods are flagged only for a newer release tag, not merely a
  different one.

## v1.9.1 (2026-09-06)

**ZCSDK Runtime updates come from GitHub**
- The runtime that SDK-built content mods need (ZCSDKBridge + ZCSDKLoader) is
  now published by the Zero Company Mod SDK to the
  `EnvianMods/ZCSDK-Runtime-Release` repo. Mod Command reads that repo's
  `latest.json` at startup and installs the newest release from there, so a
  runtime update no longer waits for a Mod Command release.
- Settings → ZCSDK Runtime shows which version an install would use and where
  it comes from, offers "Update to x" when the installed copy is behind the
  newest release, and gained a "Check for updates" button that re-reads the
  repo immediately. A one-time notice appears at startup when an installed
  runtime is behind a new release.
- The copy bundled with the app (`tools/ZCSDKRuntime.zip`, now 0.5) stays as
  the offline fallback: when GitHub is unreachable, or the download fails, the
  bundled copy installs instead.
- "Update available" now means a part is genuinely behind (numeric compare)
  or unversioned; a hand-deployed dev copy that is newer than the package no
  longer shows as an update.

## v1.9.0 (2026-09-06)

**Installing another version of a mod joins its existing entry**
- When a mod's `modinfo.json` names the same title (and author) as a mod you
  already have, installing it no longer creates a second entry. A **newer**
  version replaces the installed one and archives the old version; an **older**
  version is archived as an alternate without touching your install; the
  **same** version is a reinstall. The mod keeps its name, enabled state, load
  and start-order slots, and its place in your profiles.
- Every archived version shows in the mod's **⧗ versions** button, so you can
  roll back or load a different version for testing in one click. Version
  history now follows the title the author shipped, so renaming a mod no longer
  strands its archived versions.

**Nothing is stored beside the app any more**
- Settings and working data now live in your per-user app-data folder
  (`%APPDATA%\ZeroCompanyModCommand` on Windows). A data folder from an
  earlier version found next to the exe is copied there on first start and
  left behind renamed `.migrated-<date>`, never deleted.
- The mod archive in the game folder is now `ModCommandArchive`. An existing
  `ZeroCompanyModArchive` is renamed in place on first start, with everything
  in it (library, backups, archived versions, mirrored manifest) untouched.

## v1.8.3 (2026-09-05)

**Linked the wrong page? Unlink or relink any mod**
- Clicking a linked mod's **◈ NEXUS** or **⎇ GITHUB** badge now opens the
  source dialog instead of jumping straight to the website. A new **Current
  source** section shows what the mod is linked to, with **↗ View page** to
  check it (Nexus pages open inside the app) and **⊘ Unlink** to detach the mod
  back to LOCAL. Pick a different match in the sections below to relink it.
- Unlinking also clears any pending update prompt, so a mistaken link can't
  keep offering updates from the wrong page.

## v1.8.2 (2026-09-05)

**Link mods finds the right Nexus page — even when the title looks nothing like the mod**
- The **Link mods** button now walks your unlinked mods one at a time in a
  wizard. Each step shows the best Nexus match pre-selected in a dropdown (open
  it for the other top candidates), a **↗ View page** button that opens that
  mod's Nexus page inside the app so you can check it before committing, and a
  search box (by title *or* author) for when the recommendations are wrong.
  **Link** attaches your pick and moves on; **Skip** leaves a mod unlinked;
  **Cancel** stops at any point.
- Matching is far smarter. It reads everything a mod record knows — its local
  name, the archive it was installed from, and its author — and adds up the
  evidence from every route: file hash, the Nexus download's embedded mod id,
  a catalog-wide index of every mod's uploaded file names, title search, and
  author search. A mod named after its archive ("ZCUnlocked") is now found even
  though its Nexus page is titled something completely different.
- The file-name index is built once (a progress bar shows it), cached, and only
  refreshes mods that have changed on Nexus since, so repeat scans are instant.

## v1.8.1 (2026-09-05)

**Link mods now matches UE4SS mods, and lets you confirm every match**
- The **Link mods** button (Command Deck toolbar) used to only recognise mods
  Nexus indexes by file hash — in practice loose-pak uploads — so it couldn't
  identify UE4SS mods at all. It now also searches Nexus by name, so mods like
  script and DLL tweaks get candidate sources too.
- Because a name match is a best guess, nothing is linked automatically. Link
  mods now opens a review panel listing each unlinked mod with its candidate
  Nexus sources (with author, version, and a confidence label). Tick the ones
  you want, pick the right source from the dropdown, and press **Link selected**.
  Strong matches are pre-ticked for you; weaker guesses are shown but left for
  you to decide. Mods with no match tell you to link them by hand from their
  LOCAL badge.

## v1.8.0 (2026-09-05)

**Free Nexus accounts can now download and install without leaving the app**
- Pressing Install on a mod (or updating one, or picking a specific version)
  now opens that mod's real Nexus page inside Mod Command, in an isolated,
  themed panel. Sign in if asked, press the page's **Mod Manager Download**
  button, and the file downloads and installs right here — with a progress bar
  and an "Installed ✓" confirmation that closes the panel for you.
- This closes the one gap free accounts had: Nexus only issues download links to
  a logged-in session (never through the API), so the manager brings the page to
  you instead of sending you out to a separate browser. Premium accounts still
  install fully in-app as before, and the website "Mod Manager Download" button
  (nxm://) still works too.
- The embedded page is shown faithfully and runs in its own isolated session; a
  "Sign in to Nexus" control and an "Open in browser" fallback are always there.

## v1.7.1 (2026-09-05)

**Interface**
- The Command Deck is decluttered: the leftover "Hangar Bay" heading and its
  subtitle — a remnant of an earlier window merge — are gone. The installed-mod
  list now follows the overview cards directly, under a slim divider.
- The action buttons above the mod list are slimmer, and **Install folder** and
  **Open ~mods** moved to Settings → Shortcuts, keeping the toolbar focused on
  everyday actions (Check updates, Install archive, Import existing, Config Editor).

**Polish**
- New application icon — the app's holo emblem (a cyan hexagon with an amber
  command hub) now appears on the executable, the window, and the taskbar in
  place of the default Electron icon.

## v1.7.0 (2026-09-05)

**Interface**
- The Command Deck's overview cards are slimmer, taking less vertical space
- The config editor is renamed **Config Editor** and opens as a full-screen
  window from a button in the Hangar Bay action row (it no longer has its own
  sidebar tab); the redundant external Nexus link was removed from that row
  since in-app browsing lives in the Holonet tab
- The Hangar Bay action buttons stay on one line and shrink to fit instead of
  wrapping when the window is narrow

**Content mods built with the Zero Company Mod SDK install like any other pak mod**
- SDK packages ship two sidecars beside the pak trio — `<Mod>.AssetRegistry.bin`
  (the mod's asset registry, so the game can enumerate its new items) and
  `<Mod>.zcsdk.lua` (the runtime manifest). They now install and deploy to
  `~mods` next to the renamed paks, keeping their exact names (the runtime finds
  the manifest by suffix and resolves the registry relative to it); previously
  they were dropped as "non-pak files". Enable/disable, profiles, the version
  vault, multi-mod archives, loose-pak installs (when the folder holds one pak
  group), and Import existing (a hand-copied package in `~mods`) all carry them
- Hangar rows show a ◆ SDK chip on such mods; it turns amber ("RUNTIME MISSING")
  and installs the runtime on click while the game can't discover the content

**ZCSDK Runtime — one-click prerequisite, bundled with the app**
- Settings → ZCSDK Runtime installs the two UE4SS mods that SDK-built content
  mods need (ZCSDKBridge + ZCSDKLoader) from a package bundled with Mod Command —
  nothing to download. UE4SS is fetched first when it is missing. Installing an
  SDK-built mod without a working runtime offers the install right away
- Re-running replaces earlier copies by name (including adopted dev copies whose
  files drifted on disk) after vaulting them, keeps their UE4SS start-order
  slots, and never leaves duplicate folders; the card offers "Update to x.y"
  when the bundled package is newer or the installed copy is unversioned
- Diagnostics and support reports include the runtime's state

**Fixes**
- Zip extraction now uses Windows' own bsdtar by its full path, then the built-in
  extractor, then 7-Zip when present. A bare `tar` on the PATH could be GNU tar
  (which can't read zips), and the built-in extractor rejects the `./` directory
  entry some tools put in zips — SDK-built packages included

## v1.6.0 (2026-09-04)

**Your mod archive now lives in the game folder — and survives everything**
- The archive (installed mods, game-file backups, version vault, and a mirror
  of the manager's records) now defaults to `<game>\ZeroCompanyModArchive`.
  Deleting or updating the app no longer touches your mods: a fresh install
  finds the archive and restores everything automatically — names, versions,
  origins, enabled states, load order, squad profiles, archived versions
- Settings → Paths → Mod archive: move it anywhere (contents are copied,
  verified, then removed from the old location) or reset to the game-folder
  default. Existing installs migrate their archive automatically on first start

**Import from mod managers — not just game files**
- Import existing now also finds: orphaned entries in the manager's own
  archive (a lost settings file no longer strands your mods), a previous Mod
  Command data folder, and other managers' libraries in known locations —
  plus "Import from a manager folder…" for anywhere else
- A Mod Command archive restores with full metadata; foreign libraries import
  every mod folder as its own entry, then try to identify each on Nexus (md5)
  so names and update tracking come back

**Choose any version from the Holonet**
- Every Holonet card gains a ⧗ version picker listing all files the mod's
  Nexus page offers (newest first, with category, size, and date). Premium
  accounts install any version directly — switching an installed mod vaults
  the current version first; free accounts get routed to the exact files page
- Cards refresh in place after any install: buttons flip to "✓ Installed"
  (or "⬆ Update") immediately, without reloading the mod list from Nexus

**First-run experience**
- A setup assistant on first launch walks through game detection, getting and
  saving the Nexus API key (with a link to the key page and step-by-step
  instructions), and registering nxm:// one-click downloads; reopen it any
  time via Settings → Setup assistant
- Settings gains the same API-key guidance and link
- Holonet default sort is now Most endorsed

**Streamlined layout — five tabs instead of seven**
- The Command Deck and Hangar Bay are one tab: the operational overview on
  top, the full mod list (actions, squad profiles, Enable/Disable all) below
- Diagnostics and Load Order are one tab: compact health tiles on top (hover
  for full text), the UE4SS start order next, conflict analysis after it, and
  the pak & IoStore load order at the bottom

## v1.5.0 (2026-09-04)

**Version vault — roll back mod versions, pin them in profiles**
- Whenever a mod updates, the outgoing version is archived automatically (the
  newest 5 per mod are kept). A new ⧗ version button on every Hangar Bay row
  opens the vault: one click rolls back to any archived version — and rolling
  back archives the current version first, so you can roll forward again
- Squad profiles now pin the exact version of every mod they were saved with:
  applying a profile swaps versions back in from the vault where they differ
  (with a clear note when an archived version is no longer available)

**Game update freeze (experimental, opt-in)**
- New Settings toggle that stops the game auto-updating overnight and breaking
  a modded playthrough: it sets Steam's own "update only on launch" flag and
  locks the game's Steam manifest so no update can be scheduled, and the
  Launch button starts the game directly while frozen (a Steam launch is what
  triggers the update check). The freeze is re-asserted at startup if Steam
  unlocked the manifest, Diagnostics reports its state, and turning it off
  restores everything
- Honest limits, shown before enabling: launching from the Steam UI itself can
  still force an update, and online modes may require the current build.
  Steam installs only — EA App users get pointed at the EA App's own
  auto-update setting

**Hangar Bay & Holonet quality of life**
- Enable all / Disable all buttons (disable-all runs one aggregate file-
  ownership check first, so hand-edited files are never silently removed)
- Holonet and Forge cards now show when a mod is already installed: a green
  "IN HANGAR" badge (with a disabled note when all its entries are off), the
  Install button becomes "✓ Installed", and if an update is waiting the card
  offers "⬆ Update" directly

## v1.4.0 (2026-09-04)

**Support reports & sanitized logs**
- Diagnostics gains **Copy support report** and **Save report…**: one text
  block with everything a bug report needs — app/game/launcher/build info,
  tool status, the full mod list (type, version, origin, priorities, install
  build, EA status, pending updates), conflict pairs, UE4SS hook collisions,
  duplicates, missing deployed files, the health scan, and the session log
- Everything is sanitized before it reaches the clipboard or a file: the game
  path, the manager's data folder, your user-profile path, username, and
  machine name are replaced with placeholders; the Nexus API key is never
  included at all
- New session log: the manager records installs, enables/disables, order
  applies, update checks, guided installs, startup recovery, and every error
  in memory (nothing written to disk) — the report carries the recent tail

## v1.3.0 (2026-09-04)

**Multi-mod archives: every mod becomes its own entry**
- An archive that packs several mods now installs each as its own entry, so
  they can be enabled, ordered, updated, and removed separately:
  - every folder with `Scripts/main.lua` or `dlls/main.dll` is one UE4SS mod
    (previously only the first folder in such an archive was installed)
  - pak/utoc/ucas containers split by their containing folder — a mod that
    ships several paks in one folder stays one entry; folders under a
    `LogicMods` path keep their LogicMods deployment
  - each entry reads its own folder's `modinfo.json` for title/version/author
    and EA-compatibility declarations
  - UE4SS runtime archives, game-folder trees, and single mods never split
- Nexus/GitHub downloads that split still track their download: every entry
  carries the origin, and updating any of them replaces all sibling entries
  from a fresh download (enabled state and load-order positions are preserved
  by name across the update)
- Fixed: a Nexus/GitHub download that ships a FOMOD installer now opens the
  guided steps (previously the wizard only opened for local archive installs),
  and the finished install keeps the download's update tracking

## v1.2.0 (2026-09-04)

**EA App support — bridging the Steam and EA mod communities**
- The EA App edition of the game is now detected (registry + EA Games library
  scan, `__Installer` signature) alongside Steam installs; every mod format
  deploys identically for EA players
- Launch works for the EA edition (direct exe launch; the Launch button and
  Command Deck show which launcher owns the install)
- Per-mod EA compatibility: a mod's `modinfo.json` can declare
  `"eaCompatible": false` or `"launchers": ["steam"]`, and an owner-curated
  community list (ea-compat.json, updates live like the featured roster) flags
  known Steam-only mods by Nexus id. EA users see a red warning chip and a
  confirm before enabling; Steam users see an FYI chip so shared setups don't
  surprise EA friends. Diagnostics reports both directions

**Game-build incompatibility warnings**
- Every install/adoption records the game build it happened under (Steam
  manifest build id, or an exe fingerprint for EA/manual installs)
- When the game updates, affected mods get a "game updated" chip and a
  Diagnostics warning; after testing a mod, one click marks it verified on the
  current build

**UE4SS start order**
- New start-order panel in Load Order: drag enabled UE4SS mods; entries are
  written as one managed block in mods.txt placed just before the runtime's
  Keybinds entry, with its "do not move up" warning kept attached
- DLL-pass / Lua-pass tags reflect UE4SS's two start passes (every DLL mod
  starts before any Lua mod; order applies within each pass)
- Everything else in mods.txt — runtime entries, comments, hand-added mods —
  is preserved untouched; a managed mod hand-placed elsewhere moves into the
  block; enabled.txt markers are retired once the block is authoritative

**Linux / Proton / Steam Deck**
- Steam library discovery on Linux (native, classic, and flatpak locations),
  Proton compat-prefix detection, and an AppImage build target
- nxm:// one-click downloads register via a .desktop entry + xdg-mime
- Diagnostics gains Proton guidance (the WINEDLLOVERRIDES line UE4SS needs —
  never applied automatically) and Steam Deck notes; 7-Zip is found via p7zip
- The Launch button routes through Steam so Proton and launch options apply

## v1.1.0 (2026-09-04)

**Guided installers (FOMOD)**
- Archives that ship a FOMOD installer script now install by answering the
  author's own questions — option groups with descriptions, images and
  recommended answers, conditional steps driven by earlier choices, and a Back
  button that returns a step exactly as you left it
- Only the files your answers select are installed; they go through the same
  classification, library, and deploy pipeline as any other mod, and the
  download's update tracking keeps working
- The mod's title/version/author/description come from `fomod/info.xml`
- Installer scripts are read, never executed; every path in them is
  re-validated outside the UI before anything is written. Conditions on other
  game plugins or tool versions don't apply to Zero Company — they're shown as
  a warning and treated as unmet

**Game-folder replacement mods**
- New GAMEFILES mod type: archives laid out against the game root
  (`SWZeroCompany/...`, `Engine/...` — e.g. replacement movies) now install as
  managed mods. The original of every game file a mod replaces is backed up
  first and restored when the mod is disabled or uninstalled
- Two game-folder mods replacing the same file are flagged as a conflict on the
  exact path they both touch

**Safety**
- SHA-256 ownership: every installed and deployed file's hash is recorded.
  Disable/uninstall verifies the deployed files first — a file changed outside
  the manager stops the operation and asks before anything is deleted
- The Nexus API key is now stored encrypted with your OS user credentials
  (Windows DPAPI via Electron safeStorage); an existing plaintext key is
  migrated automatically on first start
- Archive extraction rejects path traversal and strips symbolic links

**Load order pipeline**
- Review before apply: applying a drafted order first shows every conflict pair
  and which winners change, for confirmation
- One-step rollback: “Undo last apply” restores the previous order (and undoes
  the undo if pressed again)
- Startup recovery: enabled mods whose deployed files went missing (game
  update, manual cleanup) are redeployed automatically from the library

## v1.0.0 (2026-09-01)

First public release.

**Mod management**
- Archive/folder/loose-pak installs (drag & drop), auto-classification
  (pak / IoStore / LogicMods / UE4SS mods / UE4SS runtime), enable/disable with a
  canonical mod library, rename, uninstall
- Friendly mod metadata: any mod (UE4SS or pak/IoStore) can ship a `modinfo.json`
  (`{"title", "version", "author", "description"}`) to control its display name
  and details in the Hangar Bay
- Import existing mods: adopts manually-installed mods (paks in ~mods, LogicMods,
  UE4SS folders) into full management without touching the game files. Adopted
  files matching a Nexus upload are identified automatically (md5); anything else
  can be linked by hand — click a mod's LOCAL badge to attach its Nexus page or
  curated GitHub repo so updates get tracked
- Squad profiles: save/apply/delete named mod sets with load order

**Conflict & health detection**
- CONFIRMED asset-overlap conflicts (retoc container inspection), SUSPECTED
  filename conflicts, pairwise conflict report and N×N compatibility matrix
- UE4SS hook & keybind scanning across managed and unmanaged mods
- Duplicate-mod detection: flags the same UE4SS mod active under two folders
  (double execution causes frame stutter); names each folder and which is managed
- Diagnostics: installation health scan and deployed-file audit

**Load order**
- Drag-to-reorder with priority renumbering, one-click suggested order

**Two mod sources + updates**
- Holonet: in-app Nexus Mods browser (search, category filters, sorting, paging)
  with the Featured Transmissions promo strip
- The Forge: curated GitHub mods (owner-vetted allowlist, updates live), installs
  from release archives only, behind a confirmation dialog
- nxm:// one-click download handler; Nexus API key management
- Mod update checks (automatic + on demand): GitHub mods and Nexus premium update
  in place preserving load order/names/enabled state; free Nexus accounts get a
  flagged link and the returning download replaces the old version
- Launcher update banner: the app announces when a newer launcher version is out

**Quality of life**
- Datapad: config editor for game INIs, UE4SS settings and mod configs —
  structured value editing that preserves formatting, automatic first-save backups
- UE4SS one-click runtime install
- Launch via Steam or directly; portable single-exe distribution
