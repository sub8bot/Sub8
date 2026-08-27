/** Local/cloud desk-harness client: GET /health + POST /turn NDJSON. */

export const BRAIN_STARTING = "desk brain starting";

/**
 * The bot fields these helpers read. Deliberately structural and minimal, the
 * same way server/isolation.mts does it: callers hand over the whole bot
 * record, which is far wider than this and still untyped at most call sites.
 * The ports are read through Number(), so a string port stays legal.
 */
export interface HarnessBot {
  vm?:
    | {
        harnessPort?: number | string | undefined;
        hostHarnessPort?: number | string | undefined;
      }
    | undefined;
}

/**
 * GET /health. Open-ended because the desk-harness answers with more than the
 * three flags this file gates on, and callers pass the body straight through.
 */
export interface HarnessHealth {
  ok?: boolean | undefined;
  harness?: boolean | undefined;
  grok?: boolean | undefined;
  [key: string]: unknown;
}

/** One NDJSON line off /turn. `type` and `content` are all this file reads. */
export interface DeskEvent {
  type?: string | undefined;
  content?: string | undefined;
  [key: string]: unknown;
}

export interface HarnessTimeout {
  timeoutMs?: number | undefined;
}

export interface HarnessStopOptions extends HarnessTimeout {
  url?: string | undefined;
  token?: string | undefined;
  botId?: string | undefined;
}

/**
 * POST /stop. `stopped` is read through Number(), so an older desk answering a
 * string still counts.
 */
export interface DeskStopBody {
  ok?: boolean | undefined;
  stopped?: unknown;
}

/**
 * `runDeskTurn`'s fetch init is asserted `as RequestInit`, and so is
 * `harnessStop`'s JSON body. RequestInit declares `signal?: AbortSignal | null`
 * with no `| undefined`, so under exactOptionalPropertyTypes forwarding an
 * absent signal -- which every caller that does not pass one does -- is an
 * error against a lib type we do not own. fetch treats an absent and an
 * undefined signal identically. The assertion adds no runtime instruction.
 */
export interface DeskTurnOptions {
  url?: string | undefined;
  token?: string | undefined;
  body?: unknown;
  onEvent?: ((ev: DeskEvent) => void) | undefined;
  signal?: AbortSignal | undefined;
}

/** What `ensure` may hand back. Only `url` and `via` are read; the rest is spread through. */
export interface EnsuredHarness {
  url?: string | undefined;
  via?: string | undefined;
  [key: string]: unknown;
}

export interface ResolveHarnessOptions {
  bot?: HarnessBot | null | undefined;
  token?: string | undefined;
  ensure?: ((arg: { token?: string | undefined; bot?: HarnessBot | null | undefined }) => EnsuredHarness | null | undefined | Promise<EnsuredHarness | null | undefined>) | undefined;
  mappedPort?: number | string | undefined;
}

export function harnessUrlFor(bot?: HarnessBot | null): string | null {
  const port = Number(bot?.vm?.harnessPort || bot?.vm?.hostHarnessPort || 0);
  if (!port) return null;
  return `http://127.0.0.1:${port}`;
}

export async function harnessStatus(url?: string | null, { timeoutMs = 1500 }: HarnessTimeout = {}): Promise<HarnessHealth | null> {
  if (!url) return null;
  try {
    const res = await fetch(`${String(url).replace(/\/$/, "")}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const body = await res.json().catch(() => ({}));
    return body && typeof body === "object" ? (body as HarnessHealth) : null;
  } catch {
    return null;
  }
}

export async function harnessHealthy(url?: string | null, { timeoutMs = 1500 }: HarnessTimeout = {}): Promise<boolean> {
  const body = await harnessStatus(url, { timeoutMs });
  return Boolean(body?.ok && body?.harness);
}

/** Prefer /turn only when grok is actually on the desk. */
export async function harnessCanTurn(url?: string | null, { timeoutMs = 1500 }: HarnessTimeout = {}): Promise<boolean> {
  const body = await harnessStatus(url, { timeoutMs });
  return Boolean(body?.ok && body?.harness && body?.grok === true);
}

/**
 * Stop the work this desk is running for a bot.
 *
 * Same shape as the cloud client (cloud/src/harness-client.mjs harnessStop ->
 * desk-harness POST /stop): aborting on the host only stops the host reading
 * the /turn stream — without this the grok child keeps running inside the desk
 * long after the user pressed Stop. A local desk is shared by a team, so the
 * stop is scoped to one botId. Best effort: never throws, and an older desk
 * whose harness has no /stop just answers 404.
 */
export async function harnessStop({ url, token, botId, timeoutMs = 4000 }: HarnessStopOptions = {}): Promise<{ ok: boolean; stopped: number }> {
  const base = String(url || "").replace(/\/$/, "");
  if (!base || !token) return { ok: false, stopped: 0 };
  try {
    const res = await fetch(`${base}/stop`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(botId ? { botId } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, stopped: 0 };
    const body = (await res.json().catch(() => ({}))) as DeskStopBody;
    return { ok: body?.ok !== false, stopped: Number(body?.stopped) || 0 };
  } catch {
    return { ok: false, stopped: 0 };
  }
}

/** Status line is for in-desk grok /turn only — never Mac CLI fallback. */
export function shouldAnnounceDeskBrain({ via, grok }: { via?: unknown; grok?: unknown } = {}): boolean {
  return String(via || "") === "desk" && grok === true;
}

export function deskTurnFailed(events: (DeskEvent | null | undefined)[] = [], content: unknown = ""): boolean {
  if (String(content || "").trim()) return false;
  return (events || []).some((e) => e && e.type === "error");
}

export async function runDeskTurn({ url, token, body, onEvent, signal }: DeskTurnOptions = {}): Promise<{ content: string }> {
  const base = String(url || "").replace(/\/$/, "");
  if (!base) throw new Error("harness url required");
  const res = await fetch(`${base}/turn`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token || ""}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body || {}),
    signal,
  } as RequestInit);
  if (res.status === 401) throw new Error("desk harness: bad token");
  if (!res.ok) throw new Error(`desk harness HTTP ${res.status}`);
  const reader = res.body?.getReader?.();
  if (!reader) {
    const text = await res.text();
    return consumeNdjson(text, onEvent);
  }
  const decoder = new TextDecoder();
  let buf = "";
  let doneContent = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() || "";
    for (const line of lines) {
      const ev = parseNdjsonLine(line);
      if (!ev) continue;
      if (ev.type === "done") doneContent = ev.content || doneContent;
      if (typeof onEvent === "function") onEvent(ev);
    }
  }
  if (buf.trim()) {
    const ev = parseNdjsonLine(buf);
    if (ev) {
      if (ev.type === "done") doneContent = ev.content || doneContent;
      if (typeof onEvent === "function") onEvent(ev);
    }
  }
  return { content: doneContent };
}

function parseNdjsonLine(line: unknown): DeskEvent | null {
  const s = String(line || "").trim();
  if (!s) return null;
  try {
    const ev = JSON.parse(s);
    return ev && typeof ev === "object" ? (ev as DeskEvent) : null;
  } catch {
    return null;
  }
}

function consumeNdjson(text: unknown, onEvent: ((ev: DeskEvent) => void) | undefined): { content: string } {
  let doneContent = "";
  for (const line of String(text || "").split("\n")) {
    const ev = parseNdjsonLine(line);
    if (!ev) continue;
    if (ev.type === "done") doneContent = ev.content || doneContent;
    if (typeof onEvent === "function") onEvent(ev);
  }
  return { content: doneContent };
}

/**
 * Prefer the in-desk :3011 mapping, then a host-side harness, else null.
 * `ensure` may start a loopback supervisor (desk-harness/local.mjs).
 */
export async function resolveHarness({ bot, token, ensure, mappedPort }: ResolveHarnessOptions = {}) {
  const mapped = Number(bot?.vm?.harnessPort || mappedPort || 0);
  if (mapped) {
    const url = `http://127.0.0.1:${mapped}`;
    if (await harnessHealthy(url)) return { url, token, via: "desk", port: mapped };
  }
  const hostPort = Number(bot?.vm?.hostHarnessPort || 0);
  if (hostPort) {
    const url = `http://127.0.0.1:${hostPort}`;
    if (await harnessHealthy(url)) return { url, token, via: "host", port: hostPort };
  }
  if (typeof ensure === "function") {
    const started = await ensure({ token, bot });
    if (started?.url && (await harnessHealthy(started.url))) return { ...started, via: started.via || "host" };
  }
  return null;
}
