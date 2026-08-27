import assert from "node:assert/strict";
import http from "node:http";
import { BRAIN_STARTING, harnessUrlFor, harnessHealthy, harnessCanTurn, deskTurnFailed, runDeskTurn, resolveHarness, shouldAnnounceDeskBrain } from "../server/desk-client.mjs";
import { deskCreateArgs } from "../server/vm.mjs";
import { DISPLAY_SLOTS, HARNESS_PORT, harnessHostPort } from "@sub8/desk-ports";

assert.equal(BRAIN_STARTING, "desk brain starting");
assert.equal(shouldAnnounceDeskBrain({ via: "desk", grok: true }), true);
assert.equal(shouldAnnounceDeskBrain({ via: "desk", grok: false }), false);
assert.equal(shouldAnnounceDeskBrain({ via: "host", grok: true }), false);
assert.equal(shouldAnnounceDeskBrain({}), false);
assert.equal(HARNESS_PORT, 3011);
assert.equal(harnessHostPort(13109), 13109 + DISPLAY_SLOTS);
assert.equal(harnessUrlFor({ vm: { harnessPort: 14011 } }), "http://127.0.0.1:14011");
assert.equal(harnessUrlFor({ vm: {} }), null);

const args = deskCreateArgs({ name: "localbot-x", volume: "vol-x", port: 13109, image: "img" });
assert.ok(args.includes("DESK_HARNESS=1"));
assert.ok(args.some((a) => a === "127.0.0.1:13117:3011"));
const remap = deskCreateArgs({ name: "localbot-x", volume: "vol-x", port: 13100, harnessPort: 14101, image: "img" });
assert.ok(remap.some((a) => a === "127.0.0.1:14101:3011"));

function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

{
  const { server, port } = await serve((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, harness: true, grok: false }));
  });
  try {
    assert.equal(await harnessHealthy(`http://127.0.0.1:${port}`), true);
    assert.equal(await harnessCanTurn(`http://127.0.0.1:${port}`), false);
  } finally {
    server.close();
  }
}

{
  const { server, port } = await serve((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, harness: true }));
      return;
    }
    assert.equal(req.headers.authorization, "Bearer tok");
    res.writeHead(200, { "Content-Type": "application/x-ndjson" });
    res.write(`${JSON.stringify({ type: "tool", name: "computer", args: { action: "screenshot" } })}\n`);
    res.write(`${JSON.stringify({ type: "delta", text: "hi" })}\n`);
    res.end(`${JSON.stringify({ type: "done", content: "opened example.com" })}\n`);
  });
  try {
    const events = [];
    const out = await runDeskTurn({
      url: `http://127.0.0.1:${port}`,
      token: "tok",
      body: { content: "open example.com" },
      onEvent: (e) => events.push(e),
    });
    assert.equal(out.content, "opened example.com");
    assert.equal(events[0].type, "tool");
    assert.equal(events.at(-1).type, "done");
    const ep = await resolveHarness({ bot: { vm: { harnessPort: port } }, token: "tok" });
    assert.equal(ep.via, "desk");
    assert.equal(ep.port, port);
    const viaMapped = await resolveHarness({ bot: { vm: {} }, token: "tok", mappedPort: port });
    assert.equal(viaMapped.via, "desk");
    assert.equal(viaMapped.port, port);
  } finally {
    server.close();
  }
}

assert.equal(await harnessHealthy("http://127.0.0.1:9"), false);
assert.equal(deskTurnFailed([{ type: "error", message: "grok not installed" }], ""), true);
assert.equal(deskTurnFailed([{ type: "error", message: "x" }], "hello"), false);
assert.equal(deskTurnFailed([{ type: "done", content: "" }], ""), false);
console.log("ok desk-client");
