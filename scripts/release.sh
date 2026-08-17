#!/usr/bin/env bash
# Build Mac (signed + notarized DMG), Windows zip, and Linux packages.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

export CSC_IDENTITY_AUTO_DISCOVERY="${CSC_IDENTITY_AUTO_DISCOVERY:-true}"
if [ -z "${SUB8BOT_SIGN_IDENTITY:-${OCTOBOT_SIGN_IDENTITY:-}}" ]; then
  SUB8BOT_SIGN_IDENTITY="$(security find-identity -v -p codesigning 2>/dev/null | awk -F'"' '/Developer ID Application/{print $2; exit}')"
  export SUB8BOT_SIGN_IDENTITY
fi
export OCTOBOT_SIGN_IDENTITY="${OCTOBOT_SIGN_IDENTITY:-$SUB8BOT_SIGN_IDENTITY}"

VERSION="$(node -p "require('./package.json').version")"

echo "==> Icons"
npm run icons

echo "==> Mac"
npx electron-builder --mac dmg zip --arm64 --x64

echo "==> Notarize Mac artifacts"
shopt -s nullglob
for app in dist/mac-arm64/Sub8Bot.app dist/mac/Sub8Bot.app dist/mac-x64/Sub8Bot.app; do
  [ -d "$app" ] && bash scripts/sign-and-notarize.sh "$app"
done
for dmg in dist/Sub8Bot-"$VERSION"-mac-*.dmg dist/Sub8Bot-"$VERSION".dmg; do
  [ -f "$dmg" ] && bash scripts/sign-and-notarize.sh "$dmg"
done

echo "==> Windows"
npx electron-builder --win zip --x64

echo "==> Linux"
npx electron-builder --linux AppImage tar.gz --x64

echo "==> Checksums"
(
  cd dist
  shasum -a 256 Sub8Bot-"$VERSION"-* > "Sub8Bot-${VERSION}.sha256" || true
)
ls -lh dist/Sub8Bot-"$VERSION"-* || true
echo "==> Release artifacts ready in dist/"
