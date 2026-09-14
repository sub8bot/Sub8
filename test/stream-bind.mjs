import assert from "node:assert/strict";
import {
  novncAutoconnectUrl,
  stillCoversLive,
  desktopCloudStreamUrl,
} from "../web/stream-bind.mjs";

assert.equal(stillCoversLive({ streamReady: false }), true, "still is the placeholder until VNC is live");
assert.equal(stillCoversLive({ streamReady: true }), false, "a live iframe must not be covered by a cached screenshot");
assert.equal(stillCoversLive({}), true);

const abs = novncAutoconnectUrl("http://127.0.0.1:13100/vnc.html");
assert.match(abs, /autoconnect=true/);
assert.match(abs, /127\.0\.0\.1:13100/);

const rel = novncAutoconnectUrl("/api/cloud/stream/cmp_abc/vnc.html?path=api/cloud/stream/cmp_abc/websockify");
assert.match(rel, /^\/api\/cloud\/stream\/cmp_abc\/vnc\.html/);
assert.match(rel, /autoconnect=true/);
assert.match(rel, /path=api%2Fcloud%2Fstream%2Fcmp_abc%2Fwebsockify|path=api\/cloud\/stream\/cmp_abc\/websockify/);
assert.doesNotMatch(rel, /^https?:\/\//, "relative stream URLs stay same-origin");

const viewed = novncAutoconnectUrl("/api/cloud/stream/cmp_abc/vnc.html", { viewOnly: true });
assert.match(viewed, /view_only=true/);
const held = novncAutoconnectUrl("/api/cloud/stream/cmp_abc/vnc.html?view_only=true", { viewOnly: false });
assert.doesNotMatch(held, /view_only=true/);

const url = desktopCloudStreamUrl("cmp_abc");
assert.match(url, /^\/api\/cloud\/stream\/cmp_abc\/vnc\.html\?/);
assert.match(url, /path=api(?:%2F|\/)cloud(?:%2F|\/)stream(?:%2F|\/)cmp_abc(?:%2F|\/)websockify/);
assert.doesNotMatch(url, /:3000/);
const d2 = desktopCloudStreamUrl("cmp_abc", { display: 2 });
assert.match(d2, /display(?:=|%3D)2/);
assert.equal(desktopCloudStreamUrl(""), "");

console.log("ok stream-bind");
