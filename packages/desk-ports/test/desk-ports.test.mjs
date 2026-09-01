/**
 * The port assertions that used to be spread across test/vm-status.mjs,
 * test/harness-proxy.mjs, test/display.mjs and test/desk-client.mjs. Those files
 * keep everything that is actually about vm.mjs — docker ps parsing, the create
 * args, warmLocalDesks — and hand the arithmetic over here.
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import {
  DISPLAY_SLOTS,
  HARNESS_PORT,
  HARNESS_STDIO_BRIDGE,
  attachHarnessProxy,
  harnessHostPort,
  mappedHarnessPort,
  needsHarnessPublish,
  parseDisplayPorts,
  resolveStreamPort,
  streamPortForDisplay,
} from "../dist/index.js";

test("one desk reserves eight displays, and its harness sits just past them", () => {
  assert.equal(DISPLAY_SLOTS, 8);
  assert.equal(harnessHostPort(13109), 13109 + DISPLAY_SLOTS);
  assert.equal(harnessHostPort(0), null);
  assert.equal(harnessHostPort(-1), null);
  assert.equal(harnessHostPort("nope"), null);
  assert.equal(harnessHostPort(undefined), null);
});

test("the harness port has one definition, and it is @sub8/harness-protocol's", () => {
  // server/vm.mjs and server/desk-client.mjs each declared their own
  // DESK_HARNESS_CONTAINER_PORT = 3011. Both are gone.
  assert.equal(HARNESS_PORT, 3011);
});

test("parseDisplayPorts reads docker's mapping, including the harness slot", () => {
  assert.deepEqual(parseDisplayPorts("0.0.0.0:13102->3000/tcp, [::]:13102->3000/tcp, 0.0.0.0:13103->3001/tcp"), {
    3000: 13102,
    3001: 13103,
  });
  // Built from HARNESS_PORT on purpose: the regex still spells 3011 out, and
  // this is what stops the two drifting apart.
  assert.equal(parseDisplayPorts(`0.0.0.0:13109->3000/tcp, 0.0.0.0:13117->${HARNESS_PORT}/tcp`)[HARNESS_PORT], 13117);
  assert.deepEqual(parseDisplayPorts(""), {});
  assert.deepEqual(parseDisplayPorts(null), {});
  // 3008/3009/3010 are not ours — 3010 in particular is the older pi executor.
  assert.deepEqual(parseDisplayPorts("0.0.0.0:14000->3010/tcp"), {});
});

test("only a real docker mapping counts as a published harness", () => {
  assert.equal(mappedHarnessPort({ 3000: 13100 }), null);
  assert.equal(mappedHarnessPort({ 3000: 13100, [HARNESS_PORT]: 14101 }), 14101);
  assert.equal(mappedHarnessPort(null), null);
  assert.equal(mappedHarnessPort({ [HARNESS_PORT]: 0 }), null);
  assert.equal(needsHarnessPublish({ 3000: 13100 }), true);
  assert.equal(needsHarnessPublish({ 3000: 13100, 3001: 13101 }), true);
  assert.equal(needsHarnessPublish({ 3000: 13100, [HARNESS_PORT]: 14101 }), false);
});

test("a worker never borrows display :1's port", () => {
  assert.equal(streamPortForDisplay(1, { 3000: 13102, 3001: 13103 }, 13102), 13102);
  assert.equal(streamPortForDisplay(2, { 3000: 13102, 3001: 13103 }, 13102), 13103);
  assert.equal(streamPortForDisplay(2, { 3000: 13102 }, 13102), null, "do not steal :1's port for a worker");
  assert.equal(streamPortForDisplay(2, { 3000: 13102 }, 13103), 13103);
  assert.equal(streamPortForDisplay(0, { 3000: 13102 }, null), 13102, "slot 0 means :1");
  assert.equal(streamPortForDisplay(1, null, null), null);
});

test("docker's current mapping beats a port we wrote down", () => {
  // A stored port that still answers HTTP can belong to a *different* desk
  // after Docker remaps. Mapped always wins; stored is only a fallback.
  assert.equal(resolveStreamPort(13100, 13101), 13101);
  assert.equal(resolveStreamPort(13100, null), 13100);
  assert.equal(resolveStreamPort(null, 13102), 13102);
  assert.equal(resolveStreamPort(null, null), null);
});

test("the stdio bridge dials loopback inside the desk and knows no host paths", () => {
  assert.match(HARNESS_STDIO_BRIDGE, /127\.0\.0\.1/);
  assert.ok(HARNESS_STDIO_BRIDGE.includes(String(HARNESS_PORT)));
  assert.doesNotMatch(HARNESS_STDIO_BRIDGE, /\/Users/);
  assert.doesNotMatch(HARNESS_STDIO_BRIDGE, /\/home\//);
});

function listen(server) {
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
    server.on("error", reject);
  });
}

test("attachHarnessProxy pipes a client straight through to whatever it is handed", async () => {
  const backend = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, harness: true, grok: false }));
  });
  const proxy = net.createServer();
  try {
    const bport = await listen(backend);
    attachHarnessProxy(proxy, () => net.connect(bport, "127.0.0.1"));
    const pport = await listen(proxy);
    const res = await fetch(`http://127.0.0.1:${pport}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.harness, true);
  } finally {
    proxy.close();
    backend.close();
  }
});

test("a remote that never connects hangs up on the client instead of hanging", async () => {
  const proxy = attachHarnessProxy(net.createServer(), () => null);
  try {
    const port = await listen(proxy);
    await new Promise((resolve, reject) => {
      const client = net.connect(port, "127.0.0.1");
      client.on("close", resolve);
      client.on("error", reject);
      client.setTimeout(3000, () => reject(new Error("proxy left the client hanging")));
    });
  } finally {
    proxy.close();
  }
});

test("packedPort maps every standard desk port into its slot's 100-port window", async () => {
  const { packedPort, PACK_PORT_BASE, PACK_SLOT_STRIDE } = await import("../dist/index.js");
  assert.equal(PACK_PORT_BASE, 20000);
  assert.equal(PACK_SLOT_STRIDE, 100);
  assert.equal(packedPort(0, 80), 20000);
  assert.equal(packedPort(0, 3000), 20010);
  assert.equal(packedPort(0, 3001), 20011, "3001 is websockify display 2, never an agent port");
  assert.equal(packedPort(0, 3007), 20017);
  assert.equal(packedPort(0, 3010), 20020);
  assert.equal(packedPort(0, 3011), 20021);
  assert.equal(packedPort(0, 5900), 20030);
  assert.equal(packedPort(0, 5907), 20037);
  assert.equal(packedPort(3, 3011), 20321);
  // Two slots never share a port.
  const all = (s) => [80, 3000, 3001, 3002, 3003, 3004, 3005, 3006, 3007, 3010, 3011, 5900, 5901, 5902, 5903, 5904, 5905, 5906, 5907].map((p) => packedPort(s, p));
  assert.equal(new Set([...all(0), ...all(1)]).size, new Set(all(0)).size * 2);
  assert.throws(() => packedPort(0, 22), /not a desk port/);
  assert.throws(() => packedPort(-1, 80), /slot/);
  assert.throws(() => packedPort(40, 80), /slot/);
});
