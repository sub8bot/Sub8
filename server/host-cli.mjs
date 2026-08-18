import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { appRoot, dataDir } from "./paths.mjs";
import * as vault from "./vault.mjs";

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

export function nodeBin() {
  if (process.env.ELECTRON_RUN_AS_NODE || path.basename(process.execPath).toLowerCase().includes("electron")) {
    return process.execPath;
  }
  return process.execPath;
}

function mcpScript() {
  const packed = path.join(appRoot, "server", "mcp-sub8.mjs");
  const unpacked = packed.replace(/\.asar([/\\])/, ".asar.unpacked$1");
  if (fsSync.existsSync(unpacked)) return unpacked;
  return packed;
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

export async function writeCodexHome(work, mcpEnv) {
  const home = path.join(work, "codex-home");
  await fs.mkdir(home, { recursive: true });
  const srcAuth = path.join(os.homedir(), ".codex", "auth.json");
  if (fsSync.existsSync(srcAuth)) {
    await fs.copyFile(srcAuth, path.join(home, "auth.json"));
  }
  const envLines = Object.entries(mcpEnv)
    .filter(([, v]) => v != null && String(v))
    .map(([k, v]) => `${k} = ${JSON.stringify(String(v))}`)
    .join("\n");
  const toml = `approval_policy = "never"

[plugins."browser-use@openai-bundled"]
enabled = false

[mcp_servers.sub8]
command = ${JSON.stringify(nodeBin())}
args = [${JSON.stringify(mcpScript())}]
startup_timeout_sec = 20

[mcp_servers.sub8.env]
${envLines}
`;
  await fs.writeFile(path.join(home, "config.toml"), toml);
  return home;
}

export async function runHostCli({ provider, model, userText, signal, bot, emit, internalToken, port }) {
  const box = bot?.vm?.container;
  if (!box) return "This harness only runs after the Bot computer is up.";
  const work = await fs.mkdtemp(path.join(os.tmpdir(), `sub8-${provider}-`));
  const ident = `You are the Bot named "${bot.name}". ${bot.description || ""}`.trim();
  const extra = bot.instructions?.trim() ? `\nStanding instructions:\n${bot.instructions.trim()}` : "";
  const rules = `${await fs.readFile(path.join(appRoot, "prompts", "grok-build-vm.txt"), "utf8")}
${ident}${extra}
${await vault.promptBlock(bot.id)}

You are NOT on the user's Mac. Drive the Linux desktop only through MCP tools named computer, shell, vault_list, and vault_fill.
Never use host Bash/Edit/Read on this Mac. Screenshot, then click, then vault_fill for passwords.
`;
  const prompt =
    provider === "codex"
      ? `${userText}

Open Chrome or drive the desktop with the MCP tool "computer" (action=open, screenshot, left_click, type). Do not use browser-use, browser automation skills, or host Bash. If a tool is missing, say so — do not pretend Chrome opened.`
      : `${userText}\n\nUse the desktop if this is computer work. Do not only send a plan.`;
  const mcpEnv = {
    SUB8BOT_BOT_ID: bot.id,
    SUB8BOT_DATA: dataDir,
    SUB8_INTERNAL_TOKEN: internalToken || "",
    SUB8_INTERNAL_URL: port ? `http://127.0.0.1:${port}` : "",
  };
  const mcpFile = path.join(work, "mcp.json");
  await fs.writeFile(
    mcpFile,
    JSON.stringify({
      mcpServers: {
        sub8: {
          command: nodeBin(),
          args: [mcpScript()],
          env: { ...hostEnv(), ...mcpEnv },
        },
      },
    }),
  );

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
      "--mcp-config",
      mcpFile,
      "--append-system-prompt",
      rules,
      "--session-id",
      bot.id,
    ];
    if (model) args.push("--model", model);
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
    const finish = async (text) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        if (!child.killed) child.killed || child.kill("SIGTERM");
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
      resolve(out);
    };
    const onChunk = (chunk) => {
      buf += chunk.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() || "";
      for (const line of lines) {
        if (provider === "claude") parseClaudeStream(line, acc);
        else parseCodexStream(line, acc);
      }
    };
    const timer = setTimeout(() => finish(`${provider} timed out.`), 180_000);
    signal?.addEventListener("abort", () => finish("Stopped."));
    child.stdout.on("data", onChunk);
    child.stderr.on("data", (d) => {
      const s = d.toString();
      if (/error|fail|not found|ENOENT/i.test(s)) acc.reply += (acc.reply ? "\n" : "") + s.trim();
    });
    child.on("error", (e) => finish(`${provider} failed: ${e.message}. Is it installed and signed in on this machine?`));
    child.on("close", () => {
      if (buf.trim()) {
        if (provider === "claude") parseClaudeStream(buf, acc);
        else parseCodexStream(buf, acc);
      }
      finish(acc.reply);
    });
  });
}

export async function pingHostCli(provider) {
  const env = hostEnv();
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
        resolve({ ok: /\bPONG\b/i.test(out), sample: out.trim().slice(-240), command: bin });
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
      resolve({ ok: /\bPONG\b/i.test(out), sample: out.trim().slice(-240), command: bin });
    });
  });
}
