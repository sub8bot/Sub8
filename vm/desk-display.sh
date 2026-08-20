#!/bin/bash
# Extra X display for one Bot. :1 is started by desk-init. This starts :2 .. :8.
set -euo pipefail
N="${1:-}"
if ! [[ "${N}" =~ ^[2-8]$ ]]; then
  echo "usage: desk-display 2..8" >&2
  exit 1
fi
export DISPLAY=":$N"
export HOME="${HOME:-/config}"
export XAUTHORITY="${XAUTHORITY:-/config/.Xauthority}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/runtime-abc}"
export LANG="${LANG:-C.UTF-8}"
VNC=$((5899 + N))
WEB=$((2999 + N))

mkdir -p "$HOME" "$HOME/Desktop" "$HOME/Downloads" "$HOME/agent-data" "$HOME/workspace" \
  /tmp/.X11-unix "$XDG_RUNTIME_DIR"
chmod 1777 /tmp/.X11-unix || true
chmod 700 "$XDG_RUNTIME_DIR" || true
touch "$XAUTHORITY" || true

if [ ! -S "/tmp/.X11-unix/X${N}" ]; then
  Xvfb ":$N" -screen 0 1024x768x24 -ac \
    +extension RANDR +extension RENDER +extension GLX +extension MIT-SHM +extension XTEST \
    -nolisten tcp -dpi 96 >/tmp/xvfb-"$N".log 2>&1 &
fi
for _ in $(seq 1 80); do
  xdpyinfo -display ":$N" >/dev/null 2>&1 && break
  sleep 0.1
done
if ! xdpyinfo -display ":$N" >/dev/null 2>&1; then
  echo "Xvfb :$N failed" >&2
  cat /tmp/xvfb-"$N".log >&2 || true
  exit 1
fi
xset s off -dpms >/dev/null 2>&1 || true
xsetroot -solid "#1a1d23" >/dev/null 2>&1 || true

if ! pgrep -f "xfwm4 --display :${N}" >/dev/null 2>&1; then
  xfwm4 --display ":$N" --replace --compositor=on --sm-client-disable >/tmp/xfwm4-"$N".log 2>&1 &
  sleep 0.2
fi

port_up() { (echo >/dev/tcp/127.0.0.1/"$1") >/dev/null 2>&1; }

if ! port_up "$VNC"; then
  x11vnc -display ":$N" -forever -shared -nopw -xkb -repeat \
    -rfbport "$VNC" -localhost -noxdamage -wait 10 -defer 10 \
    -o /tmp/x11vnc-"$N".log >/dev/null 2>&1 &
  for _ in $(seq 1 50); do
    port_up "$VNC" && break
    sleep 0.1
  done
fi

WEBROOT=/usr/share/novnc
if [ -f "$WEBROOT/vnc.html" ] && [ ! -e "$WEBROOT/index.html" ]; then
  ln -sf vnc.html "$WEBROOT/index.html"
fi
if ! port_up "$WEB"; then
  websockify --web="$WEBROOT" "$WEB" "127.0.0.1:$VNC" >/tmp/websockify-"$N".log 2>&1 &
fi

echo "DISPLAY=:$N vnc=$VNC novnc=$WEB"
