#!/usr/bin/env python3
"""In-desk HTTP harness on :3011 (health + NDJSON /turn + /stop). No Mac filesystem."""
from __future__ import annotations

import hmac
import json
import os
import shutil
import signal
import subprocess
import sys
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("DESK_HARNESS_PORT") or os.environ.get("PORT") or "3011")
TOKEN_FILE = os.environ.get("DESK_TOKEN_FILE") or "/config/.desk-token"
GROK_HOME = os.environ.get("GROK_HOME") or "/config/.grok"
WORK = os.environ.get("DESK_WORK") or "/config"
# Marks every process this turn spawns as that bot's work. Children inherit it
# through fork, exec and setsid, so Stop on the host can find even the shell
# children grok re-parents to pid 1. Must match vm.mjs WORK_ENV.
WORK_ENV = "SUB8_WORK"


def grok_bin() -> str:
    found = shutil.which("grok")
    if found:
        return found
    if os.path.isfile("/usr/local/bin/grok"):
        return "/usr/local/bin/grok"
    return ""


_MACHO = {
    b"\xfe\xed\xfa\xce",
    b"\xfe\xed\xfa\xcf",
    b"\xce\xfa\xed\xfe",
    b"\xcf\xfa\xed\xfe",
    b"\xca\xfe\xba\xbe",
}


def grok_present() -> bool:
    path = grok_bin()
    if not path:
        return False
    try:
        with open(path, "rb") as f:
            mag = f.read(4)
        if mag in _MACHO:
            return False
    except OSError:
        return False
    return True


def desk_token() -> str:
    env = (os.environ.get("DESK_TOKEN") or "").strip()
    if env:
        return env
    try:
        with open(TOKEN_FILE, encoding="utf-8") as f:
            return f.read().strip()
    except OSError:
        return ""


# Turns running right now. A local desk is shared by a whole team, so a stop is
# scoped to one botId; the cloud harness (server/desk-harness/server.mjs) runs
# one turn per desk and needs no id.
_RUNNING: list[dict] = []
_RUNNING_LOCK = threading.Lock()


def _register(proc: subprocess.Popen, bot_id: str) -> None:
    with _RUNNING_LOCK:
        _RUNNING.append({"proc": proc, "botId": bot_id})


def _unregister(proc: subprocess.Popen) -> None:
    with _RUNNING_LOCK:
        _RUNNING[:] = [r for r in _RUNNING if r["proc"] is not proc]


# A turn has no natural end: `--max-turns 24` bounds agent turns, not wall time,
# so a grok child that hangs on I/O held its thread and its memory forever. The
# container is capped at --memory 3g and a shared desk runs one turn per
# teammate, so unbounded concurrent turns is how that cap gets hit. desk-agent.py
# puts a timeout on every single subprocess call; this was the odd one out.
TURN_TIMEOUT_S = int(os.environ.get("DESK_TURN_TIMEOUT_S") or "900")
MAX_CONCURRENT_TURNS = int(os.environ.get("DESK_MAX_TURNS") or "3")
_TURN_SLOTS = threading.BoundedSemaphore(MAX_CONCURRENT_TURNS)


def _token_ok(got: str, want: str) -> bool:
    try:
        return hmac.compare_digest(got, want)
    except TypeError:
        return False


def _kill_group(proc) -> None:
    """
    Kill the grok child's whole process GROUP, not just its pid.

    The child is spawned with start_new_session=True precisely so it leads its
    own group, and stop_running has always used killpg for the reason its own
    docstring gives: grok re-parents shell children to pid 1, and proc.kill()
    does not reach those. The disconnect path used a bare proc.kill(), so a
    client that dropped without also calling POST /stop left them running.
    """
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        return
    except OSError:
        pass
    try:
        proc.kill()
    except OSError:
        pass


def stop_running(bot_id: str = "") -> int:
    """SIGTERM the grok child (whole process group) of the matching turns."""
    with _RUNNING_LOCK:
        rows = [r for r in _RUNNING if not bot_id or not r["botId"] or r["botId"] == bot_id]
    stopped = 0
    for row in rows:
        proc = row["proc"]
        if proc.poll() is not None:
            continue
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
        except OSError:
            try:
                proc.terminate()
            except OSError:
                continue
        stopped += 1
    return stopped


def feed_line(line: str, acc: dict) -> dict | None:
    raw = (line or "").strip()
    if not raw:
        return None
    try:
        ev = json.loads(raw)
    except json.JSONDecodeError:
        return None
    typ = str(ev.get("type") or ev.get("event") or "")
    if typ == "error":
        msg = str(ev.get("message") or ev.get("error") or "grok error")
        acc["error"] = msg
        return {"type": "error", "message": msg}
    if typ == "result":
        acc["reply"] = str(ev.get("result") or acc.get("reply") or "")
        return None
    if typ == "tool_call":
        name = ev.get("name") or (ev.get("tool") or {}).get("name") or "tool"
        return {"type": "tool", "name": str(name), "args": ev.get("args") or ev.get("input") or {}}
    if typ in ("thought", "reasoning", "tool_result", "status", "available_commands", "usage", "end"):
        return None
    if typ == "text" and isinstance(ev.get("data"), str):
        piece = ev["data"]
        acc["reply"] = acc.get("reply", "") + piece
        return {"type": "delta", "text": piece}
    update = (ev.get("params") or {}).get("update") or {}
    content = update.get("content") or ev.get("content") or {}
    text = content.get("text") if isinstance(content, dict) else None
    if text:
        acc["reply"] = acc.get("reply", "") + str(text)
        return {"type": "delta", "text": str(text)}
    return None


def display_env(display: int) -> str:
    """
    ":N" for the X screen this bot owns.

    Teammates share one container but each has its own display, and DISPLAY is
    what tells them apart -- it is how octo-vault stamps who is asking, and so
    what the host uses to decide whose grants a vault fill runs under. The
    harness was handed `display` in the /turn body (server/agent.mts sends it)
    and simply dropped it, so every teammate's grok inherited the image default
    of :1 from vm/Dockerfile. On a shared desk that made every worker look like
    the chief.
    """
    n = int(display) if str(display).isdigit() else 1
    return f":{min(8, max(1, n))}"


def run_grok_turn(prompt: str, emit, bot_id: str = "", display: int = 1) -> str:
    bin_path = grok_bin()
    if not bin_path:
        emit({"type": "error", "message": "grok not installed on this computer"})
        return ""
    args = [
        bin_path,
        "-p",
        prompt,
        "--output-format",
        "streaming-json",
        "--permission-mode",
        "bypassPermissions",
        "--always-approve",
        "--no-alt-screen",
        "--max-turns",
        "24",
        "--cwd",
        WORK,
        "--session-id",
        str(uuid.uuid4()),
    ]
    env = os.environ.copy()
    env["HOME"] = os.environ.get("HOME") or "/config"
    env["GROK_HOME"] = GROK_HOME
    # The bot's own X screen — see display_env. Without this every teammate's
    # grok ran on :1, so octo-vault stamped the chief's display and the host
    # authorised the chief's grants for anyone on the desk.
    env["DISPLAY"] = display_env(display)
    if bot_id:
        env[WORK_ENV] = bot_id
    acc: dict = {"reply": ""}
    try:
        # Own session: /stop signals the whole process group, not just grok.
        proc = subprocess.Popen(
            args,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            env=env,
            start_new_session=True,
        )
    except OSError as err:
        emit({"type": "error", "message": f"grok spawn failed: {err}"})
        return ""
    _register(proc, bot_id)
    assert proc.stdout is not None
    # Wall-clock ceiling. The read loop below blocks on stdout, so nothing else
    # can notice a wedged child; a timer that kills the group is what unblocks
    # it, and the `for line in` loop then ends on EOF.
    deadline = threading.Timer(TURN_TIMEOUT_S, lambda: _kill_group(proc))
    deadline.daemon = True
    deadline.start()
    try:
        for line in proc.stdout:
            ev = feed_line(line, acc)
            if not ev:
                continue
            try:
                emit(ev)
            except (BrokenPipeError, ConnectionResetError, OSError):
                _kill_group(proc)
                break
    finally:
        deadline.cancel()
        if proc.poll() is None:
            _kill_group(proc)
        _unregister(proc)
    code = proc.wait()
    if code not in (0, None) and not acc["reply"]:
        try:
            emit({"type": "error", "message": f"grok exited {code}"})
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
    return str(acc.get("reply") or "")


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args) -> None:  # noqa: A003
        sys.stderr.write("desk-harness: " + (fmt % args) + "\n")

    def _json(self, code: int, obj: dict) -> None:
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _ndjson(self, obj: dict) -> None:
        self.wfile.write((json.dumps(obj) + "\n").encode("utf-8"))
        self.wfile.flush()

    def do_GET(self) -> None:  # noqa: N802
        if self.path.split("?", 1)[0] == "/health":
            self._json(200, {"ok": True, "harness": True, "grok": grok_present()})
            return
        self._json(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        route = self.path.split("?", 1)[0]
        if route not in ("/turn", "/stop"):
            self._json(404, {"error": "not found"})
            return
        token = desk_token()
        auth = self.headers.get("Authorization") or ""
        # compare_digest, matching desk-agent.py, which does the same job. `!=`
        # on str short-circuits on length and then memcmp, so it leaks a timing
        # signal; the delta on a short token is well under network jitter, so
        # this is a consistency fix rather than a live exploit. The try/except is
        # not optional: compare_digest raises TypeError on a str containing
        # non-ASCII, and headers arrive latin-1-decoded, so one high byte would
        # otherwise throw out of the auth check itself.
        if not token or not _token_ok(auth, f"Bearer {token}"):
            self._json(401, {"error": "bad token"})
            return
        n = int(self.headers.get("Content-Length") or "0")
        raw = self.rfile.read(n) if n else b"{}"
        try:
            body = json.loads(raw.decode("utf-8") or "{}")
        except json.JSONDecodeError:
            body = {}
        if route == "/stop":
            # Without this, pressing Stop only stops the host reading the
            # stream: grok keeps running in the desk, burning tokens and
            # holding the display, and the user sees "Stopped." over live work.
            self._json(200, {"ok": True, "stopped": stop_running(str(body.get("botId") or ""))})
            return
        prompt = str(body.get("content") or body.get("text") or "").strip()
        ident = str(body.get("system") or "").strip()
        if ident:
            prompt = f"{ident}\n\n{prompt}"
        # Refuse rather than pile up. Each turn is a grok process inside a
        # container capped at --memory 3g, and a shared desk runs one turn per
        # teammate, so unbounded concurrency is how that cap gets hit. 503 is
        # honest and retryable; queueing here would just hold the connection.
        if not _TURN_SLOTS.acquire(blocking=False):
            self._json(503, {"error": f"desk busy ({MAX_CONCURRENT_TURNS} turns already running)"})
            return
        try:
            self.send_response(200)
            self.send_header("Content-Type", "application/x-ndjson")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            reply = run_grok_turn(
                prompt, self._ndjson, str(body.get("botId") or ""), body.get("display") or 1
            )
        finally:
            _TURN_SLOTS.release()
        try:
            self._ndjson({"type": "done", "content": reply})
        except (BrokenPipeError, ConnectionResetError, OSError):
            # The one emit that was not guarded, while every emit inside
            # run_grok_turn is. A client that disconnects right at the end of a
            # turn is the normal case for an aborted request, and it raised out
            # of do_POST here rather than closing quietly.
            pass


def main() -> None:
    httpd = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"desk-harness on :{PORT} (grok={grok_present()})", flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
