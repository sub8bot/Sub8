import type { DeskLimits } from "./types.js";

// pids is a THREAD count (the cgroup counts tasks), and one Chrome is ~100+
// threads; a team runs one Chrome per display. A 4g desk with three displays
// sat at 369/384: every fork (a screenshot, a tool, apt) failed with EAGAIN,
// workers reported "display errors", turns hung, and the model tried to
// "install screenshot tools". Still bounded (fork-bomb protection), just
// sized for the desk it actually is.
const RUNGS: ReadonlyArray<{ ramMb: number } & DeskLimits> = [
  { ramMb: 1024, memory: "1g", memorySwap: "1g", shm: "256m", cpus: "0.5", pids: 512 },
  { ramMb: 2048, memory: "2g", memorySwap: "2g", shm: "256m", cpus: "0.5", pids: 768 },
  { ramMb: 4096, memory: "4g", memorySwap: "4g", shm: "256m", cpus: "1.0", pids: 1024 },
  { ramMb: 8192, memory: "8g", memorySwap: "8g", shm: "256m", cpus: "2.0", pids: 1536 },
  { ramMb: 16384, memory: "16g", memorySwap: "16g", shm: "256m", cpus: "4.0", pids: 2048 },
];

export function limitsFromRamMb(ramMb: number): DeskLimits {
  const n = Number(ramMb);
  let picked = RUNGS[0]!;
  for (const rung of RUNGS) {
    if (Number.isFinite(n) && n >= rung.ramMb) picked = rung;
  }
  const { memory, memorySwap, shm, cpus, pids } = picked;
  return { memory, memorySwap, shm, cpus, pids };
}
