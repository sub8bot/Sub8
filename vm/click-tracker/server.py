#!/usr/bin/env python3
"""Tiny click-tracker HTTP server. Serves the lab and records hits."""
from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
HITS = Path("/tmp/click-hits.json")
AIM = Path("/tmp/click-aim.json")
PORT = 8766


def read_json(path: Path, default):
    try:
        return json.loads(path.read_text())
    except Exception:
        return default


def write_json(path: Path, data) -> None:
    path.write_text(json.dumps(data, indent=2))


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        return

    def _send(self, code: int, body: bytes, ctype: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        if self.path.startswith("/aim"):
            self._send(200, json.dumps(read_json(AIM, {"x": None, "y": None})).encode(), "application/json")
            return
        if self.path.startswith("/hits"):
            self._send(200, json.dumps(read_json(HITS, [])).encode(), "application/json")
            return
        if self.path in ("/", "/index.html"):
            html = (ROOT / "index.html").read_bytes()
            self._send(200, html, "text/html; charset=utf-8")
            return
        self._send(404, b"not found", "text/plain")

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b"{}"
        try:
            data = json.loads(raw.decode() or "{}")
        except Exception:
            data = {}
        if self.path.startswith("/aim"):
            write_json(AIM, {"x": data.get("x"), "y": data.get("y")})
            self._send(200, b'{"ok":true}', "application/json")
            return
        if self.path.startswith("/reset"):
            write_json(HITS, [])
            write_json(AIM, {"x": None, "y": None})
            self._send(200, b'{"ok":true}', "application/json")
            return
        if self.path.startswith("/hit"):
            rows = read_json(HITS, [])
            rows.append(data)
            write_json(HITS, rows)
            self._send(200, b'{"ok":true}', "application/json")
            return
        self._send(404, b"not found", "text/plain")


if __name__ == "__main__":
    write_json(HITS, [])
    write_json(AIM, {"x": None, "y": None})
    httpd = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"click-tracker http://127.0.0.1:{PORT}", flush=True)
    httpd.serve_forever()
