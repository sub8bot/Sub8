/**
 * Cloud desk state tools for mcp-sub8.
 *
 * Computer/browser/shell stay on the droplet (desk-agent via desk-local).
 * Teammates, jobs, and routines live in the Worker's KV — the same
 * POST /api/brain/executor-tool callback the pi-executor uses. Without this,
 * grok-build's create_teammate writes UUID bots into the droplet's bots.json
 * that the Cloud UI never sees, and message_teammate never starts a worker turn.
 *
 * Activated only when SUB8_CLOUD_CALLBACK_URL is set (harness injects it per turn).
 * Local grok-build MCP is unchanged.
 */

/** One MCP text block. The only content kind these tools return. */
export interface McpTextContent {
  type: "text";
  text: string;
}

/** An MCP tool result, as mcp-sub8 hands it back to the harness. */
export interface McpToolResult {
  content: McpTextContent[];
  isError?: boolean;
}

/** The env the Worker callback is configured from. */
export interface CloudToolEnv {
  url: string;
  computerId: string;
  botId: string;
  deskToken: string;
}

/** The Worker's reply, as loose as it arrives off the wire. */
interface WorkerToolReply {
  error?: unknown;
  text?: unknown;
  visible?: unknown;
}

export const CLOUD_STATE_TOOLS = new Set([
  "ask_user",
  "set_job",
  "list_tasks",
  "update_task",
  "create_teammate",
  "list_teammates",
  "message_teammate",
  "rename_bot",
  "update_bot",
  "delete_teammate",
  "show_user",
  "upsert_routine",
  "list_routines",
  "disable_routine",
  "delete_routine",
  // Worker already implements memory via desk-action. In-desk grok-build used
  // mcp-sub8's docker-container check, which Cloud desks fail, so "what's your
  // name?" never read /config/agent-data.
  "memory",
]);

export function cloudCallbackConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(String(env.SUB8_CLOUD_CALLBACK_URL || "").trim());
}

export function cloudToolEnv(env: NodeJS.ProcessEnv = process.env): CloudToolEnv {
  return {
    url: String(env.SUB8_CLOUD_CALLBACK_URL || "").trim(),
    computerId: String(env.SUB8_CLOUD_COMPUTER_ID || "").trim(),
    botId: String(env.SUB8_CLOUD_BOT_ID || env.SUB8BOT_BOT_ID || "").trim(),
    deskToken: String(env.SUB8_DESK_TOKEN || "").trim(),
  };
}

/**
 * POST the named state tool to the Worker. Returns MCP {content, isError?}.
 * `null` means "not a cloud state tool — caller should use the local store".
 */
export async function tryCloudStateTool(
  name: string,
  args: unknown,
  env: NodeJS.ProcessEnv = process.env,
  fetchFn: typeof fetch = fetch,
): Promise<McpToolResult | null> {
  if (!cloudCallbackConfigured(env) || !CLOUD_STATE_TOOLS.has(name)) return null;
  const cfg = cloudToolEnv(env);
  if (!cfg.url) return { content: [{ type: "text", text: `${name} is unavailable (no Worker callback)` }], isError: true };
  if (!cfg.deskToken) {
    return { content: [{ type: "text", text: `${name} is unavailable (no desk token)` }], isError: true };
  }
  try {
    const res = await fetchFn(cfg.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.deskToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ computerId: cfg.computerId, botId: cfg.botId, name, args: args || {} }),
      signal: AbortSignal.timeout(60_000),
    });
    const data = (await res.json().catch(() => ({}))) as WorkerToolReply;
    if (!res.ok) {
      const msg = data.error || data.text || `worker tool ${name} ${res.status}`;
      return { content: [{ type: "text", text: String(msg) }], isError: true };
    }
    return { content: [{ type: "text", text: String(data.text || data.visible || "ok") }] };
  } catch (err) {
    return { content: [{ type: "text", text: (err as Error | undefined)?.message || `${name} failed` }], isError: true };
  }
}
