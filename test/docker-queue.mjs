import assert from "node:assert/strict";
import { isLongDocker, dockerQueueStats } from "../server/vm.mjs";

assert.equal(isLongDocker(["exec", "-u", "root", "box", "bash", "/tmp/setup-apps.sh"], { timeout: 180_000 }), true);
assert.equal(isLongDocker(["exec", "-u", "root", "box", "bash", "-lc", "apt-get update"], { timeout: 20_000 }), true);
assert.equal(isLongDocker(["ps", "--format", "{{.Names}}"], { timeout: 8_000 }), false);
assert.equal(isLongDocker(["exec", "box", "bash", "-lc", "command -v google-chrome"], { timeout: 12_000 }), false);
assert.equal(isLongDocker(["pull", "linuxserver/webtop:ubuntu-xfce"], { timeout: 120_000 }), true);

const q = dockerQueueStats();
assert.equal(typeof q.short.active, "number");
assert.equal(typeof q.long.waiting, "number");
assert.equal(q.kids, 0);
console.log("ok docker-queue");
