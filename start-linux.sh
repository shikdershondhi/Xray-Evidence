#!/bin/sh
cd "$(dirname "$0")" || exit 1
XRAY_WEB_APP_URL="https://shikdershondhi.github.io/Xray-Evidence/xray-md-evidence.html" npm run evidence:workflow
