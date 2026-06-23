@echo off
set PATH=C:\nvm4w\nodejs;C:\Program Files\nodejs;%PATH%
cd /d D:\Test\didacta-community\apps\api
call D:\Test\didacta-community\node_modules\.bin\vitest.CMD run tests/marketplace
