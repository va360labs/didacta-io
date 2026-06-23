@echo off
set PATH=C:\nvm4w\nodejs;C:\Program Files\nodejs;C:\Program Files\Amazon\AWSCLIV2;%PATH%
cd /d D:\Test\didacta-community\modules\migrator-learndash
echo === REBUILD START %TIME% ===
call pnpm run build
if errorlevel 1 (
  echo === REBUILD FAILED rc=%ERRORLEVEL% ===
  exit /b %ERRORLEVEL%
)
echo === REBUILD DONE %TIME% ===
cd /d D:\Test\didacta-community
echo === RESIGN START %TIME% ===
call pnpm tsx scripts/marketplace/sign-package.ts ^
  --manifest ./modules/migrator-learndash/build/manifest.json ^
  --dist ./modules/migrator-learndash/dist ^
  --migrations ./modules/migrator-learndash/prisma/migrations ^
  --out ./dist/mod.migrator-learndash-1.0.8.zip ^
  --kid didacta-issuer-2026
if errorlevel 1 (
  echo === RESIGN FAILED rc=%ERRORLEVEL% ===
  exit /b %ERRORLEVEL%
)
echo === RESIGN DONE %TIME% ===
exit /b 0
