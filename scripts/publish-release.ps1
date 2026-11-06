# 发布到 GitHub Release，并在发布后校验「更新链路真的可用」。
#
# 背景（v0.3.2 的教训）：只上传安装包、漏传 latest.json 时，应用端检查更新会
# 一律报 `Could not fetch a valid release JSON`。人工上传容易漏，所以这里把
# 「创建 Release → 上传三类产物 → 回报可用性」做成一条命令，并在最后主动
# 请求一次真实下载地址做验证（200 + 版本号匹配才算成功）。
#
# 用法（仓库根目录）：
#   pwsh -File scripts/publish-release.ps1 -Version 0.4.0
#   pwsh -File scripts/publish-release.ps1 -Version 0.4.0 -SkipBuild      # 复用已构建产物
#   pwsh -File scripts/publish-release.ps1 -Version 0.4.0 -VerifyOnly     # 只做发布后校验
#
# 前置：
#   1. `gh auth login` 已登录（需要 repo 写权限）
#   2. 三处版本号 = -Version（package.json / tauri.conf.json / Cargo.toml）
#   3. 签名密钥环境文件存在（见 build-release.ps1 的说明）
#
# 产物（build-release.ps1 生成）：
#   src-tauri/target/release/bundle/nsis/<产品名>_<版本>_x64-setup.exe
#   src-tauri/target/release/bundle/nsis/<...>.exe.sig
#   src-tauri/target/release/bundle/nsis/latest.json
#   src-tauri/target/release/bundle/portable/墨读_<版本>_portable_x64.zip

param(
    [Parameter(Mandatory = $true)][string]$Version,
    [string]$NotesFile = "",
    [string]$Repo = "AlanNiew/Modu",
    [switch]$SkipBuild,
    [switch]$VerifyOnly,
    [switch]$AllowPrerelease
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $root
$tag = "v$Version"

if (-not $NotesFile) {
    $NotesFile = Join-Path $root "docs/release-notes/$tag.md"
}

function Fail([string]$Message) {
    Write-Host "✗ $Message" -ForegroundColor Red
    exit 1
}

function Get-ReleaseAssetUrl([string]$Name) {
    "https://github.com/$Repo/releases/download/$tag/$([uri]::EscapeDataString($Name))"
}

# ---------------------------------------------------------------------------
# 0) 版本一致性 / 前置检查
# ---------------------------------------------------------------------------
$pkg = Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
$conf = Get-Content (Join-Path $root 'src-tauri/tauri.conf.json') -Raw | ConvertFrom-Json
$cargo = Get-Content (Join-Path $root 'src-tauri/Cargo.toml') -Raw
$cargoVersion = [regex]::Match($cargo, '(?m)^version = "([^"]+)"').Groups[1].Value
if ($pkg.version -ne $Version -or $conf.version -ne $Version -or $cargoVersion -ne $Version) {
    Fail "版本号不一致：package.json=$($pkg.version) tauri.conf.json=$($conf.version) Cargo.toml=$cargoVersion，期望 $Version（先改版本号再发布）"
}
if (-not (Test-Path $NotesFile)) {
    Fail "找不到发布说明：$NotesFile"
}

if (-not $VerifyOnly) {
    $auth = gh auth status 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) {
        Fail "gh 未登录：先执行 gh auth login（需要 $Repo 的写权限）"
    }
}

# ---------------------------------------------------------------------------
# 1) 构建（签名）——除非复用已构建产物
# ---------------------------------------------------------------------------
$nsisDir = Join-Path $root 'src-tauri/target/release/bundle/nsis'
$portableDir = Join-Path $root 'src-tauri/target/release/bundle/portable'

if (-not $VerifyOnly) {
    if ($SkipBuild) {
        Write-Host "== 跳过构建，复用已有产物 ==" -ForegroundColor Yellow
    } else {
        Write-Host "== 构建 v$Version（签名）+ 生成 latest.json + 便携版 ==" -ForegroundColor Cyan
        pwsh -NoProfile -File (Join-Path $root 'scripts/build-release.ps1') `
            -Version $Version -NotesFile $NotesFile
        if ($LASTEXITCODE -ne 0) { Fail "构建失败（exit $LASTEXITCODE）" }
    }
}

$exe = Get-ChildItem $nsisDir -Filter "*_${Version}_x64-setup.exe" -ErrorAction SilentlyContinue |
    Select-Object -First 1
$sig = if ($exe) { "$($exe.FullName).sig" } else { $null }
$latest = Join-Path $nsisDir 'latest.json'
$portable = Join-Path $portableDir "墨读_${Version}_portable_x64.zip"

# ---------------------------------------------------------------------------
# 2) 上传前本地自检：少任何一项都不发（这是 v0.3.2 出错的直接原因）
# ---------------------------------------------------------------------------
if (-not $VerifyOnly) {
    if (-not $exe) { Fail "找不到安装包：$nsisDir\*_${Version}_x64-setup.exe" }
    if (-not (Test-Path $sig)) { Fail "找不到签名文件：$sig" }
    if (-not (Test-Path $latest)) { Fail "找不到 latest.json：$latest（应用端更新依赖它）" }
    if (-not (Test-Path $portable)) { Write-Host "! 便携版缺失，将只发布安装版：$portable" -ForegroundColor Yellow }

    # 清单内容自检：版本、签名非空、下载地址指向本 tag。
    $manifest = Get-Content $latest -Raw | ConvertFrom-Json
    if ($manifest.version -ne $Version) {
        Fail "latest.json 的 version=$($manifest.version) 与 $Version 不一致（清单是旧的？）"
    }
    $platform = $manifest.platforms.'windows-x86_64'
    if (-not $platform.signature -or -not $platform.url) {
        Fail "latest.json 缺少 windows-x86_64 的 signature/url"
    }
    if ($platform.url -notlike "*releases/download/$tag/*") {
        Fail "latest.json 的下载地址不是 $tag：$($platform.url)"
    }
}

# ---------------------------------------------------------------------------
# 3) 建 Release 并上传（可重复执行：已存在则改说明 + 覆盖同名附件）
# ---------------------------------------------------------------------------
if (-not $VerifyOnly) {
    Write-Host "== 创建/更新 Release $tag ==" -ForegroundColor Cyan
    gh release view $tag --repo $Repo 2>$null | Out-Null
    $exists = ($LASTEXITCODE -eq 0)

    if (-not $exists) {
        $args = @(
            'release', 'create', $tag,
            '--repo', $Repo,
            '--title', "墨读 $tag",
            '--notes-file', $NotesFile
        )
        if ($AllowPrerelease) { $args += '--prerelease' }
        & gh @args
        if ($LASTEXITCODE -ne 0) { Fail "创建 Release 失败（exit $LASTEXITCODE）" }
    } else {
        Write-Host "  Release 已存在：更新说明并覆盖附件" -ForegroundColor Yellow
        gh release edit $tag --repo $Repo --title "墨读 $tag" --notes-file $NotesFile
        if ($LASTEXITCODE -ne 0) { Fail "更新 Release 说明失败" }
    }

    Write-Host "== 上传产物 ==" -ForegroundColor Cyan
    $assets = @($exe.FullName, $sig, $latest)
    if (Test-Path $portable) { $assets += $portable }
    # latest.json 必须挂在「最新」这份 release 上，endpoint 才能解析到它。
    gh release upload $tag --repo $Repo --clobber @assets
    if ($LASTEXITCODE -ne 0) { Fail "上传产物失败（exit $LASTEXITCODE）" }

    # 上传后立刻回读附件列表：确认三类关键产物真的在。
    $assetNames = gh release view $tag --repo $Repo --json assets --jq '.assets[].name'
    if ($LASTEXITCODE -ne 0) { Fail "回读 Release 附件列表失败" }
    foreach ($required in @($exe.Name, "$($exe.Name).sig", 'latest.json')) {
        if ($assetNames -notcontains $required) {
            Fail "Release 附件缺少 $required（实际：$($assetNames -join ', ')）"
        }
    }
    Write-Host "  附件清单 OK：" -ForegroundColor Green
    $assetNames | ForEach-Object { Write-Host "    - $_" }
}

# ---------------------------------------------------------------------------
# 4) 发布后可用性校验：走应用端真正使用的两个 URL
# ---------------------------------------------------------------------------
Write-Host "== 发布后校验（应用端视角）==" -ForegroundColor Cyan

$manifestUrl = "https://github.com/$Repo/releases/latest/download/latest.json"
Write-Host "  更新清单: $manifestUrl"
$manifestResponse = $null
try {
    $manifestResponse = Invoke-WebRequest -Uri $manifestUrl -UseBasicParsing -TimeoutSec 30
} catch {
    Fail "更新清单不可访问（$($_.Exception.Message)）。GitHub 的 latest 重定向有缓存，若刚发布请等 1–2 分钟重试；仍失败说明 latest.json 没挂到最新 Release 上。"
}
if ($manifestResponse.StatusCode -ne 200) {
    Fail "更新清单返回 HTTP $($manifestResponse.StatusCode)"
}
$liveManifest = $manifestResponse.Content | ConvertFrom-Json
if ($liveManifest.version -ne $Version) {
    Fail "更新清单版本是 $($liveManifest.version)，期望 $Version（Release 可能不是 latest）"
}
Write-Host "  ✓ 清单 200，version=$($liveManifest.version)" -ForegroundColor Green

$installerUrl = $liveManifest.platforms.'windows-x86_64'.url
Write-Host "  安装包: $installerUrl"
try {
    $head = Invoke-WebRequest -Uri $installerUrl -Method Head -UseBasicParsing -TimeoutSec 60
    if ($head.StatusCode -ne 200) { Fail "安装包返回 HTTP $($head.StatusCode)" }
    $sizeMb = [math]::Round([int64]$head.Headers['Content-Length'] / 1MB, 2)
    Write-Host "  ✓ 安装包 200，约 $sizeMb MiB" -ForegroundColor Green
} catch {
    Fail "清单里的安装包地址不可下载：$($_.Exception.Message)"
}

Write-Host ""
Write-Host "== 发布完成 ==" -ForegroundColor Green
Write-Host "Release : https://github.com/$Repo/releases/tag/$tag"
Write-Host "清单    : $manifestUrl"
Write-Host ""
Write-Host "最后一步（人工）：用上一版安装包（例如 v0.3.2）装一次，帮助 → 检查更新，" -ForegroundColor Cyan
Write-Host "确认能发现 v$Version、下载校验后静默升级成功。" -ForegroundColor Cyan
