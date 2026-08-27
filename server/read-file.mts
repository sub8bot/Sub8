/**
 * Structured Read (box files under /config) + WebFetch helpers.
 *
 * MCP (B4 or later) registers `read` / `web_fetch`. Do not add TOOLS here —
 * that would collide with tools-catalog.mjs.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isHostPath } from "./isolation.mjs";
import { webFetch, assertPublicHttpUrl, htmlToMarkdown } from "@sub8/web-fetch";

export { webFetch, assertPublicHttpUrl, htmlToMarkdown };

const CONFIG_ROOT = "/config";
const orchHref = new URL("../packages/orchestration/dist/code-agent.js", import.meta.url);
const orch = existsSync(fileURLToPath(orchHref)) ? await import(orchHref.href) : null;

/** The bot fields this module reads. Callers pass the whole bot record. */
export interface ReadFileBot {
  id?: string | undefined;
  vm?: { container?: string | undefined } | undefined;
}

/**
 * A test's injected file table: either a Map-like (has/get) or a plain object.
 * Kept structural because `lookupFiles` sniffs for the methods at runtime and
 * falls back to hasOwnProperty, which is exactly what the type says.
 */
export interface FileLookup {
  has?: unknown;
  get?: unknown;
  [key: string]: unknown;
}

export interface LoadTextOptions {
  bot?: ReadFileBot | undefined;
  files?: FileLookup | undefined;
  readText?: ((dest: string) => unknown) | undefined;
}

export interface ReadFileOptions extends LoadTextOptions {
  path?: string | undefined;
}

export const IMAGE_EXTS = Object.freeze([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".tif", ".tiff", ".heic", ".avif", ".svg"]);
export const PDF_EXTS = Object.freeze([".pdf"]);

function extOf(p: unknown): string {
  const base = path.posix.basename(String(p || ""));
  const i = base.lastIndexOf(".");
  return i >= 0 ? base.slice(i).toLowerCase() : "";
}

export function isImagePath(p: unknown): boolean {
  return IMAGE_EXTS.includes(extOf(p));
}

export function isPdfPath(p: unknown): boolean {
  return PDF_EXTS.includes(extOf(p));
}

function agentRoot(bot: ReadFileBot | null | undefined): string {
  const id = String(bot?.id || "").trim();
  return id ? `/config/agent-data/agents/${id}` : CONFIG_ROOT;
}

function assertUnderConfig(abs: unknown): string {
  const raw = String(abs ?? "").trim();
  if (isHostPath(raw) || raw === "/Users" || raw.startsWith("/Users/")) {
    throw new Error("path must be under /config");
  }
  if (!raw.startsWith("/")) throw new Error("path must be under /config");
  const n = path.posix.normalize(raw);
  if (n.includes("..") || n === "/" || n === CONFIG_ROOT) throw new Error("invalid path");
  if (isHostPath(n) || n === "/Users" || n.startsWith("/Users/")) {
    throw new Error("path must be under /config");
  }
  if (orch?.assertCodeAgentCwd) {
    try {
      orch.assertCodeAgentCwd(n);
    } catch {
      throw new Error("path must be under /config");
    }
  } else if (!n.startsWith(`${CONFIG_ROOT}/`)) {
    throw new Error("path must be under /config");
  }
  return n;
}

/**
 * Resolve a box path under `/config`. Relative paths join `/config`, or the
 * agent folder when `bot` is passed (same idea as memory.resolveMemoryPath).
 * Host `/Users` paths are rejected.
 */
export function resolveReadPath(raw: unknown, { bot }: { bot?: ReadFileBot | undefined } = {}): string {
  const p = String(raw ?? "").trim();
  if (!p) throw new Error("path required");
  if (isHostPath(p) || p === "/Users" || p.startsWith("/Users/")) {
    throw new Error("path must be under /config");
  }
  const abs = p.startsWith("/") ? p : path.posix.join(bot?.id ? agentRoot(bot) : CONFIG_ROOT, p);
  return assertUnderConfig(abs);
}

function lookupFiles(files: FileLookup | null | undefined, dest: string): { hit: boolean; value: unknown } {
  if (!files) return { hit: false, value: undefined };
  if (typeof files.has === "function" && typeof files.get === "function") {
    if (files.has(dest)) return { hit: true, value: files.get(dest) };
    return { hit: false, value: undefined };
  }
  if (Object.prototype.hasOwnProperty.call(files, dest)) return { hit: true, value: files[dest] };
  return { hit: false, value: undefined };
}

async function loadText(dest: string, { bot, files, readText }: LoadTextOptions = {}): Promise<string> {
  if (typeof readText === "function") {
    const got = await readText(dest);
    if (got == null) throw new Error(`file not found: ${dest}`);
    return String(got);
  }
  if (files) {
    const { hit, value } = lookupFiles(files, dest);
    if (!hit) throw new Error(`file not found: ${dest}`);
    if (Buffer.isBuffer(value)) return value.toString("utf8");
    return String(value ?? "");
  }
  const container = bot?.vm?.container;
  if (!container) throw new Error("read requires files, readText, or a running computer");
  const vm = await import("./vm.mjs");
  return String((await vm.readFileFromContainer(container, dest)) ?? "");
}

export interface ReadFileResult {
  kind: "image" | "pdf" | "text";
  path: string;
  text?: string;
}

/**
 * Structured read of a box file. Images (and PDFs) return a stub; text is utf8.
 * Inject `files` or `readText` in tests. MCP later passes `{ bot, path }`.
 */
export async function readFile(pathOrOpts: string | ReadFileOptions, maybeOpts?: ReadFileOptions): Promise<ReadFileResult> {
  const opts: ReadFileOptions = typeof pathOrOpts === "string" ? { path: pathOrOpts, ...(maybeOpts || {}) } : { ...(pathOrOpts || {}) };
  const dest = resolveReadPath(opts.path, { bot: opts.bot });
  if (isImagePath(dest)) return { kind: "image", path: dest };
  if (isPdfPath(dest)) return { kind: "pdf", path: dest };
  const text = await loadText(dest, opts);
  return { kind: "text", path: dest, text };
}
