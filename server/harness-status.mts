import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeBin, codexBin, cursorBin, hermesBin, hostEnv, parseCursorModels, whichCmd } from "./host-cli.mjs";
import { detectLocalHarnesses } from "./local-llm.mjs";
import { hostHasGrokAuth } from "./vm.mjs";
import { applyAuthAlert, parseClaudeAuthStatus } from "@sub8/harness-auth";
import type { HarnessRow } from "@sub8/harness-auth";
import type { HarnessProbe, LocalHarnesses } from "./local-llm.mjs";

/** One entry of the Settings → Harness picker. The hosted providers have
 *  nothing to install, so `installUrl` is absent for them. */
export interface HarnessCatalogEntry {
  id: string;
  label: string;
  kind: "cli-host" | "openai-local" | "openai";
  installUrl?: string;
}

/**
 * A row once applyAuthAlert has looked at it. Its declared return widens to
 * null | undefined for a null input row, and every builder below hands it an
 * object literal that always carries an id — so the row always comes back and
 * always has one. That is what the `as StatusRow` on each return records, and
 * why `id` is required here while HarnessRow leaves it optional.
 */
export interface StatusRow extends HarnessRow {
  id: string;
}

/** Only the settings fields this module reads. The real record is far wider. */
export interface HarnessStatusSettings {
  harness?:
    | {
        provider?: string | undefined;
        model?: string | undefined;
        apiKey?: string | undefined;
        baseUrl?: string | undefined;
      }
    | undefined;
}

/** What collectHarnessStatus hands the Settings → Harness tab. */
export interface HarnessStatusReport {
  defaultProvider: string;
  catalog: readonly HarnessCatalogEntry[];
  harnesses: Record<string, StatusRow>;
  local: LocalHarnesses;
}

/** One `run()` result: the merged stdout+stderr and why it failed, if it did. */
interface RunResult {
  ok: boolean;
  out: string;
  error: string | null;
}

export const HARNESS_CATALOG: readonly HarnessCatalogEntry[] = [
  { id: "grok-build", label: "Grok Build", kind: "cli-host", installUrl: "https://x.ai/cli" },
  { id: "hermes", label: "Hermes", kind: "cli-host", installUrl: "https://hermes-agent.nousresearch.com" },
  { id: "claude", label: "Claude", kind: "cli-host", installUrl: "https://code.claude.com/docs/en/setup" },
  { id: "codex", label: "Codex", kind: "cli-host", installUrl: "https://github.com/openai/codex" },
  { id: "cursor", label: "Cursor", kind: "cli-host", installUrl: "https://cursor.com/docs/cli/overview" },
  { id: "ollama", label: "Ollama", kind: "openai-local", installUrl: "https://ollama.com/download" },
  { id: "lmstudio", label: "LM Studio", kind: "openai-local", installUrl: "https://lmstudio.ai" },
  { id: "spacexai", label: "SpaceXAI", kind: "openai" },
  { id: "openrouter", label: "OpenRouter", kind: "openai" },
  { id: "openai", label: "OpenAI", kind: "openai" },
  { id: "custom", label: "Custom API", kind: "openai" },
];

function exists(p: string | undefined): boolean {
  try {
    return Boolean(p && fsSync.existsSync(p));
  } catch {
    return false;
  }
}

function resolveBin(name: string, guessed?: string): string {
  const p = guessed || whichCmd(name);
  // This was three branches. The first tested `p.includes(path.sep)` as well,
  // which the second subsumes — anything matching the first matched the second.
  // The third was then only reachable when `!p || !exists(p)`, so it always
  // returned "". exists() already guards `Boolean(p && ...)`, so it is total and
  // false for "" and undefined; the whole thing reduces to this.
  return exists(p) ? p : "";
}

function run(bin: string, args: readonly string[], { timeout = 12_000 }: { timeout?: number } = {}): Promise<RunResult> {
  return new Promise<RunResult>((resolve) => {
    if (!bin) return resolve({ ok: false, out: "", error: "not installed" });
    const child = spawn(bin, args, { env: hostEnv(), stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const t = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }, timeout);
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (out += d.toString()));
    child.on("error", (e) => {
      clearTimeout(t);
      resolve({ ok: false, out, error: e.message });
    });
    child.on("close", (code) => {
      clearTimeout(t);
      resolve({ ok: code === 0, out: out.trim(), error: code === 0 ? null : `exit ${code}` });
    });
  });
}

/**
 * The parsed file, or null when it is missing or malformed. The caller names the
 * shape it expects — every one of them reads a config file it wrote itself.
 */
async function readJson<T = unknown>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function readText(file: string): Promise<string> {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return "";
  }
}

function yamlScalar(src: string, key: string): string {
  const re = new RegExp(`(?:^|\\n)\\s*${key}:\\s*["']?([^\\n#]+)`, "i");
  const m = String(src || "").match(re);
  // The one capture group is not optional, so a match always has [1].
  return m ? m[1]!.trim().replace(/^["']|["']$/g, "") : "";
}

/** One row of ~/.codex/models_cache.json, as much of it as the ranking reads. */
interface CodexModelEntry {
  slug?: unknown;
  id?: unknown;
  visibility?: unknown;
  priority?: unknown;
}

/**
 * The cache file. Older Codex builds wrote the bare array instead of wrapping it
 * in `models`, which is why the body accepts either — `Array.isArray(payload)`
 * is the branch that reads it.
 */
interface CodexCatalogPayload {
  models?: unknown;
}

export function parseCodexModelCatalog(
  payload: CodexCatalogPayload | null | undefined,
  { current = "", includeHidden = false }: { current?: string; includeHidden?: boolean } = {},
): string[] {
  const models: CodexModelEntry[] = Array.isArray(payload?.models) ? payload.models : Array.isArray(payload) ? payload : [];
  const ranked: Array<{ slug: string; priority: number }> = [];
  for (const m of models) {
    const slug = String(m?.slug || m?.id || "").trim();
    if (!slug) continue;
    const vis = String(m?.visibility || "list").toLowerCase();
    if (!includeHidden && vis === "hide") continue;
    ranked.push({ slug, priority: Number(m?.priority) || 999 });
  }
  ranked.sort((a, b) => a.priority - b.priority || a.slug.localeCompare(b.slug));
  return [...new Set([current, ...ranked.map((m) => m.slug)].filter(Boolean))];
}

export async function listCodexModels(): Promise<string[]> {
  const home = path.join(os.homedir(), ".codex");
  const cfg = await readText(path.join(home, "config.toml"));
  const current = yamlScalar(cfg, "model") || "";
  const cache = await readJson<CodexCatalogPayload>(path.join(home, "models_cache.json"));
  const fromCache = parseCodexModelCatalog(cache, { current });
  if (fromCache.length) return fromCache;
  return parseCodexModelCatalog(
    {
      models: [
        { slug: "gpt-5.6-sol", visibility: "list", priority: 1 },
        { slug: "gpt-5.6-terra", visibility: "list", priority: 2 },
        { slug: "gpt-5.6-luna", visibility: "list", priority: 3 },
        { slug: "gpt-5.5", visibility: "list", priority: 7 },
        { slug: "gpt-5.2", visibility: "list", priority: 29 },
      ],
    },
    { current },
  );
}

async function grokStatus(): Promise<StatusRow> {
  const bin = resolveBin("grok", whichCmd("grok", [path.join(os.homedir(), ".grok", "bin", "grok")]));
  const signedIn = await hostHasGrokAuth();
  return applyAuthAlert({
    id: "grok-build",
    label: "Grok Build",
    kind: "cli-host",
    installed: Boolean(bin),
    binary: bin || "grok",
    version: "",
    signedIn,
    ready: signedIn,
    model: "grok-4.6",
    detail: signedIn
      ? "Grok CLI on this Mac. It drives the Bot computer through Sub8 tools."
      : "Not signed in on this Mac. Grok Build needs a browser login once.",
    hint: signedIn ? "" : "Sign in with Grok in Settings, or run grok login --oauth.",
    liveAuth: signedIn,
  }) as StatusRow;
}

/** ~/.hermes/auth.json: the portal logins and the API-key pool, nothing else. */
interface HermesAuth {
  providers?: Record<string, unknown> | undefined;
  credential_pool?: Record<string, unknown> | undefined;
}

async function hermesStatus(): Promise<StatusRow> {
  const bin = resolveBin("hermes", hermesBin());
  const home = path.join(os.homedir(), ".hermes");
  const cfg = await readText(path.join(home, "config.yaml"));
  const auth = await readJson<HermesAuth>(path.join(home, "auth.json"));
  const model = yamlScalar(cfg, "default") || yamlScalar(cfg, "model") || "";
  const provider = yamlScalar(cfg, "provider") || "";
  const baseUrl = yamlScalar(cfg, "base_url") || "";
  const portal = Boolean(auth?.providers?.nous || auth?.providers?.["nous-portal"]);
  const pool = auth?.credential_pool && typeof auth.credential_pool === "object" ? Object.keys(auth.credential_pool) : [];
  const hasKey = pool.length > 0;
  const localOk = /lmstudio|ollama/i.test(provider);
  let version = "";
  if (bin) {
    const v = await run(bin, ["version"], { timeout: 8_000 });
    const m = v.out.match(/Hermes Agent v?([\d.]+)/i);
    // Same as yamlScalar: the single capture group is required, so [1] is there.
    version = m ? m[1]! : (v.out.split("\n")[0] || "").slice(0, 80);
  }
  const signedIn = portal;
  const ready = Boolean(bin) && (portal || hasKey || (localOk && Boolean(cfg)));
  let detail = "Nous Research CLI on this Mac.";
  if (!bin) detail = "Hermes is not installed. Install from hermes-agent.nousresearch.com.";
  else if (portal) detail = `Signed in to Nous Portal · ${provider || "nous"} · ${model || "default"}`;
  else if (localOk) detail = `Using ${provider}${model ? ` · ${model}` : ""}${baseUrl ? ` · ${baseUrl}` : ""}. Not signed in to Nous Portal.`;
  else if (hasKey) detail = `API key configured${provider ? ` for ${provider}` : ""}${model ? ` · ${model}` : ""}.`;
  else detail = "Installed, but no provider login or API key yet. Run hermes setup or hermes model.";
  return applyAuthAlert({
    id: "hermes",
    label: "Hermes",
    kind: "cli-host",
    installed: Boolean(bin),
    binary: bin || "hermes",
    version,
    signedIn,
    ready,
    model,
    extra: { hermesProvider: provider, hermesBaseUrl: baseUrl, portal, keys: pool },
    detail,
    hint: ready ? "" : "Install Hermes, then run hermes setup --portal or hermes model.",
    liveAuth: portal,
  }) as StatusRow;
}

async function claudeStatus(): Promise<StatusRow> {
  const bin = resolveBin("claude", claudeBin());
  let signedIn = false;
  let email = "";
  let expired = false;
  let version = "";
  if (bin) {
    const [auth, text] = await Promise.all([
      run(bin, ["auth", "status"], { timeout: 10_000 }),
      run(bin, ["auth", "status", "--text"], { timeout: 10_000 }),
    ]);
    const parsed = parseClaudeAuthStatus(`${auth.out}\n${text.out}`);
    signedIn = parsed.signedIn;
    email = parsed.email;
    expired = parsed.expired;
    const v = await run(bin, ["--version"], { timeout: 6_000 });
    version = (v.out.split("\n")[0] || "").slice(0, 80);
  }
  return applyAuthAlert({
    id: "claude",
    label: "Claude",
    kind: "cli-host",
    installed: Boolean(bin),
    binary: bin || "claude",
    version,
    signedIn,
    ready: Boolean(bin) && signedIn,
    expired,
    model: "",
    extra: { email },
    liveAuth: signedIn,
    detail: !bin
      ? "Claude Code is not installed on this Mac."
      : signedIn
        ? `Signed in${email ? ` as ${email}` : ""} with Claude Code.`
        : expired && email
          ? `Session expired. Sign in again (last account: ${email}).`
          : "Claude Code is installed but not signed in.",
    hint: signedIn ? "" : "Open Settings → Harness → Claude, or in a terminal: claude auth login",
  }) as StatusRow;
}

async function codexStatus(): Promise<StatusRow> {
  const bin = resolveBin("codex", codexBin());
  const authPath = path.join(os.homedir(), ".codex", "auth.json");
  const auth = await readJson<Record<string, unknown>>(authPath);
  const signedIn = Boolean(auth && typeof auth === "object" && Object.keys(auth).length);
  let version = "";
  if (bin) {
    const v = await run(bin, ["--version"], { timeout: 6_000 });
    version = (v.out.split("\n")[0] || "").slice(0, 80);
  }
  const models = await listCodexModels();
  return applyAuthAlert({
    id: "codex",
    label: "Codex",
    kind: "cli-host",
    installed: Boolean(bin),
    binary: bin || "codex",
    version,
    signedIn,
    ready: Boolean(bin) && signedIn,
    model: models[0] || "",
    extra: { models },
    detail: !bin
      ? "Codex CLI is not installed on this Mac."
      : signedIn
        ? "Signed in. Codex uses this Mac’s login and only drives the Bot computer."
        : "Codex is installed but has no auth.json login.",
    hint: signedIn ? "" : "In a terminal: codex login",
  }) as StatusRow;
}

async function cursorStatus(): Promise<StatusRow> {
  const bin = resolveBin("cursor-agent", cursorBin());
  let signedIn = false;
  let email = "";
  let version = "";
  let models: string[] = [];
  if (bin) {
    const [who, v, listed] = await Promise.all([
      run(bin, ["status"], { timeout: 12_000 }),
      run(bin, ["--version"], { timeout: 6_000 }),
      run(bin, ["models"], { timeout: 20_000 }),
    ]);
    signedIn = /logged in as/i.test(who.out) && !/not logged/i.test(who.out);
    email = (who.out.match(/logged in as\s+(\S+)/i) || [])[1] || "";
    version = (v.out.split("\n")[0] || "").slice(0, 80);
    models = parseCursorModels(listed.out);
  }
  return applyAuthAlert({
    id: "cursor",
    label: "Cursor",
    kind: "cli-host",
    installed: Boolean(bin),
    binary: bin || "cursor-agent",
    version,
    signedIn,
    ready: Boolean(bin) && signedIn,
    model: models.includes("cursor-grok-4.6-low") ? "cursor-grok-4.6-low" : models[0] || "",
    extra: { email, models },
    liveAuth: signedIn,
    detail: !bin
      ? "Cursor CLI (cursor-agent) is not installed on this Mac."
      : signedIn
        ? `Signed in${email ? ` as ${email}` : ""} with Cursor CLI. It drives the Bot computer through Sub8 tools.`
        : "Cursor CLI is installed but not signed in.",
    hint: signedIn ? "" : "In a terminal: cursor-agent login",
  }) as StatusRow;
}

/**
 * A local-harness probe as this row reads it. Every field is optional because
 * the fallback below is a bare `{ ok: false, ... }` with no `installed`, and
 * because a probe that never ran hands back nothing at all.
 */
interface LocalDetected {
  ok?: boolean | undefined;
  installed?: boolean | undefined;
  models?: string[] | undefined;
  baseUrl?: string | undefined;
  error?: string | undefined;
}

async function localStatus(id: string, label: string, detected: HarnessProbe | undefined): Promise<StatusRow> {
  const d: LocalDetected = detected || { ok: false, models: [], baseUrl: "", error: "" };
  return applyAuthAlert({
    id,
    label,
    kind: "openai-local",
    installed: Boolean(d.ok || d.installed),
    binary: d.baseUrl || "",
    version: "",
    signedIn: Boolean(d.ok),
    ready: Boolean(d.ok && (d.models || []).length),
    model: (d.models || [])[0] || "",
    extra: { models: d.models || [], baseUrl: d.baseUrl || "" },
    detail: d.ok
      ? `Running at ${d.baseUrl} · ${(d.models || []).length} model${(d.models || []).length === 1 ? "" : "s"}.`
      : d.error || `${label} is not running.`,
    hint: d.ok ? "" : `Start ${label}, then Refresh.`,
    liveAuth: Boolean(d.ok),
  }) as StatusRow;
}

async function spacexStatus(settings: HarnessStatusSettings): Promise<StatusRow> {
  const key = Boolean((settings?.harness?.apiKey && settings.harness.apiKey !== "••••") || process.env.XAI_API_KEY);
  return applyAuthAlert({
    id: "spacexai",
    label: "SpaceXAI",
    kind: "openai",
    installed: true,
    binary: settings?.harness?.baseUrl || "https://api.x.ai/v1",
    version: "",
    signedIn: key,
    ready: key,
    model: settings?.harness?.model || "grok-4.6",
    detail: key ? "API key is set (Settings or XAI_API_KEY)." : "No API key. Paste one here or set XAI_API_KEY.",
    hint: key ? "" : "Add an xAI key in this tab.",
    liveAuth: key,
  }) as StatusRow;
}

export async function collectHarnessStatus(settings: HarnessStatusSettings = {}): Promise<HarnessStatusReport> {
  const local = await detectLocalHarnesses({ force: true });
  const rows = await Promise.all([
    grokStatus(),
    hermesStatus(),
    claudeStatus(),
    codexStatus(),
    cursorStatus(),
    localStatus("ollama", "Ollama", local.ollama),
    localStatus("lmstudio", "LM Studio", local.lmstudio),
    spacexStatus(settings),
  ]);
  const byId = Object.fromEntries(rows.map((r) => [r.id, r] as const));
  return {
    defaultProvider: settings?.harness?.provider || "grok-build",
    catalog: HARNESS_CATALOG,
    harnesses: byId,
    local,
  };
}
