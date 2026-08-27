import test from "node:test";
import assert from "node:assert/strict";
import { AVATAR_COLORS, requireVm, isHostPath, assertVmShell } from "../dist/index.js";

test("avatar palette is stable and unique", () => {
  assert.equal(AVATAR_COLORS.length, 12);
  assert.equal(new Set(AVATAR_COLORS).size, 12, "a duplicate colour makes two bots indistinguishable");
  for (const c of AVATAR_COLORS) assert.match(c, /^#[0-9a-f]{6}$/i);
});

test("requireVm accepts a remote desk and a localbot container", () => {
  assert.equal(requireVm({ vm: { deskUrl: "http://127.0.0.1:80", deskToken: "t" } }), "sub8-desk");
  assert.equal(
    requireVm({ vm: { deskUrl: "http://127.0.0.1:80", deskToken: "t", container: "sub8-desk-2" } }),
    "sub8-desk-2",
  );
  assert.equal(requireVm({ vm: { container: "localbot-abc123" } }), "localbot-abc123");
});

test("requireVm refuses anything that is not a bot computer", () => {
  // The whole point of the guard: no container means the work would land on the host.
  for (const bot of [null, undefined, {}, { vm: {} }, { vm: { container: "" } }, { vm: { container: "postgres" } }]) {
    assert.throws(() => requireVm(bot, "screenshot"), /screenshot blocked: no bot computer/);
  }
  // A desk URL without a token is not enough to trust it.
  assert.throws(() => requireVm({ vm: { deskUrl: "http://x" } }), /blocked/);
});

test("isHostPath catches the host Mac, not desk paths", () => {
  for (const p of ["/Users/someone/secrets", "/Users", "/home/someone/x", "/Library/Keychains", "/Applications/Safari.app"]) {
    assert.equal(isHostPath(p), true, p);
  }
  for (const p of ["/config/workspace/hello.py", "/tmp/x", "", null, undefined]) {
    assert.equal(isHostPath(p), false, String(p));
  }
});

test("assertVmShell blocks host paths, synthetic input, the debug port and secret dumps", () => {
  const blocked = [
    ["cat /Users/someone/.ssh/id_rsa", /host paths/],
    ["cd /Users && ls", /host paths/],
    ["xdotool key Return", /do not click or type/],
    ["box-input type hi", /do not click or type/],
    ["python -c 'import websocket' 127.0.0.1:9222/json", /debug port/],
    ["curl http://127.0.0.1:9222/json/new", /debug port/],
    ["sqlite3 ~/chrome-desk/Default/Cookies .dump", /cookies or secrets/],
  ];
  for (const [cmd, re] of blocked) assert.throws(() => assertVmShell(cmd), re, cmd);
});

test("assertVmShell allows ordinary desk work", () => {
  for (const cmd of ["python3 /config/workspace/hello.py", "ls -la /config", "echo hi", "", null]) {
    assert.doesNotThrow(() => assertVmShell(cmd), String(cmd));
  }
});
