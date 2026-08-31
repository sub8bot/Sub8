import test from "node:test";
import assert from "node:assert/strict";
import { limitsFromRamMb } from "../dist/index.js";

test("1 GB desk is a 1g cgroup with a half CPU and a pid cap", () => {
  assert.deepEqual(limitsFromRamMb(1024), {
    memory: "1g",
    memorySwap: "1g",
    shm: "256m",
    cpus: "0.5",
    pids: 256,
  });
});

test("4 GB desk is the default dedicated webtop", () => {
  assert.deepEqual(limitsFromRamMb(4096), {
    memory: "4g",
    memorySwap: "4g",
    shm: "256m",
    cpus: "1.0",
    pids: 512,
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
