#!/bin/bash
# Open the click lab and fire known desktop clicks. Writes /tmp/click-lab-report.txt
set -euo pipefail
export DISPLAY="${DISPLAY:-:1}"
export XAUTHORITY="${XAUTHORITY:-/config/.Xauthority}"
export HOME="${HOME:-/config}"
PAGE="file:///config/Desktop/click-lab.html"
REPORT="/tmp/click-lab-report.txt"
: > "$REPORT"
echo "display=$(xdpyinfo | awk '/dimensions/{print $2}')" | tee -a "$REPORT"
echo "pointer_start=$(xdotool getmouselocation)" | tee -a "$REPORT"
wmctrl -lG | tee -a "$REPORT"
/usr/local/bin/chrome-desktop "$PAGE" >/tmp/click-lab-chrome.log 2>&1 &
sleep 2
# wait for chrome
for i in 1 2 3 4 5 6 7 8; do
  wmctrl -l | grep -qi "click lab\|octobot click" && break
  sleep 0.4
done
# maximize / place
wid=$(wmctrl -l | awk 'BEGIN{IGNORECASE=1} /click lab|octobot click/{print $1; exit}')
if [ -n "${wid:-}" ]; then
  wmctrl -ia "$wid" || true
  wmctrl -ir "$wid" -e 0,0,27,1024,741 || true
fi
sleep 0.6
echo "--- after open ---" | tee -a "$REPORT"
wmctrl -lG | tee -a "$REPORT"
POINTS="200,200 512,400 55,612 800,500 400,300"
n=0
for p in $POINTS; do
  n=$((n+1))
  x=${p%,*}; y=${p#*,}
  echo "AIM $n $x $y" | tee -a "$REPORT"
  # reload with aim so the page knows the desktop target
  # then click
  /usr/local/bin/octo-click "$x" "$y" || true
  eval "$(xdotool getmouselocation --shell)"
  echo "POINTER $X $Y  (aimed $x $y)  dX=$((X-x)) dY=$((Y-y))" | tee -a "$REPORT"
  sleep 0.35
done
echo DONE | tee -a "$REPORT"
