#!/bin/bash
# One Chrome, one tab. Extra invocations replace the current page.
set -euo pipefail
export DISPLAY="${DISPLAY:-:1}"
export HOME="${HOME:-/config}"
export XAUTHORITY="${XAUTHORITY:-/config/.Xauthority}"
CHROME="$(command -v google-chrome-stable || command -v google-chrome || command -v chromium || command -v chromium-browser || true)"
if [ -z "$CHROME" ]; then
  echo "Chrome is not installed" >&2
  exit 1
fi
URL="${1:-https://www.google.com/}"
flags=(
  --no-sandbox
  --disable-dev-shm-usage
  --disable-gpu
  --renderer-process-limit=2
  --user-data-dir=/config/chrome-desk
  --remote-debugging-port=9222
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
)
if curl -sf --max-time 1 http://127.0.0.1:9222/json/version >/dev/null; then
  exec python3 /usr/local/bin/chrome-one-tab "$URL"
fi
exec "$CHROME" "${flags[@]}" "$URL"
