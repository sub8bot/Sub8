#!/bin/zsh
set -e
export DOCKER_HOST="${DOCKER_HOST:-unix://$HOME/.colima/default/docker.sock}"
if ! docker info >/dev/null 2>&1; then
  echo "Starting Colima…"
  colima start
fi
cd "$(dirname "$0")"
if [ -z "${XAI_API_KEY:-}" ]; then
  echo "warning: XAI_API_KEY is empty — Settings → Harness expects SpaceXAI / grok-4.6"
fi
SERVER=""
if curl -sf -m 2 http://127.0.0.1:8787/api/health | grep -q '"ok":true'; then
  echo "Server already running on http://127.0.0.1:8787"
else
  node server/index.mjs &
  SERVER=$!
  trap 'kill $SERVER 2>/dev/null || true' EXIT
  sleep 0.8
fi
APP_ELECTRON="$PWD/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
has_main=0
has_window=0
# Read ps in-shell so grep/pgrep -f cannot self-match this check.
while IFS= read -r pid cmd; do
  case "$cmd" in
    "$APP_ELECTRON"*) has_main=1 ;;
    *"Electron Helper (Renderer)"*"--app-path=$PWD"*|*"--app-path=$PWD"*"Electron Helper (Renderer)"*) has_window=1 ;;
  esac
done < <(ps -ax -o pid=,command=)
if [ "$has_main" = 1 ] && [ "$has_window" = 1 ]; then
  echo "Local Bot window already running — focusing"
  # Second instance exits after requestSingleInstanceLock focuses the existing window.
  npx electron . >/dev/null 2>&1 || true
  if [ -n "$SERVER" ]; then
    wait "$SERVER"
  fi
  exit 0
fi
if [ "$has_main" = 1 ]; then
  echo "Local Bot Electron has no window — relaunching"
  while IFS= read -r pid cmd; do
    case "$cmd" in
      "$APP_ELECTRON"*) kill "$pid" 2>/dev/null || true ;;
    esac
  done < <(ps -ax -o pid=,command=)
  sleep 0.4
fi
npx electron .
