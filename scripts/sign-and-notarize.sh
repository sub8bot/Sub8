#!/usr/bin/env bash
# Developer ID-sign, notarize, and staple Sub8.
#
#   scripts/sign-and-notarize.sh [path-to-Sub8.app|Sub8.dmg] [--sign-only]
#
# Requires env (never commit these):
#   SUB8BOT_SIGN_IDENTITY (or OCTOBOT_SIGN_IDENTITY)
#   SUB8BOT_NOTARY_KEY / SUB8BOT_NOTARY_KEY_ID / SUB8BOT_NOTARY_ISSUER
# or SUB8BOT_NOTARY_PROFILE for a notarytool keychain profile.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${1:-$ROOT/dist/mac-arm64/Sub8.app}"
SIGN_ONLY=""
for a in "$@"; do [ "$a" = "--sign-only" ] && SIGN_ONLY=1; done

IDENTITY="${SUB8BOT_SIGN_IDENTITY:-${OCTOBOT_SIGN_IDENTITY:-}}"
PROFILE="${SUB8BOT_NOTARY_PROFILE:-${OCTOBOT_NOTARY_PROFILE:-}}"
ENTITLEMENTS="$ROOT/build/entitlements.mac.plist"

NOTARY_KEY="${SUB8BOT_NOTARY_KEY:-${OCTOBOT_NOTARY_KEY:-${XPLORER_NOTARY_KEY:-$HOME/.appstoreconnect/private_keys/AuthKey_YBARNDQVXS.p8}}}"
NOTARY_KEY_ID="${SUB8BOT_NOTARY_KEY_ID:-${OCTOBOT_NOTARY_KEY_ID:-${XPLORER_NOTARY_KEY_ID:-YBARNDQVXS}}}"
NOTARY_ISSUER="${SUB8BOT_NOTARY_ISSUER:-${OCTOBOT_NOTARY_ISSUER:-${XPLORER_NOTARY_ISSUER:-9576b918-20c9-4fd9-8b1b-9201381136aa}}}"

if [ -z "$IDENTITY" ]; then
  echo "Set SUB8BOT_SIGN_IDENTITY to your Developer ID Application name." >&2
  exit 1
fi

if [ -n "$NOTARY_KEY" ] && [ -f "$NOTARY_KEY" ] && [ -n "$NOTARY_KEY_ID" ] && [ -n "$NOTARY_ISSUER" ]; then
  NOTARY_AUTH=(--key "$NOTARY_KEY" --key-id "$NOTARY_KEY_ID" --issuer "$NOTARY_ISSUER")
  NOTARY_AUTH_DESC="API key"
elif [ -n "$PROFILE" ]; then
  NOTARY_AUTH=(--keychain-profile "$PROFILE")
  NOTARY_AUTH_DESC="keychain profile"
else
  NOTARY_AUTH=()
  NOTARY_AUTH_DESC=""
fi

[ -e "$TARGET" ] || { echo "Nothing to sign at $TARGET" >&2; exit 1; }

echo "==> Signing $TARGET"

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
  ZIP="${TMPDIR:-/tmp}/Sub8-notarize-$$.zip"
  rm -f "$ZIP"
  echo "==> Zipping for notarytool"
  ditto -c -k --keepParent "$TARGET" "$ZIP"
  SUBMIT="$ZIP"
fi

if [ -z "$NOTARY_AUTH_DESC" ]; then
  echo "Skipping notarization (set SUB8BOT_NOTARY_KEY + KEY_ID + ISSUER, or SUB8BOT_NOTARY_PROFILE)"
  exit 0
fi

echo "==> Submitting to Apple notarization"
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
