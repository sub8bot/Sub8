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
  const pathOnly = String(urlPath || "").split("?")[0] || "";
  const m = /^\/api\/cloud\/stream\/([^/]+)(?:\/(.*))?$/.exec(pathOnly);
  if (!m) return null;
  const rest = String(m[2] || "").replace(/^\/+/, "");
  return { computerId: decodeURIComponent(String(m[1] || "")), rest: rest || "vnc.html" };
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
  const target = workerDeskAssetUrl(base, parsed.computerId, parsed.rest, { display: displayOf(String(req.url || "")) });
  const upstream = await fetch(target, {
    headers: { Authorization: `Bearer ${token}`, Accept: String(req.headers.accept || "*/*") },
    signal: AbortSignal.timeout(15_000),
  });
  res.status(upstream.status);
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  res.setHeader("Pragma", "no-cache");
  const ct = upstream.headers.get("content-type");
  if (ct) res.setHeader("Content-Type", ct);
  res.end(Buffer.from(await upstream.arrayBuffer()));
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
  app.get("/api/cloud/stream/:computerId", (req, res, next) => {
    proxyAsset(req, res, opts).catch(next);
  });
  app.get("/api/cloud/stream/:computerId/*asset", (req, res, next) => {
    proxyAsset(req, res, opts).catch(next);
  });

  const wss = new WsServerCtor({ noServer: true });
  httpServer.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = String(req.url || "");
    if (!isCloudStreamWsPath(url)) return;
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
