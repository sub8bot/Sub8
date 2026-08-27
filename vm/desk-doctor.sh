#!/bin/bash
# Diagnose this computer. Print OK/FAIL. Do not rebuild anything.
set -u
export DISPLAY="${DISPLAY:-:1}"
export HOME="${HOME:-/config}"
fail=0
ok() { echo "OK   $*"; }
bad() { echo "FAIL $*"; fail=1; }
note() { echo "NOTE $*"; }

echo "desk-doctor $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "user=$(id -un 2>/dev/null || echo ?) home=$HOME host=$(hostname) display=$DISPLAY"
if [ -e /.dockerenv ]; then ok "container"; else bad "not a container"; fi

if command -v xdpyinfo >/dev/null 2>&1 && xdpyinfo >/dev/null 2>&1; then
  ok "X $DISPLAY"
else
  bad "X $DISPLAY down — /tmp/xvfb.log"
fi

pgrep -x picom >/dev/null 2>&1 && ok "picom" || bad "picom"
pgrep -x xfwm4 >/dev/null 2>&1 && ok "xfwm4" || bad "xfwm4"

port_up() {
  local p="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | grep -q ":${p}"
    return
  fi
  (echo >/dev/tcp/127.0.0.1/"$p") >/dev/null 2>&1
}
port_up 5900 && ok "x11vnc :5900" || bad "x11vnc :5900"
port_up 3000 && ok "novnc :3000" || bad "novnc :3000"
port_up 9222 && ok "chrome debug :9222" || note "chrome debug :9222 down (normal until Chrome is open)"

if curl -sf --max-time 1 http://127.0.0.1:9222/json/version >/dev/null 2>&1; then
  tabs=$(curl -sf --max-time 1 http://127.0.0.1:9222/json/list 2>/dev/null | python3 -c "import json,sys
d=json.load(sys.stdin)
print(len([x for x in d if x.get('type')=='page']))" 2>/dev/null || echo "?")
  ok "chrome tabs=$tabs (want 1)"
elif pgrep -f 'chrome|chromium' >/dev/null 2>&1; then
  note "chrome is running without debug port 9222"
else
  note "chrome not running — open with computer action open"
fi

echo "disk:"
df -h /config / 2>/dev/null | awk 'NR==1 || /config|\/$/'
echo "memory:"
awk '/MemTotal|MemAvailable|SwapTotal/{print}' /proc/meminfo 2>/dev/null || true
echo "logs: /tmp/xvfb.log /tmp/chrome.log /tmp/x11vnc.log /tmp/picom.log /tmp/xfwm4.log"
exit "$fail"
