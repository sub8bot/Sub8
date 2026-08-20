import assert from "node:assert/strict";
import { deskCreateArgs, deskMemory, deskShm, SLIM_IMAGE, FALLBACK_IMAGE, parseDockerProgress, isLongDocker } from "../server/vm.mjs";

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
assert.equal(args.at(-1), SLIM_IMAGE);
assert.ok(args.some((a) => /13109-13116:3000-3007/.test(String(a))));
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

console.log("ok desk");
