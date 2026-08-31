import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { snapshotVolume, restoreVolume, type DockerRun } from "@sub8/desk-images";
import { dataDir as defaultDataDir } from "./paths.mjs";
import * as computers from "./computers.mjs";
import { docker } from "./vm.mjs";

export interface DeskImage {
  id: string;
  computerId: string;
  volume: string;
  fileName: string;
  bytes: number;
  createdAt: number;
  note: string;
}

export type DeskComputerRef = {
  id: string;
  container: string;
  volume: string;
};

export type SnapshotControl = {
  pause?: (container: string) => Promise<void>;
  unpause?: (container: string) => Promise<void>;
};

export type RestoreControl = {
  stop: (container: string) => Promise<void>;
  start: (container: string) => Promise<void>;
};

function notFound(): Error {
  const err = new Error("not found") as Error & { status: number };
  err.status = 404;
  return err;
}

export function imagesDir(root: string = defaultDataDir): string {
  return path.join(root, "desk-images");
}

export function catalogPath(root: string = defaultDataDir): string {
  return path.join(imagesDir(root), "desk-images.json");
}

/** Ensure desk-images/ + empty catalog exist. Returns the data root. */
export function createCatalog(root: string): string {
  const dir = imagesDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const cat = catalogPath(root);
  if (!fs.existsSync(cat)) fs.writeFileSync(cat, "[]\n");
  return root;
}

export function readCatalog(root: string = defaultDataDir): DeskImage[] {
  try {
    const raw = JSON.parse(fs.readFileSync(catalogPath(root), "utf8"));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function writeCatalog(root: string, rows: DeskImage[]): void {
  const dir = imagesDir(root);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(catalogPath(root), JSON.stringify(rows, null, 2) + "\n");
}

export function addImageRow(
  root: string,
  partial: {
    computerId: string;
    volume: string;
    fileName: string;
    bytes: number;
    note?: string | undefined;
    id?: string | undefined;
    createdAt?: number | undefined;
  },
): DeskImage {
  createCatalog(root);
  const row: DeskImage = {
    id: partial.id || randomUUID(),
    computerId: partial.computerId,
    volume: partial.volume,
    fileName: partial.fileName,
    bytes: partial.bytes,
    createdAt: partial.createdAt || Date.now(),
    note: partial.note || "",
  };
  const rows = readCatalog(root);
  rows.push(row);
  writeCatalog(root, rows);
  return row;
}

/** Remove a catalog row and delete its archive file when present. */
export function removeImageRow(root: string, imageId: string): DeskImage | null {
  const rows = readCatalog(root);
  const i = rows.findIndex((r) => r.id === imageId);
  if (i < 0) return null;
  const [removed] = rows.splice(i, 1);
  writeCatalog(root, rows);
  if (removed?.fileName) {
    try {
      fs.unlinkSync(path.join(imagesDir(root), removed.fileName));
    } catch {
      /* archive may already be gone */
    }
  }
  return removed || null;
}

async function defaultPause(container: string): Promise<void> {
  const r = await docker(["pause", container], { timeout: 15_000 });
  if (!r.ok && !/is not running|No such container/i.test(r.out || "")) {
    throw new Error(r.out || "pause failed");
  }
}

async function defaultUnpause(container: string): Promise<void> {
  await docker(["unpause", container], { timeout: 15_000 });
}

async function defaultStop(container: string): Promise<void> {
  const st = await docker(["inspect", "-f", "{{.State.Status}}", container], { timeout: 8_000 });
  if (/paused/i.test(st.out || "")) await docker(["unpause", container], { timeout: 15_000 });
  await docker(["stop", "-t", "8", container], { timeout: 20_000 });
}

async function defaultStart(container: string): Promise<void> {
  const r = await docker(["start", container], { timeout: 20_000 });
  if (!r.ok) throw new Error(r.out || "start failed");
}

async function resolveDesk(
  computerId: string,
  opts: {
    computer?: DeskComputerRef | undefined;
    resolveComputer?: ((id: string) => Promise<DeskComputerRef | null>) | undefined;
  },
): Promise<DeskComputerRef> {
  if (opts.computer) return opts.computer;
  const lookup =
    opts.resolveComputer ||
    (async (id: string) => {
      const row = await computers.getComputer(id);
      return row ? { id: row.id, container: row.container, volume: row.volume } : null;
    });
  const row = await lookup(computerId);
  if (!row) throw notFound();
  return row;
}

/**
 * Pause the desk, tar its named volume into dataDir/desk-images/, append catalog.
 * Never snapshots the golden image; never docker commit.
 */
export async function performSnapshot(opts: {
  computerId: string;
  note?: string | undefined;
  dataDir?: string | undefined;
  run: DockerRun;
  control?: SnapshotControl | undefined;
  computer?: DeskComputerRef | undefined;
  resolveComputer?: ((id: string) => Promise<DeskComputerRef | null>) | undefined;
}): Promise<DeskImage> {
  const root = opts.dataDir || defaultDataDir;
  const desk = await resolveDesk(opts.computerId, opts);
  createCatalog(root);

  const id = randomUUID();
  const fileName = `${id}.tgz`;
  const archiveAbs = path.join(imagesDir(root), fileName);

  const pause = opts.control?.pause || defaultPause;
  const unpause = opts.control?.unpause || defaultUnpause;

  await pause(desk.container);
  try {
    await snapshotVolume({ run: opts.run, volume: desk.volume, archiveAbs });
  } finally {
    await unpause(desk.container).catch(() => {});
  }

  const st = fs.statSync(archiveAbs);
  return addImageRow(root, {
    id,
    computerId: desk.id,
    volume: desk.volume,
    fileName,
    bytes: st.size,
    note: opts.note || "",
  });
}

/**
 * Stop the desk (not pause), untar the archive into its volume, start again.
 */
export async function performRestore(opts: {
  computerId: string;
  imageId: string;
  dataDir?: string | undefined;
  run: DockerRun;
  control?: RestoreControl | undefined;
  computer?: DeskComputerRef | undefined;
  resolveComputer?: ((id: string) => Promise<DeskComputerRef | null>) | undefined;
}): Promise<DeskImage> {
  const root = opts.dataDir || defaultDataDir;
  const desk = await resolveDesk(opts.computerId, opts);
  const image = readCatalog(root).find((r) => r.id === opts.imageId && r.computerId === desk.id);
  if (!image) throw notFound();

  const archiveAbs = path.join(imagesDir(root), image.fileName);
  if (!fs.existsSync(archiveAbs)) throw notFound();

  const stop = opts.control?.stop || defaultStop;
  const start = opts.control?.start || defaultStart;

  await stop(desk.container);
  try {
    await restoreVolume({ run: opts.run, volume: desk.volume, archiveAbs });
  } finally {
    await start(desk.container);
  }
  return image;
}

/** Adapter: vm.docker → @sub8/desk-images DockerRun. */
export function dockerRunner(timeout = 120_000): DockerRun {
  return async (argv) => {
    const r = await docker(argv, { timeout });
    return { ok: r.ok, out: r.out || "", err: r.out || "" };
  };
}
