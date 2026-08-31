import { basename, dirname } from "node:path";

function archiveParts(archiveAbs: string): { hostDir: string; base: string } {
  const base = basename(archiveAbs);
  if (!base || base.includes("..")) {
    throw new Error("desk-images: bad archive path");
  }
  return { hostDir: dirname(archiveAbs), base };
}

/** Tar a named volume into an archive on the host. Never emits "commit". */
export function snapshotArgs(volume: string, archiveAbs: string): string[] {
  const { hostDir, base } = archiveParts(archiveAbs);
  return [
    "run",
    "--rm",
    "-v",
    `${volume}:/from:ro`,
    "-v",
    `${hostDir}:/to`,
    "alpine:3.20",
    "tar",
    "-C",
    "/from",
    "-czf",
    `/to/${base}`,
    ".",
  ];
}

/** Untar a host archive into a named volume. Never emits "commit". */
export function restoreArgs(volume: string, archiveAbs: string): string[] {
  const { hostDir, base } = archiveParts(archiveAbs);
  return [
    "run",
    "--rm",
    "-v",
    `${volume}:/to`,
    "-v",
    `${hostDir}:/from`,
    "alpine:3.20",
    "tar",
    "-C",
    "/to",
    "-xzf",
    `/from/${base}`,
    ".",
  ];
}

/** List docker volumes. */
export function listVolumeArgs(): string[] {
  return ["volume", "ls"];
}
