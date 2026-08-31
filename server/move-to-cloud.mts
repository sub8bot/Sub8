import { execFileSync } from "node:child_process";
import path from "node:path";

const SKIP = /chrome|Cache|Singleton|IndexedDB|node_modules|\.grok\//i;
const NOTE = /\.(md|txt|json|jsonl)$/i;

/** Files from a local /config tarball that are small enough to copy via desk-action shell. */
export function pickMoveEntries(entries: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of entries) {
    const n = String(raw || "").replace(/^\.\//, "").replace(/\\/g, "/");
    if (!n || n.endsWith("/")) continue;
    if (n.includes("..") || n.startsWith("/")) continue;
    if (SKIP.test(n)) continue;
    if (/MOVE-MARKER/i.test(n) || n.startsWith("Desktop/") || n.startsWith("Desktop\\")) {
      out.push(n);
    } else if (NOTE.test(n) && (!n.includes("/") || n.startsWith("agent-data/") || n.startsWith("workspace/"))) {
      out.push(n);
    }
    if (out.length >= 96) break;
  }
  return out;
}

export function remapMovePath(entry: string, fromBotId?: string | undefined, toBotId?: string | undefined): string {
  const n = String(entry || "").replace(/^\.\//, "").replace(/\\/g, "/");
  const from = String(fromBotId || "");
  const to = String(toBotId || "");
  if (!from || !to || from === to) return n;
  return n.split(from).join(to);
}

export function remapMoveBody(body: Buffer, fromBotId?: string | undefined, toBotId?: string | undefined): Buffer {
  const from = String(fromBotId || "");
  const to = String(toBotId || "");
  if (!from || !to || from === to || !body.includes(from)) return body;
  return Buffer.from(body.toString("utf8").split(from).join(to));
}

export type MoveCopyOpts = {
  fromBotId?: string | undefined;
  toBotId?: string | undefined;
};

export function personalNameFromNotes(text: string): string {
  const m = String(text || "").match(/Personal name:\s*(.+)/i);
  return (m?.[1] || "").trim();
}

export function identityStamp({ handle, personalName }: { handle: string; personalName?: string | undefined }): string {
  const bot = String(handle || "Bot").trim() || "Bot";
  const name = String(personalName || "").trim();
  const lines = ["", "## Identity (moved from Local)", `- Bot handle: ${bot}`];
  if (name) {
    lines.push(`- Personal name: ${name}`);
    lines.push(`If asked your name, answer ${name}.`);
  }
  return `${lines.join("\n")}\n`;
}

export function stampAgentsMdShell(note: string): string {
  const b64 = Buffer.from(note).toString("base64");
  return `mkdir -p /config /config/.grok; touch /config/AGENTS.md /config/.grok/AGENTS.md; for f in /config/AGENTS.md /config/.grok/AGENTS.md; do grep -q "moved from Local" "$f" 2>/dev/null || echo ${b64} | base64 -d >> "$f"; done`;
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
  opts: MoveCopyOpts = {},
): Promise<{ count: number; personalName: string }> {
  const files = filesToCopyFromArchive(archiveAbs, opts);
  for (const file of files) {
    const out = await runShell(shellWriteFile(file.dest, file.body));
    if (out && out.ok === false) throw new Error(out.text || `copy ${file.dest} failed`);
  }
  const profile = files.find((f) => /memory\/profile\.md$/.test(f.dest));
  return { count: files.length, personalName: personalNameFromNotes(profile?.body.toString("utf8") || "") };
}

export function filesToCopyFromArchive(archiveAbs: string, opts: MoveCopyOpts = {}): Array<{ dest: string; body: Buffer }> {
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
    const dest = destInConfig(remapMovePath(entry, opts.fromBotId, opts.toBotId));
    files.push({ dest, body: remapMoveBody(body, opts.fromBotId, opts.toBotId) });
  }
  return files;
}
