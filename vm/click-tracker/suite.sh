#!/bin/bash
# Aim → click → read what the page recorded. Exit 0 only if every hit is within 2px.
set -euo pipefail
export DISPLAY="${DISPLAY:-:1}"
export XAUTHORITY="${XAUTHORITY:-/config/.Xauthority}"
export HOME="${HOME:-/config}"
BASE=http://127.0.0.1:8766
REPORT=/tmp/click-suite-report.txt
: > "$REPORT"

log() { echo "$*" | tee -a "$REPORT"; }

wait_http() {
  for i in $(seq 1 40); do
    curl -sf "$BASE/hits" >/dev/null && return 0
    sleep 0.15
  done
  return 1
}

ensure_server() {
  if ! curl -sf "$BASE/hits" >/dev/null 2>&1; then
    python3 /config/Desktop/click-tracker/server.py >/tmp/click-tracker.log 2>&1 &
    echo $! > /tmp/click-tracker.pid
  fi
  wait_http
}

ensure_page() {
  if ! wmctrl -l | grep -qi "click tracker"; then
    /usr/local/bin/chrome-desktop "$BASE/" >/tmp/click-tracker-chrome.log 2>&1 &
    for i in $(seq 1 20); do
      wmctrl -l | grep -qi "click tracker\|127.0.0.1:8765" && break
      sleep 0.3
    done
  fi
  wid=$(wmctrl -l | awk 'BEGIN{IGNORECASE=1} /click tracker|127.0.0.1:8765/{print $1; exit}')
  if [ -n "${wid:-}" ]; then
    wmctrl -ia "$wid" || true
    wmctrl -ir "$wid" -e 0,0,27,1024,741 || true
  fi
  sleep 0.5
}

hits_len() { curl -sf "$BASE/hits" | python3 -c 'import sys,json; print(len(json.load(sys.stdin)))'; }

ensure_server
curl -sf -X POST "$BASE/reset" >/dev/null
ensure_page

POINTS="200,200 512,384 55,612 800,500 400,300 750,350 100,700"
n=0
fail=0
for p in $POINTS; do
  n=$((n+1))
  x=${p%,*}; y=${p#*,}
  curl -sf -X POST "$BASE/aim" -H "Content-Type: application/json" -d "{\"x\":$x,\"y\":$y}" >/dev/null
  sleep 0.25
  found=""
  for attempt in 1 2 3; do
    /usr/local/bin/octo-click "$x" "$y"
    for i in $(seq 1 15); do
      if row=$(python3 /config/Desktop/click-tracker/readhit.py "$x" "$y" 2>/dev/null); then
        found=$row
        break
      fi
      sleep 0.08
    done
    [ -n "$found" ] && break
    sleep 0.2
  done
  eval "$(xdotool getmouselocation --shell)"
  ptr_dx=$((X - x)); ptr_dy=$((Y - y))
  sx=${found%%,*}; rest=${found#*,}
  sy=${rest%%,*}; rest=${rest#*,}
  cli=${rest%%,*}; rest=${rest#*,}
  cly=${rest%%,*}; ok=${rest##*,}
  if [ "$sx" = "$x" ] && [ "$sy" = "$y" ] && [ "$ptr_dx" -eq 0 ] && [ "$ptr_dy" -eq 0 ]; then
    status=PASS
  else
    fail=$((fail+1))
    status=FAIL
  fi
  log "$status aim=$x,$y pointer=$X,$Y (d $ptr_dx,$ptr_dy) page_screen=$sx,$sy client=$cli,$cly ok=$ok"
done

log "---"
log "failed=$fail / $n"
[ "$fail" -eq 0 ]
