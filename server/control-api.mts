/**
 * The control API: a documented, authenticated surface under /api/control/v1
 * that other local apps and agent harnesses use to list, message, watch and
 * stop bots in the running app. See docs/control-api.md.
 *
 * Two checks gate every request, and both must pass:
 *
 *  1. The socket's remote address is loopback. The server already binds
 *     127.0.0.1, so this mostly documents intent and refuses anything that
 *     reaches the socket another way.
 *  2. `Authorization: Bearer <token>`. The token lives in <dataDir>/control.json
 *     (mode 0600) and is separate from the internal token mcp-sub8 uses, so
 *     regenerating one never breaks the other. The data dir is never mounted
 *     into a desk container, so a bot cannot read it. A bot's container does
 *     reach the host API through the VM gateway, and on Lima that traffic can
 *     arrive as loopback, which is why the token is the check that matters.
 *
 * Requests that carry an Origin header (a web page) are refused outright: a
 * harness or CLI never sends one, and there is no reason to let a browser in.
 *
 * The routes reuse the app's own functions (passed in as `deps`) for sending a
 * message, steering a busy turn and stopping, so the control API behaves
 * exactly like the chat box does.
 */
import express from "express";
import type { Request, Response, Router } from "express";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, renameSync, chmodSync } from "node:fs";
import path from "node:path";

export const CONTROL_FILE_VERSION = 1;
export const CONTROL_PREFIX = "/api/control/v1";

/** What <dataDir>/control.json holds. `url` already includes the /api/control/v1 prefix. */
export interface ControlFile {
  url: string;
  token: string;
  version: number;
  enabled: boolean;
}

export interface ControlMessage {
  id?: string;
  role?: string;
  kind?: string;
  content?: string;
  summary?: string;
  hidden?: boolean;
  pending?: boolean;
  ts?: number;
  [k: string]: unknown;
}

export interface ControlBot {
  id: string;
  name?: string;
  description?: string;
  harness?: { provider?: string; model?: string } | undefined;
  vm?: { status?: string; error?: string | null } | null | undefined;
  usageLimit?: { until?: number } | null | undefined;
  teamId?: string;
  messages?: ControlMessage[];
  updatedAt?: number | string;
  [k: string]: unknown;
}

export interface ControlDeps {
  dataDir: string;
  port: number;
  appVersion: () => string;
  loadBots: () => Promise<ControlBot[]>;
  getBot: (id: string) => Promise<ControlBot | null>;
  /** Ids whose turn is running right now. Memory only, cheap to call often. */
  busyIds: () => Iterable<string>;
  /** True when the bot has an active usage limit (routines paused). */
  limited?: (bot: ControlBot) => boolean;
  /** The chat box's send: starts a turn when idle, steers when busy. */
  send: (botId: string, text: string) => Promise<{ id: string; ts: number; queued: boolean }>;
  /** The Stop button. */
  stop: (botId: string) => Promise<{ stopped: boolean }>;
  /** Every app broadcast (event name + payload). Returns an unsubscribe. */
  subscribe: (fn: (event: string, data: unknown) => void) => () => void;
}

// ---------------------------------------------------------------------------
// control.json

export function controlFilePath(dataDir: string): string {
  return path.join(dataDir, "control.json");
}

function newToken(): string {
  return `s8c_${randomBytes(24).toString("base64url")}`;
}

function validToken(t: unknown): t is string {
  return typeof t === "string" && /^s8c_[A-Za-z0-9_-]{24,}$/.test(t);
}

function writeControlFile(dataDir: string, rec: ControlFile): void {
  const file = controlFilePath(dataDir);
  mkdirSync(dataDir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(rec, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    /* best effort on filesystems without modes */
  }
}

function readControlFile(dataDir: string): Partial<ControlFile> | null {
  try {
    const raw = JSON.parse(readFileSync(controlFilePath(dataDir), "utf8"));
    return raw && typeof raw === "object" ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Load control.json, creating it (with a fresh token) on first use. The URL is
 * rewritten when the port changed since it was last written, so a harness that
 * reads the file always gets the live address.
 */
export function ensureControlFile(dataDir: string, port: number): ControlFile {
  const url = `http://127.0.0.1:${port}${CONTROL_PREFIX}`;
  const prev = readControlFile(dataDir);
  const rec: ControlFile = {
    url,
    token: validToken(prev?.token) ? prev.token : newToken(),
    version: CONTROL_FILE_VERSION,
    enabled: prev?.enabled === false ? false : true,
  };
  if (!prev || prev.url !== rec.url || prev.token !== rec.token || prev.version !== rec.version || prev.enabled !== rec.enabled) {
    writeControlFile(dataDir, rec);
  }
  return rec;
}

export function setControlEnabled(dataDir: string, port: number, enabled: boolean): ControlFile {
  const rec = { ...ensureControlFile(dataDir, port), enabled: Boolean(enabled) };
  writeControlFile(dataDir, rec);
  return rec;
}

export function regenerateControlToken(dataDir: string, port: number): ControlFile {
  const rec = { ...ensureControlFile(dataDir, port), token: newToken() };
  writeControlFile(dataDir, rec);
  return rec;
}

/** The last four characters, for a masked display. Never the token itself. */
export function tokenHint(token: string): string {
  return token ? `…${token.slice(-4)}` : "";
}

// ---------------------------------------------------------------------------
// Request gate

export function isLoopback(addr: string | undefined | null): boolean {
  const a = String(addr || "");
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1" || /^127\.\d+\.\d+\.\d+$/.test(a) || /^::ffff:127\.\d+\.\d+\.\d+$/.test(a);
}

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function fail(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ ok: false, error: { code, message } });
}

/**
 * Loopback, no browser Origin, switched on, and the right bearer token, in
 * that order. Exported so the tests can drive it with a fake socket address.
 */
export function controlGate(deps: Pick<ControlDeps, "dataDir" | "port">) {
  return (req: Request, res: Response, next: (err?: unknown) => void): void => {
    if (!isLoopback(req.socket?.remoteAddress)) return fail(res, 403, "forbidden", "control API accepts connections from this computer only");
    if (req.headers.origin) return fail(res, 403, "forbidden", "control API does not accept browser requests");
    const rec = ensureControlFile(deps.dataDir, deps.port);
    if (!rec.enabled) return fail(res, 403, "disabled", "control API is turned off in Sub8 Settings");
    const auth = String(req.headers.authorization || "");
    const m = /^Bearer\s+(\S+)\s*$/i.exec(auth);
    if (!m || !sameSecret(m[1]!, rec.token)) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="sub8-control"');
      return fail(res, 401, "unauthorized", "missing or invalid bearer token; read it from control.json in the Sub8 data folder");
    }
    res.setHeader("Cache-Control", "no-store");
    next();
  };
}

// ---------------------------------------------------------------------------
// Shaping

export type ControlStatus = "idle" | "working" | "paused" | "error";

const PREVIEW = 280;

function preview(s: unknown, n = PREVIEW): string {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function tsOf(m: ControlMessage | undefined): number {
  return Number(m?.ts || 0) || 0;
}

/** A row a person would read in the chat: the user's lines and the bot's replies. */
export function isChatRow(m: ControlMessage): boolean {
  if (!m || m.hidden) return false;
  if (m.role === "user") return true;
  return m.role === "assistant" && (!m.kind || m.kind === "choices" || m.kind === "secret-request" || m.kind === "notice");
}

/** The bot's reply text, ignoring cards and notices. */
function isReply(m: ControlMessage): boolean {
  return Boolean(m && !m.hidden && m.role === "assistant" && !m.kind && String(m.content || "").trim());
}

export function statusOf(bot: ControlBot, busy: boolean, limited: boolean): ControlStatus {
  if (busy) return "working";
  const vmStatus = String(bot.vm?.status || "");
  if (vmStatus === "error" || bot.vm?.error) return "error";
  if (vmStatus === "paused" || limited) return "paused";
  return "idle";
}

export function publicMessage(m: ControlMessage): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: String(m.id || ""),
    role: m.role === "user" ? "user" : m.role === "activity" ? "activity" : "assistant",
    text: String(m.content || ""),
    ts: tsOf(m),
  };
  if (m.kind) out.kind = m.kind;
  if (m.summary) out.summary = String(m.summary);
  if (m.pending) out.pending = true;
  if (Array.isArray(m.choices)) out.choices = (m.choices as { id?: unknown; label?: unknown }[]).map((c) => ({ id: c?.id, label: c?.label }));
  if (m.speakerName) out.speaker = String(m.speakerName);
  return out;
}

export function summarizeBot(bot: ControlBot, busy: boolean, limited: boolean): Record<string, unknown> {
  const msgs = bot.messages || [];
  const status = statusOf(bot, busy, limited);
  let lastReply: ControlMessage | undefined;
  let lastUser: ControlMessage | undefined;
  let lastActivity: ControlMessage | undefined;
  for (let i = msgs.length - 1; i >= 0 && (!lastReply || !lastUser || !lastActivity); i--) {
    const m = msgs[i]!;
    if (!lastReply && isReply(m)) lastReply = m;
    if (!lastUser && m.role === "user" && !m.hidden) lastUser = m;
    if (!lastActivity && m.role === "activity") lastActivity = m;
  }
  const newest = msgs.reduce((n, m) => Math.max(n, tsOf(m)), 0);
  const updated = Number(bot.updatedAt) || (typeof bot.updatedAt === "string" ? Date.parse(bot.updatedAt) : 0) || newest;
  const turn = status === "working"
    ? {
        request: lastUser ? preview(lastUser.content, 200) : "",
        requestAt: tsOf(lastUser) || null,
        doing: lastActivity && tsOf(lastActivity) >= tsOf(lastUser) ? preview(lastActivity.summary || lastActivity.content, 200) : "",
      }
    : null;
  return {
    id: bot.id,
    name: String(bot.name || ""),
    description: String(bot.description || ""),
    provider: String(bot.harness?.provider || "default"),
    model: String(bot.harness?.model || ""),
    location: "local",
    status,
    turn,
    lastReply: lastReply ? { id: String(lastReply.id || ""), text: preview(lastReply.content), ts: tsOf(lastReply) } : null,
    teamId: bot.teamId || null,
    updatedAt: updated || null,
  };
}

// ---------------------------------------------------------------------------
// Event fan-out (SSE and long-poll share it)

type Listener = (ev: { type: string; data: Record<string, unknown> }) => void;

/**
 * Watches app broadcasts and the in-memory busy set, and turns them into two
 * control events: `status` (a bot's status changed) and `message` (a new chat
 * row). Runs only while someone is listening.
 */
class ControlEvents {
  private listeners = new Set<Listener>();
  private unsub: (() => void) | null = null;
  private poll: NodeJS.Timeout | null = null;
  private busy = new Set<string>();
  private status = new Map<string, ControlStatus>();
  private seen = new Map<string, Set<string>>();
  constructor(private deps: ControlDeps) {}

  add(fn: Listener): () => void {
    this.listeners.add(fn);
    if (this.listeners.size === 1) this.start();
    return () => {
      this.listeners.delete(fn);
      if (!this.listeners.size) this.end();
    };
  }

  private emit(type: string, data: Record<string, unknown>): void {
    for (const fn of [...this.listeners]) {
      try {
        fn({ type, data });
      } catch {
        /* a broken listener must not stop the others */
      }
    }
  }

  private markSeen(botId: string, id: string): boolean {
    let s = this.seen.get(botId);
    if (!s) this.seen.set(botId, (s = new Set()));
    if (s.has(id)) return false;
    s.add(id);
    if (s.size > 400) s.delete(s.values().next().value as string);
    return true;
  }

  private start(): void {
    this.busy = new Set(this.deps.busyIds());
    this.unsub = this.deps.subscribe((event, data) => this.onBroadcast(event, data));
    // Busy flips are memory only; a light poll catches the ones no broadcast names.
    this.poll = setInterval(() => this.checkBusy(), 400);
    this.poll.unref?.();
  }

  private end(): void {
    this.unsub?.();
    this.unsub = null;
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
  }

  private checkBusy(): void {
    const now = new Set(this.deps.busyIds());
    for (const id of now) if (!this.busy.has(id)) this.setStatus(id, "working");
    for (const id of this.busy) {
      if (!now.has(id)) {
        // The row decides between idle, paused and error.
        this.deps.getBot(id).then((b) => b && this.botChanged(b)).catch(() => {});
      }
    }
    this.busy = now;
  }

  private setStatus(botId: string, status: ControlStatus, bot?: ControlBot): void {
    if (this.status.get(botId) === status) return;
    this.status.set(botId, status);
    this.emit("status", { botId, status, ...(bot ? { bot: summarizeBot(bot, status === "working", status === "paused") } : {}), ts: Date.now() });
  }

  private botChanged(bot: ControlBot): void {
    const busy = new Set(this.deps.busyIds()).has(bot.id);
    const limited = this.deps.limited ? this.deps.limited(bot) : false;
    this.setStatus(bot.id, statusOf(bot, busy, limited), bot);
    const known = this.seen.has(bot.id);
    for (const m of bot.messages || []) {
      if (!isChatRow(m) || !m.id) continue;
      // First sight of a bot primes the seen set instead of replaying its history.
      if (this.markSeen(bot.id, String(m.id)) && known) this.emit("message", { botId: bot.id, message: publicMessage(m) });
    }
  }

  private onBroadcast(event: string, data: unknown): void {
    if (event === "bot" && data && typeof data === "object" && (data as ControlBot).id) {
      this.botChanged(data as ControlBot);
    } else if (event === "bots" && Array.isArray(data)) {
      for (const b of data) if (b?.id) this.botChanged(b as ControlBot);
    } else if (event === "message" && data && typeof data === "object") {
      const m = data as ControlMessage & { botId?: string };
      if (!m.botId || !m.id || !isChatRow(m)) return;
      if (!this.seen.has(m.botId)) this.seen.set(m.botId, new Set());
      if (this.markSeen(m.botId, String(m.id))) this.emit("message", { botId: m.botId, message: publicMessage(m) });
    }
  }
}

// ---------------------------------------------------------------------------
// Router

export interface WaitResult {
  done: boolean;
  timedOut: boolean;
  status: ControlStatus;
  reply: Record<string, unknown> | null;
  replies: Record<string, unknown>[];
}

const MAX_WAIT_MS = 10 * 60 * 1000;
const DEFAULT_WAIT_MS = 120 * 1000;
/** A turn that produced no reply counts as finished after the bot sits idle this long. */
const IDLE_SETTLE_MS = 3000;

export function controlRouter(deps: ControlDeps): Router {
  const router = express.Router();
  const events = new ControlEvents(deps);
  const isBusy = (id: string): boolean => new Set(deps.busyIds()).has(id);
  const limited = (b: ControlBot): boolean => (deps.limited ? deps.limited(b) : false);

  router.use(controlGate(deps));

  /** Resolve :bot by id first, then by case-insensitive exact name. */
  async function findBot(key: string): Promise<ControlBot | null | "ambiguous"> {
    const k = String(key || "");
    if (!k) return null;
    const byId = await deps.getBot(k).catch(() => null);
    if (byId) return byId;
    const all = await deps.loadBots();
    const hits = all.filter((b) => String(b.name || "").toLowerCase() === k.toLowerCase());
    if (hits.length > 1) return "ambiguous";
    return hits[0] ? (await deps.getBot(hits[0].id)) || hits[0] : null;
  }

  async function botOr404(req: Request, res: Response): Promise<ControlBot | null> {
    const bot = await findBot(String(req.params.bot || ""));
    if (bot === "ambiguous") {
      fail(res, 409, "ambiguous", "more than one bot has that name; use its id");
      return null;
    }
    if (!bot) {
      fail(res, 404, "not_found", "no bot with that id or name");
      return null;
    }
    return bot;
  }

  async function waitFor(botId: string, since: number, timeoutMs: number, signal?: AbortSignal): Promise<WaitResult> {
    const deadline = Date.now() + timeoutMs;
    let idleSince = isBusy(botId) ? 0 : Date.now();
    let sawBusy = isBusy(botId);
    while (true) {
      const busy = isBusy(botId);
      if (busy) {
        sawBusy = true;
        idleSince = 0;
      } else if (!idleSince) idleSince = Date.now();
      if (!busy) {
        const bot = await deps.getBot(botId);
        if (!bot) return { done: true, timedOut: false, status: "error", reply: null, replies: [] };
        const replies = (bot.messages || []).filter((m) => isReply(m) && tsOf(m) > since);
        const settled = Date.now() - idleSince >= IDLE_SETTLE_MS && (sawBusy || Date.now() - since >= IDLE_SETTLE_MS);
        // A reply after `since` with the bot idle is the answer; a turn may also
        // end quietly, which is "done" once the bot has stayed idle a moment.
        if ((replies.length && Date.now() - idleSince >= 300) || settled) {
          const st = statusOf(bot, false, limited(bot));
          return { done: true, timedOut: false, status: st, reply: replies.length ? publicMessage(replies.at(-1)!) : null, replies: replies.map(publicMessage) };
        }
      }
      if (Date.now() >= deadline || signal?.aborted) {
        const bot = await deps.getBot(botId);
        return { done: false, timedOut: true, status: bot ? statusOf(bot, isBusy(botId), limited(bot)) : "error", reply: null, replies: [] };
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  function waitMs(v: unknown): number {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_WAIT_MS;
    return Math.min(MAX_WAIT_MS, Math.max(100, Math.round(n)));
  }

  function abortOnClose(req: Request, res: Response): AbortSignal {
    const ac = new AbortController();
    res.on("close", () => ac.abort());
    req.on("aborted", () => ac.abort());
    return ac.signal;
  }

  router.get("/status", async (_req, res) => {
    const bots = await deps.loadBots();
    const busy = new Set(deps.busyIds());
    const counts: Record<ControlStatus, number> = { idle: 0, working: 0, paused: 0, error: 0 };
    for (const b of bots) counts[statusOf(b, busy.has(b.id), limited(b))]++;
    res.json({ ok: true, app: "Sub8", version: deps.appVersion(), api: CONTROL_FILE_VERSION, bots: { total: bots.length, ...counts } });
  });

  router.get("/bots", async (_req, res) => {
    const bots = await deps.loadBots();
    const busy = new Set(deps.busyIds());
    res.json({ ok: true, bots: bots.map((b) => summarizeBot(b, busy.has(b.id), limited(b))) });
  });

  router.get("/bots/:bot", async (req, res) => {
    const bot = await botOr404(req, res);
    if (!bot) return;
    const recent = (bot.messages || []).filter(isChatRow).slice(-10).map(publicMessage);
    res.json({ ok: true, bot: { ...summarizeBot(bot, isBusy(bot.id), limited(bot)), recent } });
  });

  router.get("/bots/:bot/messages", async (req, res) => {
    const bot = await botOr404(req, res);
    if (!bot) return;
    const since = Number(req.query.since || 0) || 0;
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 50));
    const withActivity = ["1", "true", "yes"].includes(String(req.query.activity || "").toLowerCase());
    const rows = (bot.messages || []).filter((m) => (isChatRow(m) || (withActivity && m.role === "activity")) && tsOf(m) > since);
    const page = rows.slice(-limit);
    res.json({ ok: true, botId: bot.id, messages: page.map(publicMessage), hasMore: rows.length > page.length });
  });

  router.post("/bots/:bot/messages", async (req, res) => {
    const bot = await botOr404(req, res);
    if (!bot) return;
    const text = String(req.body?.text ?? req.body?.content ?? "").trim();
    if (!text) return fail(res, 400, "bad_request", "body must be JSON with a non-empty \"text\"");
    if (text.length > 100_000) return fail(res, 413, "too_large", "text is longer than 100000 characters");
    const wasBusy = isBusy(bot.id);
    const sent = await deps.send(bot.id, text);
    const out: Record<string, unknown> = { ok: true, botId: bot.id, messageId: sent.id, ts: sent.ts, delivery: sent.queued || wasBusy ? "steered" : "started" };
    const wantWait = req.body?.wait === true || ["1", "true", "yes"].includes(String(req.query.wait || "").toLowerCase());
    if (wantWait) {
      out.wait = await waitFor(bot.id, sent.ts, waitMs(req.body?.timeoutMs ?? req.query.timeoutMs), abortOnClose(req, res));
    }
    if (!res.headersSent && !res.writableEnded) res.json(out);
  });

  router.post("/bots/:bot/stop", async (req, res) => {
    const bot = await botOr404(req, res);
    if (!bot) return;
    const r = await deps.stop(bot.id);
    res.json({ ok: true, botId: bot.id, stopped: r.stopped });
  });

  const waitRoute = async (req: Request, res: Response): Promise<void> => {
    const bot = await botOr404(req, res);
    if (!bot) return;
    let since = Number(req.query.since ?? req.body?.since);
    if (!Number.isFinite(since) || since <= 0) {
      // Default: wait for the answer to the latest thing the user said.
      const lastUser = [...(bot.messages || [])].reverse().find((m) => m.role === "user");
      since = tsOf(lastUser);
    }
    const r = await waitFor(bot.id, since, waitMs(req.query.timeoutMs ?? req.body?.timeoutMs), abortOnClose(req, res));
    if (!res.writableEnded) res.json({ ok: true, botId: bot.id, ...r });
  };
  router.post("/bots/:bot/wait", waitRoute);
  router.get("/bots/:bot/wait", waitRoute);

  router.get("/events", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
    const only = String(req.query.bot || "");
    const write = (type: string, data: unknown) => {
      try {
        res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch {
        /* closed */
      }
    };
    write("hello", { ts: Date.now(), version: deps.appVersion() });
    const off = events.add(({ type, data }) => {
      if (only && data.botId !== only) return;
      write(type, data);
    });
    const iv = setInterval(() => {
      try {
        res.write(`: keepalive ${Date.now()}\n\n`);
      } catch {
        /* closed */
      }
    }, 15_000);
    res.on("close", () => {
      clearInterval(iv);
      off();
    });
  });

  router.use((_req: Request, res: Response) => fail(res, 404, "not_found", "no such control API route"));
  return router;
}
