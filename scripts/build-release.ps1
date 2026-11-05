# 一键发布：签名构建 → 生成 latest.json → 打包便携版
#
# 用法（在仓库根目录执行）：
#   pwsh -File scripts/build-release.ps1 -Version 0.3.1
#   pwsh -File scripts/build-release.ps1 -Version 0.3.1 -NotesFile docs/release-notes/v0.3.1.md
#
# 前置：
#   1. 三处版本号已改成 -Version（package.json / src-tauri/Cargo.toml / tauri.conf.json）
#   2. 签名密钥在仓库外：D:\Programing\AI_Code\deepseek\_modu-updater\env.ps1
#      会注入 TAURI_SIGNING_PRIVATE_KEY / TAURI_SIGNING_PRIVATE_KEY_PASSWORD
#
# 产物（src-tauri/target/release/bundle/）：
#   nsis/     安装包 .exe + .exe.sig + latest.json
#   portable/ 便携版 ZIP
#
# 发布：到 GitHub 建 v<Version> Release，上传 安装包、便携 ZIP、latest.json。

param(
    [Parameter(Mandatory = $true)][string]$Version,
    [string]$NotesFile = "",
    [string]$KeyEnvFile = "D:\Programing\AI_Code\deepseek\_modu-updater\env.ps1"
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $root

if (-not $NotesFile) {
    $NotesFile = Join-Path $root "docs/release-notes/v$Version.md"
}

# 1) 版本一致性检查：三处必须都是同一个版本，避免发出「清单写 0.3.1、程序还是 0.3.0」的包。
$pkg = Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
$conf = Get-Content (Join-Path $root 'src-tauri/tauri.conf.json') -Raw | ConvertFrom-Json
$cargo = Get-Content (Join-Path $root 'src-tauri/Cargo.toml') -Raw
$cargoVersion = [regex]::Match($cargo, '(?m)^version = "([^"]+)"').Groups[1].Value
if ($pkg.version -ne $Version -or $conf.version -ne $Version -or $cargoVersion -ne $Version) {
    throw "版本号不一致：package.json=$($pkg.version) tauri.conf.json=$($conf.version) Cargo.toml=$cargoVersion，期望 $Version"
}

# 2) 签名密钥（仓库外）
if (-not (Test-Path $KeyEnvFile)) {
    throw "找不到签名密钥环境文件：$KeyEnvFile`n请先运行 pnpm tauri signer generate 并保存私钥与密码。"
}
. $KeyEnvFile
if (-not $env:TAURI_SIGNING_PRIVATE_KEY -or -not $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD) {
    throw "签名环境变量未就绪（需要在 env.ps1 里设置 TAURI_SIGNING_PRIVATE_KEY / _PASSWORD）"
}

Set-Location $root
Write-Host "== 构建 v$Version（签名）==" -ForegroundColor Cyan
pnpm tauri build --bundles nsis
if ($LASTEXITCODE -ne 0) { throw "构建失败（exit $LASTEXITCODE）" }

$nsisDir = Join-Path $root 'src-tauri/target/release/bundle/nsis'
$exe = Get-ChildItem $nsisDir -Filter "*_${Version}_x64-setup.exe" | Select-Object -First 1
if (-not $exe) { throw "找不到安装包：$nsisDir\*_${Version}_x64-setup.exe" }
$sig = "$($exe.FullName).sig"
if (-not (Test-Path $sig)) {
    throw "找不到签名文件：$sig（检查 createUpdaterArtifacts / 签名环境变量）"
}

Write-Host "== 生成 latest.json ==" -ForegroundColor Cyan
node (Join-Path $root 'scripts/make-latest-json.mjs') `
    --version $Version `
    --exe $exe.FullName `
    --sig $sig `
    --notes $NotesFile `
    --out (Join-Path $nsisDir 'latest.json')
if ($LASTEXITCODE -ne 0) { throw "latest.json 生成失败" }

Write-Host "== 打包便携版 ==" -ForegroundColor Cyan
pwsh -NoProfile -File (Join-Path $root 'scripts/package-portable.ps1') -Version $Version
if ($LASTEXITCODE -ne 0) { throw "便携版打包失败" }

$portable = Join-Path $root "src-tauri/target/release/bundle/portable/墨读_${Version}_portable_x64.zip"

Write-Host ""
Write-Host "== 完成 ==" -ForegroundColor Green
Write-Host "安装包     : $($exe.FullName)"
Write-Host "签名       : $sig"
Write-Host "更新清单   : $(Join-Path $nsisDir 'latest.json')"
if (Test-Path $portable) { Write-Host "便携包     : $portable" }
Write-Host ""
Write-Host "SHA-256（安装包）:" -ForegroundColor Cyan
(Get-FileHash $exe.FullName -Algorithm SHA256).Hash.ToLower()
Write-Host ""
Write-Host "下一步：GitHub 建 v$Version Release，上传 安装包 / 便携 ZIP / latest.json"
