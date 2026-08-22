import assert from "node:assert/strict";
import { computerBackendName, keepSets, newComputer } from "../server/computers.mjs";
import { resolveComputerBackend } from "../server/computer-backends/index.mjs";

assert.equal(newComputer().backend, "local-docker");
assert.equal(computerBackendName({ id: "legacy" }), "local-docker");
assert.equal(resolveComputerBackend({ id: "legacy" }).name, "local-docker");
assert.equal(resolveComputerBackend({ backend: "local-docker" }).name, "local-docker");
assert.throws(() => resolveComputerBackend({ backend: "not-installed" }), /Unknown computer backend: not-installed/);

assert.deepEqual(
  keepSets([
    { backend: "local-docker", container: "localbot-a", volume: "localbot-config-a" },
    { container: "localbot-legacy", volume: "localbot-config-legacy" },
    { backend: "not-installed", container: "remote-a", volume: "remote-volume-a" },
  ]),
  {
    keepNames: ["localbot-a", "localbot-legacy"],
    keepVolumes: ["localbot-config-a", "localbot-config-legacy"],
  },
);

console.log("ok computer-backends");
