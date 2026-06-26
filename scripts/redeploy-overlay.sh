#!/usr/bin/env bash
# Kill running overlay, rebuild frontend → PyInstaller bundle → Tauri .app,
# reinstall to /Applications, and launch the overlay (self-contained, no
# detached uvicorn needed — the backend ships inside the .app).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="phonetic-atlas-overlay"
APP_SRC="$REPO_ROOT/desktop/src-tauri/target/release/bundle/macos/$APP_NAME.app"
APP_DST="/Applications/$APP_NAME.app"
PORT=7842

say() { printf '\033[1;36m[redeploy]\033[0m %s\n' "$*"; }

say "killing existing overlay + anything on :$PORT"
pkill -f "$APP_NAME" 2>/dev/null || true
lsof -ti :"$PORT" -sTCP:LISTEN 2>/dev/null | xargs -r kill 2>/dev/null || true
sleep 1

say "building frontend (dist/)"
cd "$REPO_ROOT"
npm run build --silent

say "building PyInstaller server-bundle"
.venv/bin/pyinstaller --clean --onefile --name server-bundle \
  --add-data "sample_cache.py:." \
  --distpath dist/pyinstaller \
  --workpath build/pyinstaller \
  server.py 2>&1 | grep -E '(INFO: Building EXE|WARNING|completed|Build complete)'

say "building release .app (Tauri)"
cd "$REPO_ROOT/desktop"
npx tauri build --bundles app 2>&1 | tail -3

# Manually copy PyInstaller bundle into the .app (Tauri 2 externalBin
# doesn't always copy sidecars; this is reliable).
BIN_DIR="$APP_SRC/Contents/Resources/binaries"
mkdir -p "$BIN_DIR"
cp "$REPO_ROOT/dist/pyinstaller/server-bundle" "$BIN_DIR/server-bundle"

say "reinstalling to $APP_DST"
rm -rf "$APP_DST"
cp -R "$APP_SRC" "$APP_DST"
xattr -dr com.apple.quarantine "$APP_DST" 2>/dev/null || true

say "launching overlay (backend ships inside — no detached uvicorn needed)"
open "$APP_DST"

# Wait for backend inside the app to bind
for _ in $(seq 1 20); do
    if curl -sf -o /dev/null "http://127.0.0.1:$PORT/"; then
        say "overlay + backend up on :$PORT"
        break
    fi
    sleep 0.5
done

say "done — overlay pinned to bottom across Space/display changes"
