'use strict';
// OWNER TOOL — builds the Mod Command X SOURCE package: the app's source plus
// Build.bat, with every binary left out, for attaching to a GitHub release of
// EnvianMods/ModCommandX next to the ready-made exe. Users run Build.bat, which
// installs the build dependencies with npm, fetches the excluded tools (7-Zip,
// retoc, ZCSDK Runtime) from their official sources and produces the same
// portable exe. X is never published on Nexus Mods.
//
// Usage: node package-source-release.js [--version 1.0.0] [--out <zipPath>]
//   version defaults to RELEASE_VERSION.txt.
//   Output: release/ModCommandX-Source-v<version>.zip
// Needs: PowerShell (robocopy for the snapshot) and tools/7-Zip/7z.exe to zip.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const arg = (flag, dflt) => { const i = process.argv.indexOf(flag); return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt; };
const version = arg('--version', fs.readFileSync(path.join(REPO, 'RELEASE_VERSION.txt'), 'utf8').trim());
const internal = require(path.join(REPO, 'package.json')).version;
const out = path.resolve(arg('--out', path.join(REPO, 'release', `ModCommandX-Source-v${version}.zip`)));
const sevenZip = path.join(REPO, 'tools', '7-Zip', '7z.exe');
if (!fs.existsSync(sevenZip)) { console.error('tools/7-Zip/7z.exe is missing.'); process.exit(1); }

const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'mcx-source-'));
const root = path.join(stage, `ModCommandX-Source-v${version}`);
fs.mkdirSync(root);

// Folders and files that never ship: dev state, secrets, build output, and
// every binary (fetched by Build.bat instead).
const XD = ['node_modules', 'release', 'data', '.git', 'zcbak', 'owner-tools', 'docs', '7-Zip'];
// No script-type files either (kept from the upstream package, whose file host
// quarantined a trivial .bat): Build.bat ships as Build.bat.txt.
const XF = ['*token*.txt', 'nexus-key.txt', '*.exe', '*.dll', '*.bat', '*.cmd', '*.ps1', '*.py', '*.vbs', 'ZCSDKRuntime.zip', 'zcsdk-runtime.json', 'BUNDLED.txt', 'HANDOFF.md', 'DESCRIPTION.txt', '*.log', 'Thumbs.db', '.DS_Store'];
const rc = spawnSync('robocopy', [REPO, root, '/E', '/XD', ...XD, '/XF', ...XF, '/NFL', '/NDL', '/NJH', '/NJS'], { stdio: 'inherit' });
if (rc.status >= 8) { console.error('robocopy failed'); process.exit(1); }

fs.copyFileSync(path.join(REPO, 'Build.bat'), path.join(root, 'Build.bat.txt'));
fs.writeFileSync(path.join(root, 'README-BUILD.txt'), [
  `MOD COMMAND X v${version} - BUILD FROM SOURCE`,
  'A private side-by-side build of Zero Company Mod Command for STAR WARS: Zero Company.',
  '',
  'This package is the full source of Mod Command X plus a one-click build script.',
  'You build the exe yourself in a couple of minutes and get exactly the build',
  `published at https://github.com/EnvianMods/ModCommandX/releases (v${internal}).`,
  '',
  'HOW TO BUILD (one command)',
  '1. Install Node.js LTS from https://nodejs.org/ (accept the defaults). Once only.',
  '2. Unzip this package anywhere - for example Documents\\ModCommandX.',
  '3. Open a command prompt IN this folder: click the folder\'s address bar in File',
  '   Explorer, type   cmd   and press Enter.',
  '4. Type   npm run build   and press Enter. It installs the build dependencies',
  '   (about 150 MB, once), fetches the bundled tools from their official sources',
  '   (7-Zip, retoc, the ZCSDK Runtime) and builds release\\ModCommandX.exe.',
  '5. Run release\\ModCommandX.exe (move it anywhere you like). Your mods and',
  '   settings live in %APPDATA%\\ModCommandX, so rebuilding or updating never',
  '   touches them.',
  '',
  'PREFER DOUBLE-CLICK? The one-click script ships as Build.bat.txt: rename it to',
  'Build.bat (File Explorer > View > "File name extensions" makes the .txt visible)',
  'and double-click it. It does the same steps and puts ModCommandX.exe next to itself.',
  '',
  'UPDATING LATER',
  'Unzip the new package over the old folder (or into a fresh one) and run the build',
  'again. Mod Command X also shows an update banner when a new release is out.',
  '',
  'WHAT BUILD.BAT DOWNLOADS',
  '- Electron + electron-builder via npm (the app framework and packager)',
  '- 7-Zip 25.01 (https://www.7-zip.org/, LGPL) for .7z/.rar mod archives',
  '- retoc 0.1.5 (https://github.com/trumank/retoc) to list files inside pak mods',
  '- the newest ZCSDK Runtime (https://github.com/EnvianMods/ZCSDK-Runtime-Release)',
  'Everything else is in this folder. See README.md for the full feature list and',
  'CHANGELOG.md for what changed.',
  '',
].join('\r\n'));

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.rmSync(out, { force: true });
execFileSync(sevenZip, ['a', '-tzip', '-mx=5', '-r', out, path.join(stage, '*')], { stdio: 'ignore' });

// Prove the package is binary-free before it is attached to a release.
const listing = execFileSync(sevenZip, ['l', '-ba', out], { encoding: 'utf8' });
const bad = listing.split(/\r?\n/).filter((l) => /\.(exe|dll|zip|7z|rar|msi|sys|scr|com)\s*$/i.test(l.trim()));
if (bad.length) { console.error('Binaries or nested archives found in the package:\n' + bad.join('\n')); process.exit(1); }
const files = listing.split(/\r?\n/).filter((l) => l.trim() && !/\sD[.A-Z]{4}\s/.test(l)).length;
fs.rmSync(stage, { recursive: true, force: true });
console.log(`${path.basename(out)} — v${version}, ${files} files, ${(fs.statSync(out).size / 1048576).toFixed(1)} MB, no binaries.`);
console.log('Attach it to the GitHub release with: node publish-release.js ' + version + ' "' + out + '"');
