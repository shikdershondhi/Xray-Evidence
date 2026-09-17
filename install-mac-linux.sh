#!/bin/sh
# NeuString Xray Evidence - local workflow server installer (macOS / Linux)
# Run from the website manual: curl -fsSL <site>/install-mac-linux.sh | bash
set -e

REPO="shikdershondhi/Xray-Evidence"
BRANCH="main"
INSTALL_DIR="$HOME/xray-evidence-server"

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }

say "Checking Node.js"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed."
  echo "Install it from https://nodejs.org (LTS) or via:"
  echo "  macOS:   brew install node"
  echo "  Linux:   see https://nodejs.org/en/download/package-manager"
  exit 1
fi
echo "Found $(node -v) / npm $(npm -v)"

say "Downloading server bundle into $INSTALL_DIR"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
curl -fsSL "https://codeload.github.com/$REPO/tar.gz/refs/heads/$BRANCH" \
  | tar -xz -C "$TMP_DIR"
rm -rf "$INSTALL_DIR"
mv "$TMP_DIR/Xray-Evidence-$BRANCH" "$INSTALL_DIR"

cd "$INSTALL_DIR"

say "Installing npm dependencies (this can take a few minutes)"
npm install --no-fund --no-audit

say "Installing Playwright Chromium browser"
npx playwright install chromium

say "Writing start scripts"
cat > "$INSTALL_DIR/start-server.sh" <<'EOF'
#!/bin/sh
cd "$(dirname "$0")" || exit 1
export XRAY_WEB_APP_URL="https://shikdershondhi.github.io/Xray-Evidence/xray-md-evidence.html"
npm run evidence:workflow
EOF
chmod +x "$INSTALL_DIR/start-server.sh"

if [ "$(uname)" = "Darwin" ]; then
  cp "$INSTALL_DIR/start-server.sh" "$INSTALL_DIR/start-server.command"
fi

printf '\n\033[1;32mDone!\033[0m Server installed in %s\n' "$INSTALL_DIR"
echo ""
echo "To start the local workflow server:"
echo "  sh $INSTALL_DIR/start-server.sh"
echo ""
echo "Then open the web app (GitHub Pages) and click Connect -"
echo "it will talk to this server at http://127.0.0.1:39291"
