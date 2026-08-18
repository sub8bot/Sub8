#!/usr/bin/env node
/**
 * Host MCP for Claude / Codex. Tools only reach the bot Linux desktop, never this Mac.
 */
import * as store from "./store.mjs";
import * as vm from "./vm.mjs";
import * as vault from "./vault.mjs";

const botId = process.env.SUB8BOT_BOT_ID || "";
const token = process.env.SUB8_INTERNAL_TOKEN || "";
const emitUrl = process.env.SUB8_INTERNAL_URL || "";

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

async function emit(event, data) {
  if (!emitUrl || !token || !botId) return;
  try {
    await fetch(`${emitUrl}/api/internal/emit`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-sub8-token": token },
      body: JSON.stringify({ botId, event, data }),
    });
  } catch {
    /* UI notify is best-effort */
  }
}

const TOOLS = [
  {
    name: "computer",
    description:
      "Drive the bot Linux desktop. Screenshot first. x,y are pixels on the last 1024x768 screenshot.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "screenshot",
            "left_click",
            "right_click",
            "double_click",
            "type",
            "key",
            "scroll",
            "wait",
            "open",
            "mouse_move",
          ],
        },
        x: { type: "number" },
        y: { type: "number" },
        text: { type: "string" },
        keys: { type: "string" },
        dy: { type: "number" },
        dx: { type: "number" },
        ms: { type: "number" },
      },
      required: ["action"],
    },
  },
  {
    name: "shell",
    description: "Run a command inside the bot Linux desktop (home /config). Not the host Mac.",
    inputSchema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
  {
    name: "vault_list",
    description: "List saved logins this Bot may use. Never includes passwords.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "vault_fill",
    description: "Paste a saved username or password into the focused desktop field. Never prints the secret.",
    inputSchema: {
      type: "object",
      properties: {
        account_id: { type: "string" },
        field: { type: "string", enum: ["username", "password"] },
      },
      required: ["account_id", "field"],
    },
  },
];

async function botOrThrow() {
  const bot = await store.getBot(botId);
  if (!bot) throw new Error("Bot not found");
  if (bot.vm?.status !== "running" || !bot.vm.container) throw new Error("Computer is not running yet.");
  return bot;
}

async function runComputer(args) {
  const bot = await botOrThrow();
  const action = args.action;
  await emit("tool", { name: "computer", args });
  if (action === "screenshot") {
    const shot = await vm.screenshot(bot);
    await emit("message", {
      id: `tl${Date.now()}mcp`,
      role: "activity",
      kind: "tool",
      name: "computer",
      action: "screenshot",
      summary: "Looked at the screen",
      ts: Date.now(),
    });
    return {
      content: [
        { type: "text", text: `Screenshot ${shot.width}x${shot.height}. Coordinates are 1:1, origin top-left.` },
        { type: "image", data: shot.buf.toString("base64"), mimeType: "image/png" },
      ],
    };
  }
  if (action === "open") {
    await vm.openChrome(bot, args.text || "");
    await vm.wait(1200);
    await emit("message", {
      id: `tl${Date.now()}mcp`,
      role: "activity",
      kind: "tool",
      name: "computer",
      action: "open",
      summary: "Opened Chrome",
      ts: Date.now(),
    });
    const shot = await vm.screenshot(bot);
    return {
      content: [
        {
          type: "text",
          text: `Opened ${String(args.text || "Chrome").slice(0, 160)}. Screenshot ${shot.width}x${shot.height}. Click the next control or type.`,
        },
        { type: "image", data: shot.buf.toString("base64"), mimeType: "image/png" },
      ],
    };
  }
  if (action === "left_click") await vm.click(bot, args.x, args.y, 1, 1);
  else if (action === "right_click") await vm.click(bot, args.x, args.y, 3, 1);
  else if (action === "double_click") await vm.click(bot, args.x, args.y, 1, 2);
  else if (action === "mouse_move") await vm.mouseMove(bot, args.x, args.y);
  else if (action === "type") await vm.typeText(bot, args.text || "");
  else if (action === "key") await vm.key(bot, args.keys || args.text || "Return");
  else if (action === "scroll") await vm.scroll(bot, args.x, args.y, args.dy || 0, args.dx || 0);
  else if (action === "wait") await vm.wait(args.ms || 800);
  else throw new Error(`unknown action ${action}`);
  await emit("message", {
    id: `tl${Date.now()}mcp`,
    role: "activity",
    kind: "tool",
    name: "computer",
    action,
    summary: action === "open" ? "Opened Chrome" : action.replaceAll("_", " "),
    ts: Date.now(),
  });
  return { content: [{ type: "text", text: `${action} ok` }] };
}

async function callTool(name, args = {}) {
  if (name === "computer") return runComputer(args);
  if (name === "shell") {
    const bot = await botOrThrow();
    const secrets = await vault.listSecrets();
    const cmd = String(args.command || "");
    if (secrets.some((s) => s && cmd.includes(s))) {
      return { content: [{ type: "text", text: "Blocked: do not put vault secrets in the shell." }], isError: true };
    }
    await emit("message", {
      id: `tl${Date.now()}sh`,
      role: "activity",
      kind: "tool",
      name: "shell",
      action: "shell",
      summary: `Ran ${cmd.slice(0, 48)}`,
      ts: Date.now(),
    });
    const r = await vm.shell(bot, cmd);
    return { content: [{ type: "text", text: vault.redactSecrets(r.output || (r.ok ? "(ok)" : "(failed)"), secrets) }] };
  }
  if (name === "vault_list") {
    const rows = await vault.grantedAccounts(botId);
    return { content: [{ type: "text", text: rows.length ? JSON.stringify(rows, null, 2) : "No saved logins granted." }] };
  }
  if (name === "vault_fill") {
    const bot = await botOrThrow();
    const filled = await vault.fillIntoDesktop(bot, args.account_id, args.field || "password");
    await emit("message", {
      id: `tl${Date.now()}vf`,
      role: "activity",
      kind: "tool",
      name: "vault_fill",
      action: "vault_fill",
      summary: args.field === "username" ? "Pasted username" : "Pasted password",
      ts: Date.now(),
    });
    return { content: [{ type: "text", text: filled.text }], isError: !filled.ok };
  }
  throw new Error(`unknown tool ${name}`);
}

function result(id, payload) {
  send({ jsonrpc: "2.0", id, result: payload });
}

function fail(id, message) {
  send({ jsonrpc: "2.0", id, error: { code: -32000, message: String(message || "error") } });
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    result(id, {
      protocolVersion: params?.protocolVersion || "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "sub8", version: "0.3.10" },
    });
    return;
  }
  if (method === "notifications/initialized" || method === "initialized") return;
  if (method === "tools/list") {
    result(id, { tools: TOOLS });
    return;
  }
  if (method === "ping") {
    result(id, {});
    return;
  }
  if (method === "tools/call") {
    try {
      const out = await callTool(params?.name, params?.arguments || {});
      result(id, out);
    } catch (err) {
      result(id, { content: [{ type: "text", text: err.message }], isError: true });
    }
    return;
  }
  if (id !== undefined) fail(id, `unknown method ${method}`);
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  const lines = buf.split(/\r?\n/);
  buf = lines.pop() || "";
  for (const line of lines) {
    const raw = line.trim();
    if (!raw) continue;
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      continue;
    }
    handle(msg).catch((err) => {
      if (msg.id !== undefined) fail(msg.id, err.message);
    });
  }
});
process.stdin.on("end", () => process.exit(0));
