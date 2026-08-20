import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { appRoot, dataDir } from "./paths.mjs";
import * as vault from "./vault.mjs";
import * as ctx from "./context.mjs";
import * as memory from "./memory.mjs";

export function extraPath() {
  const home = process.env.HOME || os.homedir() || "";
  const extras = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    path.join(home, ".local", "bin"),
    path.join(home, ".docker", "bin"),
  ];
  return extras.filter((p) => fsSync.existsSync(p)).join(path.delimiter);
}

export function whichCmd(name, extra = []) {
  const home = process.env.HOME || os.homedir() || "";
  const candidates = [
    ...extra,
    path.join(home, ".local", "bin", name),
    `/opt/homebrew/bin/${name}`,
    `/usr/local/bin/${name}`,
  ];
  for (const p of candidates) {
    if (p && fsSync.existsSync(p)) return p;
  }
  return name;
}

export function claudeBin() {
  return whichCmd("claude");
}

export function codexBin() {
  return whichCmd("codex");
}

export function hermesBin() {
  const home = process.env.HOME || os.homedir() || "";
  return whichCmd("hermes", [path.join(home, ".hermes", "hermes-agent", "venv", "bin", "hermes")]);
}

export function grokBin() {
  const home = process.env.HOME || os.homedir() || "";
  return whichCmd("grok", [path.join(home, ".grok", "bin", "grok")]);
}

export function hermesConfigPath() {
  return path.join(os.homedir(), ".hermes", "config.yaml");
}

const HERMES_MIN_CTX = 131072;
/** Isolated Sub8 ACP home: Hermes Agent requires >= 64k. Do not use 128k. */
export const HERMES_SUB8_CTX = 65536;

export function withHermesContextLength(cfg, n = HERMES_MIN_CTX) {
  let out = String(cfg || "");
  if (!/(?:^|\n)model:\s*\n/.test(out)) {
    out = `model:\n  context_length: ${n}\n  provider: lmstudio\n  base_url: http://127.0.0.1:1234/v1\n` + out;
  } else if (/(?:^|\n)model:\s*\n(?:  .+\n)*?  context_length:\s*/.test(out)) {
    out = out.replace(/((?:^|\n)model:\s*\n(?:  .+\n)*?  context_length:\s*)\d+/, `$1${n}`);
  } else {
    out = out.replace(/((?:^|\n)model:\s*\n)/, `$1  context_length: ${n}\n`);
  }
  // Oneshoot / isolated HERMES_HOME re-probes LM Studio and sees ~4k.
  // The CLI has a cache; this is the override Hermes documents.
  if (/(?:^|\n)auxiliary:\s*\n[\s\S]*?\n  compression:\s*\n[\s\S]*?\n    context_length:\s*\d+/.test(out)) {
    out = out.replace(/((?:^|\n)  compression:\s*\n(?:    .+\n)*?    context_length:\s*)\d+/, `$1${n}`);
  } else if (/(?:^|\n)  compression:\s*\n/.test(out) && /(?:^|\n)auxiliary:\s*\n/.test(out)) {
    out = out.replace(/((?:^|\n)  compression:\s*\n)/, `$1    context_length: ${n}\n`);
  } else if (/(?:^|\n)auxiliary:\s*\n/.test(out)) {
    out = out.replace(
      /((?:^|\n)auxiliary:\s*\n)/,
      `$1  compression:\n    context_length: ${n}\n    provider: auto\n    model: ''\n`,
    );
  } else {
    out += `\nauxiliary:\n  compression:\n    context_length: ${n}\n    provider: auto\n    model: ''\n`;
  }
  return out;
}

export function withHermesReasoningEffort(cfg, effort = "low") {
  let out = String(cfg || "");
  if (/(?:^|\n)agent:\s*\n(?:  .+\n)*?  reasoning_effort:\s*/.test(out)) {
    return out.replace(/((?:^|\n)agent:\s*\n(?:  .+\n)*?  reasoning_effort:\s*)[^\n#]+/, `$1${effort}`);
  }
  if (/(?:^|\n)agent:\s*\n/.test(out)) {
    return out.replace(/((?:^|\n)agent:\s*\n)/, `$1  reasoning_effort: ${effort}\n`);
  }
  return `${out.trimEnd()}\nagent:\n  reasoning_effort: ${effort}\n`;
}

/** Strip Hermes host browser/terminal/web so it cannot open Chrome on the Mac. */
export function withHermesHostLockdown(cfg) {
  let out = String(cfg || "");
  out = out.replace(/(?:^|\n)toolsets:\n(?:- [^\n]+\n)*/g, "\ntoolsets: []\n");
  if (/(?:^|\n)  disabled_toolsets:\n/.test(out)) {
    out = out.replace(
      /(?:^|\n)  disabled_toolsets:\n(?:  - [^\n]+\n)*/,
      "\n  disabled_toolsets:\n  - browser\n  - terminal\n  - web\n",
    );
  } else if (/(?:^|\n)agent:\s*\n/.test(out)) {
    out = out.replace(/((?:^|\n)agent:\s*\n)/, `$1  disabled_toolsets:\n  - browser\n  - terminal\n  - web\n`);
  }
  out = out.replace(/((?:^|\n)platform_toolsets:\n)  cli:\n(?:  - [^\n]+\n)+/, `$1  cli: []\n`);
  out = out.replace(/((?:^|\n)browser:\n(?:  .+\n)*?  cloud_provider:\s*)[^\n]+/, `$1none`);
  return out;
}

export function readHermesModel() {
  try {
    const cfg = fsSync.readFileSync(hermesConfigPath(), "utf8");
    const m = cfg.match(/(?:^|\n)model:\s*\n(?:  .+\n)*?  default:\s*["']?([^\n#]+)/);
    return m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
  } catch {
    return "";
  }
}

export async function setHermesModel(model) {
  const name = String(model || "").trim();
  if (!name) throw new Error("model required");
  const file = hermesConfigPath();
  let cfg = "";
  try {
    cfg = await fs.readFile(file, "utf8");
  } catch {
    cfg = "model:\n  provider: lmstudio\n  base_url: http://127.0.0.1:1234/v1\n  default: qwen3.8-27b\n";
  }
  if (/(?:^|\n)model:\s*\n(?:  .+\n)*?  default:\s*/.test(cfg)) {
    cfg = cfg.replace(/((?:^|\n)model:\s*\n(?:  .+\n)*?  default:\s*)([^\n#]+)/, `$1${name}`);
  } else if (/(?:^|\n)model:\s*\n/.test(cfg)) {
    cfg = cfg.replace(/((?:^|\n)model:\s*\n)/, `$1  default: ${name}\n`);
  } else {
    cfg = `model:\n  provider: lmstudio\n  base_url: http://127.0.0.1:1234/v1\n  default: ${name}\n` + cfg;
  }
  cfg = withHermesContextLength(cfg);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, cfg);
  return { ok: true, model: name, contextLength: HERMES_MIN_CTX };
}

export function nodeBin() {
  const exe = path.basename(process.execPath || "").toLowerCase();
  const electronish = /electron|^sub8$/.test(exe) || process.env.ELECTRON_RUN_AS_NODE;
  if (!electronish && process.execPath && fsSync.existsSync(process.execPath)) return process.execPath;
  return whichCmd("node", ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]);
}

export function mcpServerSpec(mcpEnv = {}) {
  return {
    type: "stdio",
    command: nodeBin(),
    args: [mcpScript()],
    env: { ...hostEnv(), ...mcpEnv },
  };
}

const IMPORT_RE = /(?:import|from)\s+["'](\.[^"']+)["']|import\(\s*["'](\.[^"']+)["']/g;

// Every file the MCP server pulls in, as paths relative to appRoot.
function mcpGraph(entry, root, seen = new Set()) {
  if (seen.has(entry) || !fsSync.existsSync(entry)) return seen;
  seen.add(entry);
  let src = "";
  try {
    src = fsSync.readFileSync(entry, "utf8");
  } catch {
    return seen;
  }
  for (const m of src.matchAll(IMPORT_RE)) {
    mcpGraph(path.resolve(path.dirname(entry), m[1] || m[2]), root, seen);
  }
  return seen;
}

// Claude runs this server with real node, which cannot read inside app.asar.
// A bundle that unpacks the entry point but not its imports dies with
// ERR_MODULE_NOT_FOUND, and Claude just reports "sub8 MCP not connected".
// Copy the whole graph somewhere real node can read it, and keep it fresh.
function healMcp(packed) {
  try {
    const out = path.join(dataDir, "mcp");
    let entry = "";
    for (const file of mcpGraph(packed, appRoot)) {
      const rel = path.relative(appRoot, file);
      if (rel.startsWith("..")) continue;
      const dest = path.join(out, rel);
      const src = fsSync.statSync(file);
      const stale = !fsSync.existsSync(dest) || fsSync.statSync(dest).mtimeMs !== src.mtimeMs;
      if (stale) {
        fsSync.mkdirSync(path.dirname(dest), { recursive: true });
        fsSync.copyFileSync(file, dest);
        fsSync.utimesSync(dest, src.atime, src.mtime);
      }
      if (file === packed) entry = dest;
    }
    return entry;
  } catch {
    return "";
  }
}

function mcpScript() {
  const packed = path.join(appRoot, "server", "mcp-sub8.mjs");
  const unpacked = packed.replace(/\.asar([/\\])/, ".asar.unpacked$1");
  const entry = fsSync.existsSync(unpacked) ? unpacked : packed;
  const root = path.dirname(path.dirname(entry));
  const complete = [...mcpGraph(packed, appRoot)].every((file) =>
    fsSync.existsSync(path.join(root, path.relative(appRoot, file))),
  );
  if (complete) return entry;
  return healMcp(packed) || entry;
}

export function hostEnv() {
  const env = { ...process.env, HOME: process.env.HOME || os.homedir() };
  const prefix = extraPath();
  if (prefix) env.PATH = `${prefix}${path.delimiter}${env.PATH || "/usr/bin:/bin"}`;
  if (path.basename(process.execPath).toLowerCase().includes("electron")) {
    env.ELECTRON_RUN_AS_NODE = "1";
  }
  return env;
}

function parseClaudeStream(line, acc) {
  let evt;
  try {
    evt = JSON.parse(line);
  } catch {
    return;
  }
  if (evt.type === "assistant" && Array.isArray(evt.message?.content)) {
    for (const part of evt.message.content) {
      if (part.type === "text" && part.text) acc.reply += part.text;
    }
  }
  if (evt.type === "content_block_delta" && evt.delta?.text) acc.reply += evt.delta.text;
  if (evt.type === "result" && typeof evt.result === "string" && !acc.reply) acc.reply = evt.result;
}

function parseCodexStream(line, acc) {
  let evt;
  try {
    evt = JSON.parse(line);
  } catch {
    return;
  }
  const item = evt.item || evt.msg || {};
  const typ = String(item.type || evt.item_type || evt.type || "");
  if (/agent_message|assistant_message|agent.message/i.test(typ)) {
    const text = item.text || item.message || evt.text || "";
    if (text && typeof text === "string") acc.reply += (acc.reply ? "\n" : "") + text;
  }
  if (Array.isArray(item.content)) {
    for (const part of item.content) {
      if (part?.text && part.type !== "reasoning") acc.reply += part.text;
    }
  }
}

export function grokShouldKeepText(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  if (/^Error: max turns reached$/i.test(t)) return false;
  if (t.length > 280) return true;
  return !/^(I('ll| will) |Let me |Trying |The (first |desktop |MCP |hash |trip|origin|destination|route|search) |Origin is |SFO is set|One way is |Google Flights is open)/i.test(
    t,
  );
}

export function foldGrokVisibleText(parts) {
  const list = (parts || []).map((p) => String(p || "").trim()).filter(Boolean);
  const kept = list.filter(grokShouldKeepText);
  return (kept.length ? kept : list.slice(-1)).join("\n");
}

function parseGrokStream(line, acc) {
  let evt;
  try {
    evt = JSON.parse(line);
  } catch {
    return;
  }
  const typ = String(evt.type || evt.event || "");
  if (/think|reasoning|tool_call|tool_result|status|error/i.test(typ) && typ !== "result") return;
  if (typ === "result" && typeof evt.result === "string" && evt.result.trim()) {
    acc.final = true;
    acc.parts = [evt.result.trim()];
    acc.reply = foldGrokVisibleText(acc.parts);
    return;
  }
  if (acc.final) return;
  const text =
    (typ === "text" && typeof evt.data === "string" && evt.data) ||
    (typeof evt.text === "string" && evt.text) ||
    (typeof evt.message === "string" && evt.message) ||
    "";
  const update = evt.params?.update || evt.update || {};
  const kind = update.sessionUpdate || update.session_update || evt.method || "";
  const chunk = update.content?.text || update.content?.content || "";
  const piece = text || (/agent_message/i.test(kind) ? chunk : "");
  if (!piece || !String(piece).trim()) return;
  acc.parts = acc.parts || [];
  acc.parts.push(String(piece).trim());
  acc.reply = foldGrokVisibleText(acc.parts);
}

export function hostCodexAuthPath() {
  return path.join(os.homedir(), ".codex", "auth.json");
}

export function hostHermesAuthPath() {
  return path.join(os.homedir(), ".hermes", "auth.json");
}

/** Share login tokens with an isolated CLI home. Copying auth.json burns one-time refresh tokens. */
export async function shareAuthFile(src, dest) {
  if (!src || !fsSync.existsSync(src)) return "missing";
  await fs.mkdir(path.dirname(dest), { recursive: true });
  try {
    await fs.lstat(dest);
    await fs.unlink(dest);
  } catch {
    /* dest missing */
  }
  try {
    await fs.symlink(src, dest);
    return "symlink";
  } catch {
    await fs.copyFile(src, dest);
    return "copy";
  }
}

/** If Codex rewrote a copied auth.json, copy the new tokens back to the host login. */
export async function harvestAuthFile(src, dest) {
  try {
    const st = await fs.lstat(dest);
    if (st.isSymbolicLink()) return "symlink";
    const srcExists = fsSync.existsSync(src);
    const srcM = srcExists ? (await fs.stat(src)).mtimeMs : 0;
    if (!srcExists || st.mtimeMs >= srcM - 1000) {
      await fs.mkdir(path.dirname(src), { recursive: true });
      await fs.copyFile(dest, src);
      return "copied-back";
    }
    return "stale";
  } catch {
    return "missing";
  }
}

export async function writeCodexHome(work, mcpEnv) {
  const home = path.join(work, "codex-home");
  await fs.mkdir(home, { recursive: true });
  await shareAuthFile(hostCodexAuthPath(), path.join(home, "auth.json"));
  const envLines = Object.entries({ PATH: hostEnv().PATH, ...mcpEnv })
    .filter(([, v]) => v != null && String(v))
    .map(([k, v]) => `${k} = ${JSON.stringify(String(v))}`)
    .join("\n");
  const cwd = path.resolve(work);
  const toml = `approval_policy = "never"
sandbox_mode = "danger-full-access"

[projects.${JSON.stringify(cwd)}]
trust_level = "trusted"

[plugins."browser-use@openai-bundled"]
enabled = false

[mcp_servers.sub8]
command = ${JSON.stringify(nodeBin())}
args = [${JSON.stringify(mcpScript())}]
startup_timeout_sec = 30
enabled = true

[mcp_servers.sub8.env]
${envLines}
`;
  await fs.writeFile(path.join(home, "config.toml"), toml);
  return home;
}

export async function writeHermesHome(home, mcpEnv, { contextLength = HERMES_SUB8_CTX, reasoning = "low" } = {}) {
  const src = path.join(os.homedir(), ".hermes");
  await fs.mkdir(home, { recursive: true });
  for (const name of ["config.yaml", ".env"]) {
    const from = path.join(src, name);
    if (fsSync.existsSync(from)) await fs.copyFile(from, path.join(home, name));
  }
  await shareAuthFile(path.join(src, "auth.json"), path.join(home, "auth.json"));
  // CLI caches LM Studio context here. Without it, oneshot re-probes /v1/models
  // and Hermes rejects Qwen at the advertised ~4k window.
  for (const name of ["models_dev_cache.json", "ollama_cloud_models_cache.json"]) {
    const from = path.join(src, name);
    const to = path.join(home, name);
    if (!fsSync.existsSync(from)) continue;
    try {
      await fs.lstat(to);
    } catch {
      try {
        await fs.symlink(from, to);
      } catch {
        await fs.copyFile(from, to).catch(() => {});
      }
    }
  }
  const mcp = {
    command: nodeBin(),
    args: [mcpScript()],
    env: Object.fromEntries(Object.entries(mcpEnv).filter(([, v]) => v != null && String(v))),
  };
  const block = [
    "",
    "mcp_servers:",
    "  sub8:",
    `    command: ${JSON.stringify(mcp.command)}`,
    "    args:",
    ...mcp.args.map((a) => `      - ${JSON.stringify(a)}`),
    "    env:",
    ...Object.entries(mcp.env).map(([k, v]) => `      ${k}: ${JSON.stringify(String(v))}`),
    "",
  ].join("\n");
  const cfgPath = path.join(home, "config.yaml");
  let cfg = "";
  try {
    cfg = await fs.readFile(cfgPath, "utf8");
  } catch {
    cfg = "model:\n  provider: auto\n";
  }
  cfg = cfg.replace(/\nmcp_servers:\n[\s\S]*?(?=\n[a-z_][a-z0-9_]*:|\s*$)/i, "\n");
  cfg = withHermesContextLength(cfg, contextLength);
  cfg = withHermesReasoningEffort(cfg, reasoning);
  cfg = withHermesHostLockdown(cfg);
  await fs.writeFile(cfgPath, `${cfg.trimEnd()}\n${block}`);
  return home;
}

export async function writeGrokHome(botId, mcpEnv) {
  const home = path.join(dataDir, "grok-host", String(botId || "bot"));
  await fs.mkdir(home, { recursive: true });
  const srcAuth = path.join(os.homedir(), ".grok", "auth.json");
  if (fsSync.existsSync(srcAuth)) {
    await fs.copyFile(srcAuth, path.join(home, "auth.json"));
  }
  const envLines = Object.entries(mcpEnv)
    .filter(([, v]) => v != null && String(v))
    .map(([k, v]) => `${k} = ${JSON.stringify(String(v))}`)
    .join("\n");
  const toml = `[ui]
permission_mode = "always-approve"

[models]
default_reasoning_effort = "low"

[mcp_servers.sub8]
command = ${JSON.stringify(nodeBin())}
args = [${JSON.stringify(mcpScript())}]
enabled = true
startup_timeout_sec = 20

[mcp_servers.sub8.env]
${envLines}
`;
  await fs.writeFile(path.join(home, "config.toml"), toml);
  return home;
}

function grokSessionExists(home, id) {
  const root = path.join(home, "sessions");
  if (!id || !fsSync.existsSync(root)) return false;
  try {
    const names = fsSync.readdirSync(root);
    return names.some((n) => n.includes(id));
  } catch {
    return false;
  }
}

export async function runHostCli({ provider, model, userText, signal, bot, settings, hidden = false, emit, internalToken, port }) {
  const box = bot?.vm?.container;
  if (!box) return "This harness only runs after the Bot computer is up.";
  const work = await fs.mkdtemp(path.join(os.tmpdir(), `sub8-${provider}-`));
  const extra = await ctx.agentsExtra({ bot, settings, hidden });
  await memory.ensureLayout(bot).catch(() => {});
  const hermesFast = provider === "hermes";
  const grokFast = provider === "grok-build";
  const rules = hermesFast
    ? `${extra}

You are Sub8 on this Bot's Linux desktop. Call it "my computer".
Drive it only through MCP tools: computer, shell, memory, vault_list, vault_fill, list_routines, upsert_routine, disable_routine, list_teammates, message_teammate, ask_user, create_teammate, rename_bot, update_bot, delete_teammate.
You MAY edit standing routines: list_routines, then upsert_routine with that id. Overlapping jobs (same group or similar interval) must update the existing id, not create a second one.
Always call a tool before you reply. Do not only describe the next step.
computer action=open text=https://… already returns a screenshot. Do not screenshot again unless the page is wrong. Do not curl a page you opened. Do not use xdotool or host Bash.`
    : grokFast
      ? `${extra}

You are Sub8 on this Bot's Linux desktop. Call it "my computer".
MCP server "sub8" is already connected. Its tools are: computer, shell, memory, vault_list, vault_fill, list_routines, upsert_routine, disable_routine, list_teammates, message_teammate, ask_user, create_teammate, rename_bot, update_bot, delete_teammate.
You MAY edit standing routines (list_routines, then upsert_routine with that id). Do not create a second job that overlaps.
Call computer immediately. Never search for tools, never invent APIs, never curl localhost, never say tools are missing unless a computer call returned an error.
Do not print a user-visible sentence between every click. One short ack, then tools until the job is done, then one result with the answer.
computer action=open text=https://… already returns a screenshot.`
    : `${await fs.readFile(path.join(appRoot, "prompts", "capabilities.txt"), "utf8")}
${extra}

You are Sub8 on this Bot's Linux desktop (display :1, home /config). Call it "my computer". Never say box, container, Docker, VM, or Mac in user-facing replies.
Drive the desktop through MCP tools: computer, shell, memory, vault_list, vault_fill, list_routines, upsert_routine, disable_routine, list_teammates, message_teammate, ask_user, create_teammate, rename_bot, update_bot, delete_teammate. Do not create overlapping jobs — update the existing id. Repeating jobs must continue from /config/agent-data history, not start over.
To open a site: computer action=open text=https://…
To see the screen: computer action=screenshot
To click: computer action=left_click with x,y from the screenshot.
To type: computer action=type. To press a key: computer action=key.
To sign in: vault_fill. Never print a password.
Talk to teammates with message_teammate (pass their bot id from list_teammates). One Chrome, one tab, one worker at a time. If you need a yes/no, a pick, or confirmation from the user, call ask_user and wait — do not guess.
Do not drive Chrome with xdotool, wmctrl, octo-click, CDP, or host Bash. Call the sub8 tools. If the desktop is sick, shell desk-doctor. Do not announce tools are missing unless a tool call returned an error.
`;
  const prompt = `${userText}

You have an MCP server named "sub8". Use computer action=open to go to a URL. Do not only send a plan.`;
  const mcpEnv = {
    SUB8BOT_BOT_ID: bot.id,
    SUB8BOT_DATA: dataDir,
    SUB8_INTERNAL_TOKEN: internalToken || "",
    SUB8_INTERNAL_URL: port ? `http://127.0.0.1:${port}` : "",
  };
  const mcpFile = path.join(work, "mcp.json");
  const mcpJson = JSON.stringify({ mcpServers: { sub8: mcpServerSpec(mcpEnv) } }, null, 2);
  await fs.writeFile(mcpFile, mcpJson);
  await fs.writeFile(path.join(work, ".mcp.json"), mcpJson);

  let bin;
  let args;
  const spawnEnv = hostEnv();
  if (provider === "claude") {
    bin = claudeBin();
    args = [
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "bypassPermissions",
      "--dangerously-skip-permissions",
      "--strict-mcp-config",
      "--mcp-config",
      mcpFile,
      "--append-system-prompt",
      rules,
      "--session-id",
      bot.id,
    ];
    if (model) args.push("--model", model);
  } else if (provider === "grok-build") {
    const home = await writeGrokHome(bot.id, mcpEnv);
    spawnEnv.GROK_HOME = home;
    spawnEnv.GROK_CONFIG = JSON.stringify({ models: { default_reasoning_effort: "low" } });
    bin = grokBin();
    args = [
      "-p",
      prompt,
      "--output-format",
      "streaming-json",
      "--permission-mode",
      "bypassPermissions",
      "--always-approve",
      "--no-alt-screen",
      "--max-turns",
      "48",
      "--effort",
      "low",
      "--rules",
      rules,
      "--cwd",
      work,
    ];
    if (model) args.push("-m", model);
    if (grokSessionExists(home, bot.id)) args.push("--resume", bot.id);
    else args.push("--session-id", bot.id);
  } else if (provider === "hermes") {
    const { hermesAcpPrompt } = await import("./hermes-acp.mjs");
    const home = await writeHermesHome(path.join(dataDir, "hermes-host"), mcpEnv);
    spawnEnv.HERMES_HOME = home;
    try {
      const text = await hermesAcpPrompt({
        bot,
        text: `${rules}\n\n${prompt}`,
        mcpEnv,
        command: nodeBin(),
        args: [mcpScript()],
        signal,
        bin: hermesBin(),
        env: spawnEnv,
        home,
      });
      return text || "(no output from hermes)";
    } catch (err) {
      const msg = String(err.message || err);
      console.error("hermes acp", msg);
      if (/silent|timed out|still working/i.test(msg)) return msg;
      /* fall back to a one-shot only if ACP never came up */
    }
    spawnEnv.HERMES_ACCEPT_HOOKS = "1";
    bin = hermesBin();
    args = [
      "-z",
      `${rules}\n\n${prompt}`,
      "--yolo",
      "--accept-hooks",
    ];
    const hermesModel = model || readHermesModel();
    if (hermesModel) args.push("-m", hermesModel);
  } else {
    const home = await writeCodexHome(work, mcpEnv);
    spawnEnv.CODEX_HOME = home;
    bin = codexBin();
    args = [
      "exec",
      "--skip-git-repo-check",
      "--ephemeral",
      "--color",
      "never",
      "--json",
      "--dangerously-bypass-approvals-and-sandbox",
      "-C",
      work,
    ];
    if (model && !/grok/i.test(model)) args.push("-m", model);
    args.push(prompt);
  }

  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      env: spawnEnv,
      cwd: work,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const acc = { reply: "" };
    let buf = "";
    let done = false;
    const IDLE_MS = 180_000;
    const HARD_MS = 20 * 60_000;
    let idleTimer = null;
    const bumpIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(
        () => finish(`${provider} went silent for 3 minutes. Send another message to continue.`),
        IDLE_MS,
      );
    };
    const hardTimer = setTimeout(
      () => finish(`${provider} hit the 20 minute limit. Send another message to continue.`),
      HARD_MS,
    );
    const finish = async (text) => {
      if (done) return;
      done = true;
      if (idleTimer) clearTimeout(idleTimer);
      clearTimeout(hardTimer);
      try {
        if (!child.killed) child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      let out = String(text || "").trim() || `(no output from ${provider})`;
      out = out
        .replace(/Reading additional input from stdin\.\.\./gi, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      try {
        out = vault.redactSecrets(out, await vault.listSecrets());
      } catch {
        /* ignore */
      }
      try {
        if (provider === "codex") await harvestAuthFile(hostCodexAuthPath(), path.join(work, "codex-home", "auth.json"));
        if (provider === "hermes") await harvestAuthFile(hostHermesAuthPath(), path.join(work, "hermes-home", "auth.json"));
      } catch {
        /* ignore */
      }
      resolve(out);
    };
    const onChunk = (chunk) => {
      bumpIdle();
      buf += chunk.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() || "";
      for (const line of lines) {
        if (provider === "claude") parseClaudeStream(line, acc);
        else if (provider === "codex") parseCodexStream(line, acc);
        else if (provider === "grok-build") parseGrokStream(line, acc);
        else acc.reply += (acc.reply ? "\n" : "") + line;
      }
    };
    bumpIdle();
    signal?.addEventListener("abort", () => finish("Stopped."));
    child.stdout.on("data", onChunk);
    child.stderr.on("data", (d) => {
      bumpIdle();
      const s = d.toString();
      if (/error|fail|not found|ENOENT/i.test(s)) acc.reply += (acc.reply ? "\n" : "") + s.trim();
    });
    child.on("error", (e) => finish(`${provider} failed: ${e.message}. Is it installed and signed in on this machine?`));
    child.on("close", () => {
      if (buf.trim()) {
        if (provider === "claude") parseClaudeStream(buf, acc);
        else if (provider === "codex") parseCodexStream(buf, acc);
        else if (provider === "grok-build") parseGrokStream(buf, acc);
        else if (buf.trim()) acc.reply += (acc.reply ? "\n" : "") + buf.trim();
      }
      finish(acc.reply);
    });
  });
}

export async function pingHostCli(provider) {
  const env = hostEnv();
  if (provider === "grok-build") {
    const bin = grokBin();
    return await new Promise((resolve) => {
      const child = spawn(
        bin,
        [
          "-p",
          "Reply with only the word PONG.",
          "--permission-mode",
          "bypassPermissions",
          "--always-approve",
          "--no-alt-screen",
          "--output-format",
          "plain",
        ],
        { env, stdio: ["ignore", "pipe", "pipe"] },
      );
      let out = "";
      const t = setTimeout(() => {
        try {
          child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
      }, 90_000);
      child.stdout.on("data", (d) => (out += d.toString()));
      child.stderr.on("data", (d) => (out += d.toString()));
      child.on("error", (e) => {
        clearTimeout(t);
        resolve({ ok: false, error: e.message, sample: "", log: e.message, command: bin });
      });
      child.on("close", () => {
        clearTimeout(t);
        resolve({
          ok: /pong/i.test(out),
          sample: out.trim().slice(0, 240),
          log: out.trim().slice(-400),
          command: bin,
          error: /pong/i.test(out) ? null : "Grok CLI did not reply PONG. Sign in with grok login --oauth.",
        });
      });
    });
  }
  if (provider === "hermes") {
    const bin = hermesBin();
    return await new Promise((resolve) => {
      const hermesModel = readHermesModel();
      const args = ["-z", "Reply with only the word PONG.", "--yolo"];
      if (hermesModel) args.push("-m", hermesModel);
      const child = spawn(bin, args, {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      const t = setTimeout(() => {
        try {
          child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
      }, 90_000);
      child.stdout.on("data", (d) => (out += d.toString()));
      child.stderr.on("data", (d) => (out += d.toString()));
      child.on("error", (e) => {
        clearTimeout(t);
        resolve({ ok: false, error: e.message, sample: "", log: e.message, command: bin });
      });
      child.on("close", () => {
        clearTimeout(t);
        resolve({
          ok: /\bPONG\b/i.test(out),
          sample: out.trim().slice(-400),
          log: out.trim().slice(-2000),
          command: bin,
        });
      });
    });
  }
  if (provider === "claude") {
    const bin = claudeBin();
    return await new Promise((resolve) => {
      const child = spawn(
        bin,
        ["-p", "Reply with only the word PONG.", "--output-format", "text", "--permission-mode", "dontAsk", "--no-session-persistence"],
        { env, stdio: ["ignore", "pipe", "pipe"] },
      );
      let out = "";
      const t = setTimeout(() => {
        try {
          child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
      }, 60_000);
      child.stdout.on("data", (d) => (out += d.toString()));
      child.stderr.on("data", (d) => (out += d.toString()));
      child.on("error", (e) => {
        clearTimeout(t);
        resolve({ ok: false, error: e.message, sample: "" });
      });
      child.on("close", () => {
        clearTimeout(t);
        resolve({ ok: /\bPONG\b/i.test(out), sample: out.trim().slice(-240), log: out.trim().slice(-2000), command: bin });
      });
    });
  }
  const bin = codexBin();
  return await new Promise((resolve) => {
    const child = spawn(
      bin,
      ["exec", "--skip-git-repo-check", "--ephemeral", "--color", "never", "Reply with only the word PONG. Do not use tools."],
      { env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    const t = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }, 90_000);
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (out += d.toString()));
    child.on("error", (e) => {
      clearTimeout(t);
      resolve({ ok: false, error: e.message, sample: "" });
    });
    child.on("close", () => {
      clearTimeout(t);
      resolve({ ok: /\bPONG\b/i.test(out), sample: out.trim().slice(-240), log: out.trim().slice(-2000), command: bin });
    });
  });
}
