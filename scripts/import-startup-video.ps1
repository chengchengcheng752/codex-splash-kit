#Requires -Version 5.1
<#
.SYNOPSIS
    把你自己的视频导入为 Codex 启动动画（走应用自己的导入流程）。

.DESCRIPTION
    data\media\startup\ 是受管存储：手动拷进去的 mp4 会在应用下次启动时被删除。
    必须通过插件面板的视频选择器导入，本脚本用 CDP 直接驱动那个 <input type="file">，
    等价于你自己点一次"选择视频"。

    前提：Codex 正通过 Code-Codex 运行（存在回环 CDP 端口）。

.PARAMETER Video
    视频绝对路径。

.PARAMETER Port
    CDP 端口。省略时自动从 ChatGPT.exe 的 --remote-debugging-port 参数读取。

.PARAMETER NodePath
    node.exe 路径。省略时从 PATH 查找。

.EXAMPLE
    .\import-startup-video.ps1 -Video .\my-splash.mp4
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Video,
    [int]$Port,
    [string]$NodePath
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Video)) { throw "视频不存在：$Video" }
$Video = (Resolve-Path -LiteralPath $Video).Path
$size = (Get-Item -LiteralPath $Video).Length
Write-Host ("video : {0}  ({1:N0} bytes)" -f $Video, $size)

if (-not $Port) {
    $proc = Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -match 'remote-debugging-port=(\d+)' } | Select-Object -First 1
    if (-not $proc) {
        throw 'No CDP port found. Codex must be running *through Code-Codex*. ' +
              'Fully quit Codex and start it with the generated launcher, then retry.'
    }
    $Port = [int][regex]::Match($proc.CommandLine, 'remote-debugging-port=(\d+)').Groups[1].Value
}
Write-Host ("cdp   : 127.0.0.1:{0}" -f $Port)

if (-not $NodePath) {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if (-not $cmd) { throw 'node.exe not found on PATH. Pass -NodePath.' }
    $NodePath = $cmd.Source
}
Write-Host ("node  : {0}" -f $NodePath)

$lib = Join-Path $PSScriptRoot 'lib\import-startup-video.mjs'
if (-not (Test-Path -LiteralPath $lib)) { throw "缺少脚本：$lib" }

& $NodePath $lib --video $Video --port $Port
$code = $LASTEXITCODE

# 复核受管存储是否一致
$store = Join-Path $env:LOCALAPPDATA 'Programs\Code-Codex\data\media\startup'
if (Test-Path -LiteralPath $store) {
    Write-Host ''
    Write-Host '--- managed store ---'
    $idx = Get-ChildItem -LiteralPath $store -File -Filter '*.json' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($idx) {
        $rec = Get-Content -LiteralPath $idx.FullName -Raw | ConvertFrom-Json
        $blob = Join-Path $store (Join-Path $rec.job 'blob')
        $blobSize = if (Test-Path -LiteralPath $blob) { (Get-Item -LiteralPath $blob).Length } else { 0 }
        Write-Host ("name          : {0}" -f $rec.record.name)
        Write-Host ("duration      : {0} s" -f $rec.record.duration)
        Write-Host ("blob size     : {0:N0} bytes" -f $blobSize)
        Write-Host ("source size   : {0:N0} bytes" -f $size)
        if ($blobSize -eq $size) {
            Write-Host 'integrity     : OK (blob size == source size)' -ForegroundColor Green
        } else {
            Write-Host 'integrity     : MISMATCH - the import was probably interrupted. Re-run this script.' -ForegroundColor Red
            Write-Host '                (an interrupted import leaves a truncated blob and does not update the index)' -ForegroundColor Yellow
        }
    } else {
        Write-Host '(no index json yet)'
    }
}

exit $code
