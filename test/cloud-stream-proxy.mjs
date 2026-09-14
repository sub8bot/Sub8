import assert from "node:assert/strict";
import {
  parseCloudStreamPath,
  workerDeskAssetUrl,
  isCloudStreamWsPath,
} from "../server/cloud/stream-proxy.mjs";

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

console.log("ok cloud-stream-proxy");
