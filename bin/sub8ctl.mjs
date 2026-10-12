#!/usr/bin/env node
/**
 * sub8ctl: control the running Sub8 app from a terminal or an agent harness.
 *
 * Reads the API address and token from control.json in the Sub8 data folder
 * (written by the app; see docs/control-api.md) and talks to the local control
 * API. Plain Node, no dependencies, so it runs from a source checkout or from
 * inside the installed app bundle.
 *
 *   sub8ctl status
 *   sub8ctl bots
 *   sub8ctl show <bot>
 *   sub8ctl send <bot> "<text>" [--wait] [--timeout <seconds>]
 *   sub8ctl stop <bot>
 *   sub8ctl tail <bot> [--limit <n>]
 *   sub8ctl events [--bot <bot>]
 *   sub8ctl screen <bot> [out.png] [--cached]
 *   sub8ctl mcp            (stdio MCP server for Claude Code, Codex and others)
 *
 * <bot> is a bot id or its exact name (case-insensitive).
 */
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const VERSION = "1";

// ---------------------------------------------------------------------------
// Discovery

function defaultDataDir() {
  if (process.env.SUB8BOT_DATA) return process.env.SUB8BOT_DATA;
  const home = os.homedir();
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "Sub8", "data");
  if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "Sub8", "data");
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "Sub8", "data");
}

function controlFile(opts) {
  return opts.file || process.env.SUB8_CONTROL_FILE || path.join(defaultDataDir(), "control.json");
}

class CtlError extends Error {
  constructor(message, status = 0, code = "") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Read fresh on every call, so a regenerated token is picked up without a restart. */
function loadControl(opts) {
  const file = controlFile(opts);
  let rec;
  try {
    rec = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new CtlError(
      err && err.code === "ENOENT"
        ? `No control file at ${file}. Open Sub8 once (and check Settings > Control API is on).`
        : `Could not read ${file}: ${err.message}`,
    );
  }
  if (!rec || typeof rec.url !== "string" || typeof rec.token !== "string") throw new CtlError(`${file} is missing url or token`);
  if (rec.enabled === false) throw new CtlError("The control API is turned off. Turn it on in Sub8 > Settings > Control API.");
  return { url: rec.url.replace(/\/+$/, ""), token: rec.token };
}

async function call(opts, method, route, body, { signal } = {}) {
  const { url, token } = loadControl(opts);
  let res;
  try {
    res = await fetch(url + route, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (err) {
    if (err && err.name === "AbortError") throw err;
    throw new CtlError(`Sub8 is not answering at ${url}. Is the app running?`);
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON */
  }
  if (!res.ok) {
    const e = data && data.error;
    throw new CtlError((e && (e.message || e)) || `HTTP ${res.status}`, res.status, (e && e.code) || "");
  }
  return data;
}

const enc = (s) => encodeURIComponent(String(s));

/** GET /bots/:bot/screen as raw PNG bytes plus when it was taken. */
async function fetchScreen(opts, bot, { cached = false } = {}) {
  const { url, token } = loadControl(opts);
  let res;
  try {
    res = await fetch(`${url}/bots/${enc(bot)}/screen${cached ? "?cached=1" : ""}`, { headers: { authorization: `Bearer ${token}` } });
  } catch {
    throw new CtlError(`Sub8 is not answering at ${url}. Is the app running?`);
  }
  if (!res.ok) {
    let e = null;
    try {
      e = (await res.json())?.error;
    } catch {
      /* non-JSON */
    }
    throw new CtlError((e && (e.message || e)) || `HTTP ${res.status}`, res.status, (e && e.code) || "");
  }
  const png = Buffer.from(await res.arrayBuffer());
  return { png, ts: Number(res.headers.get("x-sub8-captured-at")) || 0, fresh: res.headers.get("x-sub8-fresh") === "1" };
}

/** Server-sent events as an async iterator of {event, data}. */
async function* streamEvents(opts, query = "", signal) {
  const { url, token } = loadControl(opts);
  let res;
  try {
    res = await fetch(`${url}/events${query}`, { headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" }, signal });
  } catch (err) {
    if (err && err.name === "AbortError") return;
    throw new CtlError(`Sub8 is not answering at ${url}. Is the app running?`);
  }
  if (!res.ok || !res.body) {
    let msg = `HTTP ${res.status}`;
    try {
      const d = await res.json();
      msg = d?.error?.message || msg;
    } catch {
      /* ignore */
    }
    throw new CtlError(msg, res.status);
  }
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      let event = "message";
      const data = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      }
      if (!data.length) continue;
      let parsed;
      try {
        parsed = JSON.parse(data.join("\n"));
      } catch {
        parsed = data.join("\n");
      }
      yield { event, data: parsed };
    }
  }
}

// ---------------------------------------------------------------------------
// Formatting

function when(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function botLine(b) {
  const model = [b.provider, b.model].filter(Boolean).join("/");
  const head = `${b.name || "(unnamed)"}  [${b.status}]  ${model}  ${b.id}`;
  const doing = b.turn && (b.turn.doing || b.turn.request) ? `\n    working on: ${b.turn.doing || b.turn.request}` : "";
  const last = b.lastReply ? `\n    last reply (${when(b.lastReply.ts)}): ${b.lastReply.text}` : "";
  return head + doing + last;
}

function msgLine(m) {
  const who = m.role === "user" ? "you" : m.role === "activity" ? "  ..." : m.speaker || "bot";
  return `[${when(m.ts)}] ${who}: ${m.text}`;
}

// ---------------------------------------------------------------------------
// Commands

async function cmdStatus(opts) {
  const s = await call(opts, "GET", "/status");
  if (opts.json) return print(s);
  const b = s.bots;
  console.log(`Sub8 ${s.version} (control API v${s.api})`);
  console.log(`bots: ${b.total} total, ${b.working} working, ${b.idle} idle, ${b.paused} paused, ${b.error} error`);
}

async function cmdBots(opts) {
  const r = await call(opts, "GET", "/bots");
  if (opts.json) return print(r.bots);
  if (!r.bots.length) return console.log("No bots.");
  for (const b of r.bots) console.log(botLine(b));
}

async function cmdShow(opts, bot) {
  need(bot, "show <bot>");
  const r = await call(opts, "GET", `/bots/${enc(bot)}`);
  if (opts.json) return print(r.bot);
  console.log(botLine(r.bot));
  if (r.bot.recent?.length) {
    console.log("");
    for (const m of r.bot.recent) console.log(msgLine(m));
  }
}

async function cmdSend(opts, bot, text) {
  need(bot && text, 'send <bot> "<text>" [--wait]');
  const body = { text };
  if (opts.wait) {
    body.wait = true;
    body.timeoutMs = Math.round((opts.timeout || 600) * 1000);
  }
  const r = await call(opts, "POST", `/bots/${enc(bot)}/messages`, body);
  if (opts.json) return print(r);
  console.log(`${r.delivery === "steered" ? "Steered into the running turn" : "Started a turn"} (message ${r.messageId}).`);
  if (r.wait) {
    if (r.wait.timedOut) console.log(`Still ${r.wait.status} after the timeout.`);
    else if (r.wait.reply) console.log(`\n${r.wait.reply.text}`);
    else console.log(`Finished with no reply (${r.wait.status}).`);
  }
}

async function cmdStop(opts, bot) {
  need(bot, "stop <bot>");
  const r = await call(opts, "POST", `/bots/${enc(bot)}/stop`);
  if (opts.json) return print(r);
  console.log(r.stopped ? "Stopped." : "Nothing was running.");
}

async function cmdTail(opts, bot) {
  need(bot, "tail <bot>");
  const { bot: b } = await call(opts, "GET", `/bots/${enc(bot)}`);
  const limit = Number(opts.limit) || 20;
  const hist = await call(opts, "GET", `/bots/${enc(b.id)}/messages?limit=${limit}`);
  for (const m of hist.messages) console.log(opts.json ? JSON.stringify(m) : msgLine(m));
  if (!opts.json) console.log(`--- following ${b.name || b.id} [${b.status}] (Ctrl-C to stop) ---`);
  for await (const ev of streamEvents(opts, `?bot=${enc(b.id)}`)) {
    if (opts.json) console.log(JSON.stringify(ev));
    else if (ev.event === "message") console.log(msgLine(ev.data.message));
    else if (ev.event === "status") console.log(`--- ${ev.data.status} ---`);
  }
}

async function cmdEvents(opts) {
  let q = "";
  if (opts.bot) {
    const { bot } = await call(opts, "GET", `/bots/${enc(opts.bot)}`);
    q = `?bot=${enc(bot.id)}`;
  }
  for await (const ev of streamEvents(opts, q)) console.log(JSON.stringify(ev));
}

async function cmdScreen(opts, bot, out) {
  need(bot, "screen <bot> [out.png]");
  const shot = await fetchScreen(opts, bot, { cached: opts.cached });
  const file = path.resolve(out || `sub8-${String(bot).replace(/[^A-Za-z0-9._-]+/g, "_")}-screen.png`);
  writeFileSync(file, shot.png);
  if (opts.json) return print({ file, bytes: shot.png.length, ts: shot.ts, fresh: shot.fresh });
  console.log(`Saved ${file} (${shot.png.length} bytes, ${shot.fresh ? "just captured" : `saved ${when(shot.ts)}`}).`);
}

function print(v) {
  console.log(JSON.stringify(v, null, 2));
}

function need(ok, usage) {
  if (!ok) throw new CtlError(`usage: sub8ctl ${usage}`);
}

// ---------------------------------------------------------------------------
// MCP (stdio, newline-delimited JSON-RPC 2.0)

const BOT_ARG = { type: "string", description: "Bot id or exact bot name (case-insensitive)." };
const MCP_TOOLS = [
  {
    name: "list_bots",
    description: "List the bots in the running Sub8 app with their status (idle, working, paused, error), model, what they are working on and their last reply.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_bot",
    description: "Get one Sub8 bot's status, current turn and its most recent chat messages.",
    inputSchema: { type: "object", properties: { bot: BOT_ARG }, required: ["bot"], additionalProperties: false },
  },
  {
    name: "read_messages",
    description: "Read a Sub8 bot's chat messages (user and bot rows), oldest first. Use `since` (ms timestamp) to get only newer ones.",
    inputSchema: {
      type: "object",
      properties: {
        bot: BOT_ARG,
        since: { type: "number", description: "Only messages with ts greater than this (ms since epoch)." },
        limit: { type: "number", description: "Most recent N messages (default 30, max 500)." },
        include_activity: { type: "boolean", description: "Also include tool/thinking activity rows." },
      },
      required: ["bot"],
      additionalProperties: false,
    },
  },
  {
    name: "send_message",
    description:
      "Send a message to a Sub8 bot as the user. Starts a turn when the bot is idle; steers the running turn when it is busy. With wait=true, blocks until the bot is idle again and returns its reply.",
    inputSchema: {
      type: "object",
      properties: {
        bot: BOT_ARG,
        text: { type: "string", description: "The message." },
        wait: { type: "boolean", description: "Wait for the bot to finish and return its reply." },
        timeout_seconds: { type: "number", description: "How long to wait when wait=true (default 300, max 600)." },
      },
      required: ["bot", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "wait_for_bot",
    description: "Wait until a Sub8 bot finishes its current turn and return its reply.",
    inputSchema: {
      type: "object",
      properties: { bot: BOT_ARG, timeout_seconds: { type: "number", description: "Default 300, max 600." } },
      required: ["bot"],
      additionalProperties: false,
    },
  },
  {
    name: "get_screen",
    description:
      "See a Sub8 bot's Linux desktop: returns a PNG screenshot of its computer (a fresh capture when the computer is running, otherwise the latest saved one).",
    inputSchema: {
      type: "object",
      properties: { bot: BOT_ARG, cached: { type: "boolean", description: "Return the latest saved screenshot without capturing a new one." } },
      required: ["bot"],
      additionalProperties: false,
    },
  },
  {
    name: "stop_bot",
    description: "Stop a Sub8 bot's running turn (the Stop button).",
    inputSchema: { type: "object", properties: { bot: BOT_ARG }, required: ["bot"], additionalProperties: false },
  },
];

function secs(v, dflt) {
  const n = Number(v);
  return Math.round(Math.min(600, Number.isFinite(n) && n > 0 ? n : dflt) * 1000);
}

async function mcpTool(opts, name, a = {}) {
  switch (name) {
    case "list_bots":
      return (await call(opts, "GET", "/bots")).bots;
    case "get_bot":
      return (await call(opts, "GET", `/bots/${enc(a.bot)}`)).bot;
    case "read_messages": {
      const q = new URLSearchParams();
      if (a.since) q.set("since", String(a.since));
      q.set("limit", String(a.limit || 30));
      if (a.include_activity) q.set("activity", "1");
      const r = await call(opts, "GET", `/bots/${enc(a.bot)}/messages?${q}`);
      return { messages: r.messages, hasMore: r.hasMore };
    }
    case "send_message": {
      const body = { text: String(a.text || "") };
      if (a.wait) {
        body.wait = true;
        body.timeoutMs = secs(a.timeout_seconds, 300);
      }
      return await call(opts, "POST", `/bots/${enc(a.bot)}/messages`, body);
    }
    case "wait_for_bot":
      return await call(opts, "POST", `/bots/${enc(a.bot)}/wait?timeoutMs=${secs(a.timeout_seconds, 300)}`);
    case "stop_bot":
      return await call(opts, "POST", `/bots/${enc(a.bot)}/stop`);
    default:
      throw new CtlError(`unknown tool ${name}`);
  }
}

function runMcp(opts) {
  const out = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", async (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return out({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
    }
    const { id, method, params } = msg || {};
    const isRequest = id !== undefined && id !== null;
    try {
      if (method === "initialize") {
        return out({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: params?.protocolVersion || "2025-06-18",
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "sub8", version: VERSION },
            instructions:
              "Controls bots in the Sub8 desktop app on this computer. Each bot has its own Linux desktop with a browser. Use list_bots to find a bot, send_message to give it work (wait=true to get the reply), read_messages to follow along, get_screen to see its desktop, and stop_bot to halt it.",
          },
        });
      }
      if (method === "ping") return isRequest && out({ jsonrpc: "2.0", id, result: {} });
      if (method === "tools/list") return out({ jsonrpc: "2.0", id, result: { tools: MCP_TOOLS } });
      if (method === "tools/call") {
        try {
          if (params?.name === "get_screen") {
            const a = params?.arguments || {};
            const shot = await fetchScreen(opts, a.bot, { cached: Boolean(a.cached) });
            const note = shot.fresh ? "Captured just now." : `Latest saved screenshot${shot.ts ? ` from ${new Date(shot.ts).toISOString()}` : ""}.`;
            return out({
              jsonrpc: "2.0",
              id,
              result: { content: [{ type: "image", data: shot.png.toString("base64"), mimeType: "image/png" }, { type: "text", text: note }] },
            });
          }
          const data = await mcpTool(opts, params?.name, params?.arguments || {});
          return out({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] } });
        } catch (err) {
          return out({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true } });
        }
      }
      if (!isRequest) return; // notifications (initialized, cancelled) need no answer
      out({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
    } catch (err) {
      if (isRequest) out({ jsonrpc: "2.0", id, error: { code: -32603, message: String(err?.message || err) } });
    }
  });
  rl.on("close", () => process.exit(0));
}

// ---------------------------------------------------------------------------
// Entry

const HELP = `sub8ctl: control the running Sub8 app

usage:
  sub8ctl status
  sub8ctl bots
  sub8ctl show <bot>
  sub8ctl send <bot> "<text>" [--wait] [--timeout <seconds>]
  sub8ctl stop <bot>
  sub8ctl tail <bot> [--limit <n>]
  sub8ctl events [--bot <bot>]
  sub8ctl screen <bot> [out.png] [--cached]
  sub8ctl mcp

options:
  --json          print raw JSON
  --file <path>   control.json to use (default: Sub8 data folder, or $SUB8_CONTROL_FILE)

<bot> is a bot id or its exact name.
MCP setup: claude mcp add sub8 -- node "${path.resolve(process.argv[1] || "sub8ctl.mjs")}" mcp`;

function parseArgs(argv) {
  const opts = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") opts.json = true;
    else if (a === "--wait" || a === "-w") opts.wait = true;
    else if (a === "--timeout") opts.timeout = Number(argv[++i]);
    else if (a === "--limit") opts.limit = Number(argv[++i]);
    else if (a === "--file") opts.file = argv[++i];
    else if (a === "--bot") opts.bot = argv[++i];
    else if (a === "--cached") opts.cached = true;
    else if (a === "-h" || a === "--help") opts.help = true;
    else pos.push(a);
  }
  return { opts, pos };
}

export async function main(argv = process.argv.slice(2)) {
  const { opts, pos } = parseArgs(argv);
  const [cmd, ...rest] = pos;
  if (!cmd || opts.help || cmd === "help") {
    console.log(HELP);
    return 0;
  }
  if (cmd === "mcp") {
    runMcp(opts);
    return null;
  }
  const table = {
    status: () => cmdStatus(opts),
    bots: () => cmdBots(opts),
    show: () => cmdShow(opts, rest[0]),
    send: () => cmdSend(opts, rest[0], rest.slice(1).join(" ")),
    stop: () => cmdStop(opts, rest[0]),
    tail: () => cmdTail(opts, rest[0]),
    events: () => cmdEvents(opts),
    screen: () => cmdScreen(opts, rest[0], rest[1]),
  };
  if (!table[cmd]) {
    console.error(`unknown command: ${cmd}\n\n${HELP}`);
    return 2;
  }
  try {
    await table[cmd]();
    return 0;
  } catch (err) {
    console.error(`sub8ctl: ${err.message}`);
    return err.status === 401 || err.status === 403 ? 3 : 1;
  }
}

function realpath(p) {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}
// Run when executed directly (including through an npm bin symlink), not when imported.
if (process.argv[1] && realpath(process.argv[1]) === realpath(fileURLToPath(import.meta.url))) {
  main().then((code) => {
    if (code !== null) process.exitCode = code;
  });
}
