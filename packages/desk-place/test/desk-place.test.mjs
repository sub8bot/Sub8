import test from "node:test";
import assert from "node:assert/strict";
import {
  CPU_OVERSUBSCRIBE,
  HOST_CPU_RESERVE_MILLI,
  HOST_DISK_RESERVE_GB,
  HOST_RAM_RESERVE_MB,
  hostFits,
  pickHost,
  usableHost,
} from "../dist/index.js";

const want4g = { ramMb: 4096, diskGb: 40, milliCpus: 1000, dedicated: false };

function host(over = {}) {
  return {
    id: "h1",
    ramMb: 63488,
    diskGb: 770,
    milliCpus: 15800,
    reservedRamMb: 0,
    reservedDiskGb: 0,
    reservedMilliCpus: 0,
    dedicated: false,
    region: "nyc3",
    ...over,
  };
}

function packUntilFull(h, want) {
  let n = 0;
  while (hostFits(h, want)) {
    n += 1;
    h = {
      ...h,
      reservedRamMb: h.reservedRamMb + want.ramMb,
      reservedDiskGb: h.reservedDiskGb + want.diskGb,
      reservedMilliCpus: h.reservedMilliCpus + want.milliCpus,
    };
  }
  return n;
}

test("host reserves are the documented constants", () => {
  assert.equal(HOST_RAM_RESERVE_MB, 2048);
  assert.equal(HOST_DISK_RESERVE_GB, 30);
  assert.equal(HOST_CPU_RESERVE_MILLI, 200);
  assert.equal(CPU_OVERSUBSCRIBE, 1.5);
});

test("usableHost subtracts the OS reserves and never goes negative", () => {
  assert.deepEqual(usableHost(65536, 500, 16000), { ramMb: 63488, diskGb: 470, milliCpus: 15800 });
  assert.deepEqual(usableHost(1024, 10, 100), { ramMb: 0, diskGb: 0, milliCpus: 0 });
});

test("a 64 GB host packs fifteen 4 GB desks and rejects the sixteenth", () => {
  // The spec's example used a 500 GB disk, which the disk rule bounds at 11;
  // 800 GB keeps this one RAM-bound: (65536-2048)/4096 = 15.5 → 15.
  const raw = usableHost(65536, 800, 16000);
  const h = host({ ...raw });
  assert.equal(packUntilFull(h, want4g), 15);
});

test("disk is never oversubscribed: a 500 GB host is disk-bound at eleven 4 GB desks", () => {
  const raw = usableHost(65536, 500, 16000);
  assert.equal(packUntilFull(host({ ...raw }), want4g), 11); // (500-30)/40 = 11.75 → 11
});

test("cpu may oversubscribe 1.5×, no further", () => {
  // 4200 raw → 4000 usable → 6000 milli of reservations, so six 1-core desks.
  const raw = usableHost(1_000_000, 100_000, 4200);
  const want = { ramMb: 1024, diskGb: 25, milliCpus: 1000, dedicated: false };
  assert.equal(packUntilFull(host({ ...raw }), want), 6);
});

test("dedicated SKUs never co-tenant", () => {
  const h = {
    id: "h1",
    ramMb: 16384,
    diskGb: 200,
    milliCpus: 8000,
    reservedRamMb: 4096,
    reservedDiskGb: 40,
    reservedMilliCpus: 1000,
    dedicated: false,
    region: "nyc3",
  };
  assert.equal(hostFits(h, { ramMb: 8192, diskGb: 80, milliCpus: 2000, dedicated: true }), false);
});

test("a dedicated host takes exactly one desk, and only if it fits outright", () => {
  const empty = host({ ramMb: 8192, diskGb: 100, milliCpus: 2000, dedicated: true });
  assert.equal(hostFits(empty, { ramMb: 8192, diskGb: 80, milliCpus: 2000, dedicated: true }), true);
  // No 1.5× cpu allowance on a dedicated box.
  assert.equal(hostFits(empty, { ramMb: 8192, diskGb: 80, milliCpus: 2400, dedicated: true }), false);
  const taken = { ...empty, reservedRamMb: 4096, reservedDiskGb: 40, reservedMilliCpus: 1000 };
  assert.equal(hostFits(taken, want4g), false);
  // Any leftover reservation counts as occupied, not just RAM.
  assert.equal(hostFits({ ...empty, reservedDiskGb: 1 }, want4g), false);
});

test("pickHost returns null when every host is full", () => {
  assert.equal(pickHost([], want4g), null);
  const full = host({ reservedRamMb: 63488, reservedDiskGb: 0, reservedMilliCpus: 0 });
  assert.equal(pickHost([full], want4g), null);
});

test("pickHost prefers the tightest fit and ignores region", () => {
  const roomy = host({ id: "roomy", reservedRamMb: 4096, reservedDiskGb: 40, reservedMilliCpus: 1000 });
  const snug = host({ id: "snug", region: "sfo3", reservedRamMb: 57344, reservedDiskGb: 560, reservedMilliCpus: 14000 });
  const full = host({ id: "full", reservedRamMb: 61440, reservedDiskGb: 600, reservedMilliCpus: 15000 });
  assert.equal(pickHost([roomy, full, snug], want4g)?.id, "snug");
  assert.equal(pickHost([roomy, full, snug], { ...want4g, ramMb: 8192, diskGb: 80, milliCpus: 2000 })?.id, "roomy");
});
