import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const init = fs.readFileSync(path.join(root, "vm/desk-init.sh"), "utf8");
const extra = fs.readFileSync(path.join(root, "vm/desk-display.sh"), "utf8");

assert.match(init, /WS_HOST="0\.0\.0\.0:"/, "default websockify listens on all interfaces so docker-proxy DNAT to eth0 works");
assert.match(init, /NOVNC_LOOPBACK/, "loopback websockify is opt-in (dedicated public -p 3000:3000), not the passwordless default");
assert.match(
  init,
  /NOVNC_LOOPBACK.*WS_HOST="127\.0\.0\.1:"/s,
  "NOVNC_LOOPBACK=1 is what binds websockify to loopback",
);
// 2026-09-05 fail-closed used to do this whenever VNC_PASSWORD was empty. That
// overrode RFB_EXPOSE=1 (Worker RFB relay) and made local/packed docker-proxy
// publishes unreachable — Docker DNAT hits the container eth0, not 127.0.0.1.
assert.doesNotMatch(
  init,
  /else\n  RFB_LOCALHOST="-localhost"\n  WS_HOST="127\.0\.0\.1:"/,
  "missing VNC_PASSWORD must not override RFB_EXPOSE or force loopback websockify",
);
assert.match(extra, /NOVNC_LOOPBACK/, "extra displays honor the same loopback gate");

console.log("ok desk-init-bind");
