#!/usr/bin/env bash
# Build a signed + notarized OctoBot.dmg (same flow as Xnative).
#
#   scripts/make-dmg.sh [--skip-app-build]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

SKIP_BUILD=0
for a in "$@"; do [ "$a" = "--skip-app-build" ] && SKIP_BUILD=1; done

VERSION="$(node -p "require('./package.json').version")"
APP=""
for cand in \
  "$ROOT/dist/mac-arm64/OctoBot.app" \
  "$ROOT/dist/mac/OctoBot.app" \
  "$ROOT/dist/OctoBot.app"
do
  [ -d "$cand" ] && APP="$cand" && break
done

if [ "$SKIP_BUILD" -eq 0 ] || [ -z "$APP" ]; then
  echo "==> Building mac app with electron-builder"
  npx electron-builder --mac dmg zip --arm64 --x64
  for cand in \
    "$ROOT/dist/mac-arm64/OctoBot.app" \
    "$ROOT/dist/mac/OctoBot.app"
  do
    [ -d "$cand" ] && APP="$cand" && break
  done
fi

[ -d "$APP" ] || { echo "Missing OctoBot.app" >&2; exit 1; }

echo "==> Signing + notarizing app"
bash "$ROOT/scripts/sign-and-notarize.sh" "$APP"

STAGE="$ROOT/dist/dmg-stage"
VOLNAME="OctoBot"
DMG_PATH="$ROOT/dist/OctoBot-${VERSION}.dmg"
DMG_LATEST="$ROOT/dist/OctoBot.dmg"

echo "==> Staging DMG contents"
rm -rf "$STAGE"
mkdir -p "$STAGE"
ditto "$APP" "$STAGE/OctoBot.app"
ln -s /Applications "$STAGE/Applications"
cat > "$STAGE/README.txt" << EOF
OctoBot ${VERSION}
================

1. Drag OctoBot to Applications
2. Open OctoBot
3. Sign in to Grok / SpaceXAI from Settings → Harness if asked

OctoBot runs each Bot on its own local Linux computer (Docker).
On a Mac, start Colima or Docker Desktop first.

Not affiliated with xAI.
EOF

echo "==> Creating DMG: $DMG_PATH"
rm -f "$DMG_PATH" "$DMG_LATEST"
hdiutil create \
  -volname "$VOLNAME" \
  -srcfolder "$STAGE" \
  -ov -format UDZO \
  "$DMG_PATH"

echo "==> Signing + notarizing DMG"
bash "$ROOT/scripts/sign-and-notarize.sh" "$DMG_PATH"

cp -f "$DMG_PATH" "$DMG_LATEST"
shasum -a 256 "$DMG_PATH" | tee "$DMG_PATH.sha256"
echo "==> Done $DMG_PATH"
