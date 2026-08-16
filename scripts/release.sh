#!/usr/bin/env bash
# Build Mac (signed + notarized DMG), Windows zip, and Linux packages.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

export CSC_IDENTITY_AUTO_DISCOVERY="${CSC_IDENTITY_AUTO_DISCOVERY:-true}"
if [ -z "${OCTOBOT_SIGN_IDENTITY:-}" ]; then
  OCTOBOT_SIGN_IDENTITY="$(security find-identity -v -p codesigning 2>/dev/null | awk -F'"' '/Developer ID Application/{print $2; exit}')"
  export OCTOBOT_SIGN_IDENTITY
fi

VERSION="$(node -p "require('./package.json').version")"

echo "==> Icons"
npm run icons

echo "==> Mac"
npx electron-builder --mac dmg zip --arm64 --x64

echo "==> Notarize Mac artifacts"
shopt -s nullglob
for app in dist/mac-arm64/OctoBot.app dist/mac/OctoBot.app dist/mac-x64/OctoBot.app; do
  [ -d "$app" ] && bash scripts/sign-and-notarize.sh "$app"
done
for dmg in dist/OctoBot-"$VERSION"-mac-*.dmg dist/OctoBot-"$VERSION".dmg; do
  [ -f "$dmg" ] && bash scripts/sign-and-notarize.sh "$dmg"
done

echo "==> Windows"
npx electron-builder --win zip --x64

echo "==> Linux"
npx electron-builder --linux AppImage tar.gz --x64

echo "==> Checksums"
(
  cd dist
  shasum -a 256 OctoBot-"$VERSION"-* > "OctoBot-${VERSION}.sha256" || true
)
ls -lh dist/OctoBot-"$VERSION"-* || true
echo "==> Release artifacts ready in dist/"
