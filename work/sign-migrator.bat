@echo off
set PATH=C:\nvm4w\nodejs;C:\Program Files\nodejs;C:\Program Files\Amazon\AWSCLIV2;%PATH%
cd /d D:\Test\didacta-community
if not exist dist mkdir dist
call pnpm tsx scripts/marketplace/sign-package.ts ^
  --manifest ./modules/migrator-learndash/build/manifest.json ^
  --dist ./modules/migrator-learndash/dist ^
  --migrations ./modules/migrator-learndash/prisma/migrations ^
  --out ./dist/mod.migrator-learndash-1.0.8.zip ^
  --kid didacta-issuer-2026
echo === EXIT %ERRORLEVEL% ===
