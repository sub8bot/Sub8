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
URL="${1:-https://www.google.com/?hl=en&gl=us}"
N="${DISPLAY#:}"
N="${N%%.*}"
if [ -z "$N" ] || [ "$N" = "1" ]; then
  PROFILE=/config/chrome-desk
  DEBUG_PORT=9222
else
  PROFILE="/config/chrome-desk-${N}"
  DEBUG_PORT=$((9221 + N))
fi

kill_unprofiled_chrome() {
  # Old webtop/boot Chromes have no --user-data-dir and steal :1 / RAM.
  # ps pads PIDs with spaces — use awk $1, not ${line%% *}.
  local pids
  pids="$(ps -eo pid= -o args= 2>/dev/null | awk '
    /--type=/ { next }
    /crashpad/ { next }
    /user-data-dir=/ { next }
    /chrome-desktop|chrome-one-tab|box-chrome/ { next }
    /google-chrome|chromium|\/chrome\/chrome/ { print $1 }
  ')"
  for pid in $pids; do
    kill "$pid" 2>/dev/null || true
  done
}

mkdir -p "$PROFILE"
if [ ! -w "$PROFILE" ]; then
  if command -v sudo >/dev/null 2>&1; then
    sudo chown -R "$(id -u):$(id -g)" "$PROFILE" 2>/dev/null || true
  fi
fi
if [ ! -w "$PROFILE" ]; then
  PROFILE="/tmp/chrome-desk-${N:-1}"
  mkdir -p "$PROFILE"
fi
mkdir -p "$PROFILE/Default"
prefs="$PROFILE/Default/Preferences"
if [ ! -f "$prefs" ]; then
  cat > "$prefs" << 'EOF'
{"intl":{"accept_languages":"en-US,en"},"translate":{"enabled":false},"webkit":{"webprefs":{"default_text_encoding_name":"UTF-8"}}}
EOF
fi

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
kill_unprofiled_chrome || true
if curl -sf --max-time 1 "$CHROME_DEBUG/json/version" >/dev/null; then
  exec python3 /usr/local/bin/chrome-one-tab "$URL"
fi
exec "$CHROME" "${flags[@]}" "$URL"
