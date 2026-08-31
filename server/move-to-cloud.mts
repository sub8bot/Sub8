import { execFileSync } from "node:child_process";
import path from "node:path";

/** Files from a local /config tarball that are small enough to copy via desk-action shell. */
export function pickMoveEntries(entries: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of entries) {
    const n = String(raw || "").replace(/^\.\//, "").replace(/\\/g, "/");
    if (!n || n.endsWith("/")) continue;
    if (n.includes("..") || n.startsWith("/")) continue;
    if (/chrome|Cache|Singleton|IndexedDB|node_modules|\.grok\//i.test(n)) continue;
    if (/MOVE-MARKER/i.test(n) || n.startsWith("Desktop/") || n.startsWith("Desktop\\")) {
      out.push(n);
      continue;
    }
    if (/\.(txt|md)$/i.test(n) && !n.includes("/")) out.push(n);
    if (out.length >= 64) break;
  }
  return out;
}

export function destInConfig(entry: string): string {
  const n = String(entry || "").replace(/^\.\//, "").replace(/\\/g, "/");
  return path.posix.join("/config", n);
}

export function shellWriteFile(dest: string, content: string | Buffer): string {
  const dir = path.posix.dirname(dest);
  const b64 = Buffer.from(content).toString("base64");
  return `mkdir -p ${JSON.stringify(dir)} && echo ${b64} | base64 -d > ${JSON.stringify(dest)}`;
}

export function listTarEntries(archiveAbs: string): string[] {
  const out = execFileSync("tar", ["-tzf", archiveAbs], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  return String(out || "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function extractTarFile(archiveAbs: string, entry: string): Buffer {
  return execFileSync("tar", ["-xOf", archiveAbs, entry], { maxBuffer: 2 * 1024 * 1024 });
}

export async function copyArchiveToDesk(
  archiveAbs: string,
  runShell: (cmd: string) => Promise<{ ok?: boolean; text?: string }>,
): Promise<number> {
  const files = filesToCopyFromArchive(archiveAbs);
  for (const file of files) {
    const out = await runShell(shellWriteFile(file.dest, file.body));
    if (out && out.ok === false) throw new Error(out.text || `copy ${file.dest} failed`);
  }
  return files.length;
}

export function filesToCopyFromArchive(archiveAbs: string): Array<{ dest: string; body: Buffer }> {
  const picked = pickMoveEntries(listTarEntries(archiveAbs));
  const files: Array<{ dest: string; body: Buffer }> = [];
  let total = 0;
  for (const entry of picked) {
    let body: Buffer;
    try {
      body = extractTarFile(archiveAbs, entry);
    } catch {
      try {
        body = extractTarFile(archiveAbs, `./${entry}`);
      } catch {
        continue;
      }
    }
    if (body.length > 64 * 1024) continue;
    total += body.length;
    if (total > 512 * 1024) break;
    files.push({ dest: destInConfig(entry), body });
  }
  return files;
}
