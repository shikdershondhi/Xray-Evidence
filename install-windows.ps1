# NeuString Xray Evidence - local workflow server installer (Windows)
# Run from PowerShell (as a normal user):
#   irm https://<site>/install-windows.ps1 | iex
# or download and run: powershell -ExecutionPolicy Bypass -File install-windows.ps1

$ErrorActionPreference = "Stop"

$Repo = "shikdershondhi/Xray-Evidence"
$Branch = "main"
$InstallDir = Join-Path $env:USERPROFILE "xray-evidence-server"

function Say($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }

Say "Checking Node.js"
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "Node.js is not installed."
  Write-Host "Install the LTS from https://nodejs.org then re-run this script."
  exit 1
}
Write-Host "Found $(node -v) / npm $(npm -v)"

Say "Downloading server bundle into $InstallDir"
$Tmp = Join-Path $env:TEMP ("xray-evidence-" + [guid]::NewGuid().ToString("N"))
$Zip = Join-Path $Tmp "repo.zip"
New-Item -ItemType Directory -Path $Tmp | Out-Null
try {
  Invoke-WebRequest -Uri "https://github.com/$Repo/archive/refs/heads/$Branch.zip" `
    -OutFile $Zip -UseBasicParsing
  Expand-Archive -Path $Zip -DestinationPath $Tmp -Force
  if (Test-Path $InstallDir) { Remove-Item -Recurse -Force $InstallDir }
  Move-Item (Join-Path $Tmp "Xray-Evidence-$Branch") $InstallDir
} finally {
  Remove-Item -Recurse -Force $Tmp -ErrorAction SilentlyContinue
}

Set-Location $InstallDir

Say "Installing npm dependencies (this can take a few minutes)"
npm install --no-fund --no-audit
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Say "Installing Playwright Chromium browser"
npx playwright install chromium
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Say "Writing start script"
@"
@echo off
cd /d "%~dp0"
set "XRAY_WEB_APP_URL=https://shikdershondhi.github.io/Xray-Evidence/xray-md-evidence.html"
npm run evidence:workflow
"@ | Set-Content -Path (Join-Path $InstallDir "start-server.bat") -Encoding ASCII

Write-Host ""
Write-Host "Done! Server installed in $InstallDir" -ForegroundColor Green
Write-Host ""
Write-Host "To start the local workflow server:"
Write-Host "  double-click $InstallDir\start-server.bat"
Write-Host ""
Write-Host "Then open the web app (GitHub Pages) and click Connect -"
Write-Host "it will talk to this server at http://127.0.0.1:39291"
