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
for app in dist/mac-arm64/Sub8.app dist/mac/Sub8.app dist/mac-x64/Sub8.app; do
  [ -d "$app" ] && bash scripts/sign-and-notarize.sh "$app"
done
for dmg in dist/Sub8-mac-*.dmg dist/Sub8-"$VERSION"-mac-*.dmg dist/Sub8-"$VERSION".dmg; do
  [ -f "$dmg" ] && bash scripts/sign-and-notarize.sh "$dmg"
done

echo "==> Windows"
npx electron-builder --win nsis zip --x64

echo "==> Linux"
npx electron-builder --linux AppImage tar.gz --x64

echo "==> Checksums"
(
  cd dist
  shasum -a 256 Sub8-mac-* Sub8-win-* Sub8-linux-* Sub8-"$VERSION"-* > "Sub8-${VERSION}.sha256" 2>/dev/null || true
)
ls -lh dist/Sub8-mac-* dist/Sub8-win-* dist/Sub8-linux-* dist/Sub8-"$VERSION"-* dist/latest*.yml 2>/dev/null || true
echo "==> Release artifacts ready in dist/"
echo "Upload latest.yml (Windows) and latest-mac.yml (Mac) with the GitHub release so in-app updates work."
