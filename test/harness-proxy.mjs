/**
 * warmLocalDesks: at boot, publish :3011 for THIS app's desks and no stranger's.
 * The proxy plumbing it leans on (attachHarnessProxy, HARNESS_STDIO_BRIDGE) now
 * lives in @sub8/desk-ports and is covered by that package's test.
 */
import assert from "node:assert/strict";
import { warmLocalDesks } from "../server/vm.mjs";

{
  const published = [];
  const upserts = [];
  const logs = [];
  const out = await warmLocalDesks({
    listStates: async () => ({
      ok: true,
      states: new Map([
        ["localbot-mine", { running: true, novncPort: 13100, portMap: { 3000: 13100 } }],
        ["localbot-other", { running: true, novncPort: 13108, portMap: { 3000: 13108 } }],
        ["localbot-has", { running: true, novncPort: 13116, portMap: { 3000: 13116, 3011: 14101 } }],
      ]),
    }),
    publish: async (name, novnc) => {
      published.push({ name, novnc });
      return 14110;
    },
    ensure: async () => {},
    bots: [
      { id: "a", vm: { container: "localbot-mine" } },
      { id: "b", vm: { container: "localbot-has", harnessPort: 14101 } },
    ],
    upsertBot: async (bot) => {
      upserts.push(bot);
      return bot;
    },
    onLog: (m) => logs.push(m),
  });
  assert.deepEqual(published, [{ name: "localbot-mine", novnc: 13100 }]);
  assert.equal(out.warmed.length, 1);
  assert.equal(out.warmed[0].harnessPort, 14110);
  assert.equal(upserts[0].vm.harnessPort, 14110);
  const empty = await warmLocalDesks({
    listStates: async () => ({ ok: true, states: new Map([["localbot-mine", { running: true, portMap: {} }]]) }),
    publish: async () => {
      throw new Error("must not touch stranger desks");
    },
    ensure: async () => {},
    bots: [],
  });
  assert.equal(empty.warmed.length, 0);
}

console.log("ok harness-proxy");
