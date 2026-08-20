#!/bin/bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
export HOME=/config

wait_apt() {
  for _ in $(seq 1 30); do
    if ! fuser /var/lib/dpkg/lock-frontend /var/lib/apt/lists/lock /var/cache/apt/archives/lock >/dev/null 2>&1; then
      dpkg --configure -a >/dev/null 2>&1 || true
      return 0
    fi
    sleep 2
  done
}

apt_retry() {
  local n=0
  until [ "$n" -ge 4 ]; do
    wait_apt
    if apt-get update -qq && apt-get install -y -qq --fix-missing "$@"; then
      return 0
    fi
    n=$((n + 1))
    sleep $((n * 3))
  done
  return 1
}

need_chrome=0
command -v google-chrome >/dev/null 2>&1 || command -v google-chrome-stable >/dev/null 2>&1 || need_chrome=1
# RustDesk and Grok Build CLI are not installed by default.

if [ "$need_chrome" = 1 ]; then
  apt_retry wget ca-certificates curl desktop-file-utils xdg-utils fonts-liberation fonts-noto-core libnss3 libatk-bridge2.0-0 libgtk-3-0 libxss1 libasound2t64 libasound2 \
    || apt_retry wget ca-certificates curl desktop-file-utils xdg-utils fonts-liberation fonts-noto-core
fi

arch=$(dpkg --print-architecture 2>/dev/null || uname -m)
case "$arch" in
  amd64|x86_64) chrome_deb="google-chrome-stable_current_amd64.deb" ;;
  *) chrome_deb="google-chrome-stable_current_arm64.deb" ;;
esac

fetch_deb() {
  local url="$1" dest="$2"
  if command -v wget >/dev/null 2>&1; then
    wget -q --tries=4 --timeout=30 -O "$dest" "$url" && return 0
  fi
  curl -fsSL --retry 4 --retry-delay 2 -o "$dest" "$url"
}

if [ "$need_chrome" = 1 ]; then
  echo "Installing Google Chrome ($arch)…"
  if dpkg -l google-chrome-stable 2>/dev/null | grep -Eq '^.[FHU]'; then
    dpkg --remove --force-remove-reinstreq google-chrome-stable >/dev/null 2>&1 || true
  fi
  fetch_deb "https://dl.google.com/linux/direct/${chrome_deb}" /tmp/chrome.deb
  wait_apt
  apt-get install -y -qq --fix-missing /tmp/chrome.deb || { dpkg -i /tmp/chrome.deb || true; wait_apt; apt-get install -f -y -qq; }
  rm -f /tmp/chrome.deb
fi

# if [ "$need_rustdesk" = 1 ]; then
#   echo "Installing RustDesk 1.4.9 ($arch)…"
#   fetch_deb "https://github.com/rustdesk/rustdesk/releases/download/1.4.9/${rustdesk_deb}" /tmp/rustdesk.deb
#   wait_apt
#   apt-get install -y -qq --fix-missing /tmp/rustdesk.deb || { dpkg -i /tmp/rustdesk.deb || true; wait_apt; apt-get install -f -y -qq; }
#   rm -f /tmp/rustdesk.deb
# fi
#
# echo "Installing latest Grok Build CLI…"
# curl -fsSL https://x.ai/cli/install.sh | bash || true
# … grok CLI install omitted; Grok Build harness runs on the host via Sub8 tools.

mkdir -p /config/Desktop /config/chrome-desk /usr/share/applications
# One Chrome, one tab. chrome-one-tab.py is copied by Sub8; this wrapper matches the slim desk.
cat > /usr/local/bin/chrome-desktop << 'EOF'
#!/bin/bash
set -euo pipefail
export DISPLAY="${DISPLAY:-:1}"
export HOME="${HOME:-/config}"
CHROME="$(command -v google-chrome-stable || command -v google-chrome || command -v chromium || command -v chromium-browser || true)"
if [ -z "$CHROME" ]; then
  echo "Chrome is not installed" >&2
  exit 1
fi
URL="${1:-https://www.google.com/}"
flags=(
  --no-sandbox
  --disable-dev-shm-usage
  --disable-gpu
  --renderer-process-limit=2
  --user-data-dir=/config/chrome-desk
  --remote-debugging-port=9222
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
)
if curl -sf --max-time 1 http://127.0.0.1:9222/json/version >/dev/null; then
  exec python3 /usr/local/bin/chrome-one-tab "$URL"
fi
exec "$CHROME" "${flags[@]}" "$URL"
EOF
chmod +x /usr/local/bin/chrome-desktop
ln -sfn /usr/local/bin/chrome-desktop /usr/local/bin/chrome
ln -sfn /usr/local/bin/chrome-desktop /usr/local/bin/box-chrome

cat > /config/Desktop/Google\ Chrome.desktop << 'EOF'
[Desktop Entry]
Version=1.0
Type=Application
Name=Google Chrome
Comment=Browse the web
Exec=/usr/local/bin/chrome-desktop %U
Icon=google-chrome
Terminal=false
Categories=Network;WebBrowser;
EOF

# RustDesk.desktop and Grok Build.desktop omitted on purpose.

chmod +x /config/Desktop/*.desktop
chown -R abc:abc /config/Desktop
sudo -u abc -H env DISPLAY=:1 HOME=/config gio set "/config/Desktop/Google Chrome.desktop" "metadata::trusted" true 2>/dev/null || true
update-desktop-database /usr/share/applications >/dev/null 2>&1 || true
echo "APPS_OK chrome=$(command -v google-chrome-stable || command -v google-chrome)"
