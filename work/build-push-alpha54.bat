@echo off
set PATH=C:\Program Files\Docker\Docker\resources\bin;C:\Program Files\Git\cmd;%PATH%
cd /d D:\Test\didacta-community
echo === BUILD START %TIME% ===
docker build --build-arg DIDACTA_VERSION=0.0.1-alpha.54 -t didactaio/community:0.0.1-alpha.54 .
set BUILD_RC=%ERRORLEVEL%
if not "%BUILD_RC%"=="0" (
  echo === BUILD FAILED rc=%BUILD_RC% ===
  exit /b %BUILD_RC%
)
echo === BUILD DONE %TIME% ===
echo === PUSH START %TIME% ===
docker push didactaio/community:0.0.1-alpha.54
set PUSH_RC=%ERRORLEVEL%
if not "%PUSH_RC%"=="0" (
  echo === PUSH FAILED rc=%PUSH_RC% ===
  exit /b %PUSH_RC%
)
echo === PUSH DONE %TIME% ===
docker inspect --format "DIGEST {{index .RepoDigests 0}}" didactaio/community:0.0.1-alpha.54
echo === ALL OK ===
exit /b 0
