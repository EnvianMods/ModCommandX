@echo off
cd /d "%~dp0"
if "%~1"=="" (
  echo Usage: "Publish Release.bat" 1.2.0 "path\to\ModCommandX-v1.2.0.zip" --notes "what's new"
  echo        creates the GitHub Release on EnvianMods/ModCommandX and uploads the zip
  echo        (it must contain ModCommandX.exe AND "Uninstall Mod Command X.exe");
  echo        more files after the zip are uploaded as extra assets;
  echo        installed copies of Mod Command X pick it up from there.
  echo        add --show to list existing releases.
  pause
  exit /b 1
)
node publish-release.js %*
pause
