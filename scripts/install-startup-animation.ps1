#Requires -Version 5.1
<#
.SYNOPSIS
    给 Codex Desktop 装上启动动画所需环境，并绕开 Windows 非 ASCII 用户名下的两个缺陷。

.DESCRIPTION
    做四件事：
      1. 环境体检（-Diagnose 模式）：代码页、用户名、安装状态、插件缓存、CDP 端口
      2. 离线导入 codex-startup-transition 插件到 Code-Codex 的插件缓存
      3. 写原生开关 data\settings.json 的 startupTransitionEnabled
      4. 生成 ASCII-safe 启动器（.cmd）与桌面快捷方式

    本脚本不修改 Codex Desktop 本体，不修改官方 Codex 桌面快捷方式，不下载任何东西。

.PARAMETER PluginAsset
    codex-startup-transition 插件资产文件路径，例如
    CodeCodex-plugin-codex-startup-transition-1.0.0.js（来自 Code-Codex 的 GitHub Release 插件资产）。

.PARAMETER InstallRoot
    Code-Codex 安装根目录。默认 %LOCALAPPDATA%\Programs\Code-Codex

.PARAMETER TempRoot
    ASCII 临时目录根。默认自动选择 %PUBLIC%\CodexSplash 或 %SystemDrive%\CodexSplash

.PARAMETER SkipShortcut
    不创建桌面快捷方式。

.PARAMETER Diagnose
    只做体检，不修改 Codex / Code-Codex 的任何状态。
    注：体检里包含一次真实的 Add-Type 实测，会创建/复用一个 ASCII 临时目录（默认
    %PUBLIC%\CodexSplash）。除此之外不写任何文件。

.EXAMPLE
    .\install-startup-animation.ps1 -Diagnose

.EXAMPLE
    .\install-startup-animation.ps1 -PluginAsset .\CodeCodex-plugin-codex-startup-transition-1.0.0.js
#>
[CmdletBinding()]
param(
    [string]$PluginAsset,
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'Programs\Code-Codex'),
    [string]$TempRoot,
    [switch]$SkipShortcut,
    [switch]$Diagnose
)

$ErrorActionPreference = 'Stop'
$script:Problems = @()
$script:Notes    = @()

function Write-Head($t) { Write-Host ''; Write-Host "=== $t ===" -ForegroundColor Cyan }
function Write-Ok($t)   { Write-Host "  [ok]   $t" -ForegroundColor Green }
function Write-Warn2($t){ Write-Host "  [warn] $t" -ForegroundColor Yellow; $script:Notes += $t }
function Write-Bad($t)  { Write-Host "  [FAIL] $t" -ForegroundColor Red;  $script:Problems += $t }

function Test-AsciiPath {
    param([string]$Path)
    if ([string]::IsNullOrEmpty($Path)) { return $false }
    return ($Path -notmatch '[^\x00-\x7F]')
}

function Get-CodePage {
    try {
        $out = & "$env:SystemRoot\System32\chcp.com" 2>$null
        if ($out -match '(\d+)') { return [int]$Matches[1] }
    } catch { }
    return $null
}

function Resolve-AsciiTempRoot {
    param([string]$Preferred)
    $candidates = @()
    if ($Preferred) { $candidates += $Preferred }
    if ($env:PUBLIC) { $candidates += (Join-Path $env:PUBLIC 'CodexSplash') }
    if ($env:SystemDrive) { $candidates += (Join-Path $env:SystemDrive 'CodexSplash') }
    foreach ($c in $candidates) {
        if (-not (Test-AsciiPath $c)) { continue }
        try {
            New-Item -ItemType Directory -Force -Path $c | Out-Null
            $probe = Join-Path $c '.write-probe'
            [IO.File]::WriteAllText($probe, 'x'); Remove-Item $probe -Force
            return $c
        } catch { continue }
    }
    throw 'No writable ASCII temp directory found. Pass -TempRoot with an ASCII path.'
}

# ---------------------------------------------------------------- 1. 体检

Write-Head '环境体检'

$codePage = Get-CodePage
$profile  = $env:USERPROFILE
$profileAscii = Test-AsciiPath $profile
$tempAscii    = Test-AsciiPath $env:TEMP

Write-Host ("  user profile    : {0}" -f $profile)
Write-Host ("  profile is ASCII: {0}" -f $profileAscii)
Write-Host ("  active code page: {0}" -f $codePage)
Write-Host ("  TEMP            : {0}  (ASCII: {1})" -f $env:TEMP, $tempAscii)

if (-not $profileAscii -and $codePage -ne 65001) {
    Write-Warn2 '用户名含非 ASCII 且代码页不是 65001 —— 本仓库针对的两个缺陷都会命中（预期之内，脚本已自带绕行）。'
}

# Add-Type 可用性实测：这是缺陷 B 的直接判据
$addTypeOk = $false
$addTypeErr = $null
try {
    Add-Type -TypeDefinition 'public class CodexSplashProbe { public static int V(){ return 1; } }' -ErrorAction Stop
    $addTypeOk = $true
} catch {
    $addTypeErr = ($_.Exception.Message -split "`n")[0]
}
if ($addTypeOk) { Write-Ok 'Add-Type (default TEMP) works' }
else { Write-Bad ("Add-Type with default TEMP fails: " + $addTypeErr) }

# 切到 ASCII TEMP 后应当成功
try {
    $asciiTemp = Resolve-AsciiTempRoot -Preferred $TempRoot
    Write-Host ("  ASCII temp root : {0}" -f $asciiTemp)
    $savedTemp = $env:TEMP; $savedTmp = $env:TMP
    $env:TEMP = Join-Path $asciiTemp 'tmp'; $env:TMP = $env:TEMP
    New-Item -ItemType Directory -Force -Path $env:TEMP | Out-Null
    Add-Type -TypeDefinition 'public class CodexSplashProbe2 { public static int V(){ return 2; } }' -ErrorAction Stop
    Write-Ok 'Add-Type works with ASCII TEMP  → 启动器必须设置 TEMP/TMP'
    $env:TEMP = $savedTemp; $env:TMP = $savedTmp
} catch {
    Write-Bad ("Add-Type with ASCII TEMP also failed: " + ($_.Exception.Message -split "`n")[0])
}

# Code-Codex 安装状态
Write-Head 'Code-Codex 安装状态'
Write-Host ("  install root    : {0}" -f $InstallRoot)
if (-not (Test-Path $InstallRoot)) { Write-Bad 'InstallRoot 不存在 —— 请先安装 Code-Codex。' }
else {
    $current = Join-Path $InstallRoot 'current-version'
    if (Test-Path $current) {
        $ver = (Get-Content $current -Raw).Trim()
        Write-Ok ("current-version = {0}" -f $ver)
        $cli = Join-Path $InstallRoot "versions\$ver\code-codex.exe"
        if (Test-Path $cli) { Write-Ok '版本目录完整（code-codex.exe 存在）' }
        else { Write-Bad ("versions\{0}\code-codex.exe 缺失 —— 官方安装器很可能在 Updating shortcuts 阶段回滚了，需要手工补齐安装目录。" -f $ver) }
    } else {
        Write-Bad 'current-version 缺失 —— 安装未提交。'
    }

    $pluginDir = Join-Path $InstallRoot 'plugins\appearance\codex-startup-transition'
    if (Test-Path $pluginDir) {
        $v = Get-ChildItem $pluginDir -Directory | Select-Object -First 1
        Write-Ok ("插件缓存已存在：{0}" -f $v.Name)
    } else {
        Write-Warn2 '插件缓存中没有 codex-startup-transition —— 需要 -PluginAsset 导入。'
    }

    $settings = Join-Path $InstallRoot 'data\settings.json'
    if (Test-Path $settings) {
        $s = Get-Content $settings -Raw | ConvertFrom-Json
        Write-Host ("  startupTransitionEnabled = {0}" -f $s.startupTransitionEnabled)
    } else {
        Write-Warn2 'data\settings.json 不存在（应用尚未启动过）。'
    }
}

# CDP 端口
Write-Head 'Codex 运行状态'
$proc = Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match 'remote-debugging-port=(\d+)' } | Select-Object -First 1
if ($proc) {
    $port = [regex]::Match($proc.CommandLine, 'remote-debugging-port=(\d+)').Groups[1].Value
    Write-Ok ("Codex 正通过 Code-Codex 运行，CDP 端口 {0}" -f $port)
} else {
    $any = Get-Process ChatGPT -ErrorAction SilentlyContinue
    if ($any) { Write-Warn2 'Codex 在运行但**没有** CDP 端口 —— 说明不是通过 Code-Codex 启动的，动画不会出现。请完全退出后改用启动器。' }
    else { Write-Host '  Codex 未运行。' }
}

if ($Diagnose) {
    Write-Head '结论'
    if ($script:Problems.Count -eq 0) { Write-Host '  未发现阻断性问题。' -ForegroundColor Green }
    else { $script:Problems | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red } }
    if ($script:Notes.Count -gt 0) { Write-Host '  提示：'; $script:Notes | ForEach-Object { Write-Host "  - $_" -ForegroundColor Yellow } }
    return
}

# ---------------------------------------------------------------- 2. 导入插件

Write-Head '导入启动动画插件'

if ($PluginAsset) {
    if (-not (Test-Path $PluginAsset)) { throw "PluginAsset 不存在：$PluginAsset" }
    $assetName = Split-Path $PluginAsset -Leaf
    if ($assetName -notmatch 'startup-transition') {
        Write-Warn2 "文件名不以 startup-transition 命名（$assetName），仍按 codex-startup-transition 处理。"
    }

    $stage = Join-Path $asciiTemp 'plugin-import'
    $target = Join-Path $stage 'plugins\appearance\codex-startup-transition'
    New-Item -ItemType Directory -Force -Path $target | Out-Null
    Copy-Item -LiteralPath $PluginAsset -Destination (Join-Path $target $assetName) -Force

    $ver2 = (Get-Content (Join-Path $InstallRoot 'current-version') -Raw).Trim()
    $cli = Join-Path $InstallRoot "versions\$ver2\code-codex.exe"
    if (-not (Test-Path $cli)) { throw "找不到 code-codex.exe：$cli" }

    Write-Host "  运行：code-codex.exe plugins --import-dir `"$stage`""
    & $cli plugins --import-dir $stage 2>&1 | ForEach-Object { Write-Host "    $_" }
    if ($LASTEXITCODE -ne 0) { Write-Bad ("插件导入命令返回 {0}" -f $LASTEXITCODE) }

    $listed = & $cli plugins 2>&1 | Out-String
    if ($listed -match 'codex-startup-transition') {
        $entry = ($listed | ConvertFrom-Json | Where-Object { $_.id -eq 'codex-startup-transition' })
        if ($entry.installed) { Write-Ok '插件已导入（installed=true）' }
        else { Write-Bad '插件存在但 installed=false —— 资产可能不匹配内置目录（大小/SHA-256 校验失败）。' }
    } else {
        Write-Bad '导入后未能从插件列表读到 codex-startup-transition。'
    }
} else {
    Write-Warn2 '未提供 -PluginAsset，跳过插件导入。'
}

# ---------------------------------------------------------------- 3. 写原生开关

Write-Head '写原生开关'

$dataDir = Join-Path $InstallRoot 'data'
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
$settingsPath = Join-Path $dataDir 'settings.json'
$settingsObj = $null
if (Test-Path $settingsPath) {
    try { $settingsObj = Get-Content $settingsPath -Raw | ConvertFrom-Json } catch { $settingsObj = $null }
}
if (-not $settingsObj) { $settingsObj = [pscustomobject]@{} }
if ($settingsObj.PSObject.Properties.Name -contains 'startupTransitionEnabled') {
    $settingsObj.startupTransitionEnabled = $true
} else {
    $settingsObj | Add-Member -NotePropertyName startupTransitionEnabled -NotePropertyValue $true -Force
}
$json = $settingsObj | ConvertTo-Json -Depth 6
[IO.File]::WriteAllText($settingsPath, $json, [Text.UTF8Encoding]::new($false))
Write-Ok "startupTransitionEnabled = true  →  $settingsPath"
Write-Warn2 '应用运行时会重写该文件；渲染进程若发现 localStorage 里 enabled=true 也会自动把它同步回来，属正常行为。'

# ---------------------------------------------------------------- 4. 生成启动器

Write-Head '生成 ASCII-safe 启动器'

$launcherDir = Join-Path $asciiTemp 'launcher'
New-Item -ItemType Directory -Force -Path $launcherDir | Out-Null
$launcherCmd = Join-Path $launcherDir 'codex-splash-launch.cmd'
$tempForCmd  = Join-Path $asciiTemp 'tmp'

$cmd = @"
@echo off
rem Codex splash launcher - generated by codex-splash-kit
rem ASCII TEMP is REQUIRED: csc/Add-Type cannot write into a non-ASCII profile temp path.
setlocal
if not exist "$tempForCmd" mkdir "$tempForCmd" >nul 2>&1
set "TEMP=$tempForCmd"
set "TMP=$tempForCmd"
set "ROOT=%LOCALAPPDATA%\Programs\Code-Codex"
if not exist "%ROOT%\current-version" (
  echo [codex-splash] Code-Codex install not found at %ROOT% 1>&2
  exit /b 1
)
set "VER="
for /f "usebackq delims=" %%v in ("%ROOT%\current-version") do set "VER=%%v"
if not exist "%ROOT%\versions\%VER%\code-codex.exe" (
  echo [codex-splash] Missing %ROOT%\versions\%VER%\code-codex.exe 1>&2
  exit /b 1
)
start "" "%ROOT%\versions\%VER%\code-codex.exe" run
exit /b 0
"@
[IO.File]::WriteAllText($launcherCmd, $cmd, [Text.ASCIIEncoding]::new())
Write-Ok "启动器已生成：$launcherCmd"

if (-not $SkipShortcut) {
    $desktop = [Environment]::GetFolderPath('Desktop')
    $lnkName = 'Codex (Code-Codex).lnk'
    $lnkAscii = Join-Path $launcherDir $lnkName
    $lnkFinal = Join-Path $desktop $lnkName
    $created = $false
    try {
        if (-not (Test-AsciiPath $launcherCmd) -or -not (Test-AsciiPath $lnkAscii)) { throw 'non-ASCII path on the ASCII side' }
        $sh = New-Object -ComObject WScript.Shell
        $l = $sh.CreateShortcut($lnkAscii)
        $l.TargetPath       = "$env:SystemRoot\System32\cmd.exe"
        $l.Arguments        = ('/c "{0}"' -f $launcherCmd)
        $l.WorkingDirectory = "$env:SystemRoot\System32"
        $l.Description      = 'Launch Codex Desktop via Code-Codex (startup animation)'
        $l.WindowStyle      = 7
        $l.Save()
        Copy-Item -LiteralPath $lnkAscii -Destination $lnkFinal -Force
        $created = (Test-Path -LiteralPath $lnkFinal)
    } catch {
        Write-Warn2 ("快捷方式创建失败（预期内的非 ASCII 缺陷：" + ($_.Exception.Message -split "`n")[0] + "）")
    }
    if ($created) { Write-Ok "桌面快捷方式：$lnkFinal" }
    else {
        Write-Warn2 "请手动创建快捷方式：目标 cmd.exe，参数 /c `"$launcherCmd`""
    }
}

# ---------------------------------------------------------------- 收尾

Write-Head '下一步'
Write-Host '  1. 完全退出 Codex（含托盘进程）'
Write-Host '  2. 双击桌面上的 "Codex (Code-Codex)"'
Write-Host '  3. 在 Codex 里打开 Code-Codex 菜单 → Preview Market → Appearance'
Write-Host '     → Codex Startup Transition → Enable'
Write-Host '  4. 用 scripts\import-startup-video.ps1 导入你自己的启动视频'
Write-Host ''
Write-Host '  注意：若 Codex 已在运行（哪怕是自己重启的），注入器会拒绝并报 CC-START-STATE-001，' -ForegroundColor Yellow
Write-Host '        那一次启动不会有动画 —— 必须先完全退出再从这个入口启动。' -ForegroundColor Yellow
