#!/bin/bash
# Same job as Grok Bot's box-chrome: one window, no sandbox, 1024x768.
set -euo pipefail
export DISPLAY="${DISPLAY:-:1}"
export HOME="${HOME:-/config}"
export XAUTHORITY="${XAUTHORITY:-/config/.Xauthority}"
CHROME="$(command -v google-chrome-stable || command -v google-chrome || command -v chromium || command -v chromium-browser || true)"
if [ -z "$CHROME" ]; then
  echo "Chrome is not installed" >&2
  exit 1
fi
flags=(
  --no-sandbox
  --disable-dev-shm-usage
  --disable-gpu
  --no-first-run
  --no-default-browser-check
  --disable-session-crashed-bubble
  --disable-infobars
  --test-type
  --disable-features=TranslateUI
  --start-maximized
  --window-position=0,0
  --window-size=1024,768
)
if [ "$#" -gt 0 ]; then
  exec "$CHROME" "${flags[@]}" --new-tab "$@"
fi
exec "$CHROME" "${flags[@]}" --new-tab "https://www.google.com/"
