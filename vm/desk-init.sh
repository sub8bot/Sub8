#!/bin/bash
# Slim desk: Xvfb + xfwm4 + picom + x11vnc + noVNC. No full XFCE session.
set -euo pipefail
export HOME="${HOME:-/config}"
export DISPLAY="${DISPLAY:-:1}"
export XAUTHORITY="${XAUTHORITY:-/config/.Xauthority}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/runtime-abc}"
export XDG_CURRENT_DESKTOP="${XDG_CURRENT_DESKTOP:-XFCE}"
export LANG="${LANG:-C.UTF-8}"
export LANGUAGE="${LANGUAGE:-en_US:en}"
export LC_ALL="${LC_ALL:-C.UTF-8}"

mkdir -p "$HOME" "$HOME/Desktop" "$HOME/Downloads" "$HOME/agent-data" "$HOME/workspace" \
  /tmp/.X11-unix "$XDG_RUNTIME_DIR"
chmod 1777 /tmp/.X11-unix || true
chmod 700 "$XDG_RUNTIME_DIR" || true
touch "$XAUTHORITY" || true

if command -v dbus-launch >/dev/null 2>&1; then
  eval "$(dbus-launch --sh-syntax)"
  export DBUS_SESSION_BUS_ADDRESS DBUS_SESSION_BUS_PID
fi

if [ ! -S /tmp/.X11-unix/X1 ]; then
  Xvfb :1 -screen 0 1024x768x24 -ac \
    +extension RANDR +extension RENDER +extension GLX +extension MIT-SHM +extension XTEST \
    -nolisten tcp -dpi 96 >/tmp/xvfb.log 2>&1 &
  XVFB_PID=$!
else
  XVFB_PID=""
fi

for _ in $(seq 1 80); do
  xdpyinfo -display :1 >/dev/null 2>&1 && break
  sleep 0.1
done
if ! xdpyinfo -display :1 >/dev/null 2>&1; then
  echo "Xvfb failed to start" >&2
  cat /tmp/xvfb.log >&2 || true
  exit 1
fi

xset s off -dpms >/dev/null 2>&1 || true
xsetroot -solid "#1a1d23" >/dev/null 2>&1 || true

# picom first (DISPLAY already :1). xfwm4 keeps its compositor as fallback.
picom --backend xrender --vsync >/tmp/picom.log 2>&1 &
PICOM_PID=$!
sleep 0.15
xfwm4 --display :1 --replace --compositor=on --sm-client-disable >/tmp/xfwm4.log 2>&1 &
XFWM_PID=$!
sleep 0.3
# Chrome is the computer. Keep a browser window on the desk.
(
  while true; do
    /usr/local/bin/chrome-desktop
    sleep 2
  done
) >/tmp/chrome.log 2>&1 &
CHROME_PID=$!

x11vnc -display :1 -forever -shared -nopw -xkb -repeat \
  -rfbport 5900 -localhost -noxdamage -wait 10 -defer 10 \
  -o /tmp/x11vnc.log >/dev/null 2>&1 &
VNC_PID=$!

for _ in $(seq 1 50); do
  if (echo >/dev/tcp/127.0.0.1/5900) >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done

WEB=/usr/share/novnc
if [ -f "$WEB/vnc.html" ] && [ ! -e "$WEB/index.html" ]; then
  ln -sf vnc.html "$WEB/index.html"
fi
websockify --web="$WEB" 3000 127.0.0.1:5900 >/tmp/websockify.log 2>&1 &
WS_PID=$!

cleanup() {
  for p in ${CHROME_PID:-} $WS_PID $VNC_PID $PICOM_PID $XFWM_PID $XVFB_PID ${DBUS_SESSION_BUS_PID:-}; do
    [ -n "${p:-}" ] && kill "$p" >/dev/null 2>&1 || true
  done
}
trap cleanup TERM INT EXIT

wait $WS_PID $VNC_PID $XVFB_PID
