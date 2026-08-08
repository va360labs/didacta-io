@echo off
REM ===========================================================================
REM Wrapper Windows para scripts/test-local.sh.
REM Política activa desde 2026-05-01: pruebas SOLO en local sobre Docker Desktop
REM CI no ejecuta tests.
REM
REM Uso:
REM   scripts\test-local.cmd                full (pre-flight + build + unit + integ)
REM   scripts\test-local.cmd unit           solo unit
REM   scripts\test-local.cmd integ          solo integración
REM ===========================================================================

setlocal

REM Buscar Git Bash (en Windows Docker Desktop incluye Git, pero no garantizado).
set "BASH_BIN="
if exist "C:\Program Files\Git\bin\bash.exe" set "BASH_BIN=C:\Program Files\Git\bin\bash.exe"
if not defined BASH_BIN if exist "C:\Program Files (x86)\Git\bin\bash.exe" set "BASH_BIN=C:\Program Files (x86)\Git\bin\bash.exe"

if not defined BASH_BIN (
  echo [test-local] ERROR: no se encontro bash.exe (Git Bash). Instala Git for Windows.
  exit /b 1
)

"%BASH_BIN%" "%~dp0test-local.sh" %*
exit /b %ERRORLEVEL%
