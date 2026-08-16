#!/usr/bin/env bash
# Developer ID-sign, notarize, and staple OctoBot (same Apple account as Xnative / Xplor).
#
#   scripts/sign-and-notarize.sh [path-to-OctoBot.app|OctoBot.dmg] [--sign-only]
#
# Prereqs:
#   export XPLORER_NOTARY_KEY="$HOME/.appstoreconnect/private_keys/AuthKey_[redacted].p8"
#   export XPLORER_NOTARY_KEY_ID="[redacted]"
#   export XPLORER_NOTARY_ISSUER="[redacted]"
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${1:-$ROOT/dist/mac-arm64/OctoBot.app}"
SIGN_ONLY=""
for a in "$@"; do [ "$a" = "--sign-only" ] && SIGN_ONLY=1; done

IDENTITY="${OCTOBOT_SIGN_IDENTITY:-${XNATIVE_SIGN_IDENTITY:-Developer ID Application: Daniel Farina ([redacted])}}"
TEAM_ID="${OCTOBOT_TEAM_ID:-[redacted]}"
PROFILE="${OCTOBOT_NOTARY_PROFILE:-xplorer-notary}"
ENTITLEMENTS="$ROOT/build/entitlements.mac.plist"

NOTARY_KEY="${XPLORER_NOTARY_KEY:-${ASKHERE_NOTARY_KEY:-$HOME/.appstoreconnect/private_keys/AuthKey_[redacted].p8}}"
NOTARY_KEY_ID="${XPLORER_NOTARY_KEY_ID:-${ASKHERE_NOTARY_KEY_ID:-[redacted]}}"
NOTARY_ISSUER="${XPLORER_NOTARY_ISSUER:-${ASKHERE_NOTARY_ISSUER:-[redacted]}}"

if [ -n "$NOTARY_KEY" ] && [ -f "$NOTARY_KEY" ] && [ -n "$NOTARY_KEY_ID" ] && [ -n "$NOTARY_ISSUER" ]; then
  NOTARY_AUTH=(--key "$NOTARY_KEY" --key-id "$NOTARY_KEY_ID" --issuer "$NOTARY_ISSUER")
  NOTARY_AUTH_DESC="API key $NOTARY_KEY_ID"
else
  NOTARY_AUTH=(--keychain-profile "$PROFILE")
  NOTARY_AUTH_DESC="keychain profile $PROFILE"
fi

[ -e "$TARGET" ] || { echo "Nothing to sign at $TARGET" >&2; exit 1; }

echo "==> Signing $TARGET"
echo "    Identity: $IDENTITY"
echo "    Team:     $TEAM_ID"

if [[ "$TARGET" == *.app ]]; then
  codesign --force --deep --options runtime --timestamp \
    --entitlements "$ENTITLEMENTS" \
    -s "$IDENTITY" \
    "$TARGET"
  codesign --verify --deep --strict --verbose=2 "$TARGET"
else
  codesign --force --timestamp -s "$IDENTITY" "$TARGET"
  codesign --verify --verbose=2 "$TARGET"
fi
echo "==> codesign OK"

if [ -n "$SIGN_ONLY" ]; then
  echo "==> --sign-only: skipping notarization"
  exit 0
fi

SUBMIT="$TARGET"
ZIP=""
if [[ "$TARGET" == *.app ]]; then
  ZIP="${TMPDIR:-/tmp}/OctoBot-notarize-$$.zip"
  rm -f "$ZIP"
  echo "==> Zipping for notarytool"
  ditto -c -k --keepParent "$TARGET" "$ZIP"
  SUBMIT="$ZIP"
fi

echo "==> Submitting to Apple notarization ($NOTARY_AUTH_DESC)"
xcrun notarytool submit "$SUBMIT" "${NOTARY_AUTH[@]}" --wait

echo "==> Stapling ticket"
xcrun stapler staple "$TARGET"
xcrun stapler validate "$TARGET"

if [[ "$TARGET" == *.app ]]; then
  echo "==> Gatekeeper assessment"
  spctl --assess --type execute -vv "$TARGET" || true
  rm -f "$ZIP"
fi

echo "==> Done: notarized $TARGET"
