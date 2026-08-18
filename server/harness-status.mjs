import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeBin, codexBin, hermesBin, hostEnv, whichCmd } from "./host-cli.mjs";
import { detectLocalHarnesses } from "./local-llm.mjs";
import { hostHasGrokAuth } from "./vm.mjs";

export const HARNESS_CATALOG = [
  { id: "grok-build", label: "Grok Build", kind: "cli-host" },
  { id: "hermes", label: "Hermes", kind: "cli-host" },
  { id: "claude", label: "Claude", kind: "cli-host" },
  { id: "codex", label: "Codex", kind: "cli-host" },
  { id: "ollama", label: "Ollama", kind: "openai-local" },
  { id: "lmstudio", label: "LM Studio", kind: "openai-local" },
  { id: "spacexai", label: "SpaceXAI", kind: "openai" },
];

function exists(p) {
  try {
    return Boolean(p && fsSync.existsSync(p));
  } catch {
    return false;
  }
}

function resolveBin(name, guessed) {
  const p = guessed || whichCmd(name);
  if (p && p.includes(path.sep) && exists(p)) return p;
  if (p && exists(p)) return p;
  return exists(p) ? p : "";
}

function run(bin, args, { timeout = 12_000 } = {}) {
  return new Promise((resolve) => {
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
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (out += d.toString()));
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

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function readText(file) {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return "";
  }
}

function yamlScalar(src, key) {
  const re = new RegExp(`(?:^|\\n)\\s*${key}:\\s*["']?([^\\n#]+)`, "i");
  const m = String(src || "").match(re);
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
}

async function grokStatus() {
  const bin = resolveBin("grok", whichCmd("grok", [path.join(os.homedir(), ".grok", "bin", "grok")]));
  const signedIn = await hostHasGrokAuth();
  return {
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
  };
}

async function hermesStatus() {
  const bin = resolveBin("hermes", hermesBin());
  const home = path.join(os.homedir(), ".hermes");
  const cfg = await readText(path.join(home, "config.yaml"));
  const auth = await readJson(path.join(home, "auth.json"));
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
    version = m ? m[1] : (v.out.split("\n")[0] || "").slice(0, 80);
  }
  const signedIn = portal;
  const ready = Boolean(bin) && (portal || hasKey || (localOk && Boolean(cfg)));
  let detail = "Nous Research CLI on this Mac.";
  if (!bin) detail = "Hermes is not installed. Install from hermes-agent.nousresearch.com.";
  else if (portal) detail = `Signed in to Nous Portal · ${provider || "nous"} · ${model || "default"}`;
  else if (localOk) detail = `Using ${provider}${model ? ` · ${model}` : ""}${baseUrl ? ` · ${baseUrl}` : ""}. Not signed in to Nous Portal.`;
  else if (hasKey) detail = `API key configured${provider ? ` for ${provider}` : ""}${model ? ` · ${model}` : ""}.`;
  else detail = "Installed, but no provider login or API key yet. Run hermes setup or hermes model.";
  return {
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
  };
}

async function claudeStatus() {
  const bin = resolveBin("claude", claudeBin());
  let signedIn = false;
  let email = "";
  let version = "";
  if (bin) {
    const auth = await run(bin, ["auth", "status"], { timeout: 10_000 });
    try {
      const j = JSON.parse(auth.out.replace(/^[\s\S]*?(\{)/, "{"));
      signedIn = Boolean(j.loggedIn);
      email = j.email || "";
    } catch {
      signedIn = /loggedIn["']?\s*:\s*true/i.test(auth.out);
    }
    const v = await run(bin, ["--version"], { timeout: 6_000 });
    version = (v.out.split("\n")[0] || "").slice(0, 80);
  }
  return {
    id: "claude",
    label: "Claude",
    kind: "cli-host",
    installed: Boolean(bin),
    binary: bin || "claude",
    version,
    signedIn,
    ready: Boolean(bin) && signedIn,
    model: "",
    extra: { email },
    detail: !bin
      ? "Claude Code is not installed on this Mac."
      : signedIn
        ? `Signed in${email ? ` as ${email}` : ""} with Claude Code.`
        : "Claude Code is installed but not signed in.",
    hint: signedIn ? "" : "In a terminal: claude  (then /login)",
  };
}

async function codexStatus() {
  const bin = resolveBin("codex", codexBin());
  const authPath = path.join(os.homedir(), ".codex", "auth.json");
  const auth = await readJson(authPath);
  const signedIn = Boolean(auth && typeof auth === "object" && Object.keys(auth).length);
  let version = "";
  if (bin) {
    const v = await run(bin, ["--version"], { timeout: 6_000 });
    version = (v.out.split("\n")[0] || "").slice(0, 80);
  }
  return {
    id: "codex",
    label: "Codex",
    kind: "cli-host",
    installed: Boolean(bin),
    binary: bin || "codex",
    version,
    signedIn,
    ready: Boolean(bin) && signedIn,
    model: "",
    detail: !bin
      ? "Codex CLI is not installed on this Mac."
      : signedIn
        ? "Signed in. Codex uses this Mac’s login and only drives the Bot computer."
        : "Codex is installed but has no auth.json login.",
    hint: signedIn ? "" : "In a terminal: codex login",
  };
}

async function localStatus(id, label, detected) {
  const d = detected || { ok: false, models: [], baseUrl: "", error: "" };
  return {
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
  };
}

async function spacexStatus(settings) {
  const key = Boolean((settings?.harness?.apiKey && settings.harness.apiKey !== "••••") || process.env.XAI_API_KEY);
  return {
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
  };
}

export async function collectHarnessStatus(settings = {}) {
  const local = await detectLocalHarnesses({ force: true });
  const rows = await Promise.all([
    grokStatus(),
    hermesStatus(),
    claudeStatus(),
    codexStatus(),
    localStatus("ollama", "Ollama", local.ollama),
    localStatus("lmstudio", "LM Studio", local.lmstudio),
    spacexStatus(settings),
  ]);
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  return {
    defaultProvider: settings?.harness?.provider || "grok-build",
    catalog: HARNESS_CATALOG,
    harnesses: byId,
    local,
  };
}
