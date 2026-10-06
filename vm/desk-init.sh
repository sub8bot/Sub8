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
  "$XDG_RUNTIME_DIR"
# libX11/xtrans refuses to listen unless /tmp/.X11-unix is root-owned.
# systemd-tmpfiles does this on a real Debian boot; Docker never runs it.
if [ "$(id -u)" = 0 ]; then
  mkdir -p /tmp/.X11-unix
  chown root:root /tmp/.X11-unix
  chmod 1777 /tmp/.X11-unix
else
  sudo mkdir -p /tmp/.X11-unix
  sudo chown root:root /tmp/.X11-unix
  sudo chmod 1777 /tmp/.X11-unix
fi
chmod 700 "$XDG_RUNTIME_DIR" || true
touch "$XAUTHORITY" || true

if command -v dbus-launch >/dev/null 2>&1; then
  eval "$(dbus-launch --sh-syntax)"
  export DBUS_SESSION_BUS_ADDRESS DBUS_SESSION_BUS_PID
fi

if xdpyinfo -display :1 >/dev/null 2>&1; then
  XVFB_PID=""
else
  rm -f /tmp/.X11-unix/X1 /tmp/.X1-lock
  Xvfb :1 -screen 0 1024x768x24 -ac \
    +extension RANDR +extension RENDER +extension GLX +extension MIT-SHM +extension XTEST \
    -nolisten tcp -dpi 96 >/tmp/xvfb.log 2>&1 &
  XVFB_PID=$!
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
mkdir -p /config/chrome-desk /config/workspace
if [ "$(id -u)" = 0 ]; then
  chown -R abc:abc /config/chrome-desk /config/workspace 2>/dev/null || true
fi
(
  while true; do
    /usr/local/bin/chrome-desktop
    sleep 2
  done
) >/tmp/chrome.log 2>&1 &
CHROME_PID=$!

# x11vnc binds LOOPBACK-ONLY unless RFB_EXPOSE=1.
#
# The default is what desks do today: the in-container websockify is the only
# thing that reaches RFB, so nothing on the network can. RFB_EXPOSE=1 is set
# only when the authenticated Worker stream proxy is active
# (cloud/src/desk-stream.ts, gated by STREAM_VIA_WORKER), which needs `docker -p`
# to publish 5900 so the Worker's raw-TCP tunnel can reach it. The Worker's
# egress is not in any IP range a firewall can name, so that port is open to
# the internet and the VNC password below is what guards it.
#
# Unset, this changes nothing. See docs/authenticated-desk-stream.md.
RFB_LOCALHOST="-localhost"
if [ "${RFB_EXPOSE:-0}" = "1" ]; then RFB_LOCALHOST=""; fi

# SECURITY (2026-09-05): never run a passwordless screen the network can reach.
# Dedicated droplets publish websockify with `docker -p 3000:3000` (0.0.0.0 on
# the host). Those runs set NOVNC_LOOPBACK=1 so a passwordless screen stays on
# container loopback. Local and packed desks already bind the *host* publish to
# 127.0.0.1; Docker DNAT then hits the container's eth0, not 127.0.0.1, so
# websockify must listen on 0.0.0.0 inside or the desktop never becomes
# reachable. Dedicated and packed desks that the Worker relays (RFB_EXPOSE=1)
# carry a per-desk VNC password instead.
#
# The password, in order: VNC_PASSWORD; else derived from the desk token
# (DESK_TOKEN_FILE, default /run/sub8/desk-token) the same way the Worker
# derives it (cloud/src/desk.ts deskVncPassword); else the rfbauth file a
# previous start wrote, which lives in the container layer (not /config, so a
# volume moved to another desk never carries it). desk-display reads the same
# file for :2..:8. Never echo the password or the token.
#
# Fail closed: RFB_EXPOSE=1 with no password keeps x11vnc AND websockify on
# loopback, so the relay simply cannot reach a passwordless screen.
VNC_PASSFILE="${VNC_PASSFILE:-/tmp/.vncpass}"
vnc_password_from_token() {
  local f="${DESK_TOKEN_FILE:-/run/sub8/desk-token}"
  [ -r "$f" ] || return 0
  python3 -c 'import base64,hashlib,sys
t=sys.stdin.read().strip()
if t: print(base64.urlsafe_b64encode(hashlib.sha256(("sub8-vnc:"+t).encode()).digest()).decode()[:8])' <"$f" 2>/dev/null || true
}
if [ -z "${VNC_PASSWORD:-}" ]; then VNC_PASSWORD="$(vnc_password_from_token)"; fi
if [ -n "${VNC_PASSWORD:-}" ]; then
  (umask 077 && x11vnc -storepasswd "$VNC_PASSWORD" "$VNC_PASSFILE" >/dev/null 2>&1) || true
fi
# The harness started below has no use for it.
unset VNC_PASSWORD

VNC_AUTH="-nopw"
WS_HOST="0.0.0.0:"
if [ -s "$VNC_PASSFILE" ]; then
  VNC_AUTH="-rfbauth $VNC_PASSFILE"
else
  if [ "${RFB_EXPOSE:-0}" = "1" ]; then
    echo "desk-init: RFB_EXPOSE=1 but no VNC password; keeping the screen on loopback" >&2
    RFB_LOCALHOST="-localhost"
    WS_HOST="127.0.0.1:"
  fi
  if [ "${NOVNC_LOOPBACK:-0}" = "1" ]; then WS_HOST="127.0.0.1:"; fi
fi

x11vnc -display :1 -forever -shared $VNC_AUTH -xkb -repeat \
  -rfbport 5900 $RFB_LOCALHOST -noxdamage -wait 10 -defer 10 \
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
websockify --web="$WEB" "${WS_HOST}3000" 127.0.0.1:5900 >/tmp/websockify.log 2>&1 &
WS_PID=$!

python3 /usr/local/bin/desk-harness >/tmp/desk-harness.log 2>&1 &
HARNESS_PID=$!

cleanup() {
  for p in ${CHROME_PID:-} ${HARNESS_PID:-} $WS_PID $VNC_PID $PICOM_PID $XFWM_PID $XVFB_PID ${DBUS_SESSION_BUS_PID:-}; do
    [ -n "${p:-}" ] && kill "$p" >/dev/null 2>&1 || true
  done
}
trap cleanup TERM INT EXIT

wait $WS_PID $VNC_PID $XVFB_PID
