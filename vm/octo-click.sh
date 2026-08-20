#!/bin/bash
# Reliable screen-absolute click for Sub8 / Grok Build.
# Usage: octo-click X Y [button] [count]
# Prefers XTEST (box-input). Falls back to xdotool if XTEST is missing.
set -euo pipefail
export DISPLAY="${DISPLAY:-:1}"
export XAUTHORITY="${XAUTHORITY:-/config/.Xauthority}"
export HOME="${HOME:-/config}"
TX="${1:?x}"
TY="${2:?y}"
BTN="${3:-1}"
N="${4:-1}"
if [ -x /usr/local/bin/box-input ]; then
  if /usr/local/bin/box-input click "$TX" "$TY" "$BTN" "$N"; then
    exit 0
  fi
fi
REAL="${OCTO_XDOTOOL:-/usr/bin/xdotool}"
unset WINDOW
timeout 0.2 "$REAL" mousemove --sync --screen 0 "$TX" "$TY" >/dev/null 2>&1 \
  || "$REAL" mousemove --screen 0 "$TX" "$TY"
for i in 1 2 3 4 5; do
  eval "$("$REAL" getmouselocation --shell)"
  dx=$((X - TX))
  dy=$((Y - TY))
  [ "${dx#-}" -le 2 ] && [ "${dy#-}" -le 2 ] && break
  "$REAL" mousemove --screen 0 "$TX" "$TY"
  sleep 0.03
done
wid=$("$REAL" getmouselocation --shell | awk -F= '/^WINDOW=/{print $2}')
if [ -n "${wid:-}" ] && [ "$wid" != "0" ]; then
  timeout 0.2 "$REAL" windowactivate --sync "$wid" >/dev/null 2>&1 \
    || "$REAL" windowactivate "$wid" >/dev/null 2>&1 || true
fi
unset WINDOW
"$REAL" click --clearmodifiers --repeat "$N" --delay 40 "$BTN"
eval "$("$REAL" getmouselocation --shell)"
echo "POINTER=$X,$Y"
