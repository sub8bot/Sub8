#!/bin/bash
# One Chrome, one tab, on THIS $DISPLAY. Extra invocations replace the current page.
set -euo pipefail
export DISPLAY="${DISPLAY:-:1}"
export HOME="${HOME:-/config}"
export XAUTHORITY="${XAUTHORITY:-/config/.Xauthority}"
export LANG="${LANG:-C.UTF-8}"
export LANGUAGE="${LANGUAGE:-en_US:en}"
export LC_ALL="${LC_ALL:-C.UTF-8}"
CHROME="$(command -v google-chrome-stable || command -v google-chrome || command -v chromium || command -v chromium-browser || true)"
if [ -z "$CHROME" ]; then
  echo "Chrome is not installed" >&2
  exit 1
fi
URL="${1:-https://www.google.com/?hl=en}"
N="${DISPLAY#:}"
N="${N%%.*}"
if [ -z "$N" ] || [ "$N" = "1" ]; then
  PROFILE=/config/chrome-desk
  DEBUG_PORT=9222
else
  PROFILE="/config/chrome-desk-${N}"
  DEBUG_PORT=$((9221 + N))
fi
mkdir -p "$PROFILE"
export CHROME_DEBUG="http://127.0.0.1:${DEBUG_PORT}"
flags=(
  --no-sandbox
  --disable-dev-shm-usage
  --disable-gpu
  --renderer-process-limit=2
  --user-data-dir="$PROFILE"
  --remote-debugging-port="$DEBUG_PORT"
  --remote-debugging-address=127.0.0.1
  --remote-allow-origins=*
  --no-first-run
  --no-default-browser-check
  --disable-session-crashed-bubble
  --hide-crash-restore-bubble
  --disable-infobars
  --test-type
  --disable-features=TranslateUI,MediaRouter
  --start-maximized
  --window-position=0,0
  --window-size=1024,768
  --lang=en-US
  --accept-lang=en-US,en
)
if curl -sf --max-time 1 "$CHROME_DEBUG/json/version" >/dev/null; then
  exec python3 /usr/local/bin/chrome-one-tab "$URL"
fi
exec "$CHROME" "${flags[@]}" "$URL"
