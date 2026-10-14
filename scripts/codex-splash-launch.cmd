@echo off
rem ============================================================================
rem  codex-splash-launch.cmd  -  REFERENCE TEMPLATE
rem
rem  This is the shape of the launcher that
rem  scripts\install-startup-animation.ps1 generates (it bakes in the ASCII temp
rem  directory it detected and verifies the paths). If you prefer to do it by
rem  hand, copy this file and edit the two marked lines.
rem
rem  WHY ASCII TEMP:
rem    On Windows with a non-ASCII user profile path (e.g. C:\Users\<non-ASCII>),
rem    PowerShell's Add-Type shells out to csc.exe which writes into %TEMP% and
rem    fails with "Could not write to output file ... The directory name is
rem    invalid." Any launcher that compiles a C# helper at startup dies.
rem    Pointing TEMP/TMP at an ASCII directory fixes it.
rem ============================================================================
setlocal

rem --- EDIT 1: an ASCII, user-writable temp directory ---
set "SPLASH_TMP=%PUBLIC%\CodexSplash\tmp"
if not exist "%SPLASH_TMP%" mkdir "%SPLASH_TMP%" >nul 2>&1
set "TEMP=%SPLASH_TMP%"
set "TMP=%SPLASH_TMP%"

rem --- EDIT 2: Code-Codex install root (usually correct as-is) ---
set "ROOT=%LOCALAPPDATA%\Programs\Code-Codex"

if not exist "%ROOT%\current-version" (
  echo [codex-splash] Code-Codex not found at "%ROOT%" 1>&2
  exit /b 1
)

set "VER="
for /f "usebackq delims=" %%v in ("%ROOT%\current-version") do set "VER=%%v"

if not exist "%ROOT%\versions\%VER%\code-codex.exe" (
  echo [codex-splash] Missing "%ROOT%\versions\%VER%\code-codex.exe" 1>&2
  echo [codex-splash] The official installer probably rolled back. See docs\windows-non-ascii-pitfalls.md 1>&2
  exit /b 1
)

rem `start ""` detaches so this console window can close immediately.
start "" "%ROOT%\versions\%VER%\code-codex.exe" run
exit /b 0
