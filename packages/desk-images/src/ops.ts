import type { DockerRun } from "./types.js";
import { restoreArgs, snapshotArgs } from "./argv.js";

export function ensureVolumeArgs(volume: string): string[] {
  return ["volume", "create", volume];
}

function throwIfFailed(result: { ok: boolean; out: string; err: string }): void {
  if (!result.ok) {
    throw new Error(result.err || result.out || "docker failed");
  }
}

export async function snapshotVolume(opts: {
  run: DockerRun;
  volume: string;
  archiveAbs: string;
}): Promise<void> {
  const result = await opts.run(snapshotArgs(opts.volume, opts.archiveAbs));
  throwIfFailed(result);
}

export async function restoreVolume(opts: {
  run: DockerRun;
  volume: string;
  archiveAbs: string;
}): Promise<void> {
  const created = await opts.run(ensureVolumeArgs(opts.volume));
  if (!created.ok && !/already exists/i.test(created.err)) {
    throw new Error(created.err || created.out || "docker failed");
  }
  const result = await opts.run(restoreArgs(opts.volume, opts.archiveAbs));
  throwIfFailed(result);
}
