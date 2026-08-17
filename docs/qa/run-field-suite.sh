#!/bin/bash
# Comprehensive computer-control suite on a bot VM.
# Usage: CONTAINER=localbot-555baff5 bash docs/qa/run-field-suite.sh
set -u
C="${CONTAINER:?set CONTAINER}"
export DISPLAY=:1 HOME=/config XAUTHORITY=/config/.Xauthority
OUT=/tmp/field-suite
mkdir -p "$OUT"
: > "$OUT/report.txt"
pass=0; fail=0; n=0

log() { echo "$*" | tee -a "$OUT/report.txt"; }
dex() { docker exec -u abc -e DISPLAY=:1 -e HOME=/config -e XAUTHORITY=/config/.Xauthority "$C" bash -lc "$*"; }

click() {
  dex "/usr/local/bin/octo-click $1 $2 >/tmp/octo-last.txt; eval \"\$(xdotool getmouselocation --shell)\"; echo \$X \$Y"
}

assert_ptr() {
  local ax=$1 ay=$2 label=$3
  n=$((n+1))
  local got
  got=$(click "$ax" "$ay")
  local X=${got%% *}; local Y=${got##* }
  X=${X:-0}; Y=${Y:-0}
  local dx=$((X-ax)); local dy=$((Y-ay))
  local adx=${dx#-}; local ady=${dy#-}
  if [ "$adx" -le 2 ] && [ "$ady" -le 2 ]; then
    pass=$((pass+1))
    log "PASS  T$(printf '%02d' $n)  $label  aim=$ax,$ay  landed=$X,$Y"
    return 0
  fi
  fail=$((fail+1))
  log "FAIL  T$(printf '%02d' $n)  $label  aim=$ax,$ay  landed=$X,$Y  d=$dx,$dy"
  return 1
}

shot() { dex "scrot -p -o $1"; docker cp "$C:$1" "/tmp/field-$(basename "$1")" 2>/dev/null || true; }

log "container=$C"
log "started $(date -u +%Y-%m-%dT%H:%M:%SZ)"
dex "command -v xdotool; command -v octo-click; xdotool getdisplaygeometry"

log ""
log "## A  Desktop pointer (15)"
for p in 200,80 400,80 700,80 200,200 512,200 800,200 200,400 512,384 800,400 300,550 600,550 900,650 350,300 650,450 450,700; do
  assert_ptr "${p%,*}" "${p#*,}" desktop
done
shot /tmp/field-desktop.png

log ""
log "## B  Open Chromium + form page"
dex "wmctrl -l | awk 'BEGIN{IGNORECASE=1} /chrom/{print \$1}' | while read id; do wmctrl -ic \$id || true; done" || true
sleep 0.4
# prefer google-chrome if present
BROWSER=$(dex "command -v google-chrome || command -v google-chrome-stable || command -v chromium")
log "browser=$BROWSER"
dex "$BROWSER --no-sandbox --disable-gpu --disable-dev-shm-usage --no-first-run --window-position=0,0 --window-size=1024,741 'https://httpbin.org/forms/post' >/tmp/chrome-field.log 2>&1 &"
for i in $(seq 1 40); do
  dex "wmctrl -l" | grep -qiE "chrom|httpbin|form" && break
  sleep 0.4
done
dex "wid=\$(wmctrl -l | awk 'BEGIN{IGNORECASE=1} /chrom|httpbin|form/{print \$1; exit}'); [ -n \"\$wid\" ] && wmctrl -ia \$wid && wmctrl -ir \$wid -e 0,0,27,1024,741 || true"
sleep 1.2
shot /tmp/field-form-open.png

log ""
log "## C  Chrome chrome + page pointer (15)"
# stay in content-ish region
for p in 200,160 400,160 700,160 250,250 500,250 750,250 200,400 512,400 800,400 300,520 600,520 180,600 400,600 700,600 900,350; do
  assert_ptr "${p%,*}" "${p#*,}" chrome
done
shot /tmp/field-form-clicks.png

log ""
log "## D  Terminal (10)"
dex "xfce4-terminal --hide-menubar --geometry=70x20+200+160 >/tmp/term-field.log 2>&1 &" || true
twid=""
for i in $(seq 1 40); do
  twid=$(dex "wmctrl -l" | awk 'BEGIN{IGNORECASE=1} /Terminal/{print $1; exit}')
  [ -n "$twid" ] && break
  sleep 0.25
done
log "terminal=$twid"
if [ -n "$twid" ]; then
  geom=$(dex "wmctrl -lG" | awk -v id="$twid" '$1==id {print $3,$4,$5,$6}')
  set -- $geom
  tx=$1; ty=$2; tw=$3; th=$4
  log "term-geom $tx $ty $tw $th"
  dex "wmctrl -ia $twid || true"
  sleep 0.3
  for p in \
    $((tx+40)),$((ty+40)) \
    $((tx+tw/2)),$((ty+40)) \
    $((tx+tw-50)),$((ty+40)) \
    $((tx+40)),$((ty+th/2)) \
    $((tx+tw/2)),$((ty+th/2)) \
    $((tx+tw-50)),$((ty+th/2)) \
    $((tx+40)),$((ty+th-36)) \
    $((tx+tw/2)),$((ty+th-36)) \
    $((tx+tw-50)),$((ty+th-36)) \
    $((tx+tw/3)),$((ty+th/3))
  do
    assert_ptr "${p%,*}" "${p#*,}" terminal
  done
else
  log "FAIL  no terminal"
  fail=$((fail+10)); n=$((n+10))
fi
shot /tmp/field-terminal.png

log ""
log "## SUMMARY pass=$pass fail=$fail total=$n"
[ "$fail" -eq 0 ] && [ "$n" -ge 40 ]
