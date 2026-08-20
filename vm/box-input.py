#!/usr/bin/env python3
"""Pixel-accurate X11 input via XTEST. No xdotool.

Clicks go to whatever is under that screen pixel. The Computer tool should
screenshot, then call: box-input click X Y [button] [count]
"""
from __future__ import annotations

import os
import subprocess
import sys
import time
from ctypes import CDLL, POINTER, byref, c_char_p, c_int, c_uint, c_ulong, c_void_p

DISPLAY_NAME = os.environ.get("DISPLAY", ":1")
SCREEN_W = 1024
SCREEN_H = 768

Window = c_ulong
KeySym = c_ulong
libX11 = None
libXtst = None


def load_x11():
    global libX11, libXtst
    if libX11:
        return
    libX11 = CDLL("libX11.so.6")
    libXtst = CDLL("libXtst.so.6")
    libX11.XOpenDisplay.argtypes = [c_char_p]
    libX11.XOpenDisplay.restype = c_void_p
    libX11.XCloseDisplay.argtypes = [c_void_p]
    libX11.XCloseDisplay.restype = c_int
    libX11.XFlush.argtypes = [c_void_p]
    libX11.XFlush.restype = c_int
    libX11.XSync.argtypes = [c_void_p, c_int]
    libX11.XSync.restype = c_int
    libX11.XDefaultScreen.argtypes = [c_void_p]
    libX11.XDefaultScreen.restype = c_int
    libX11.XRootWindow.argtypes = [c_void_p, c_int]
    libX11.XRootWindow.restype = Window
    libX11.XDisplayWidth.argtypes = [c_void_p, c_int]
    libX11.XDisplayWidth.restype = c_int
    libX11.XDisplayHeight.argtypes = [c_void_p, c_int]
    libX11.XDisplayHeight.restype = c_int
    libX11.XWarpPointer.argtypes = [c_void_p, Window, Window, c_int, c_int, c_uint, c_uint, c_int, c_int]
    libX11.XWarpPointer.restype = c_int
    libX11.XQueryPointer.argtypes = [
        c_void_p,
        Window,
        POINTER(Window),
        POINTER(Window),
        POINTER(c_int),
        POINTER(c_int),
        POINTER(c_int),
        POINTER(c_int),
        POINTER(c_uint),
    ]
    libX11.XQueryPointer.restype = c_int
    libX11.XStringToKeysym.argtypes = [c_char_p]
    libX11.XStringToKeysym.restype = KeySym
    libX11.XKeysymToKeycode.argtypes = [c_void_p, KeySym]
    libX11.XKeysymToKeycode.restype = c_uint
    libXtst.XTestFakeMotionEvent.argtypes = [c_void_p, c_int, c_int, c_int, c_ulong]
    libXtst.XTestFakeMotionEvent.restype = c_int
    libXtst.XTestFakeButtonEvent.argtypes = [c_void_p, c_uint, c_int, c_ulong]
    libXtst.XTestFakeButtonEvent.restype = c_int
    libXtst.XTestFakeKeyEvent.argtypes = [c_void_p, c_uint, c_int, c_ulong]
    libXtst.XTestFakeKeyEvent.restype = c_int

MOD_KEYS = ("Shift_L", "Shift_R", "Control_L", "Control_R", "Alt_L", "Alt_R", "Super_L", "Super_R", "Caps_Lock")

KEY_ALIASES = {
    "ctrl": "Control_L",
    "control": "Control_L",
    "alt": "Alt_L",
    "shift": "Shift_L",
    "super": "Super_L",
    "meta": "Super_L",
    "cmd": "Super_L",
    "win": "Super_L",
    "enter": "Return",
    "return": "Return",
    "esc": "Escape",
    "escape": "Escape",
    "backspace": "BackSpace",
    "del": "Delete",
    "delete": "Delete",
    "tab": "Tab",
    "space": "space",
    "pgup": "Page_Up",
    "pageup": "Page_Up",
    "pgdn": "Page_Down",
    "pagedown": "Page_Down",
    "left": "Left",
    "right": "Right",
    "up": "Up",
    "down": "Down",
    "home": "Home",
    "end": "End",
}


class Display:
    def __init__(self):
        load_x11()
        self.dpy = libX11.XOpenDisplay(DISPLAY_NAME.encode())
        if not self.dpy:
            raise SystemExit(f"cannot open display {DISPLAY_NAME}")
        self.screen = libX11.XDefaultScreen(self.dpy)
        self.root = libX11.XRootWindow(self.dpy, self.screen)
        self.width = libX11.XDisplayWidth(self.dpy, self.screen) or SCREEN_W
        self.height = libX11.XDisplayHeight(self.dpy, self.screen) or SCREEN_H

    def close(self):
        libX11.XCloseDisplay(self.dpy)

    def sync(self):
        libX11.XSync(self.dpy, 0)

    def clamp(self, x, y):
        x = int(round(float(x)))
        y = int(round(float(y)))
        return max(0, min(self.width - 1, x)), max(0, min(self.height - 1, y))

    def pointer(self):
        root_r = Window()
        child = Window()
        rx = c_int()
        ry = c_int()
        wx = c_int()
        wy = c_int()
        mask = c_uint()
        libX11.XQueryPointer(self.dpy, self.root, byref(root_r), byref(child), byref(rx), byref(ry), byref(wx), byref(wy), byref(mask))
        return rx.value, ry.value

    def move(self, x, y):
        x, y = self.clamp(x, y)
        libX11.XWarpPointer(self.dpy, 0, self.root, 0, 0, 0, 0, x, y)
        libXtst.XTestFakeMotionEvent(self.dpy, self.screen, x, y, 0)
        self.sync()
        for _ in range(5):
            px, py = self.pointer()
            if abs(px - x) <= 2 and abs(py - y) <= 2:
                return x, y
            libX11.XWarpPointer(self.dpy, 0, self.root, 0, 0, 0, 0, x, y)
            self.sync()
            time.sleep(0.02)
        return self.pointer()

    def clear_modifiers(self):
        for name in MOD_KEYS:
            kc = self.keycode(name)
            if kc:
                libXtst.XTestFakeKeyEvent(self.dpy, kc, 0, 0)
        self.sync()

    def keycode(self, name):
        if not name:
            return 0
        ks = libX11.XStringToKeysym(name.encode())
        if not ks:
            return 0
        return libX11.XKeysymToKeycode(self.dpy, ks)

    def button(self, btn, press):
        libXtst.XTestFakeButtonEvent(self.dpy, int(btn), 1 if press else 0, 0)
        self.sync()

    def key_event(self, name, press):
        kc = self.keycode(name)
        if not kc:
            return False
        libXtst.XTestFakeKeyEvent(self.dpy, kc, 1 if press else 0, 0)
        self.sync()
        return True


def print_pointer(x, y):
    print(f"POINTER={x},{y}")


def click(d: Display, x, y, button=1, count=1):
    d.clear_modifiers()
    x, y = d.move(x, y)
    n = max(1, min(5, int(count)))
    btn = max(1, min(7, int(button)))
    for i in range(n):
        d.button(btn, True)
        time.sleep(0.012)
        d.button(btn, False)
        if i + 1 < n:
            time.sleep(0.04)
    px, py = d.pointer()
    print_pointer(px, py)


def keysym_for_token(tok: str) -> str:
    t = tok.strip()
    if not t:
        return ""
    low = t.lower()
    if low in KEY_ALIASES:
        return KEY_ALIASES[low]
    if len(t) == 1:
        if t.isupper() or t in '!@#$%^&*()_+{}|:"<>?~':
            return t
        return t
    if t.startswith("F") and t[1:].isdigit():
        return t
    return t[0].upper() + t[1:] if t.islower() else t


def send_combo(d: Display, spec: str):
    # A lone "+" is the character, not a combo splitter.
    parts = [spec] if spec == "+" or len(spec) == 1 else [p for p in spec.split("+") if p]
    if not parts:
        return
    names = [keysym_for_token(p) for p in parts]
    mods, keys = [], []
    for n in names:
        if n in ("Control_L", "Alt_L", "Shift_L", "Super_L"):
            mods.append(n)
        else:
            keys.append(n)
    if not keys:
        keys = mods
        mods = []
    d.clear_modifiers()
    for m in mods:
        d.key_event(m, True)
    for k in keys:
        # Shift for uppercase latin
        need_shift = len(k) == 1 and k.isupper()
        if need_shift:
            d.key_event("Shift_L", True)
        d.key_event(k if not (len(k) == 1 and k.isupper()) else k.lower(), True)
        d.key_event(k if not (len(k) == 1 and k.isupper()) else k.lower(), False)
        if need_shift:
            d.key_event("Shift_L", False)
        time.sleep(0.012)
    for m in reversed(mods):
        d.key_event(m, False)
    d.sync()


def ascii_type(d: Display, text: str):
    for ch in text:
        if ch == "\n":
            send_combo(d, "Return")
        elif ch == "\t":
            send_combo(d, "Tab")
        elif ch == " ":
            send_combo(d, "space")
        else:
            send_combo(d, ch)


def paste(text: str):
    r = subprocess.run(["xclip", "-selection", "clipboard"], input=text.encode("utf-8"), check=False)
    if r.returncode != 0:
        raise SystemExit("xclip failed")


def type_text(d: Display, text: str):
    if not text:
        return
    # XTEST keysyms skip colon/slash/dot/question (URLs become httpswww…).
    # Clipboard paste keeps punctuation, spaces, and Unicode intact.
    paste(text)
    time.sleep(0.05)
    send_combo(d, "ctrl+v")


def usage(err=False):
    text = (
        "usage: box-input click X Y [button] [count]\n"
        "       box-input move X Y\n"
        "       box-input location\n"
        "       box-input type TEXT\n"
        "       box-input key KEYS\n"
        "       box-input down BUTTON\n"
        "       box-input up BUTTON"
    )
    print(text, file=sys.stderr if err else sys.stdout)
    return 2 if err else 0


def main(argv):
    if len(argv) < 2 or argv[1] in ("-h", "--help"):
        return usage(err=False)
    cmd = argv[1]
    d = Display()
    try:
        if cmd == "click":
            if len(argv) < 4:
                return usage(True)
            click(d, argv[2], argv[3], int(argv[4]) if len(argv) > 4 else 1, int(argv[5]) if len(argv) > 5 else 1)
        elif cmd == "move":
            if len(argv) < 4:
                return usage(True)
            x, y = d.move(argv[2], argv[3])
            print_pointer(x, y)
        elif cmd == "location":
            x, y = d.pointer()
            print_pointer(x, y)
        elif cmd == "type":
            type_text(d, " ".join(argv[2:]))
        elif cmd == "type-b64":
            import base64

            type_text(d, base64.b64decode(argv[2] or "").decode("utf-8"))
        elif cmd == "key":
            send_combo(d, "+".join(argv[2:]) if len(argv) > 2 else "")
        elif cmd in ("down", "up"):
            if len(argv) < 3:
                return usage(True)
            d.button(int(argv[2]), cmd == "down")
        elif cmd == "display":
            print(f"DISPLAY={DISPLAY_NAME} {d.width}x{d.height}")
        else:
            return usage(True)
    finally:
        d.close()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
