#!/bin/zsh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${GROK_BOT_PROXY_PORT:-8899}"
LOG="$ROOT/data/traces/grok-bot-netlog.json"
mkdir -p "$ROOT/data/traces"

if ! lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
  node "$ROOT/tools/grok-bot-proxy.mjs" >>"$ROOT/data/traces/grok-bot-proxy.out" 2>&1 &
  sleep 0.4
fi

# Single-instance apps reuse the running process; quit first so proxy + netlog attach.
osascript -e 'tell application "Grok Bot" to quit' >/dev/null 2>&1 || true
sleep 0.8

PAC="file://${ROOT}/tools/grok-bot.pac"
BIN="/Applications/Grok Bot.app/Contents/MacOS/Grok Bot"
export http_proxy="http://127.0.0.1:${PORT}"
export https_proxy="http://127.0.0.1:${PORT}"
export HTTP_PROXY="$http_proxy"
export HTTPS_PROXY="$https_proxy"
export ALL_PROXY="$http_proxy"
export NODE_USE_ENV_PROXY=1
export GLOBAL_AGENT_HTTP_PROXY="$http_proxy"

"$BIN" \
  --proxy-server="http://127.0.0.1:${PORT}" \
  --proxy-pac-url="$PAC" \
  --proxy-bypass-list="<-loopback>" \
  --log-net-log="$LOG" \
  --net-log-capture-mode=IncludeSensitive \
  >/tmp/grok-bot-proxied.out 2>&1 &

echo "Grok Bot launched via 127.0.0.1:${PORT}"
echo "CONNECT log: $ROOT/data/traces/grok-bot-proxy.jsonl"
echo "Chromium netlog: $LOG"
