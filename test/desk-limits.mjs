import assert from "node:assert/strict";
import {
  allocateDeskCaps,
  budgetFromMemTotal,
  cpusForMemory,
  decideTabReset,
  dockerRuntimeName,
  memoryUpdateArgs,
  memString,
  parseChromeRenderers,
  parseMemMb,
  resettablePages,
  DESK_FLOOR_MB,
  VM_RESERVE_MB,
  TAB_RESET_INTERVAL_MS,
} from "../server/desk-limits.mjs";
import { deskCreateArgs } from "../server/vm.mjs";

// ---- memory strings and CPU that follows memory
assert.equal(parseMemMb("2g"), 2048);
assert.equal(parseMemMb("4352m"), 4352);
assert.equal(parseMemMb("1.5g"), 1536);
assert.equal(parseMemMb("3GiB"), 3072);
assert.equal(parseMemMb(String(4 * 1073741824)), 4096);
assert.equal(parseMemMb("lots"), 0);
assert.equal(memString(4096), "4g");
assert.equal(memString(4352), "4352m");

// The rung at or below the memory.
assert.equal(cpusForMemory("1g"), "0.5");
assert.equal(cpusForMemory("2g"), "0.5");
assert.equal(cpusForMemory("3g"), "0.5");
assert.equal(cpusForMemory("4g"), "1.0");
assert.equal(cpusForMemory("6g"), "1.0");
assert.equal(cpusForMemory("8g"), "2.0");
assert.equal(cpusForMemory("20g"), "4.0");
assert.equal(cpusForMemory(4352), "1.0");
assert.equal(cpusForMemory("512m"), "0.5");

// Every live memory update carries --cpus (a desk raised 2g -> 4g used to keep 0.5).
const up = memoryUpdateArgs("localbot-x", 4096);
assert.deepEqual(up, ["update", "--memory", "4g", "--memory-swap", "4g", "--cpus", "1.0", "localbot-x"]);
assert.equal(memoryUpdateArgs("localbot-x", 2048)[6], "0.5");

// Desk create: CPU follows the memory actually given, pids follow the intended size.
const created = deskCreateArgs({ name: "localbot-deadbeef", volume: "v", port: 13109, memory: "4g" });
assert.equal(created[created.indexOf("--memory") + 1], "4g");
assert.equal(created[created.indexOf("--cpus") + 1], "1.0");
const clamped = deskCreateArgs({ name: "localbot-deadbeef", volume: "v", port: 13109, memory: "1152m" });
assert.equal(clamped[clamped.indexOf("--memory") + 1], "1152m");
assert.equal(clamped[clamped.indexOf("--cpus") + 1], "0.5");

// ---- budget
const GiB = 1073741824;
const memTotal = Math.round(5.8 * GiB);
const budget = budgetFromMemTotal(memTotal);
assert.equal(budget, Math.floor(memTotal / 1048576) - VM_RESERVE_MB);
assert.equal(budgetFromMemTotal(0), 0);

const sum = (plan) => [...plan.caps.values()].reduce((a, b) => a + b, 0);

// The measured case: a 5.8 GB VM, Personal using 3.9g (cap 4g), two desks using
// ~0.37g/0.38g (caps 2g). 4g + 2g + 2g was 8 GB of caps in a 5.8 GB VM.
{
  const plan = allocateDeskCaps(
    [
      { name: "personal", usedMb: Math.round(3.9 * 1024), capMb: 4096, wantMb: 4096 },
      { name: "b", usedMb: Math.round(0.37 * 1024), capMb: 2048, wantMb: 2048 },
      { name: "c", usedMb: Math.round(0.38 * 1024), capMb: 2048, wantMb: 2048 },
    ],
    budget,
  );
  // 3.9g + margin plus two 1g floors cannot fit 5.2 GiB: shrink the idle desks
  // to the floor, never raise the busy one, flag it.
  assert.equal(plan.overBudget, true);
  assert.equal(plan.caps.get("b"), DESK_FLOOR_MB);
  assert.equal(plan.caps.get("c"), DESK_FLOOR_MB);
  assert.equal(plan.caps.get("personal"), 4096);
  assert.ok(sum(plan) < 8192);
}

// Same VM once the heavy tab is reset (Personal back to 2.7g): everything fits.
{
  const plan = allocateDeskCaps(
    [
      { name: "b", usedMb: 379, capMb: 2048, wantMb: 2048 },
      { name: "personal", usedMb: 2800, capMb: 4096, wantMb: 4096 },
      { name: "c", usedMb: 389, capMb: 2048, wantMb: 2048 },
    ],
    budget,
  );
  assert.equal(plan.overBudget, false);
  assert.ok(sum(plan) <= budget, `caps ${sum(plan)} within budget ${budget}`);
  const p = plan.caps.get("personal");
  assert.ok(p > plan.caps.get("b") && p > plan.caps.get("c"), "busiest desk gets the most");
  assert.ok(p >= 2800 + 256, "never below usage plus margin");
  for (const v of plan.caps.values()) assert.ok(v >= DESK_FLOOR_MB);
  assert.ok(plan.caps.get("b") >= 379 + 256);
}

// A roomy VM: everyone gets what they want.
{
  const plan = allocateDeskCaps(
    [
      { name: "a", usedMb: 1500, capMb: 2048, wantMb: 4096 },
      { name: "b", usedMb: 300, capMb: 2048, wantMb: 2048 },
    ],
    16000,
  );
  assert.equal(plan.caps.get("a"), 4096);
  assert.equal(plan.caps.get("b"), 2048);
}

// A raise (priority) is sized first; the others keep at least their minimum.
{
  const plan = allocateDeskCaps(
    [
      { name: "busy", usedMb: 2000, capMb: 2048, wantMb: 2048 },
      { name: "raise", usedMb: 600, capMb: 2048, wantMb: 4096, priority: true },
    ],
    5000,
  );
  // 4g does not fit next to the busy desk's minimum: raised as far as fits.
  assert.equal(plan.caps.get("raise"), 2688);
  assert.ok(sum(plan) <= 5000);
  assert.ok(plan.caps.get("busy") >= 2000 + 256);
}

// A fresh desk (no usage yet) gets its want when it fits, the floor when not.
{
  const roomy = allocateDeskCaps(
    [
      { name: "old", usedMb: 900, capMb: 2048, wantMb: 2048 },
      { name: "new", usedMb: 0, capMb: 0, wantMb: 2048 },
    ],
    budget,
  );
  assert.equal(roomy.caps.get("new"), 2048);
  const tight = allocateDeskCaps(
    [
      { name: "old", usedMb: 3500, capMb: 4096, wantMb: 4096 },
      { name: "new", usedMb: 0, capMb: 0, wantMb: 2048 },
    ],
    4900,
  );
  assert.ok(tight.caps.get("new") >= DESK_FLOOR_MB);
  assert.ok(sum(tight) <= 4900);
}

// A paused desk (usage unreadable) is never lowered below its cap.
{
  const plan = allocateDeskCaps(
    [
      { name: "paused", usedMb: null, capMb: 2048, wantMb: 2048 },
      { name: "live", usedMb: 500, capMb: 2048, wantMb: 2048 },
    ],
    3500,
  );
  assert.equal(plan.caps.get("paused"), 2048);
  assert.ok(sum(plan) <= 3500);
}

// ---- runtime name
assert.equal(dockerRuntimeName({ dockerHost: "unix:///Users/dan/.colima/default/docker.sock" }), "Colima");
assert.equal(dockerRuntimeName({ context: "colima" }), "Colima");
assert.equal(dockerRuntimeName({ dockerHost: "unix:///var/run/docker.sock", context: "desktop-linux" }), "Docker Desktop");
assert.equal(dockerRuntimeName(), "Docker Desktop");

// ---- Chrome renderers from ps
const PS = [
  "    1     0  1200 /sbin/tini -- /usr/local/bin/desk-init",
  "  200     1 150000 /opt/google/chrome/chrome --user-data-dir=/config/chrome-desk --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 https://x.com/home",
  "  210   200  40000 /opt/google/chrome/chrome --type=zygote --no-zygote-sandbox",
  "  211   200  40000 /opt/google/chrome/chrome --type=zygote",
  "  212   211  20000 /opt/google/chrome/chrome --type=zygote",
  "  300   212 2048000 /opt/google/chrome/chrome --type=renderer --renderer-client-id=7 --lang=en-US",
  "  301   212  90000 /opt/google/chrome/chrome --type=renderer --extension-process --renderer-client-id=4",
  "  302   212 120000 /opt/google/chrome/chrome --type=renderer --renderer-client-id=9",
  "  400     1 150000 /opt/google/chrome/chrome --user-data-dir=/config/chrome-desk-2 --remote-debugging-port=9223",
  "  411   400  40000 /opt/google/chrome/chrome --type=zygote",
  "  500   411 512000 /opt/google/chrome/chrome --type=renderer --renderer-client-id=3",
  "  600   599 700000 /some/orphan --type=renderer",
].join("\n");
const renderers = parseChromeRenderers(PS);
assert.deepEqual(renderers.map((r) => [r.pid, r.rssMb, r.port]), [
  [300, 2000, 9222],
  [600, 684, 0],
  [500, 500, 9223],
  [302, 117, 9222],
]);

// ---- reset decisions (cap 4g = 4096 MiB)
const now = 1_000_000_000;
const base = { renderers, memMaxMb: 4096, now };
// A renderer above 45% of the cap at a turn boundary.
let d = decideTabReset({ ...base, memUsedMb: 2500, mode: "turn-end" });
assert.equal(d.reset, true);
assert.equal(d.port, 9222);
assert.equal(d.pid, 300);
assert.equal(d.rssMb, 2000);
// Same desk, but display 1 is under Take control: the next Chrome is below threshold.
d = decideTabReset({ ...base, memUsedMb: 2500, mode: "turn-end", skipPorts: [9222] });
assert.equal(d.reset, false);
// ...unless the desk itself is above 85%.
d = decideTabReset({ ...base, memUsedMb: 3600, mode: "turn-end", skipPorts: [9222] });
assert.equal(d.reset, true);
assert.equal(d.port, 9223);
// Rate limit: once per desk per 10 minutes.
d = decideTabReset({ ...base, memUsedMb: 3600, mode: "turn-end", lastResetAt: now - 60_000 });
assert.deepEqual([d.reset, d.reason], [false, "reset recently"]);
d = decideTabReset({ ...base, memUsedMb: 3600, mode: "turn-end", lastResetAt: now - TAB_RESET_INTERVAL_MS - 1 });
assert.equal(d.reset, true);
// Backstop (bot mid-turn): only above 92% of the cap.
d = decideTabReset({ ...base, memUsedMb: 3600, mode: "backstop" });
assert.equal(d.reset, false);
d = decideTabReset({ ...base, memUsedMb: 3900, mode: "backstop" });
assert.equal(d.reset, true);
assert.equal(d.pid, 300);
// Small tabs are never reset, whatever the desk is at.
d = decideTabReset({ renderers: parseChromeRenderers(PS.split("\n").filter((l) => !/ (300|500|600) /.test(l)).join("\n")), memMaxMb: 4096, memUsedMb: 4000, mode: "backstop", now });
assert.equal(d.reset, false);
// No cap, nothing to judge.
assert.equal(decideTabReset({ ...base, memMaxMb: 0, memUsedMb: 1, mode: "turn-end" }).reset, false);

// ---- which targets get reopened
assert.deepEqual(
  resettablePages([
    { id: "A", type: "page", url: "https://x.com/home" },
    { id: "B", type: "service_worker", url: "https://x.com/sw.js" },
    { id: "C", type: "page", url: "about:blank" },
    { id: "D", type: "page", url: "devtools://devtools/bundled/inspector.html" },
    { id: "E", type: "page", url: "https://mail.example.com/" },
  ]).map((t) => t.id),
  ["A", "E"],
);

console.log("desk-limits ok");
