'use strict';
// electron-builder afterAllArtifactBuild hook: a Windows build ships
// "Uninstall Mod Command X.exe" next to ModCommandX.exe in the output folder
// (release/ by default) and reports it as an extra artifact.
const fs = require('fs');
const path = require('path');
const { OUT_EXE, EXE_NAME } = require('./build-uninstaller');

exports.default = async function afterAllArtifactBuild(result) {
  const winBuilt = (result.artifactPaths || []).some((p) => /\.exe$/i.test(p));
  if (!winBuilt) return [];
  if (!fs.existsSync(OUT_EXE)) throw new Error(`${EXE_NAME} was not built (beforePack) — cannot ship the release without it`);
  const dest = path.join(result.outDir, EXE_NAME);
  fs.copyFileSync(OUT_EXE, dest);
  console.log(`  • ${EXE_NAME} copied to ${dest}`);
  return [dest];
};
