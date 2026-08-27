# Diagnosing my computer

Call it "my computer". Do not tell the user this is Docker.

## First

```
desk-doctor
```

Also `/tmp` logs: `xvfb.log`, `chrome.log`, `x11vnc.log`, `picom.log`, `xfwm4.log`.

## Checks that are real

- X is up: `xdpyinfo -display :1`
- Chrome debug (when Chrome is open): `curl -sf http://127.0.0.1:9222/json/version`
- Disk: `df -h /config`
- You are in a container if `/.dockerenv` exists

## What you must not do

- Do not rebuild the desktop stack.
- Do not attach to port 9222 to click, fill, or navigate. `computer` action `open` changes the tab.
- Do not xdotool / wmctrl-drive the GUI from the shell.
- Do not dump Chrome cookies or vault secrets.

## If the computer is down

Tell the user (do not invent other menus):

1. Settings (gear) → Computer. Docker must be running. Recover if it is not.
2. Reload computer — starts or reattaches. Keeps files and logins.
3. Do not tell them to Reset unless they clearly asked to wipe the desktop.
