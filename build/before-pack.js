'use strict';
// electron-builder beforePack hook: a Windows build compiles the standalone
// uninstaller first, so extraResources can embed it (resources/uninstaller/bin)
// and after-all-artifacts.js can put it next to ModCommandX.exe.
const { build } = require('./build-uninstaller');

exports.default = async function beforePack(context) {
  if (context.electronPlatformName !== 'win32') return;
  build();
};
