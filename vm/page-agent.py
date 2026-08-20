#!/usr/bin/env python3
"""Page-level Chrome driver via CDP. Snapshot / click-by-ref / fill. Not pixel clicks."""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

# Reuse the one-tab CDP client.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    import importlib.machinery
    import importlib.util

    def _load(name, path):
        spec = importlib.util.spec_from_loader(name, importlib.machinery.SourceFileLoader(name, path))
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod

    one = None
    for candidate in ("/usr/local/bin/chrome-one-tab", os.path.join(os.path.dirname(__file__), "chrome-one-tab.py")):
        if os.path.isfile(candidate):
            one = _load("chrome_one_tab", candidate)
            break
    if one is None:
        raise ImportError("chrome-one-tab missing")
except Exception as err:
    print("page-agent: cannot load chrome-one-tab:", err, file=sys.stderr)
    sys.exit(1)

DEBUG = os.environ.get("CHROME_DEBUG") or "http://127.0.0.1:9222"
one.DEBUG = DEBUG

SKIP_ROLES = {
    "none",
    "generic",
    "inlineTextBox",
    "paragraph",
    "LineBreak",
    "image",
    "ignored",
    "scrollable",
    "html",
    "document",
}


def first_page():
    pages = one.pages()
    if not pages:
        raise RuntimeError("no Chrome tab — open a URL first")
    return pages[0]


def connect():
    page = first_page()
    ws = one.ws_url_for(page)
    if not ws:
        raise RuntimeError("no debugger websocket")
    return page, ws


def ax_nodes(ws):
    try:
        one.cdp_call(ws, "Accessibility.enable")
    except Exception:
        pass
    tree = one.cdp_call(ws, "Accessibility.getFullAXTree") or {}
    raw = tree.get("nodes") or []
    out = []
    for n in raw:
        if n.get("ignored"):
            continue
        role = ""
        r = n.get("role")
        if isinstance(r, dict):
            role = str(r.get("value") or "")
        elif r:
            role = str(r)
        if role in SKIP_ROLES:
            continue
        name = ""
        nm = n.get("name")
        if isinstance(nm, dict):
            name = str(nm.get("value") or "")
        elif nm:
            name = str(nm)
        bid = n.get("backendDOMNodeId")
        if not bid and role not in ("heading", "StaticText"):
            continue
        if not name.strip() and role not in ("textbox", "searchbox", "combobox", "checkbox", "radio", "slider"):
            continue
        out.append({"role": role or "node", "name": name.strip()[:80], "backend": bid, "value": _ax_value(n)})
        if len(out) >= 80:
            break
    return out


def _ax_value(n):
    v = n.get("value")
    if isinstance(v, dict):
        return str(v.get("value") or "")[:80]
    return str(v or "")[:80]


def snapshot_text(page, nodes):
    url = page.get("url") or ""
    title = page.get("title") or ""
    lines = [f"PAGE url={url} title={title} nodes={len(nodes)}"]
    for i, n in enumerate(nodes, 1):
        extra = f' value="{n["value"]}"' if n.get("value") else ""
        lines.append(f'[{i}] {n["role"]} "{n["name"]}"{extra}')
    if not nodes:
        lines.append("(no useful nodes — use computer screenshot/click)")
    return "\n".join(lines)


def box_center(ws, backend_id):
    one.cdp_call(ws, "DOM.enable")
    try:
        box = one.cdp_call(ws, "DOM.getBoxModel", {"backendNodeId": int(backend_id)})
        content = ((box or {}).get("model") or {}).get("content") or []
        if len(content) >= 8:
            xs = content[0::2]
            ys = content[1::2]
            return sum(xs) / 4.0, sum(ys) / 4.0
    except Exception:
        pass
    quads = one.cdp_call(ws, "DOM.getContentQuads", {"backendNodeId": int(backend_id)}) or {}
    q = (quads.get("quads") or [[]])[0]
    if len(q) >= 8:
        xs = q[0::2]
        ys = q[1::2]
        return sum(xs) / 4.0, sum(ys) / 4.0
    raise RuntimeError("no box for that node")


def click_xy(ws, x, y):
    for typ in ("mousePressed", "mouseReleased"):
        one.cdp_call(
            ws,
            "Input.dispatchMouseEvent",
            {"type": typ, "x": x, "y": y, "button": "left", "clickCount": 1},
        )


def node_at(ws, ref):
    nodes = ax_nodes(ws)
    i = int(ref)
    if i < 1 or i > len(nodes):
        raise RuntimeError(f"ref {ref} out of range 1..{len(nodes)}")
    n = nodes[i - 1]
    if not n.get("backend"):
        raise RuntimeError(f"[{i}] has no DOM node")
    return n, nodes


def main(argv):
    action = (argv[1] if len(argv) > 1 else "snapshot").strip().lower()
    try:
        one.get("/json/version")
    except Exception as err:
        print("chrome debug is down:", err, file=sys.stderr)
        return 1
    try:
        page, ws = connect()
        if action in ("snapshot", "ax", "tree"):
            print(snapshot_text(page, ax_nodes(ws)))
            return 0
        if action == "navigate":
            url = argv[2].strip() if len(argv) > 2 else ""
            if not url:
                print("usage: page-agent navigate URL", file=sys.stderr)
                return 1
            if not one.navigate(page, url):
                created = one.new_tab(url)
                keep = created.get("id") if isinstance(created, dict) else ""
                one.close_extras(keep)
            page, ws = connect()
            print(snapshot_text(page, ax_nodes(ws)))
            return 0
        if action == "click":
            if len(argv) < 3:
                print("usage: page-agent click REF", file=sys.stderr)
                return 1
            n, _ = node_at(ws, argv[2])
            x, y = box_center(ws, n["backend"])
            click_xy(ws, x, y)
            print(f'clicked [{argv[2]}] {n["role"]} "{n["name"]}" at {int(x)},{int(y)}')
            return 0
        if action == "fill":
            if len(argv) < 4:
                print("usage: page-agent fill REF TEXT", file=sys.stderr)
                return 1
            n, _ = node_at(ws, argv[2])
            text = " ".join(argv[3:])
            one.cdp_call(ws, "DOM.enable")
            one.cdp_call(ws, "DOM.focus", {"backendNodeId": int(n["backend"])})
            one.cdp_call(ws, "Input.dispatchKeyEvent", {"type": "keyDown", "key": "a", "code": "KeyA", "modifiers": 2})
            one.cdp_call(ws, "Input.dispatchKeyEvent", {"type": "keyUp", "key": "a", "code": "KeyA", "modifiers": 2})
            one.cdp_call(ws, "Input.insertText", {"text": text})
            print(f'filled [{argv[2]}] {n["role"]} "{n["name"]}"')
            return 0
        if action == "press":
            key = argv[2] if len(argv) > 2 else "Enter"
            names = {"return": "Enter", "enter": "Enter", "esc": "Escape", "escape": "Escape", "tab": "Tab"}
            key = names.get(key.lower(), key)
            one.cdp_call(ws, "Input.dispatchKeyEvent", {"type": "keyDown", "key": key})
            one.cdp_call(ws, "Input.dispatchKeyEvent", {"type": "keyUp", "key": key})
            print(f"pressed {key}")
            return 0
        print("usage: page-agent snapshot|click REF|fill REF TEXT|navigate URL|press KEY", file=sys.stderr)
        return 1
    except Exception as err:
        print(f"page-agent {action} failed: {err}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
