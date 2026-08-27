#!/usr/bin/env node
/**
 * In-desk MCP for grok on the Linux computer. No docker, no Mac /Users.
 * State tools POST to SUB8_INTERNAL_URL (the host app).
 */
import { spawn } from "node:child_process";
import { assertVmShell } from "./isolation.mjs";

/** What every tool call here answers with. */
export interface DeskToolResult {
  ok: boolean;
  output: string;
}

export type DeskExec = (command: string, opts?: { timeoutMs?: number | undefined }) => Promise<DeskToolResult>;

/**
 * The `arguments` bag grok hands a tool call. Every field is optional and the
 * index signature stays open: this is model-authored JSON, and each reader
 * already coerces and defaults what it needs.
 */
export interface DeskWidget {
  prompt?: unknown;
  helpText?: unknown;
  options?: unknown;
  [key: string]: unknown;
}

export interface DeskSecret {
  label?: unknown;
  description?: unknown;
  connector?: unknown;
  field?: unknown;
  [key: string]: unknown;
}

export interface DeskToolArgs {
  action?: string | undefined;
  x?: unknown;
  y?: unknown;
  text?: unknown;
  keys?: unknown;
  url?: unknown;
  command?: unknown;
  type?: unknown;
  content?: unknown;
  question?: unknown;
  hint?: unknown;
  choices?: unknown;
  widget?: DeskWidget | undefined;
  secret?: DeskSecret | undefined;
  [key: string]: unknown;
}

function displayVar() {
  return process.env.SUB8_DISPLAY ? `:${String(process.env.SUB8_DISPLAY).replace(":", "")}` : process.env.DISPLAY || ":1";
}
function tokenVar() {
  return process.env.SUB8_INTERNAL_TOKEN || "";
}
function emitUrlVar() {
  return process.env.SUB8_INTERNAL_URL || "";
}
function botIdVar() {
  return process.env.SUB8BOT_BOT_ID || "";
}

let execFn: DeskExec = defaultExec;
let fetchFn: typeof globalThis.fetch = globalThis.fetch.bind(globalThis);

export function setExec(fn: DeskExec | null | undefined): void {
  execFn = typeof fn === "function" ? fn : defaultExec;
}

export function setFetch(fn: typeof globalThis.fetch | null | undefined): void {
  fetchFn = typeof fn === "function" ? fn : globalThis.fetch.bind(globalThis);
}

function defaultExec(command: string, { timeoutMs = 30_000 }: { timeoutMs?: number | undefined } = {}): Promise<DeskToolResult> {
  return new Promise<DeskToolResult>((resolve) => {
    const child = spawn("bash", ["-lc", command], {
      env: { ...process.env, DISPLAY: displayVar(), HOME: "/config", XAUTHORITY: "/config/.Xauthority" },
      timeout: timeoutMs,
    });
    let out = "";
    child.stdout?.on("data", (d) => (out += d));
    child.stderr?.on("data", (d) => (out += d));
    child.on("error", (err) => resolve({ ok: false, output: String(err.message || err) }));
    child.on("close", (code) => resolve({ ok: code === 0, output: out.slice(0, 8000) }));
  });
}

export const TOOLS = [
  {
    name: "computer",
    description: "Pixel desktop on THIS computer. Screenshot/click/type/key. Not the user's Mac.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["screenshot", "left_click", "type", "key", "open"] },
        x: { type: "number" },
        y: { type: "number" },
        text: { type: "string" },
        keys: { type: "string" },
      },
      required: ["action"],
    },
  },
  {
    name: "shell",
    description: "Run a command on THIS computer (home /config). Not the host Mac.",
    inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
  },
  {
    name: "create_teammate",
    description: "Spin a helper Bot on this same computer. Requires name and job. Returns the new bot id.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        job: { type: "string" },
      },
      required: ["name", "job"],
    },
  },
  {
    name: "list_teammates",
    description: "List Bots on this computer/team. Use ids from here for message_teammate.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "message_teammate",
    description: "Send a note to another Bot on this computer. Never invent a UUID.",
    inputSchema: {
      type: "object",
      properties: {
        bot_id: { type: "string" },
        message: { type: "string" },
      },
      required: ["bot_id", "message"],
    },
  },
  {
    name: "task",
    description: "Background worker on this computer. type=executor. Never send_message. Parent delivers.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string" },
        prompt: { type: "string" },
      },
      required: ["prompt"],
    },
  },
  {
    name: "send_message",
    description:
      "User-visible chat. type=widget or secret-request ENDS the turn. Prefer this over plain assistant text.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["text", "widget", "secret-request", "attachment"] },
        content: { type: "string" },
        question: { type: "string" },
        widget: { type: "object" },
        secret: { type: "object" },
      },
    },
  },
];

export function computerCommand(args: DeskToolArgs = {}): string {
  const action = String(args.action || "");
  if (action === "screenshot") {
    return `ffmpeg -y -nostdin -loglevel error -f x11grab -video_size 1024x768 -i "${displayVar()}.0" -frames:v 1 -update 1 /tmp/desk-shot.png && echo SHOT_OK`;
  }
  if (action === "left_click") {
    const x = Number(args.x) || 0;
    const y = Number(args.y) || 0;
    return `if [ -x /usr/local/bin/box-input ]; then /usr/local/bin/box-input mousemove ${x} ${y} click 1; else xdotool mousemove ${x} ${y} click 1; fi`;
  }
  if (action === "type") {
    const t = String(args.text || "").replace(/'/g, `'\\''`);
    return `if [ -x /usr/local/bin/box-input ]; then /usr/local/bin/box-input type '${t}'; else xdotool type --delay 2 '${t}'; fi`;
  }
  if (action === "key") {
    const k = String(args.keys || args.text || "Return").replace(/[^A-Za-z0-9+_]/g, "");
    return `if [ -x /usr/local/bin/box-input ]; then /usr/local/bin/box-input key ${k}; else xdotool key ${k}; fi`;
  }
  if (action === "open") {
    const url = String(args.text || args.url || "").replace(/'/g, `'\\''`);
    return `/usr/local/bin/chrome-desktop '${url}'`;
  }
  throw new Error(`unknown computer action ${action}`);
}

export function deskMessageCard(args: DeskToolArgs = {}) {
  const type = String(args.type || "text").trim() || "text";
  // Secret arm FIRST. The widget arm below also fires on a bare `args.question`,
  // and this tool's own inputSchema offers `question` beside `type` and
  // `secret` -- so a model asking for a credential routinely sends
  // {type:"secret-request", question:"Paste the PAT"} and the widget arm
  // captured it, building a plain kind:"choices" card. The UI masks only on
  // kind === "secret-request", so the user got an ordinary text box, and
  // POST /choice wrote the typed credential straight into the transcript and
  // the next turn, skipping the vault/mcp routing entirely.
  //
  // Same defect and same fix as packages/choice cardFromSendMessageArgs and
  // cloud/src/cloud-tools.ts cloudChoice. This was the third copy; the desk is
  // where prompts/capabilities.txt actively tells the model to use this shape.
  if (type === "secret-request" || args.secret) {
    const s: DeskSecret = args.secret && typeof args.secret === "object" ? args.secret : {};
    return {
      id: `ch${Date.now()}sec`,
      role: "assistant",
      kind: "secret-request",
      content: String(s.label || args.question || "Paste the credential"),
      hint: s.description || "This stays out of chat.",
      pending: true,
      secret: true,
      secretTarget: { connector: s.connector || "vault", field: s.field || "secret" },
      speakerId: botIdVar(),
      ts: Date.now(),
    };
  }
  if (type === "widget" || args.widget || args.question) {
    const w: DeskWidget = args.widget && typeof args.widget === "object" ? args.widget : {};
    return {
      id: `ch${Date.now()}desk`,
      role: "assistant",
      kind: "choices",
      content: String(w.prompt || args.question || args.content || "What should we do?"),
      hint: w.helpText || args.hint || "",
      choices: w.options || args.choices || [],
      pending: true,
      speakerId: botIdVar(),
      ts: Date.now(),
    };
  }
  return null;
}

/** What the host app answers an internal POST with. */
interface HostPostBody {
  output?: unknown;
  text?: unknown;
  error?: unknown;
  [key: string]: unknown;
}

async function hostPost(path: string, body: Record<string, unknown>): Promise<DeskToolResult> {
  const emitUrl = emitUrlVar();
  const token = tokenVar();
  const botId = botIdVar();
  if (!emitUrl || !token || !botId) return { ok: false, output: "host url missing" };
  const res = await fetchFn(`${String(emitUrl).replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-sub8-token": token },
    body: JSON.stringify({ botId, ...body }),
  });
  // `as HostPostBody`: Response#json() is typed `Promise<unknown>`, and the
  // `.catch(() => ({}))` right there is what has always stood in for a body we
  // cannot parse. The assertion adds no runtime step.
  const data = await res.json().catch(() => ({})) as HostPostBody;
  const output = data.output || data.text || (res.ok ? "ok" : data.error || `http ${res.status}`);
  return { ok: res.ok, output: String(output) };
}

/**
 * NOTE for anyone auditing this file: unlike mcp-sub8.mts and agent.mts, nothing
 * here runs `vault.redactSecrets`, and that is deliberate rather than an
 * oversight.
 *
 * This module is docker-cp'd INTO the box (`vm.mts` copies it to
 * /usr/local/lib/sub8/mcp-desk.mjs) and runs there. Redacting a secret means
 * holding the list of secrets, so "adding redaction here" would mean shipping
 * every vault credential into the container the untrusted model already
 * controls -- strictly worse than not redacting. The host-side harnesses redact
 * because they run where the vault already is.
 *
 * What this file DOES enforce is `assertVmShell` on the shell command below,
 * which is the xdotool / Chrome-debug-port / cookie-dump blocklist. The real
 * containment for secrets is that the desk should not be able to reach them at
 * all -- see the vault/loopback boundary item in resume.md.
 */
export async function callTool(name: string | undefined, args: DeskToolArgs = {}): Promise<DeskToolResult | (DeskToolResult & { endTurn: boolean })> {
  if (name === "shell") {
    assertVmShell(args.command);
    return execFn(String(args.command || ""));
  }
  if (name === "computer") {
    const cmd = computerCommand(args);
    return execFn(cmd);
  }
  if (name === "create_teammate" || name === "list_teammates" || name === "message_teammate" || name === "task") {
    return hostPost("/api/internal/desk-tool", { name, args });
  }
  if (name === "send_message") {
    const card = deskMessageCard(args);
    if (card) {
      await hostPost("/api/internal/emit", { botId: botIdVar(), event: "message", data: card });
      await hostPost("/api/internal/end-turn", { botId: botIdVar() });
      return { ok: true, output: "asked the user; wait for their pick in chat", endTurn: true };
    }
    const content = String(args.content || "").trim();
    await hostPost("/api/internal/emit", {
      botId: botIdVar(),
      event: "message",
      data: { role: "assistant", content, speakerId: botIdVar(), ts: Date.now() },
    });
    return { ok: true, output: "sent" };
  }
  throw new Error(`unknown tool ${name}`);
}

export function grokMcpToml({ script = "/usr/local/lib/sub8/mcp-desk.mjs", env = {} }: { script?: string | undefined; env?: Record<string, unknown> | undefined } = {}): string {
  const envLines = Object.entries(env)
    .filter(([, v]) => v != null && String(v).length)
    .map(([k, v]) => `${k} = ${JSON.stringify(String(v))}`)
    .join("\n");
  return `[mcp_servers.sub8]
command = "node"
args = [${JSON.stringify(script)}]
${envLines ? `[mcp_servers.sub8.env]\n${envLines}\n` : ""}`;
}

function send(msg: unknown): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

/** One JSON-RPC frame off stdin. Shapes are whatever the client sent. */
interface JsonRpcRequest {
  id?: unknown;
  method?: unknown;
  params?: { protocolVersion?: unknown; name?: string | undefined; arguments?: DeskToolArgs | undefined } | undefined;
}

async function handle(msg: JsonRpcRequest): Promise<void> {
  const { id, method, params } = msg;
  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: { protocolVersion: params?.protocolVersion || "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "sub8-desk", version: "0.3.26" } },
    });
    return;
  }
  if (method === "notifications/initialized" || method === "initialized") return;
  if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    return;
  }
  if (method === "tools/call") {
    try {
      const r = await callTool(params?.name, params?.arguments || {});
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: r.output || (r.ok ? "ok" : "failed") }] } });
    } catch (err) {
      // `as Error`: strict types a catch binding as unknown; the expression is
      // the same `err.message || err` fallback it has always been.
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: String((err as Error).message || err) }], isError: true } });
    }
  }
}

function isMain(): boolean {
  const entry = process.argv[1] || "";
  return entry.endsWith("mcp-desk.mjs");
}

if (isMain() && !process.env.SUB8_MCP_DESK_TEST) {
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buf += chunk;
    const lines = buf.split(/\r?\n/);
    buf = lines.pop() || "";
    for (const line of lines) {
      const raw = line.trim();
      if (!raw) continue;
      try {
        handle(JSON.parse(raw));
      } catch {
        /* ignore */
      }
    }
  });
}
