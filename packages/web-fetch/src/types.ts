/** Errors this package throws carry a code the caller branches on. */
export interface CodedError extends Error {
  code?: string;
}

/** `Response.headers`, or the plain object a test injects instead. */
export interface HeadersLike {
  get?: ((name: string) => string | null) | undefined;
  [key: string]: unknown;
}

/** The slice of a `Response` the fetch loop reads. A real one satisfies it. */
export interface FetchLike {
  status?: unknown;
  headers?: HeadersLike | null | undefined;
  text?: (() => Promise<string>) | undefined;
  arrayBuffer?: (() => Promise<ArrayBuffer>) | undefined;
  body?: unknown;
}

/** Exactly what `webFetch` sends. Nothing here is caller-controlled. */
export interface FetchInit {
  method: string;
  redirect: "manual";
  signal: AbortSignal;
  headers: Record<string, string>;
}

/** `globalThis.fetch`, or the stub a test passes as `opts.fetch`. */
export type FetchFn = (url: string, init: FetchInit) => Promise<FetchLike>;

export interface WebFetchOptions {
  /** Override DNS resolution (tests). Defaults to node:dns/promises lookup. */
  lookup?: ((hostname: string, opts: { all: true }) => Promise<Array<{ address: string }>>) | undefined;
  fetch?: FetchFn | undefined;
  maxBytes?: unknown;
  timeoutMs?: unknown;
  maxRedirects?: unknown;
}

/** What `webFetch` resolves to — the shape the `read` and `web_fetch` tools return. */
export interface WebFetchResult {
  kind: "web";
  /** The URL asked for, before redirects. */
  url: string;
  /** The URL the body actually came from. */
  finalUrl: string;
  status: number;
  contentType: string;
  text: string;
}

/** A user-added remote MCP server, as persisted in `mcp-servers.json`. */
export interface ServerRow {
  id: string;
  name: string;
  url: string;
  /** Auth headers. Never leaves this module — `publicServer` reduces it to a boolean. */
  headers?: Record<string, string> | undefined;
  createdAt: number;
}

/** The same row with the secret removed, safe to hand a model or the UI. */
export interface PublicServer {
  id: string;
  name: string;
  url: string;
  hasAuth: boolean;
  createdAt: number;
}

/** What `addServer` accepts — an HTTP body or tool arguments. */
export interface AddServerSpec {
  name?: unknown;
  url?: unknown;
  headers?: Record<string, unknown> | undefined;
}

/** How `setServerAuth` frames the token. */
export interface AuthShape {
  header?: string;
  prefix?: string;
}

/** The slice of `Response` the JSON-RPC POST reads. */
export interface McpResponse {
  status: number;
  text: () => Promise<string>;
  headers: { get: (name: string) => string | null };
}

/** Exactly what `rpc` sends. */
export interface McpFetchInit {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
}

export type McpFetch = (url: string, init: McpFetchInit) => Promise<McpResponse>;

/** A JSON-RPC reply, as far as this module cares. */
export interface RpcMessage {
  result?: unknown;
  error?: { message?: string } | undefined;
}

export interface RpcOptions {
  initialize?: boolean;
}

/** `tools/list` through one server. `needsAuth` means 401/403, not a failure. */
export interface McpToolsResult {
  server: PublicServer | null;
  tools: unknown[];
  needsAuth?: boolean;
}

/** `tools/call` through one server. */
export interface McpCallResult {
  server: PublicServer | null;
  result?: unknown;
  needsAuth?: boolean;
}

/** The secret-request card `@sub8/choice` turns into the Connect prompt. */
export interface ConnectCard {
  type: "secret-request";
  secret: {
    label: string;
    description: string;
    connector: "mcp";
    field: string;
  };
}
