import test from "node:test";
import assert from "node:assert/strict";
import { DISPLAY_SLOTS, HARNESS_PORT } from "@sub8/desk-ports";
import { deskRunArgs, limitsFromRamMb } from "../dist/index.js";

test("1 GB desk is a 1g cgroup with a half CPU and a pid cap", () => {
  assert.deepEqual(limitsFromRamMb(1024), {
    memory: "1g",
    memorySwap: "1g",
    shm: "256m",
    cpus: "0.5",
    pids: 512,
  });
});

test("4 GB desk is the default dedicated webtop", () => {
  assert.deepEqual(limitsFromRamMb(4096), {
    memory: "4g",
    memorySwap: "4g",
    shm: "256m",
    cpus: "1.0",
    pids: 1024,
  });
});

test("16 GB billed RAM is 16g on the container, not 12g", () => {
  // 12g was a dedicated-droplet leftover (OS ate 4g of a 16g VM).
  // Packed hosts reserve OS on the host, not by shrinking the SKU.
  assert.equal(limitsFromRamMb(16384).memory, "16g");
  assert.equal(limitsFromRamMb(16384).cpus, "4.0");
});

test("unknown RAM rounds down to the next known rung, never throws", () => {
  assert.equal(limitsFromRamMb(3000).memory, "2g");
  assert.equal(limitsFromRamMb(0).memory, "1g");
  assert.equal(limitsFromRamMb(-1).memory, "1g");
});

test("loopback run args mount /config, cap cgroups, and never bind 0.0.0.0", () => {
  const args = deskRunArgs({
    name: "localbot-deadbeef",
    volume: "localbot-config-deadbeef",
    image: "sub8-desk:trixie",
    platform: "linux/arm64",
    hostname: "computer",
    limits: limitsFromRamMb(2048),
    publish: { kind: "loopback", novncPort: 13109, harnessPort: 13109 + DISPLAY_SLOTS },
    env: ["PUID=1000", "PGID=1000", "TZ=America/New_York", "TITLE=My Computer", "DESK_HARNESS=1"],
    extraArgs: ["--dns", "8.8.8.8", "--dns", "1.1.1.1", "--add-host", "host.docker.internal:host-gateway"],
  });
  assert.equal(args[0], "run");
  assert.equal(args.at(-1), "sub8-desk:trixie");
  assert.equal(args[args.indexOf("--name") + 1], "localbot-deadbeef");
  assert.equal(args[args.indexOf("-v") + 1], "localbot-config-deadbeef:/config");
  assert.equal(args[args.indexOf("--memory") + 1], "2g");
  assert.equal(args[args.indexOf("--memory-swap") + 1], "2g");
  assert.equal(args[args.indexOf("--shm-size") + 1], "256m");
  assert.equal(args[args.indexOf("--cpus") + 1], "0.5");
  assert.equal(args[args.indexOf("--pids-limit") + 1], "768");
  const ports = args.filter((_, i) => args[i - 1] === "-p");
  for (const p of ports) assert.ok(String(p).startsWith("127.0.0.1:"), p);
  assert.ok(ports.some((p) => p === `127.0.0.1:13109-${13109 + DISPLAY_SLOTS - 1}:3000-${3000 + DISPLAY_SLOTS - 1}`));
  assert.ok(ports.some((p) => p === `127.0.0.1:${13109 + DISPLAY_SLOTS}:${HARNESS_PORT}`));
  assert.ok(!args.includes("--privileged"));
  assert.ok(
    !args.includes("NOVNC_LOOPBACK=1"),
    "local docker-proxy DNAT is eth0; in-container loopback bind is unreachable",
  );
});

test("slot publish: websockify on the host loopback, RFB on the host interface, nothing else", () => {
  const args = deskRunArgs({
    name: "sub8-desk-cmp_1",
    volume: "sub8-config-cmp_1",
    image: "sub8-desk:trixie",
    platform: "linux/amd64",
    hostname: "computer",
    limits: limitsFromRamMb(2048),
    publish: { kind: "slot", slot: 2 },
    env: ["TITLE=Sub8", "TZ=UTC", "RFB_EXPOSE=1"],
  });
  const ports = args.filter((_, i) => args[i - 1] === "-p");
  // websockify 3000-3007 → 127.0.0.1:20210-20217
  for (let d = 0; d < 8; d++) assert.ok(ports.includes(`127.0.0.1:${20210 + d}:${3000 + d}`), `web ${d}`);
  // RFB 5900-5907 → 0.0.0.0:20230-20237 (the Worker relay dials these)
  for (let d = 0; d < 8; d++) assert.ok(ports.includes(`0.0.0.0:${20230 + d}:${5900 + d}`), `rfb ${d}`);
  assert.equal(ports.length, 16, "no harness publish: the harness is a per-desk host process");
  assert.ok(!ports.some((p) => /:3011$/.test(p)));
  assert.ok(!ports.some((p) => /^0\.0\.0\.0:\d+:300\d$/.test(p)), "never a public websockify on a shared host");
  assert.ok(
    !args.includes("NOVNC_LOOPBACK=1"),
    "packed noVNC is already host-loopback; container websockify must bind eth0",
  );
});

test("host publish: public :3000 fail-closes in-container via NOVNC_LOOPBACK", () => {
  const args = deskRunArgs({
    name: "sub8-desk",
    volume: "sub8-config-cmp_abc",
    image: "sub8-desk:trixie",
    platform: "linux/amd64",
    hostname: "computer",
    limits: limitsFromRamMb(4096),
    publish: { kind: "host", rfbExpose: false },
    env: ["TITLE=Sub8", "TZ=UTC"],
  });
  const ports = args.filter((_, i) => args[i - 1] === "-p");
  assert.ok(ports.includes("3000:3000"));
  assert.ok(!ports.some((p) => p.includes("5900")), "no RFB unless asked");
  assert.ok(
    args.includes("NOVNC_LOOPBACK=1"),
    "dedicated public -p 3000:3000 must not expose a passwordless screen",
  );
});
