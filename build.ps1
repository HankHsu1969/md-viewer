# MD 閱讀器 一鍵建置
# 用法：在這個資料夾按右鍵「用 PowerShell 執行」，或執行：
#   powershell -ExecutionPolicy Bypass -File build.ps1
# 產出：dist\MDViewer.exe（單一檔案，可直接複製到別台 Windows 10/11 使用）

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$wv2Version = '1.0.4314.35'
# 下載的 WebView2 套件必須和這個指紋一致，避免被竄改（換版本時要一起更新）
$wv2Sha256 = '90778DEB1B77E36292828B4B5833C9255C27533F40E0DDD55891AE718944EDC4'

function Step($t) { Write-Host "`n== $t ==" -ForegroundColor Cyan }

# 1. 下載 WebView2 SDK（微軟官方 NuGet 套件）
Step '1/4 準備 WebView2 元件'
$deps = Join-Path $root 'build\deps'
$wv2 = Join-Path $deps 'wv2'
$coreDll = Join-Path $wv2 'lib\net462\Microsoft.Web.WebView2.Core.dll'
if (-not (Test-Path $coreDll)) {
    New-Item -ItemType Directory -Force $deps | Out-Null
    $pkg = Join-Path $deps 'webview2.zip'
    $url = "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$wv2Version/microsoft.web.webview2.$wv2Version.nupkg"
    Write-Host "下載 $url"
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $url -OutFile $pkg -UseBasicParsing
    $hash = (Get-FileHash -Algorithm SHA256 $pkg).Hash
    if ($hash -ne $wv2Sha256) { Remove-Item $pkg; throw "WebView2 套件指紋不符（$hash），可能被竄改，已停止建置" }
    if (Test-Path $wv2) { Remove-Item -Recurse -Force $wv2 }
    Expand-Archive -Path $pkg -DestinationPath $wv2
}
$winFormsDll = Join-Path $wv2 'lib\net462\Microsoft.Web.WebView2.WinForms.dll'
$loaderDll = Join-Path $wv2 'runtimes\win-x64\native\WebView2Loader.dll'

# 2. 打包網頁（排版、程式碼上色、公式、流程圖、第三方授權聲明）
Step '2/4 打包網頁'
Push-Location (Join-Path $root 'web')
try {
    # npm ci：完全照 package-lock.json 安裝，確保每次用的套件版本一模一樣
    if (-not (Test-Path 'node_modules')) { npm ci --no-fund --no-audit; if ($LASTEXITCODE) { throw 'npm ci 失敗' } }
    node build.mjs
    if ($LASTEXITCODE) { throw '網頁打包失敗' }
} finally { Pop-Location }

# 3. 圖示
Step '3/4 準備圖示'
$ico = Join-Path $root 'assets\app.ico'
if (-not (Test-Path $ico)) { & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'assets\make-icon.ps1') }

# 4. 編譯（使用 Windows 內建的 C# 編譯器，不需另外安裝）
Step '4/4 編譯 EXE'
$fw = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
$csc = Join-Path $fw 'csc.exe'
if (-not (Test-Path $csc)) { throw "找不到 C# 編譯器：$csc" }
$dist = Join-Path $root 'dist'
New-Item -ItemType Directory -Force $dist | Out-Null
$out = Join-Path $dist 'MDViewer.exe'

$lines = New-Object System.Collections.Generic.List[string]
$lines.Add('/nologo')
$lines.Add('/target:winexe')
$lines.Add('/platform:x64')
$lines.Add('/optimize+')
$lines.Add('/codepage:65001')
$lines.Add('/utf8output')
$lines.Add("/out:`"$out`"")
$lines.Add("/win32icon:`"$ico`"")
$lines.Add("/win32manifest:`"$(Join-Path $root 'src\app.manifest')`"")
foreach ($r in 'System.dll', 'System.Core.dll', 'System.Drawing.dll', 'System.Windows.Forms.dll', 'System.Web.Extensions.dll') { $lines.Add("/reference:`"$(Join-Path $fw $r)`"") }
$lines.Add("/reference:`"$coreDll`"")
$lines.Add("/reference:`"$winFormsDll`"")
# 把 WebView2 元件、網頁檔、圖示全部嵌入 EXE
$lines.Add("/resource:`"$coreDll`",deps.Microsoft.Web.WebView2.Core.dll")
$lines.Add("/resource:`"$winFormsDll`",deps.Microsoft.Web.WebView2.WinForms.dll")
$lines.Add("/resource:`"$loaderDll`",deps.WebView2Loader.dll")
$lines.Add("/resource:`"$ico`",app.ico")
$webOut = Join-Path $root 'build\web'
Get-ChildItem -Path $webOut -Recurse -File | ForEach-Object {
    $rel = $_.FullName.Substring($webOut.Length + 1).Replace('\', '/')
    $lines.Add("/resource:`"$($_.FullName)`",web/$rel")
}
Get-ChildItem -Path (Join-Path $root 'src') -Filter *.cs | ForEach-Object { $lines.Add("`"$($_.FullName)`"") }

$rsp = Join-Path $root 'build\csc.rsp'
[IO.File]::WriteAllLines($rsp, $lines, (New-Object Text.UTF8Encoding($false)))
& $csc "@$rsp"
if ($LASTEXITCODE) { throw '編譯失敗' }

$size = [Math]::Round((Get-Item $out).Length / 1MB, 2)
Write-Host "`n完成！ $out （$size MB）" -ForegroundColor Green
