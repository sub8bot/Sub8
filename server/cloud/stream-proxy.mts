import { createRequire } from "node:module";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import { useMockAuth } from "./env.mjs";

const require = createRequire(import.meta.url);
const wsMod = require("ws") as {
  WebSocket: {
    new (url: string, opts?: { headers?: Record<string, string> }): WsSock;
    OPEN: number;
  };
  WebSocketServer: { new (opts: { noServer: boolean }): WsServer };
};
const WsClient = wsMod.WebSocket;
const WsServerCtor = wsMod.WebSocketServer;

interface WsSock {
  readyState: number;
  send: (data: unknown, opts?: { binary?: boolean }) => void;
  close: () => void;
  on: (ev: string, fn: (...args: unknown[]) => void) => void;
  once: (ev: string, fn: (...args: unknown[]) => void) => void;
}

interface WsServer {
  handleUpgrade: (
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    cb: (client: WsSock) => void,
  ) => void;
}

type StreamReq = { url?: string; headers: { accept?: string | string[] } };
type StreamRes = {
  status: (n: number) => StreamRes;
  type: (t: string) => StreamRes;
  send: (b: string) => void;
  json: (b: unknown) => void;
  setHeader: (k: string, v: string) => void;
  end: (b?: Buffer) => void;
};
type StreamApp = {
  get: (path: string, handler: (req: StreamReq, res: StreamRes, next: (err?: unknown) => void) => void) => unknown;
};

export function parseCloudStreamPath(urlPath: string | null | undefined): { computerId: string; rest: string } | null {
  // Older noVNC builds the socket URL as host + "/" + path ("//api/..."), newer
  // ones resolve `path` against the page, so it comes back doubled:
  // /api/cloud/stream/<id>/api/cloud/stream/<id>/websockify. Accept all three.
  const pathOnly = (String(urlPath || "").split("?")[0] || "").replace(/^\/{2,}/, "/");
  const m = /^\/api\/cloud\/stream\/([^/]+)(?:\/(.*))?$/.exec(pathOnly);
  if (!m) return null;
  let rest = String(m[2] || "").replace(/^\/+/, "");
  const again = `api/cloud/stream/${m[1]}/`;
  while (rest.startsWith(again)) rest = rest.slice(again.length);
  // A malformed escape (`%E0`) throws URIError, and this runs synchronously in
  // the server's 'upgrade' listener, where a throw is an uncaught exception.
  let computerId: string;
  try {
    computerId = decodeURIComponent(String(m[1] || ""));
  } catch {
    return null;
  }
  // `rest` is appended to /api/desk/<id>/ on the Worker with the user's bearer
  // token; a dot segment would climb out of that desk to any other GET route.
  if (rest.split("?")[0]!.split("/").some((seg) => /^(\.|%2e){1,2}$/i.test(seg))) return null;
  return { computerId, rest: rest || "vnc.html" };
}

export function isCloudStreamWsPath(urlPath: string | null | undefined): boolean {
  const p = parseCloudStreamPath(urlPath);
  return Boolean(p && p.rest.split("?")[0] === "websockify");
}

export function workerDeskAssetUrl(
  base: string,
  computerId: string,
  rest: string,
  { display }: { display?: unknown } = {},
): string {
  const origin = String(base || "").replace(/\/+$/, "");
  const id = encodeURIComponent(computerId);
  let path = String(rest || "vnc.html").replace(/^\/+/, "");
  if (!path) path = "vnc.html";
  const url = new URL(`${origin}/api/desk/${id}/${path}`);
  const n = Number(display);
  if (Number.isFinite(n) && n > 1) url.searchParams.set("display", String(n));
  return url.toString();
}

export interface CloudStreamProxyOpts {
  getToken: () => Promise<string>;
  cloudBase: () => string;
}

function displayOf(reqUrl: string): string {
  try {
    return new URL(reqUrl, "http://127.0.0.1").searchParams.get("display") || "1";
  } catch {
    return "1";
  }
}

async function proxyAsset(req: StreamReq, res: StreamRes, opts: CloudStreamProxyOpts): Promise<void> {
  const parsed = parseCloudStreamPath(String(req.url || "").split("?")[0]);
  if (!parsed) {
    res.status(404).end();
    return;
  }
  if (parsed.rest.split("?")[0] === "websockify") {
    res.status(426).type("text/plain").send("expected a websocket upgrade");
    return;
  }
  const base = opts.cloudBase();
  if (!base || base === "mock" || useMockAuth()) {
    res.status(404).json({ error: "Cloud stream proxy is off." });
    return;
  }
  const token = String((await opts.getToken()) || "");
  if (!token) {
    res.status(401).json({ error: "Sign in." });
    return;
  }
  const display = displayOf(String(req.url || ""));
  const asset = await fetchDeskAsset(base, token, parsed.computerId, parsed.rest, display, String(req.headers.accept || "*/*"));
  res.status(asset.status);
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  res.setHeader("Pragma", "no-cache");
  if (asset.type) res.setHeader("Content-Type", asset.type);
  res.end(asset.body);
}

/**
 * noVNC is ~90 small static files, each a round trip Mac -> Worker -> raw TCP
 * -> droplet (2-10s apiece), loaded as an ES module waterfall. Uncached, the
 * viewer took 20s+ to open and sat on "Connecting...". The files are the
 * container's own noVNC and never change while it runs, so keep successful
 * responses per desk, and when a module arrives, start fetching its imports so
 * the waterfall happens here in parallel instead of one level at a time.
 */
type DeskAsset = { status: number; type: string; body: Buffer; at: number };
const ASSET_TTL_MS = 6 * 60 * 60_000;
const ASSET_CACHE_MAX_BYTES = 40 * 1024 * 1024;
const assetCache = new Map<string, DeskAsset>();
const assetInflight = new Map<string, Promise<DeskAsset>>();
let assetCacheBytes = 0;

function assetKey(computerId: string, rest: string): string {
  return `${computerId}|${rest.split("?")[0]}`;
}

function rememberAsset(key: string, a: DeskAsset): void {
  const old = assetCache.get(key);
  if (old) assetCacheBytes -= old.body.length;
  assetCache.set(key, a);
  assetCacheBytes += a.body.length;
  for (const [k, v] of assetCache) {
    if (assetCacheBytes <= ASSET_CACHE_MAX_BYTES) break;
    assetCache.delete(k);
    assetCacheBytes -= v.body.length;
  }
}

function moduleImports(rest: string, body: Buffer): string[] {
  const path = rest.split("?")[0] || "";
  if (!/\.m?js$/.test(path)) return [];
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
  const out = new Set<string>();
  const re = /(?:import|export)\s[^'"]*?from\s*['"](\.{1,2}\/[^'"]+)['"]|import\s*['"](\.{1,2}\/[^'"]+)['"]/g;
  const text = body.toString("utf8");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const rel = m[1] || m[2] || "";
    const parts = (dir + rel).split("/");
    const stack: string[] = [];
    for (const seg of parts) {
      if (seg === "." || seg === "") continue;
      if (seg === "..") stack.pop();
      else stack.push(seg);
    }
    if (stack.length) out.add(stack.join("/"));
  }
  return [...out];
}

async function fetchDeskAsset(
  base: string,
  token: string,
  computerId: string,
  rest: string,
  display: string,
  accept = "*/*",
): Promise<DeskAsset> {
  const key = assetKey(computerId, rest);
  const hit = assetCache.get(key);
  if (hit && Date.now() - hit.at < ASSET_TTL_MS) return hit;
  const running = assetInflight.get(key);
  if (running) return running;
  const job = (async (): Promise<DeskAsset> => {
    const upstream = await fetch(workerDeskAssetUrl(base, computerId, rest, { display }), {
      headers: { Authorization: `Bearer ${token}`, Accept: accept },
      signal: AbortSignal.timeout(15_000),
    });
    const a: DeskAsset = {
      status: upstream.status,
      type: upstream.headers.get("content-type") || "",
      body: Buffer.from(await upstream.arrayBuffer()),
      at: Date.now(),
    };
    if (a.status === 200) {
      rememberAsset(key, a);
      for (const dep of moduleImports(rest, a.body)) {
        if (!assetCache.has(assetKey(computerId, dep))) {
          fetchDeskAsset(base, token, computerId, dep, display).catch(() => {});
        }
      }
    }
    return a;
  })();
  assetInflight.set(key, job);
  try {
    return await job;
  } finally {
    assetInflight.delete(key);
  }
}

function wsUrl(httpUrl: string): string {
  if (httpUrl.startsWith("https:")) return `wss:${httpUrl.slice(6)}`;
  if (httpUrl.startsWith("http:")) return `ws:${httpUrl.slice(5)}`;
  return httpUrl;
}

function pipeSockets(a: WsSock, b: WsSock): void {
  const send = (from: WsSock, to: WsSock) => {
    from.on("message", (...args: unknown[]) => {
      const data = args[0];
      const isBinary = Boolean(args[1]);
      if (to.readyState === WsClient.OPEN) to.send(data, { binary: isBinary });
    });
    from.on("close", () => {
      try {
        to.close();
      } catch {
        /* ignore */
      }
    });
    from.on("error", () => {
      try {
        to.close();
      } catch {
        /* ignore */
      }
    });
  };
  send(a, b);
  send(b, a);
}

/** Same-origin noVNC for the desktop Cloud pane: assets + RFB over the Worker session. */
export function attachCloudStreamProxy(app: StreamApp, httpServer: HttpServer, opts: CloudStreamProxyOpts): void {
  // These routes are registered after index.mts's apiErrorHandler (they need
  // the http server), so next(err) reached express's finalhandler, which puts
  // err.stack in the body. Answer the failure here instead.
  const failed = (res: StreamRes) => (err: unknown) => {
    console.error("[api] cloud stream failed:", (err as Error)?.message || err);
    try {
      res.status(502).json({ ok: false, error: String((err as Error)?.message || "cloud stream failed") });
    } catch {
      /* headers already sent */
    }
  };
  app.get("/api/cloud/stream/:computerId", (req, res) => {
    proxyAsset(req, res, opts).catch(failed(res));
  });
  app.get("/api/cloud/stream/:computerId/*asset", (req, res) => {
    proxyAsset(req, res, opts).catch(failed(res));
  });

  const wss = new WsServerCtor({ noServer: true });
  httpServer.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    // Node drops its own socket 'error' listener before emitting 'upgrade', so
    // a client that resets while the token is fetched (or on any path this
    // proxy does not own) raised an unhandled 'error' and killed the server.
    socket.on("error", () => {});
    const url = String(req.url || "");
    if (!isCloudStreamWsPath(url)) {
      // Nothing else answers upgrades; an unanswered one held the socket open.
      if (httpServer.listenerCount("upgrade") === 1) socket.destroy();
      return;
    }
    const parsed = parseCloudStreamPath(url);
    if (!parsed) {
      socket.destroy();
      return;
    }
    const base = opts.cloudBase();
    if (!base || base === "mock" || useMockAuth()) {
      socket.destroy();
      return;
    }
    void (async () => {
      const token = String((await opts.getToken()) || "");
      if (!token) {
        socket.destroy();
        return;
      }
      const target = wsUrl(workerDeskAssetUrl(base, parsed.computerId, "websockify", { display: displayOf(url) }));
      wss.handleUpgrade(req, socket, head, (client: WsSock) => {
        const upstream = new WsClient(target, { headers: { Authorization: `Bearer ${token}` } });
        // pipeSockets only listens once the upstream opens. Until then a
        // client error was an unhandled 'error', and a client that left
        // stranded the upstream connection.
        const dropUpstream = () => {
          try {
            upstream.close();
          } catch {
            /* ignore */
          }
        };
        client.on("error", dropUpstream);
        client.on("close", dropUpstream);
        const open = () => pipeSockets(client, upstream);
        if (upstream.readyState === WsClient.OPEN) open();
        else upstream.once("open", open);
        upstream.on("error", () => {
          try {
            client.close();
          } catch {
            /* ignore */
          }
        });
      });
    })().catch(() => {
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
    });
  });
}
