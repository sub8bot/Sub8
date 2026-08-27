#!/usr/bin/env node
/**
 * Sub8 desk-harness HTTP service — Phase 1 prototype.
 *
 * Runs ON a desk droplet. Exposes ONE endpoint the DeskTurn DO already knows how
 * to drive (via sub8-cloud/src/executor-client.mjs), but instead of the
 * reimplemented pi loop it runs the REAL grok-build harness (harness.mjs).
 *
 *   GET  /health   → { ok, harness:true, grok, mcp, tools }  (no auth; readiness probe)
 *                    `mcp`/`tools` come from a REAL cached mcp-sub8 handshake:
 *                    ok+harness+grok only ever proved the HTTP listener and the
 *                    grok binary, so a desk whose mcp-sub8 was dead answered
 *                    green for three days while every turn ran with zero tools.
 *                    Both are OMITTED until the first probe lands, because an
 *                    absent field means "unknown" on the wire (harness-protocol
 *                    HarnessHealth) and must never bench a desk.
 *   GET  /claude/auth          → { ok, loggedIn, authMethod }   Bearer <desk token>
 *   POST /claude/auth/start    → { ok, url }                    Bearer <desk token>
 *   POST /claude/auth/code     → { ok, loggedIn }  body {code}   Bearer <desk token>
 *   POST /claude/auth/logout   → { ok, loggedIn:false }          Bearer <desk token>
 *                    Claude subscription login for this desk. login prints a URL,
 *                    then blocks on stdin for the code the user pastes back, so
 *                    the child is parked between start and code.
 *   POST /stop     → { ok, stopped:<n> }               Authorization: Bearer <desk token>
 *                    Kills the grok child for the turns running on this desk.
 *                    Marking a turn "aborted" in the DO only stops the Worker
 *                    from reading more of the stream — without this the child
 *                    keeps running on the droplet until it finishes on its own.
 *   POST /turn     → NDJSON {type:"tool"|"delta"|"done"|"error"}
 *                    Authorization: Bearer <desk token>
 *                    body: the executor / harness-client contract
 *                      { content, history?, system?, display?,
 *                        model:{ provider, id, apiKey, baseUrl },
 *                        callback?:{ url, computerId, botId }, auth? }
 *                    OR the simple shape { botId, text, model, provider, auth }
 *
 * The port (3011) is deliberately DIFFERENT from the pi-executor (3010) so the
 * two can coexist on one droplet during A/B, and so nothing here collides with a
 * running executor. NOTHING starts unless DESK_HARNESS=1 AND an operator runs
 * this file. It is never deployed by these changes.
 *
 *   node server.mjs            # start the service (needs DESK_HARNESS=1)
 *   node server.mjs --selftest # wire-check with a canned stream, no grok/droplet
 */

import http from "node:http";
import fsSync from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { grokBin } from "../host-cli.mjs";
import {
  harnessEnabled,
  probeMcpTools,
  runTurn,
  selftest,
  claudeAuthStatus,
  claudeLoginStart,
  claudeLoginCode,
  claudeLogout,
  claudeExportCredentials,
  claudeImportCredentials,
} from "./harness.mjs";

import type { ChildProcess } from "node:child_process";

const SELFTEST = process.argv.includes("--selftest");
const PORT = Number(process.env.DESK_HARNESS_PORT || 3011);
const TOKEN = process.env.DESK_TOKEN || readTokenFile("/var/lib/sub8/desk-token");
const INTERNAL_TOKEN = process.env.SUB8_INTERNAL_TOKEN || "";

function readTokenFile(p: string): string {
  try {
    return fsSync.readFileSync(p, "utf8").trim();
  } catch {
    return "";
  }
}

/* ------------------------------------------------------------------ probes --
 * /health is polled hard and with short deadlines (local.mjs uses 400/600/800ms,
 * desk-client.mjs defaults to 1500ms), so NOTHING here may run a subprocess on
 * the request path. Both probes are cached: computed once, refreshed off the
 * request path when the TTL expires, and served from the last known value in
 * between. A slow or hung binary can then cost at most one background refresh —
 * never a timed-out health check, which is what benches a working desk.
 */
const GROK_TTL_MS = Number(process.env.DESK_HARNESS_GROK_TTL_MS || 60_000);
const MCP_TTL_MS = Number(process.env.DESK_HARNESS_MCP_TTL_MS || 30_000);

/** `grok --version` exited 0. Same meaning as before — only the cost moved. */
function grokProbeSync(): boolean {
  try {
    const r = spawnSync(grokBin(), ["--version"], { timeout: 5000 });
    return r.status === 0 || Boolean(r.stdout?.length);
  } catch {
    return false;
  }
}

/** The refresh runs async so a hanging grok cannot block the event loop either. */
function grokProbeAsync(): Promise<boolean> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(grokBin(), ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolve(false);
      return;
    }
    let out = 0;
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      resolve(false);
    }, 5000);
    child.stdout?.on("data", (c: Buffer) => {
      out += c.length;
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 || out > 0);
    });
  });
}

let grokState: { value: boolean; at: number } | null = null;
let grokRefreshing = false;

function grokPresent(): boolean {
  // First call is synchronous and happens at startup (below), before listen().
  if (!grokState) grokState = { value: grokProbeSync(), at: Date.now() };
  if (!grokRefreshing && Date.now() - grokState.at > GROK_TTL_MS) {
    grokRefreshing = true;
    grokProbeAsync()
      .then((value) => {
        grokState = { value, at: Date.now() };
      })
      .finally(() => {
        grokRefreshing = false;
      });
  }
  return grokState.value;
}

/*
 * The tools probe: a real mcp-sub8 handshake (harness.mjs probeMcpTools).
 *
 * Cached the same way, and DELIBERATELY absent from the body until the first
 * probe lands — an omitted field means "unknown" to every consumer, which is
 * the same thing an old harness says, so the desk is never benched for a probe
 * that has not answered yet.
 */
let mcpState: { ok: boolean; tools: number; error: string; at: number } | null = null;
let mcpRefreshing = false;

function refreshMcp(): void {
  if (mcpRefreshing) return;
  mcpRefreshing = true;
  probeMcpTools({ internalToken: INTERNAL_TOKEN, port: PORT })
    .then((r) => {
      mcpState = { ok: Boolean(r?.ok), tools: Number(r?.tools) || 0, error: r?.error || "", at: Date.now() };
      if (!mcpState.ok) console.error(`desk-harness: mcp-sub8 probe FAILED — ${mcpState.error || "no tools"}`);
    })
    .catch((err) => {
      mcpState = { ok: false, tools: 0, error: String(err?.message || err), at: Date.now() };
    })
    .finally(() => {
      mcpRefreshing = false;
    });
}

/** Last known mcp-sub8 verdict, or null while the first probe is still running. */
function mcpTools(): { ok: boolean; tools: number; error: string; at: number } | null {
  if (!mcpState || Date.now() - mcpState.at > MCP_TTL_MS) refreshMcp();
  return mcpState;
}

/**
 * The GET /health body — HarnessHealth in @sub8/harness-protocol. Deliberately
 * NOT imported: that package is typed documentation for this shape, and a
 * relative import of its gitignored dist/ would break the desk-snapshot bake.
 * Optional fields are OMITTED when unknown, never sent as false — which is why
 * `mcp`/`tools` are optional here rather than `boolean | undefined`: under
 * exactOptionalPropertyTypes only the optional form can be left off the body.
 */
interface HealthBody {
  ok: boolean;
  harness: boolean;
  grok: boolean;
  mcp?: boolean;
  tools?: number;
}

function healthBody(): HealthBody {
  const body: HealthBody = { ok: true, harness: true, grok: grokPresent() };
  const mcp = mcpTools();
  if (mcp) {
    body.mcp = mcp.ok;
    body.tools = mcp.tools;
  }
  return body;
}

/**
 * A /claude/auth request body. Untrusted JSON, so `code` stays `unknown` —
 * claudeLoginCode takes it as `unknown` and String()s it — and `credentials`
 * is spelled structurally as harness-protocol's ClaudeCredentials
 * (`Record<string, unknown>`) rather than imported, for the same reason
 * healthBody above does not import HarnessHealth.
 */
interface ClaudeAuthBody {
  code?: unknown;
  credentials?: Record<string, unknown> | null | undefined;
}

/**
 * In-flight turns on this desk. A desk runs one turn at a time (the DeskTurn DO
 * is a FIFO per computerId), so stopping "this desk" and stopping "this turn"
 * are the same operation — which is why /stop takes no id.
 */
const running = new Set<AbortController>();

function stopRunning(): number {
  let stopped = 0;
  for (const ctl of [...running]) {
    try {
      ctl.abort();
      stopped += 1;
    } catch {
      /* already gone */
    }
  }
  return stopped;
}

function serve(): void {
  const server = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(healthBody()));
      return;
    }
    if (req.method === "POST" && req.url === "/turn") {
      const auth = String(req.headers.authorization || "");
      if (!TOKEN || auth !== `Bearer ${TOKEN}`) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "bad token" }));
        return;
      }
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c);
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        body = {};
      }
      res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" });
      const emit = (obj: unknown) => res.write(`${JSON.stringify(obj)}\n`);
      // runTurn already SIGTERMs the grok child when this fires; it just never
      // had anything wired to it before /stop existed.
      const ctl = new AbortController();
      running.add(ctl);
      // The Worker hanging up (user closed the app, socket died) should also
      // kill grok rather than leave it burning tokens on the droplet.
      res.on("close", () => {
        if (running.has(ctl)) {
          running.delete(ctl);
          try {
            ctl.abort();
          } catch {
            /* ignore */
          }
        }
      });
      try {
        await runTurn(body, emit, {
          internalToken: INTERNAL_TOKEN,
          internalPort: PORT,
          deskToken: TOKEN,
          signal: ctl.signal,
        });
      } catch (err) {
        emit({ type: "error", message: String((err as Error)?.message || err) });
      } finally {
        running.delete(ctl);
      }
      res.end();
      return;
    }
    if (String(req.url || "").startsWith("/claude/auth")) {
      const auth = String(req.headers.authorization || "");
      if (!TOKEN || auth !== `Bearer ${TOKEN}`) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "bad token" }));
        return;
      }
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c);
      let body: ClaudeAuthBody = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      } catch {
        body = {};
      }
      const send = (obj: unknown, code = 200) => {
        res.writeHead(code, { "Content-Type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      try {
        if (req.method === "GET" && req.url === "/claude/auth") return send(await claudeAuthStatus());
        if (req.method === "POST" && req.url === "/claude/auth/start") {
          const status = await claudeAuthStatus();
          if (status.loggedIn) return send({ ok: true, loggedIn: true, authMethod: status.authMethod });
          const started = await claudeLoginStart();
          return send(started, started.ok ? 200 : 500);
        }
        if (req.method === "POST" && req.url === "/claude/auth/code") {
          const done = await claudeLoginCode(body.code);
          return send(done, done.ok ? 200 : 400);
        }
        if (req.method === "POST" && req.url === "/claude/auth/logout") return send(await claudeLogout());
        // Export/import let one login cover every desk on the account.
        if (req.method === "GET" && req.url === "/claude/auth/export") return send(await claudeExportCredentials());
        if (req.method === "POST" && req.url === "/claude/auth/import") return send(await claudeImportCredentials(body.credentials));
      } catch (err) {
        return send({ ok: false, error: String((err as Error)?.message || err) }, 500);
      }
      send({ error: "not found" }, 404);
      return;
    }

    if (req.method === "POST" && req.url === "/stop") {
      const auth = String(req.headers.authorization || "");
      if (!TOKEN || auth !== `Bearer ${TOKEN}`) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "bad token" }));
        return;
      }
      for await (const _c of req) {
        /* drain; body is optional */
      }
      const stopped = stopRunning();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, stopped }));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  refreshMcp(); // first tools probe, off the request path; /health omits mcp until it lands
  server.listen(PORT, () => console.log(`desk-harness on :${PORT} (grok=${grokPresent()})`));
}

if (SELFTEST) {
  selftest()
    .then((steps) => {
      console.log(`PASS desk-harness selftest: ${steps.join("; ")}`);
    })
    .catch((err) => {
      console.error("FAIL desk-harness selftest:", err.message);
      process.exit(1);
    });
} else if (!harnessEnabled()) {
  console.error("desk-harness is flag-gated: set DESK_HARNESS=1 to start it. Refusing to serve.");
  process.exit(2);
} else {
  serve();
}
