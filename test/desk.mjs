import assert from "node:assert/strict";
import { deskCreateArgs, deskMemory, deskShm, SLIM_IMAGE, FALLBACK_IMAGE, parseDockerProgress, isLongDocker, ENSURE_NODE_CMD, shouldRebuildSlim, SLIM_SOURCE_FILES } from "../server/vm.mjs";

assert.equal(SLIM_IMAGE, "sub8-desk:trixie");
assert.match(FALLBACK_IMAGE, /webtop/);
assert.equal(deskMemory(), process.env.LOCALBOT_MEMORY || "2g");
assert.equal(deskShm(), process.env.LOCALBOT_SHM || "256m");

const args = deskCreateArgs({ name: "localbot-deadbeef", volume: "localbot-config-deadbeef", port: 13109, image: SLIM_IMAGE });
assert.ok(args.includes("--memory"));
assert.equal(args[args.indexOf("--memory") + 1], deskMemory());
assert.ok(args.includes("--shm-size"));
assert.equal(args[args.indexOf("--shm-size") + 1], deskShm());
assert.ok(args.includes("--memory-swap"));
assert.ok(args.includes("--cpus"));
assert.ok(args.includes("--pids-limit"));
assert.equal(args[args.indexOf("-v") + 1], "localbot-config-deadbeef:/config");
assert.equal(args.at(-1), SLIM_IMAGE);
assert.ok(args.some((a) => /13109-13116:3000-3007/.test(String(a))));
assert.ok(args.some((a) => /13117:3011/.test(String(a))));
assert.ok(args.includes("DESK_HARNESS=1"));
const remap = deskCreateArgs({
  name: "localbot-deadbeef",
  volume: "localbot-config-deadbeef",
  port: 13100,
  harnessPort: 14101,
  image: SLIM_IMAGE,
});
assert.ok(remap.some((a) => /13100-13107:3000-3007/.test(String(a))));
assert.ok(
  remap.some((a) => a === "127.0.0.1:14101:3011"),
  "adjacent desks keep their noVNC range; 3011 uses a free port",
);
// Every published port must name 127.0.0.1. Without the bind address Docker
// Desktop listens on 0.0.0.0, and the in-container websockify has no auth in
// front of it -- that put full click-and-type control of the desk on the LAN.
for (const [i, a] of remap.entries()) {
  if (a !== "-p") continue;
  assert.ok(
    String(remap[i + 1]).startsWith("127.0.0.1:"),
    `published port must be loopback-bound, got ${remap[i + 1]}`,
  );
}
assert.ok(!remap.some((a) => /13108:3011/.test(String(a))));
assert.ok(args.includes("host.docker.internal:host-gateway"));
assert.equal(deskMemory(1), process.env.LOCALBOT_MEMORY || "2g");
if (!process.env.LOCALBOT_MEMORY) {
  assert.equal(deskMemory(3), "4g");
  assert.equal(deskMemory(8), "6g");
}
assert.ok(!args.some((a) => a === "--shm-size=1g" || a === "1g"));

assert.equal(parseDockerProgress("Downloading [====>] 40%"), 40);
assert.equal(parseDockerProgress("Step 3/12\n#5 12.2 91%"), 91);
assert.equal(parseDockerProgress("no numbers"), null);

assert.equal(isLongDocker(["build", "-t", SLIM_IMAGE, "."], { timeout: 600_000 }), true);
assert.equal(isLongDocker(["pull", FALLBACK_IMAGE], { timeout: 120_000 }), true);

assert.match(ENSURE_NODE_CMD, /command -v node/);
assert.match(ENSURE_NODE_CMD, /apt-get install[^\n]*nodejs/);
assert.match(ENSURE_NODE_CMD, /no-install-recommends/);

assert.ok(SLIM_SOURCE_FILES.includes("Dockerfile"));
assert.ok(SLIM_SOURCE_FILES.includes("desk-harness.py"));
assert.ok(SLIM_SOURCE_FILES.includes("desk-init.sh"));
const t0 = 1_700_000_000_000;
assert.equal(shouldRebuildSlim(0, [t0]), true, "missing image must build");
assert.equal(shouldRebuildSlim(t0, [t0 - 60_000]), false);
assert.equal(shouldRebuildSlim(t0, [t0 + 1]), true, "newer Dockerfile rebuilds the tag");
assert.equal(shouldRebuildSlim(t0, [t0]), false, "same-timestamp sources do not loop rebuilds");

console.log("ok desk");
