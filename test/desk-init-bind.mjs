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
// 2026-09-05 fail-closed used to do this whenever VNC_PASSWORD was empty, which
// made local desks unreachable (Docker DNAT hits the container eth0, not
// 127.0.0.1). Now only a relayed desk (RFB_EXPOSE=1) without a password falls
// back to loopback; a local desk keeps its passwordless eth0 websockify.
assert.doesNotMatch(
  init,
  /else\n  RFB_LOCALHOST="-localhost"\n  WS_HOST="127\.0\.0\.1:"/,
  "missing VNC_PASSWORD alone must not force loopback websockify",
);
assert.match(extra, /NOVNC_LOOPBACK/, "extra displays honor the same loopback gate");

// 2026-10-06: the relayed ports are open to the internet, so every display
// takes the per-desk VNC password, from VNC_PASSWORD, the desk token, or the
// rfbauth file desk-init wrote, and never runs passwordless off loopback.
for (const [name, src] of [["desk-init", init], ["desk-display", extra]]) {
  assert.match(src, /-rfbauth \$VNC_PASSFILE/, `${name}: x11vnc uses the rfbauth file`);
  assert.match(src, /VNC_PASSFILE="\$\{VNC_PASSFILE:-\/tmp\/\.vncpass\}"/, `${name}: one shared rfbauth file outside /config`);
  assert.match(src, /"sub8-vnc:"\+t/, `${name}: derives the password from the desk token like the Worker`);
  assert.match(src, /\.decode\(\)\[:8\]/, `${name}: 8 characters, all VNC auth uses`);
  assert.match(src, /RFB_EXPOSE=1 but no VNC password/, `${name}: a relayed desk with no password stays on loopback`);
  assert.match(src, /unset VNC_PASSWORD/, `${name}: the password does not linger in the environment`);
}
assert.doesNotMatch(extra, /-forever -shared -nopw/, "desk-display no longer hardcodes a passwordless x11vnc");

console.log("ok desk-init-bind");
