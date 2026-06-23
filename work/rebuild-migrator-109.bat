@echo off
set PATH=C:\nvm4w\nodejs;C:\Program Files\nodejs;C:\Program Files\Amazon\AWSCLIV2;%PATH%
cd /d D:\Test\didacta-community\modules\migrator-learndash
echo === REBUILD START %TIME% ===
call pnpm run build
if errorlevel 1 (echo BUILD FAILED & exit /b 1)
echo === REBUILD DONE %TIME% ===
cd /d D:\Test\didacta-community
echo === SIGN 1.0.9 START %TIME% ===
call pnpm tsx scripts/marketplace/sign-package.ts ^
  --manifest ./modules/migrator-learndash/build/manifest.json ^
  --dist ./modules/migrator-learndash/dist ^
  --migrations ./modules/migrator-learndash/prisma/migrations ^
  --out ./dist/mod.migrator-learndash-1.0.9.zip ^
  --kid didacta-issuer-2026
if errorlevel 1 (echo SIGN FAILED & exit /b 1)
echo === SIGN DONE %TIME% ===
exit /b 0
