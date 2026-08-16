#!/bin/bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
export HOME=/config

need_chrome=0
need_rustdesk=0
command -v google-chrome >/dev/null 2>&1 || command -v google-chrome-stable >/dev/null 2>&1 || need_chrome=1
command -v rustdesk >/dev/null 2>&1 || need_rustdesk=1

apt-get update -qq
apt-get install -y -qq wget ca-certificates desktop-file-utils xdg-utils fonts-liberation libnss3 libatk-bridge2.0-0 libgtk-3-0 libxss1 libasound2t64 libasound2 2>/dev/null || \
  apt-get install -y -qq wget ca-certificates desktop-file-utils xdg-utils fonts-liberation

if [ "$need_chrome" = 1 ]; then
  echo "Installing Google Chrome (arm64)…"
  wget -q -O /tmp/chrome.deb "https://dl.google.com/linux/direct/google-chrome-stable_current_arm64.deb"
  apt-get install -y -qq /tmp/chrome.deb || { dpkg -i /tmp/chrome.deb || true; apt-get install -f -y -qq; }
  rm -f /tmp/chrome.deb
fi

if [ "$need_rustdesk" = 1 ]; then
  echo "Installing RustDesk 1.4.9…"
  wget -q -O /tmp/rustdesk.deb "https://github.com/rustdesk/rustdesk/releases/download/1.4.9/rustdesk-1.4.9-aarch64.deb"
  apt-get install -y -qq /tmp/rustdesk.deb || { dpkg -i /tmp/rustdesk.deb || true; apt-get install -f -y -qq; }
  rm -f /tmp/rustdesk.deb
fi

echo "Installing latest Grok Build CLI…"
curl -fsSL https://x.ai/cli/install.sh | bash || true
src=$(find /root/.grok/bin /root/.local/bin /root/.grok/downloads /config/.grok/bin /config/.grok/downloads -type f \( -name grok -o -name 'grok-linux-*' \) 2>/dev/null | head -1 || true)
if [ -z "$src" ]; then
  src=$(find /root /config /usr/local -name 'grok-linux-*' -o -name grok -type f 2>/dev/null | head -1 || true)
fi
if [ -n "$src" ]; then
  target=$(readlink -f /usr/local/bin/grok 2>/dev/null || true)
  srcabs=$(readlink -f "$src" 2>/dev/null || echo "$src")
  if [ "$srcabs" != "$target" ]; then
    install -m 755 "$src" /usr/local/bin/grok
  fi
  ln -sfn /usr/local/bin/grok /usr/bin/grok
  ln -sfn /usr/local/bin/grok /usr/local/bin/agent
fi
# abc's login PATH is often /usr/bin only
if [ -x /usr/local/bin/grok ]; then
  grep -q '/usr/local/bin' /config/.profile 2>/dev/null || echo 'export PATH="/usr/local/bin:$PATH"' >> /config/.profile
  chown abc:abc /config/.profile 2>/dev/null || true
fi

mkdir -p /config/Desktop /usr/share/applications
cat > /usr/local/bin/chrome-desktop << 'EOF'
#!/bin/bash
exec google-chrome --no-sandbox --disable-dev-shm-usage --disable-gpu --no-first-run --no-default-browser-check --disable-session-crashed-bubble --window-position=0,0 --window-size=1024,768 "$@"
EOF
chmod +x /usr/local/bin/chrome-desktop
ln -sfn /usr/local/bin/chrome-desktop /usr/local/bin/chrome

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

cat > /config/Desktop/RustDesk.desktop << 'EOF'
[Desktop Entry]
Version=1.0
Type=Application
Name=RustDesk
Comment=Remote desktop
Exec=rustdesk
Icon=rustdesk
Terminal=false
Categories=Network;RemoteAccess;
EOF

cat > /config/Desktop/Grok\ Build.desktop << 'EOF'
[Desktop Entry]
Version=1.0
Type=Application
Name=Grok Build
Comment=Grok Build CLI (not the app harness)
Exec=xfce4-terminal --title=Grok Build -e "bash -lc 'grok --version; echo; exec bash'"
Icon=utilities-terminal
Terminal=false
Categories=Development;Utility;
EOF

chmod +x /config/Desktop/*.desktop
chown -R abc:abc /config/Desktop
sudo -u abc -H env DISPLAY=:1 HOME=/config gio set "/config/Desktop/Google Chrome.desktop" "metadata::trusted" true 2>/dev/null || true
sudo -u abc -H env DISPLAY=:1 HOME=/config gio set "/config/Desktop/RustDesk.desktop" "metadata::trusted" true 2>/dev/null || true
sudo -u abc -H env DISPLAY=:1 HOME=/config gio set "/config/Desktop/Grok Build.desktop" "metadata::trusted" true 2>/dev/null || true
update-desktop-database /usr/share/applications >/dev/null 2>&1 || true
echo "APPS_OK chrome=$(command -v google-chrome-stable || command -v google-chrome) rustdesk=$(command -v rustdesk) grok=$(command -v grok || echo missing)"
