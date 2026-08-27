#!/bin/zsh
# Build a local Sub8.app wrapper so macOS shows Sub8, not Electron.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/node_modules/electron/dist/Electron.app"
DEST="$ROOT/.app/Sub8.app"
PLIST="$DEST/Contents/Info.plist"
ICON="$ROOT/build/icon.icns"

[ -d "$SRC" ] || { echo "Electron.app missing — run npm install" >&2; exit 1; }

mkdir -p "$ROOT/.app"
if [ ! -d "$DEST/Contents/MacOS/Electron" ] && [ ! -x "$DEST/Contents/MacOS/Electron" ]; then
  rm -rf "$DEST"
  ditto "$SRC" "$DEST"
fi
# Refresh if Electron was upgraded
src_ver=$(defaults read "$SRC/Contents/Info" CFBundleVersion 2>/dev/null || true)
dst_ver=$(defaults read "$DEST/Contents/Info" CFBundleVersion 2>/dev/null || true)
if [ "$src_ver" != "$dst_ver" ] || [ ! -x "$DEST/Contents/MacOS/Electron" ]; then
  rm -rf "$DEST"
  ditto "$SRC" "$DEST"
fi

/usr/libexec/PlistBuddy -c "Set :CFBundleName Sub8" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName Sub8" "$PLIST" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Add :CFBundleDisplayName string Sub8" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier app.sub8bot.desktop.dev" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleExecutable Electron" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :NSMicrophoneUsageDescription Sub8 uses the microphone so you can dictate messages." "$PLIST" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Add :NSMicrophoneUsageDescription string Sub8 uses the microphone so you can dictate messages." "$PLIST"
/usr/libexec/PlistBuddy -c "Set :NSSpeechRecognitionUsageDescription Sub8 turns your speech into text on this Mac." "$PLIST" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Add :NSSpeechRecognitionUsageDescription string Sub8 turns your speech into text on this Mac." "$PLIST"

if [ -f "$ICON" ]; then
  cp -f "$ICON" "$DEST/Contents/Resources/electron.icns"
  /usr/libexec/PlistBuddy -c "Set :CFBundleIconFile electron.icns" "$PLIST" 2>/dev/null || true
fi

echo "$DEST/Contents/MacOS/Electron"
