/**
 * Every computer-use verb must refuse a bot that has no computer, at the
 * isolation guard — not later, at `docker exec undefined`.
 *
 * drag(), clipboardRead() and clipboardWrite() read bot.vm.container with no
 * requireVm of their own, unlike every neighbour. paste() was guarded while the
 * clipboardWrite() sitting immediately above it was not, which is what marks it
 * as an oversight rather than a decision. A bot with no computer reached the
 * spawn and failed there, bypassing the "work only happens inside the VM" rule
 * that server/isolation.mts exists to enforce.
 *
 * Pure guard test: every case must throw BEFORE anything spawns, so this never
 * touches Docker, a container, or a live bot.
 */
import assert from "node:assert/strict";
import * as vm from "../server/vm.mjs";

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log("PASS", name);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log("FAIL", name, "-", err.message);
  }
}

// Bots that must never reach a container.
const noVm = { id: "b1" };
const emptyVm = { id: "b2", vm: {} };
const nulled = { id: "b3", vm: { container: null } };
// A container that is not a bot computer: the exact case requireVm exists for.
const foreign = { id: "b4", vm: { container: "postgres" } };

const verbs = [
  ["drag", (b) => vm.drag(b, 1, 2, 3, 4)],
  ["clipboardRead", (b) => vm.clipboardRead(b)],
  ["clipboardWrite", (b) => vm.clipboardWrite(b, "x")],
  // `key` was the one verb this file's own premise did not actually cover: it
  // read bot.vm.container directly and reached `docker exec` for a bot the
  // guard would refuse, answering with the daemon's "No such container: null"
  // instead of the isolation message. A plain key name is required — a
  // sentence-like string is delegated to typeText, which guards separately.
  ["key", (b) => vm.key(b, "Return")],
  // Already guarded — pinned here so the family stays consistent.
  ["click", (b) => vm.click(b, 1, 2)],
  // Was `typeKeys`, which does not exist on vm.mjs — the ternary fell back to
  // rejecting with an error this file constructed, and then asserted on its own
  // literal. It reported PASS for a function that was never called, while the
  // verb that DOES exist went untested: requireVm in typeText is the only
  // isolation check on the `computer` tool's `type` action (mcp-sub8.mts:769,
  // agent.mts:2375), so losing it lets a bot with no container — or one pointed
  // at a foreign container — reach `docker exec`.
  ["typeText", (b) => vm.typeText(b, "hi")],
];

for (const [name, call] of verbs) {
  await test(`${name} refuses a bot with no computer`, async () => {
    for (const [label, bot] of [
      ["no vm", noVm],
      ["empty vm", emptyVm],
      ["null container", nulled],
      ["foreign container", foreign],
    ]) {
      await assert.rejects(
        () => call(bot),
        (err) => {
          // The isolation guard's message, not a spawn failure. If this ever
          // reads ENOENT or "undefined", the guard was skipped.
          assert.match(err.message, /blocked: no bot computer|Work only happens inside the VM/, `${name} / ${label}: ${err.message}`);
          return true;
        },
        `${name} must reject for ${label}`,
      );
    }
  });
}

await test("a real bot computer still passes the guard", async () => {
  // requireVm is what the verbs call; proving it accepts the good shapes means
  // the guards above cannot be rejecting everything.
  const { requireVm } = await import("../server/isolation.mjs");
  assert.equal(requireVm({ vm: { container: "localbot-abc" } }, "drag"), "localbot-abc");
  // A remote/cloud desk is authorised by its token pair, not the name prefix.
  assert.equal(requireVm({ vm: { deskUrl: "https://d", deskToken: "t", container: "sub8-desk" } }, "clipboard"), "sub8-desk");
});

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `${failed.length} failed` : "ok vm-guards");
process.exit(failed.length ? 1 : 0);
