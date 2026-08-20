# Sub8 slim desk: Debian 13 (Trixie) + Xvfb + xfwm4 + picom + noVNC + Chrome.
# Not a full XFCE session. Idle RAM is a few hundred MB, not a Webtop desktop.
FROM debian:trixie-slim

ENV DEBIAN_FRONTEND=noninteractive \
    HOME=/config \
    DISPLAY=:1 \
    LANG=C.UTF-8 \
    TITLE="My Computer"

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates wget curl \
    xvfb xfwm4 picom x11vnc novnc python3-websockify \
    ffmpeg python3 libxtst6 libx11-6 \
    xclip wmctrl x11-utils x11-xserver-utils xdotool xterm pcmanfm \
    dbus-x11 dbus \
    fonts-liberation fonts-dejavu-core \
    tini sudo procps \
    libnss3 libatk-bridge2.0-0 libgtk-3-0 libxss1 libasound2t64 \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sfn /usr/bin/websockify /usr/local/bin/websockify || true \
    && if [ -f /usr/share/novnc/vnc.html ] && [ ! -e /usr/share/novnc/index.html ]; then ln -sfn vnc.html /usr/share/novnc/index.html; fi

# Google Chrome when the .deb exists for this arch; Chromium otherwise.
ARG TARGETARCH
RUN set -eux; \
    arch="${TARGETARCH:-}"; \
    if [ -z "$arch" ]; then arch="$(dpkg --print-architecture)"; fi; \
    case "$arch" in \
      amd64|x86_64) deb="google-chrome-stable_current_amd64.deb" ;; \
      *) deb="google-chrome-stable_current_arm64.deb" ;; \
    esac; \
    if wget -q -O /tmp/chrome.deb "https://dl.google.com/linux/direct/${deb}"; then \
      apt-get update && apt-get install -y --no-install-recommends /tmp/chrome.deb || apt-get install -y --no-install-recommends chromium; \
    else \
      apt-get update && apt-get install -y --no-install-recommends chromium; \
    fi; \
    rm -f /tmp/chrome.deb; \
    rm -rf /var/lib/apt/lists/*

RUN useradd -u 1000 -m -d /config -s /bin/bash abc \
    && echo "abc ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/abc \
    && chmod 440 /etc/sudoers.d/abc \
    && mkdir -p /config/Desktop /config/Downloads /config/agent-data /config/workspace \
    && chown -R abc:abc /config \
    && (dbus-uuidgen >/etc/machine-id || true)

COPY desk-init.sh chrome-desktop.sh box-input.py octo-click.sh octo-vault.sh /usr/local/src/sub8/
RUN install -m 755 /usr/local/src/sub8/desk-init.sh /usr/local/bin/desk-init \
    && install -m 755 /usr/local/src/sub8/chrome-desktop.sh /usr/local/bin/chrome-desktop \
    && ln -sfn /usr/local/bin/chrome-desktop /usr/local/bin/chrome \
    && ln -sfn /usr/local/bin/chrome-desktop /usr/local/bin/box-chrome \
    && install -m 755 /usr/local/src/sub8/box-input.py /usr/local/bin/box-input \
    && install -m 755 /usr/local/src/sub8/octo-click.sh /usr/local/bin/octo-click \
    && install -m 755 /usr/local/src/sub8/octo-vault.sh /usr/local/bin/octo-vault \
    && ln -sfn /usr/local/bin/octo-vault /usr/bin/octo-vault

USER abc
WORKDIR /config
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/desk-init"]
