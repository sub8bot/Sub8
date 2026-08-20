#!/usr/bin/env python3
"""Keep exactly one Chrome tab. New URLs replace that tab; extras are closed."""
from __future__ import annotations

import base64
import json
import os
import socket
import struct
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

DEBUG = "http://127.0.0.1:9222"


def load(path, method="GET", timeout=4):
    req = urllib.request.Request(DEBUG + path, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read().decode("utf-8", "replace")
        if not raw:
            return {}
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return {"raw": raw}


def get(path, timeout=4):
    return load(path, "GET", timeout)


def close_id(tid):
    for method in ("GET", "PUT"):
        try:
            req = urllib.request.Request(DEBUG + "/json/close/" + tid, method=method)
            urllib.request.urlopen(req, timeout=3).read()
            return
        except Exception:
            continue


def pages():
    try:
        items = get("/json/list")
    except Exception:
        return []
    if not isinstance(items, list):
        return []
    return [p for p in pages_filter(items)]


def pages_filter(items):
    for p in items:
        if p.get("type") == "page" and p.get("id"):
            yield p


def close_extras(keep):
    for _ in range(10):
        extras = [p for p in pages() if p["id"] != keep]
        if not extras:
            return
        for p in extras:
            close_id(p["id"])
        time.sleep(0.05)


def _ws_frame(opcode, payload):
    payload = bytes(payload)
    mask = os.urandom(4)
    header = bytearray([0x80 | opcode])
    n = len(payload)
    if n < 126:
        header.append(0x80 | n)
    elif n < 65536:
        header.append(0x80 | 126)
        header.extend(struct.pack(">H", n))
    else:
        header.append(0x80 | 127)
        header.extend(struct.pack(">Q", n))
    masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
    return bytes(header) + mask + masked


def _parse_frame(buf):
    if len(buf) < 2:
        return None, buf
    b0, b1 = buf[0], buf[1]
    opcode = b0 & 0x0F
    masked = b1 & 0x80
    length = b1 & 0x7F
    idx = 2
    if length == 126:
        if len(buf) < 4:
            return None, buf
        length = struct.unpack(">H", buf[2:4])[0]
        idx = 4
    elif length == 127:
        if len(buf) < 10:
            return None, buf
        length = struct.unpack(">Q", buf[2:10])[0]
        idx = 10
    if masked:
        if len(buf) < idx + 4:
            return None, buf
        mask = buf[idx : idx + 4]
        idx += 4
    else:
        mask = None
    if len(buf) < idx + length:
        return None, buf
    payload = bytes(buf[idx : idx + length])
    if mask:
        payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
    return (opcode, payload), buf[idx + length :]


def cdp_call(ws_url, method, params=None, timeout=6):
    u = urllib.parse.urlparse(ws_url)
    host = u.hostname or "127.0.0.1"
    port = u.port or 9222
    path = u.path or "/"
    if u.query:
        path += "?" + u.query
    key = base64.b64encode(os.urandom(16)).decode("ascii")
    req = (
        f"GET {path} HTTP/1.1\r\n"
        f"Host: {host}:{port}\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {key}\r\n"
        "Sec-WebSocket-Version: 13\r\n"
        "\r\n"
    ).encode("ascii")
    sock = socket.create_connection((host, port), timeout=timeout)
    try:
        sock.sendall(req)
        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = sock.recv(4096)
            if not chunk:
                raise RuntimeError("chrome closed during websocket upgrade")
            buf += chunk
        head, rest = buf.split(b"\r\n\r\n", 1)
        if b"101" not in head.split(b"\r\n", 1)[0]:
            raise RuntimeError("websocket upgrade failed")
        msg_id = 1
        payload = json.dumps({"id": msg_id, "method": method, "params": params or {}}).encode()
        sock.sendall(_ws_frame(0x1, payload))
        pending = bytearray(rest)
        deadline = time.time() + timeout
        while time.time() < deadline:
            sock.settimeout(max(0.05, deadline - time.time()))
            try:
                chunk = sock.recv(4096)
            except socket.timeout:
                continue
            if not chunk:
                break
            pending.extend(chunk)
            while True:
                parsed, pending = _parse_frame(pending)
                if parsed is None:
                    pending = bytearray(pending)
                    break
                opcode, data = parsed
                pending = bytearray(pending)
                if opcode == 0x8:
                    return {}
                if opcode == 0x9:
                    sock.sendall(_ws_frame(0xA, data))
                    continue
                if opcode not in (0x1, 0x0):
                    continue
                try:
                    obj = json.loads(data.decode("utf-8", "replace"))
                except json.JSONDecodeError:
                    continue
                if obj.get("id") == msg_id:
                    if obj.get("error"):
                        raise RuntimeError(str(obj["error"]))
                    return obj.get("result") or {}
        raise TimeoutError("cdp " + method + " timed out")
    finally:
        try:
            sock.close()
        except Exception:
            pass


def ws_url_for(page):
    url = page.get("webSocketDebuggerUrl") or ""
    if url:
        return url
    tid = page.get("id") or ""
    if tid:
        return f"ws://127.0.0.1:9222/devtools/page/{tid}"
    return ""


def navigate(page, url):
    ws = ws_url_for(page)
    if not ws:
        return False
    try:
        cdp_call(ws, "Page.navigate", {"url": url})
        return True
    except Exception:
        return False


def new_tab(url):
    quoted = urllib.parse.quote(url, safe=":/?&=%#")
    created = {}
    for method, q in (("PUT", quoted), ("PUT", urllib.parse.quote(url, safe="")), ("GET", quoted)):
        try:
            created = load("/json/new?" + q, method)
            if isinstance(created, dict) and created.get("id"):
                return created
        except urllib.error.HTTPError:
            created = {}
    return created if isinstance(created, dict) else {}


def main(argv):
    url = argv[1].strip() if len(argv) > 1 else "https://www.google.com/"
    if not url:
        url = "https://www.google.com/"
    try:
        get("/json/version")
    except Exception as err:
        print("chrome debug port 9222 is down:", err, file=sys.stderr)
        return 1
    current = pages()
    keep = current[0]["id"] if current else ""
    if keep:
        close_extras(keep)
        current = pages()
        target = next((p for p in current if p["id"] == keep), current[0] if current else None)
        if target and navigate(target, url):
            close_extras(target["id"])
            left = pages()
            print(f"TAB keep={target['id']} n={len(left)} url={url}")
            return 0 if left else 1
    created = new_tab(url)
    keep = created.get("id") if isinstance(created, dict) else ""
    if not keep and pages():
        keep = pages()[0]["id"]
    close_extras(keep)
    left = pages()
    print(f"TAB keep={keep or (left[0]['id'] if left else '')} n={len(left)} url={url}")
    return 0 if left else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
