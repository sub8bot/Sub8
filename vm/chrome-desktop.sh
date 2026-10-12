#!/bin/bash
# One Chrome, one tab, on THIS $DISPLAY. Extra invocations replace the current page.
set -euo pipefail
export DISPLAY="${DISPLAY:-:1}"
export HOME="${HOME:-/config}"
export XAUTHORITY="${XAUTHORITY:-/config/.Xauthority}"
export LANG="${LANG:-C.UTF-8}"
export LANGUAGE="${LANGUAGE:-en_US:en}"
export LC_ALL="${LC_ALL:-C.UTF-8}"
CHROME="$(command -v google-chrome-stable || command -v google-chrome || command -v chromium || command -v chromium-browser || true)"
if [ -z "$CHROME" ]; then
  echo "Chrome is not installed" >&2
  exit 1
fi
URL="${1:-https://www.google.com/?hl=en&gl=us}"
N="${DISPLAY#:}"
N="${N%%.*}"
if [ -z "$N" ] || [ "$N" = "1" ]; then
  PROFILE=/config/chrome-desk
  DEBUG_PORT=9222
else
  PROFILE="/config/chrome-desk-${N}"
  DEBUG_PORT=$((9221 + N))
fi

kill_unprofiled_chrome() {
  # Old webtop/boot Chromes have no --user-data-dir and steal :1 / RAM.
  # ps pads PIDs with spaces — use awk $1, not ${line%% *}.
  local pids
  pids="$(ps -eo pid= -o args= 2>/dev/null | awk '
    /--type=/ { next }
    /crashpad/ { next }
    /user-data-dir=/ { next }
    /chrome-desktop|chrome-one-tab|box-chrome/ { next }
    /google-chrome|chromium|\/chrome\/chrome/ { print $1 }
  ')"
  for pid in $pids; do
    kill "$pid" 2>/dev/null || true
  done
}

# Teammates (display :N, N != 1) get their own Chrome and profile so they can
# work in parallel with the lead. On first start, seed that profile from the
# lead's /config/chrome-desk so the teammate is already signed in to the same
# sites. Runs once per profile (marker file). Opt out with
# SUB8_TEAMMATE_SHARE_LOGIN=0 or by creating /config/.sub8-no-teammate-login.
LEAD_PROFILE=/config/chrome-desk
SEED_MARKER=.sub8-seeded-from-lead
SEED_EXCLUDES=(
  'Singleton*' 'lockfile' 'DevToolsActivePort' '*.tmp'
  'Cache' 'Code Cache' 'GPUCache' 'ShaderCache' 'GrShaderCache'
  'GraphiteDawnCache' 'DawnCache' 'GPUPersistentCache' 'DawnGraphiteCache' 'DawnWebGPUCache'
  'component_crx_cache' 'extensions_crx_cache' 'Crashpad' 'BrowserMetrics'
  'CacheStorage' 'ScriptCache' 'optimization_guide_model_store'
  'Sessions' 'Current Session' 'Current Tabs' 'Last Session' 'Last Tabs'
)

teammate_share_login_on() {
  case "${SUB8_TEAMMATE_SHARE_LOGIN:-1}" in
    0|false|no|off) return 1 ;;
  esac
  [ ! -e /config/.sub8-no-teammate-login ]
}

# Copy one SQLite database consistently via the backup API (handles a live
# -wal/-journal); fall back to the raw files copied together.
seed_sqlite() {
  local src="$1" dst="$2"
  [ -f "$src" ] || return 0
  if python3 - "$src" "$dst" 2>/dev/null << 'PY'
import sqlite3, sys
src = sqlite3.connect("file:" + sys.argv[1] + "?mode=ro", uri=True, timeout=2)
tmp = sys.argv[2] + ".sub8-tmp"
dst = sqlite3.connect(tmp)
src.backup(dst)
dst.close()
src.close()
import os
os.replace(tmp, sys.argv[2])
for ext in ("-journal", "-wal", "-shm"):
    try:
        os.remove(sys.argv[2] + ext)
    except FileNotFoundError:
        pass
PY
  then
    return 0
  fi
  rm -f "$dst.sub8-tmp"
  local ext
  cp -p "$src" "$dst" 2>/dev/null || true
  for ext in -journal -wal; do
    if [ -f "$src$ext" ]; then cp -p "$src$ext" "$dst$ext" 2>/dev/null || true; else rm -f "$dst$ext"; fi
  done
}

seed_teammate_profile() {
  local target="$1"
  [ -d "$LEAD_PROFILE/Default" ] || return 0
  [ -f "$target/$SEED_MARKER" ] && return 0
  teammate_share_login_on || return 0
  local stage="${target}.seed.$$"
  rm -rf "$stage"
  mkdir -p "$stage" || return 0
  local ex=() pat
  for pat in "${SEED_EXCLUDES[@]}"; do ex+=(--exclude="$pat"); done
  # A snapshot of a possibly running Chrome: files may change mid-copy, so
  # ignore tar's "file changed" warnings and fix up the databases below.
  if command -v rsync >/dev/null 2>&1; then
    rsync -a "${ex[@]}" "$LEAD_PROFILE/" "$stage/" 2>/dev/null || true
  else
    tar -C "$LEAD_PROFILE" "${ex[@]}" --warning=no-file-changed --ignore-failed-read -cf - . 2>/dev/null \
      | tar -C "$stage" -xf - 2>/dev/null || true
  fi
  local db
  for db in "Default/Cookies" "Default/Login Data" "Default/Web Data" "Default/Network/Cookies"; do
    if [ -f "$LEAD_PROFILE/$db" ]; then
      mkdir -p "$(dirname "$stage/$db")"
      seed_sqlite "$LEAD_PROFILE/$db" "$stage/$db"
    fi
  done
  date -u +%Y-%m-%dT%H:%M:%SZ > "$stage/$SEED_MARKER"
  if [ -e "$target" ]; then
    cp -a "$stage/." "$target/" 2>/dev/null || true
    rm -rf "$stage"
  else
    mv "$stage" "$target"
  fi
}

if [ "$PROFILE" != "$LEAD_PROFILE" ] \
  && ! curl -sf --max-time 1 "http://127.0.0.1:${DEBUG_PORT}/json/version" >/dev/null 2>&1; then
  seed_teammate_profile "$PROFILE" || true
fi

mkdir -p "$PROFILE"
if [ ! -w "$PROFILE" ]; then
  if command -v sudo >/dev/null 2>&1; then
    sudo chown -R "$(id -u):$(id -g)" "$PROFILE" 2>/dev/null || true
  fi
fi
if [ ! -w "$PROFILE" ]; then
  PROFILE="/tmp/chrome-desk-${N:-1}"
  mkdir -p "$PROFILE"
fi
mkdir -p "$PROFILE/Default"
prefs="$PROFILE/Default/Preferences"
if [ ! -f "$prefs" ]; then
  cat > "$prefs" << 'EOF'
{"intl":{"accept_languages":"en-US,en"},"translate":{"enabled":false},"webkit":{"webprefs":{"default_text_encoding_name":"UTF-8"}}}
EOF
fi

export CHROME_DEBUG="http://127.0.0.1:${DEBUG_PORT}"
flags=(
  --no-sandbox
  --disable-dev-shm-usage
  # No GPU in the desk container. --disable-gpu also killed software WebGL, so
  # 3D pages (freebots.lol/world, maps) failed with "Could not create a WebGL
  # context". SwiftShader renders GL on the CPU: slower, but it works.
  --use-gl=angle
  --use-angle=swiftshader
  --enable-unsafe-swiftshader
  --ignore-gpu-blocklist
  --renderer-process-limit=2
  --user-data-dir="$PROFILE"
  --remote-debugging-port="$DEBUG_PORT"
  --remote-debugging-address=127.0.0.1
  --remote-allow-origins=*
  --no-first-run
  --no-default-browser-check
  --disable-session-crashed-bubble
  --hide-crash-restore-bubble
  --disable-infobars
  --test-type
  --disable-features=TranslateUI,MediaRouter
  --start-maximized
  --window-position=0,0
  --window-size=1024,768
  --lang=en-US
  --accept-lang=en-US,en
)
kill_unprofiled_chrome || true
if curl -sf --max-time 1 "$CHROME_DEBUG/json/version" >/dev/null; then
  exec python3 /usr/local/bin/chrome-one-tab "$URL"
fi
exec "$CHROME" "${flags[@]}" "$URL"
