@echo off
cd /d "%~dp0"
set "XRAY_WEB_APP_URL=https://shikdershondhi.github.io/Xray-Evidence/xray-md-evidence.html"
npm run evidence:workflow
