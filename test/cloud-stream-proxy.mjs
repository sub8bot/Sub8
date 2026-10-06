import assert from "node:assert/strict";
import {
  parseCloudStreamPath,
  workerDeskAssetUrl,
  isCloudStreamWsPath,
  isCacheableAsset,
  attachCloudStreamProxy,
} from "../server/cloud/stream-proxy.mjs";
import http from "node:http";
import { createRequire } from "node:module";

assert.deepEqual(parseCloudStreamPath("/api/cloud/stream/cmp_abc/vnc.html"), {
  computerId: "cmp_abc",
  rest: "vnc.html",
});
assert.deepEqual(parseCloudStreamPath("/api/cloud/stream/cmp_abc/app/core/rfb.js"), {
  computerId: "cmp_abc",
  rest: "app/core/rfb.js",
});
assert.deepEqual(parseCloudStreamPath("/api/cloud/stream/cmp_abc/websockify"), {
  computerId: "cmp_abc",
  rest: "websockify",
});
assert.equal(parseCloudStreamPath("/api/bots/x"), null);

assert.equal(
  workerDeskAssetUrl("https://sub8.bot", "cmp_abc", "vnc.html"),
  "https://sub8.bot/api/desk/cmp_abc/vnc.html",
);
assert.equal(
  workerDeskAssetUrl("https://sub8.bot/", "cmp_abc", "/app/app.js"),
  "https://sub8.bot/api/desk/cmp_abc/app/app.js",
);
assert.equal(
  workerDeskAssetUrl("https://sub8.bot", "cmp_abc", "websockify", { display: 2 }),
  "https://sub8.bot/api/desk/cmp_abc/websockify?display=2",
);

assert.equal(isCloudStreamWsPath("/api/cloud/stream/cmp_abc/websockify"), true);
assert.equal(isCloudStreamWsPath("/api/cloud/stream/cmp_abc/vnc.html"), false);

// vnc.html carries the desk's VNC password (Worker-injected), so it is never cached.
assert.equal(isCacheableAsset("vnc.html"), false);
assert.equal(isCacheableAsset("vnc.html?display=2"), false);
assert.equal(isCacheableAsset("app/ui.js"), true);
assert.equal(isCacheableAsset("core/rfb.js"), true);

// The WS relay: bytes the client sends before the Worker socket opens arrive
// upstream, in order and still binary, and the banner flows back.
{
  delete process.env.SUB8_MOCK_AUTH;
  const { WebSocket, WebSocketServer } = createRequire(import.meta.url)("ws");
  const got = [];
  let auth = "";
  const upstream = http.createServer();
  const uwss = new WebSocketServer({ noServer: true });
  upstream.on("upgrade", (req, sock, head) => {
    auth = req.headers.authorization || "";
    // A slow Worker: the client is long open by the time this one is.
    setTimeout(() => uwss.handleUpgrade(req, sock, head, (ws) => {
      ws.on("message", (d, isBinary) => got.push([Buffer.from(d).toString(), isBinary]));
      ws.send(Buffer.from("RFB 003.008\n"));
    }), 300);
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const local = http.createServer();
  attachCloudStreamProxy({ get() {} }, local, {
    getToken: async () => "tok",
    cloudBase: () => `http://127.0.0.1:${upstream.address().port}`,
  });
  await new Promise((r) => local.listen(0, "127.0.0.1", r));
  const ws = new WebSocket(`ws://127.0.0.1:${local.address().port}/api/cloud/stream/cmp_abc/websockify`);
  const banner = await new Promise((resolve, reject) => {
    ws.on("open", () => { ws.send(Buffer.from("early-1")); ws.send(Buffer.from("early-2")); });
    ws.on("message", (d) => resolve(Buffer.from(d).toString()));
    ws.on("error", reject);
    setTimeout(() => reject(new Error("no banner")), 4000);
  });
  ws.send(Buffer.from("late"));
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(banner, "RFB 003.008\n");
  assert.equal(auth, "Bearer tok");
  assert.deepEqual(got, [["early-1", true], ["early-2", true], ["late", true]]);
  ws.close();
  local.close();
  upstream.close();
  uwss.close();
}

console.log("ok cloud-stream-proxy");
