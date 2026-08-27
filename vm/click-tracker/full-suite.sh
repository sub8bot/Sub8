#!/bin/bash
# 40+ aimed-vs-landed clicks on desktop, Chromium, and a terminal.
set -u
export DISPLAY="${DISPLAY:-:1}"
export XAUTHORITY="${XAUTHORITY:-/config/.Xauthority}"
export HOME="${HOME:-/config}"
REPORT=/tmp/full-click-report.txt
: > "$REPORT"
pass=0
fail=0
n=0

log() { echo "$*" | tee -a "$REPORT"; }

click_at() {
  /usr/local/bin/octo-click "$1" "$2" >/tmp/octo-last.txt
  eval "$(xdotool getmouselocation --shell)"
}

check_pointer() {
  local ax=$1 ay=$2 label=$3
  n=$((n+1))
  click_at "$ax" "$ay"
  local dx=$((X - ax)) dy=$((Y - ay))
  local adx=${dx#-}; local ady=${dy#-}
  if [ "$adx" -le 2 ] && [ "$ady" -le 2 ]; then
    pass=$((pass+1))
    log "PASS  #$n  $label  aim=$ax,$ay  pointer=$X,$Y  d=$dx,$dy"
    return 0
  fi
  fail=$((fail+1))
  log "FAIL  #$n  $label  aim=$ax,$ay  pointer=$X,$Y  d=$dx,$dy"
  return 1
}

# --- desktop ---
log "== DESKTOP =="
# stay off the left icon column (~80px) and top panel (y<30)
for p in \
  200,80 400,80 600,80 800,80 \
  200,200 400,200 600,200 800,200 \
  200,400 512,384 800,400 \
  200,600 400,600 700,600 900,700 \
  350,300 650,500 450,450 750,250 300,550
do
  check_pointer "${p%,*}" "${p#*,}" desktop
done
scrot -p -o /tmp/shot-desktop.png

# --- chromium + tracker ---
log "== CHROME =="
if ! curl -sf http://127.0.0.1:8766/hits >/dev/null 2>&1; then
  python3 /config/Desktop/click-tracker/server.py >/tmp/click-tracker.log 2>&1 &
  echo $! > /tmp/click-tracker.pid
  sleep 0.4
fi
# close leftover chromiums
wmctrl -l | awk 'BEGIN{IGNORECASE=1} /chrom/{print $1}' | while read -r id; do wmctrl -ic "$id" || true; done
sleep 0.4
chromium --no-sandbox --disable-gpu --disable-dev-shm-usage --no-first-run \
  --window-position=0,0 --window-size=1024,741 \
  http://127.0.0.1:8766/ >/tmp/chromium.log 2>&1 &
for i in $(seq 1 25); do
  wmctrl -l | grep -qi "click tracker\|127.0.0.1:8766\|chromium" && break
  sleep 0.3
done
wid=$(wmctrl -l | awk 'BEGIN{IGNORECASE=1} /8766|click tracker|Chromium/{print $1; exit}')
if [ -n "${wid:-}" ]; then
  wmctrl -ia "$wid" || true
  wmctrl -ir "$wid" -e 0,0,27,1024,741 || true
fi
sleep 0.8
# dismiss any infobar by clicking page center first
curl -sf -X POST http://127.0.0.1:8766/reset >/dev/null || true
# chrome content clicks (below chrome UI ~ y 120)
for p in \
  180,180 350,180 550,180 750,180 \
  200,300 400,300 600,300 800,300 \
  250,450 512,450 780,450 \
  220,580 400,580 650,580 850,580
do
  ax=${p%,*}; ay=${p#*,}
  curl -sf -X POST http://127.0.0.1:8766/aim -H "Content-Type: application/json" -d "{\"x\":$ax,\"y\":$ay}" >/dev/null || true
  sleep 0.12
  check_pointer "$ax" "$ay" chrome-pointer
  # page screen hit (best-effort)
  if python3 /config/Desktop/click-tracker/readhit.py "$ax" "$ay" >/tmp/hit.txt 2>/dev/null; then
    log "      page-hit $(cat /tmp/hit.txt)"
  else
    log "      page-hit none (pointer still counted)"
  fi
done
scrot -p -o /tmp/shot-chrome.png

# --- terminal ---
log "== TERMINAL =="
wmctrl -l | awk 'BEGIN{IGNORECASE=1} /terminal|xterm/{print $1}' | while read -r id; do wmctrl -ic "$id" || true; done
sleep 0.3
xfce4-terminal --hide-menubar --geometry=80x24+180+140 >/tmp/term.log 2>&1 &
sleep 0.8
twid=$(wmctrl -lG | awk 'BEGIN{IGNORECASE=1} /terminal/{print $1; exit}')
log "term window $twid"
if [ -n "${twid:-}" ]; then
  wmctrl -ia "$twid" || true
  # geometry: id desk x y w h
  read -r _ _ tx ty tw th _ < <(wmctrl -lG | awk -v id="$twid" '$1==id {print}')
  log "term geom x=$tx y=$ty w=$tw h=$th"
  # 10 points inset in the terminal client area
  for p in \
    "$((tx+40)),$((ty+40))" \
    "$((tx+tw/2)),$((ty+40))" \
    "$((tx+tw-50)),$((ty+40))" \
    "$((tx+40)),$((ty+th/2))" \
    "$((tx+tw/2)),$((ty+th/2))" \
    "$((tx+tw-50)),$((ty+th/2))" \
    "$((tx+40)),$((ty+th-40))" \
    "$((tx+tw/2)),$((ty+th-40))" \
    "$((tx+tw-50)),$((ty+th-40))" \
    "$((tx+tw/3)),$((ty+th/3))"
  do
    ax=${p%,*}; ay=${p#*,}
    check_pointer "$ax" "$ay" terminal
    eval "$(xdotool getmouselocation --shell)"
    if [ "${WINDOW}" = "$((16#${twid#0x}))" ] || [ "$WINDOW" != "0" ]; then
      log "      window-under-pointer=$WINDOW"
    fi
  done
else
  log "FAIL  no terminal window"
  fail=$((fail+10))
  n=$((n+10))
fi
scrot -p -o /tmp/shot-terminal.png

log "== SUMMARY =="
log "passed=$pass failed=$fail total=$n"
[ "$fail" -eq 0 ] && [ "$n" -ge 40 ]
