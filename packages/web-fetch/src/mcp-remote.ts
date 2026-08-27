/**
 * User-added remote HTTP MCP (no Cursor marketplace).
 * GetMcpTools / CallMcpTool / AuthenticateMcpServer.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { assertPublicHttpUrl, assertResolvesPublic } from "./web-fetch.js";

import type {
  AddServerSpec,
  AuthShape,
  CodedError,
  ConnectCard,
  McpCallResult,
  McpFetch,
  McpToolsResult,
  PublicServer,
  RpcMessage,
  RpcOptions,
  ServerRow,
} from "./types.js";

export type {
  AddServerSpec,
  AuthShape,
  ConnectCard,
  McpCallResult,
  McpFetch,
  McpToolsResult,
  PublicServer,
  ServerRow,
} from "./types.js";

function dataRoot(): string {
  return process.env.SUB8BOT_DATA || process.env.OCTOBOT_DATA || path.join(process.cwd(), "data");
}

function storePath(): string {
  return path.join(dataRoot(), "mcp-servers.json");
}

let fetchFn: McpFetch = globalThis.fetch.bind(globalThis);
let writeChain: Promise<void> = Promise.resolve();

type McpLookup = (hostname: string, opts: { all: true }) => Promise<Array<{ address: string }>>;
let lookupFn: McpLookup | undefined;

/** Test seam for DNS, mirroring setFetch. Undefined means the real resolver. */
export function setLookup(fn: McpLookup | null | undefined): void {
  lookupFn = typeof fn === "function" ? fn : undefined;
}

/**
 * The guard assertMcpUrl alone never gave: resolve the host and re-run the
 * blocklist over the addresses it actually answers.
 *
 * assertPublicHttpUrl is a pure STRING match, so a public name that resolves
 * into a private range walks straight through it -- and the local API on :8787
 * serves /api/computers/:id/:action and the /api/vault mutators with no auth.
 * webFetch has resolved since 90e4dd1; this path never did, so add_mcp_server
 * could point the host at loopback and get_mcp_tools would POST there.
 *
 * Checked at REQUEST time, not only when the row is stored: a record that is
 * public when added can point somewhere else by the time it is called.
 */
async function assertMcpHostPublic(href: string): Promise<void> {
  const target = assertPublicHttpUrl(href);
  await (lookupFn ? assertResolvesPublic(target.hostname, lookupFn) : assertResolvesPublic(target.hostname));
}

export function setFetch(fn: McpFetch | null | undefined): void {
  fetchFn = typeof fn === "function" ? fn : globalThis.fetch.bind(globalThis);
}

export function resetForTest(): void {
  fetchFn = globalThis.fetch.bind(globalThis);
}

function withFile<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn);
  writeChain = run.then(
    () => {},
    () => {},
  );
  return run;
}

async function readAll(): Promise<ServerRow[]> {
  try {
    const rows: unknown = JSON.parse(await fs.readFile(storePath(), "utf8"));
    return Array.isArray(rows) ? (rows as ServerRow[]) : [];
  } catch {
    return [];
  }
}

async function writeAll(rows: ServerRow[]): Promise<ServerRow[]> {
  await fs.mkdir(dataRoot(), { recursive: true });
  await fs.writeFile(storePath(), JSON.stringify(rows, null, 2));
  return rows;
}

export function publicServer(row: ServerRow | null | undefined): PublicServer | null {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    hasAuth: Boolean(row.headers && Object.keys(row.headers).length),
    createdAt: row.createdAt,
  };
}

export async function listServers(): Promise<(PublicServer | null)[]> {
  return (await readAll()).map(publicServer);
}

export async function getServer(id: string): Promise<ServerRow | null> {
  const rows = await readAll();
  return rows.find((r) => r.id === id || r.name === id) || null;
}

export function assertMcpUrl(raw: unknown): string {
  return assertPublicHttpUrl(raw).href;
}

export async function addServer({ name, url, headers }: AddServerSpec = {}): Promise<PublicServer | null> {
  const nm = String(name || "").trim();
  if (!nm) throw new Error("name required");
  const href = assertMcpUrl(url);
  await assertMcpHostPublic(href);
  const hdrs =
    headers && typeof headers === "object" && !Array.isArray(headers)
      ? Object.fromEntries(Object.entries(headers).map(([k, v]) => [String(k), String(v)]))
      : {};
  return withFile(async () => {
    const rows = await readAll();
    if (rows.some((r) => r.name.toLowerCase() === nm.toLowerCase())) throw new Error("name already used");
    const row: ServerRow = { id: randomUUID(), name: nm, url: href, headers: hdrs, createdAt: Date.now() };
    rows.push(row);
    await writeAll(rows);
    return publicServer(row);
  });
}

export async function removeServer(id: string): Promise<{ ok: true; removed: string }> {
  return withFile(async () => {
    const rows = await readAll();
    const next = rows.filter((r) => r.id !== id && r.name !== id);
    if (next.length === rows.length) throw new Error("server not found");
    await writeAll(next);
    return { ok: true as const, removed: id };
  });
}

export async function setServerAuth(
  id: string,
  token: unknown,
  { header = "Authorization", prefix = "Bearer " }: AuthShape = {},
): Promise<PublicServer | null> {
  const secret = String(token || "").trim();
  if (!secret) throw new Error("token required");
  return withFile(async () => {
    const rows = await readAll();
    const row = rows.find((r) => r.id === id || r.name === id);
    if (!row) throw new Error("server not found");
    row.headers = { ...(row.headers || {}), [header]: `${prefix}${secret}`.replace(/Bearer Bearer /i, "Bearer ") };
    await writeAll(rows);
    return publicServer(row);
  });
}

function parseRpc(text: unknown, contentType: unknown): RpcMessage {
  const ct = String(contentType || "");
  const raw = String(text || "").trim();
  if (ct.includes("text/event-stream")) {
    const lines = raw.split(/\n/);
    for (const line of lines) {
      const m = line.match(/^data:\s*(.+)$/) as [string, string] | null;
      if (!m) continue;
      try {
        return JSON.parse(m[1]) as RpcMessage;
      } catch {
        /* next */
      }
    }
    return {};
  }
  if (!raw) return {};
  try {
    return JSON.parse(raw) as RpcMessage;
  } catch {
    return {};
  }
}

export async function rpc(
  row: ServerRow | null | undefined,
  method: string,
  params: unknown = {},
  { initialize = true }: RpcOptions = {},
): Promise<unknown> {
  if (!row?.url) throw new Error("server missing");
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...(row.headers || {}),
  };
  await assertMcpHostPublic(row.url);
  const post = async (body: Record<string, unknown>) => {
    const res = await fetchFn(row.url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), ...body }),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    if (res.status === 401 || res.status === 403) {
      const err: CodedError = new Error("needsAuth");
      err.code = "needsAuth";
      throw err;
    }
    return { res, msg: parseRpc(text, res.headers.get("content-type")) };
  };
  if (initialize) {
    await post({
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "sub8", version: "0.3.26" } },
    });
  }
  const { res, msg } = await post({ method, params });
  if (msg?.error) throw new Error(msg.error.message || "mcp error");
  return msg?.result;
}

export async function getMcpTools(id: string): Promise<McpToolsResult> {
  const row = await getServer(id);
  if (!row) throw new Error("server not found");
  try {
    const result = (await rpc(row, "tools/list", {})) as { tools?: unknown } | undefined;
    const tools = Array.isArray(result?.tools) ? result.tools : [];
    return { server: publicServer(row), tools };
  } catch (err) {
    if ((err as CodedError).code === "needsAuth") return { server: publicServer(row), needsAuth: true, tools: [] };
    throw err;
  }
}

export async function callMcpTool(id: string, toolName: unknown, args: unknown = {}): Promise<McpCallResult> {
  const row = await getServer(id);
  if (!row) throw new Error("server not found");
  const name = String(toolName || "").trim();
  if (!name) throw new Error("tool name required");
  try {
    const result = await rpc(row, "tools/call", { name, arguments: args && typeof args === "object" ? args : {} });
    return { server: publicServer(row), result };
  } catch (err) {
    if ((err as CodedError).code === "needsAuth") return { server: publicServer(row), needsAuth: true };
    throw err;
  }
}

export function connectCard(bot: unknown, row: ServerRow | null | undefined): ConnectCard {
  return {
    type: "secret-request",
    secret: {
      label: `Connect ${row?.name || "MCP"}`,
      description: "Paste the access token. It stays out of chat.",
      connector: "mcp",
      field: row?.id || "",
    },
  };
}
