import assert from "node:assert/strict";
import {
  DISPLAY_SLOTS,
  applyTeamDisplays,
  debugPortFor,
  deskCreateArgs,
  deskMemory,
  displayNum,
} from "../server/vm.mjs";

assert.equal(DISPLAY_SLOTS, 8);
assert.equal(displayNum({ vm: {} }), 1);
assert.equal(displayNum({ vm: { display: ":3" } }), 3);
assert.equal(debugPortFor(1), 9222);
assert.equal(debugPortFor(2), 9223);
assert.equal(debugPortFor(3), 9224);

if (!process.env.LOCALBOT_MEMORY) {
  assert.equal(deskMemory(), "2g");
  assert.equal(deskMemory(1), "2g");
  assert.equal(deskMemory(2), "3g");
  assert.equal(deskMemory(5), "6g");
  assert.equal(deskMemory(9), "6g");
}

const chief = { id: "c", vm: { container: "localbot-c" } };
const w1 = { id: "w1", vm: { container: "localbot-c" } };
const w2 = { id: "w2", vm: { container: "localbot-c" } };
applyTeamDisplays({ chiefId: "c", memberIds: ["c", "w1", "w2"] }, [w2, chief, w1], 13100);
assert.equal(chief.vm.display, ":1");
assert.equal(chief.vm.debugPort, 9222);
assert.equal(chief.vm.novncPort, 13100);
assert.equal(w1.vm.display, ":2");
assert.equal(w1.vm.debugPort, 9223);
assert.equal(w2.vm.display, ":3");
assert.equal(w2.vm.debugPort, 9224);

const args = deskCreateArgs({
  name: "localbot-deadbeef",
  volume: "localbot-config-deadbeef",
  port: 13109,
  image: "sub8-desk:trixie",
});
assert.ok(args.some((a) => String(a).includes("13109-13116:3000-3007")));

console.log("ok display");
