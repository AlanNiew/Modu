# 生成「墨读」便携版 ZIP（免安装）
#
# 用法（在仓库根目录执行）：
#   pwsh -File scripts/package-portable.ps1
# 产物：
#   src-tauri/target/release/bundle/portable/墨读_<version>_portable_x64.zip
#
# 便携版内容：
#   Modu.exe                 —— 主程序（Tauri 单文件，资源已内嵌）
#   启动（便携模式）.cmd      —— 把数据目录设到同级的 ModuData\，适合放 U 盘
#   使用说明.txt             —— 首次运行与 SmartScreen 说明
#
# 说明：便携版不会消除 SmartScreen（exe 未做代码签名），但配合「先解除锁定再解压」
# 或 7-Zip 解压，可以避免解压出的文件带网络标记，双击通常不再弹提示。

param(
    [string]$Version = ""
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
if (-not $Version) {
    $conf = Get-Content (Join-Path $root 'src-tauri/tauri.conf.json') -Raw | ConvertFrom-Json
    $Version = $conf.version
}
if (-not $Version) { $Version = '0.0.0' }

$exe = Join-Path $root 'src-tauri/target/release/modu.exe'
if (-not (Test-Path $exe)) {
    throw "找不到 $exe，请先运行：pnpm tauri build --bundles nsis"
}

$outDir = Join-Path $root 'src-tauri/target/release/bundle/portable'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$stage = Join-Path ([System.IO.Path]::GetTempPath()) ("modu-portable-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $stage | Out-Null

Copy-Item $exe (Join-Path $stage 'Modu.exe')

$cmd = @'
@echo off
rem Portable mode: keep library / progress / annotations next to the executable.
set MODU_DATA_DIR=%~dp0ModuData
start "" "%~dp0Modu.exe"
'@
Set-Content -Path (Join-Path $stage '启动（便携模式）.cmd') -Value $cmd -Encoding ascii

$readme = @"
墨读（Modu）便携版 v$Version
====================================

双击 Modu.exe 直接使用，不需要安装。
数据默认存放在：%APPDATA%\com.alanview.epubreader

想做成「U 盘随身版」：
  双击「启动（便携模式）.cmd」——数据会写到本目录下的 ModuData\，
  拷走整个文件夹就把书架、进度、书签、批注一起带走。

首次运行被 Windows 拦下了？
  安装包和便携版都没有做代码签名，Windows SmartScreen 会对新下载的 exe 提示
  「已保护你的电脑 / 发布者：未知」。这不是病毒告警，处理方式：

  1) 推荐：先解除网络锁定，再解压
     - 右键这个 ZIP → 属性 → 勾选「解除锁定」→ 确定 → 再解压
     - 这样解压出来的 Modu.exe 不带网络标记，双击通常不再提示
  2) 或者：用 7-Zip 解压（7-Zip 不传播网络标记）
  3) 或者：在提示窗口点「更多信息」→「仍要运行」
  4) 或者：用 winget 安装（绕过资源管理器下载标记）

  建议顺手校验完整性（SHA-256 见发布页）：
    certutil -hashfile Modu.exe SHA256

系统要求
  Windows 10/11 x64
  Microsoft Edge WebView2 Runtime（Win11 自带；Win10 一般已随 Edge 安装）

更多说明见仓库 docs/用户手册.md。
"@
Set-Content -Path (Join-Path $stage '使用说明.txt') -Value $readme -Encoding utf8

$zip = Join-Path $outDir ("墨读_{0}_portable_x64.zip" -f $Version)
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -CompressionLevel Optimal
Remove-Item $stage -Recurse -Force

$info = Get-Item $zip
$hash = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
"portable zip: $zip"
"size: {0} bytes ({1:N2} MiB)" -f $info.Length, ($info.Length / 1MB)
"sha256: $hash"
