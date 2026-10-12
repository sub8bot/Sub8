/**
 * The control API (server/control-api.mts, docs/control-api.md) and its CLI
 * (bin/sub8ctl.mjs).
 *
 * Part 1 mounts the router on a bare express app with stub dependencies, so a
 * whole send / steer / wait / stop flow runs without a harness, Docker or the
 * user's data. Part 2 boots the real server on a temp data dir and checks the
 * wiring: control.json is written 0600 at boot, the token is required, the
 * Settings routes never hand the token to a non-browser caller, and the CLI
 * reads control.json and talks to the live API.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import * as control from "../server/control-api.mjs";
import { withTempData } from "../testing/e2e/harness.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(root, "bin", "sub8ctl.mjs");

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log("PASS", name);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log("FAIL", name, "-", err.stack || err.message);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Part 1: router with stubs

function stubWorld() {
  const busy = new Set();
  const taps = new Set();
  const bots = new Map();
  const now = Date.now();
  bots.set("b1", {
    id: "b1",
    name: "Scout",
    harness: { provider: "claude", model: "opus" },
    vm: { status: "running" },
    messages: [
      { id: "u0", role: "user", content: "hello", ts: now - 5000 },
      { id: "a0", role: "assistant", content: "hi there", ts: now - 4000 },
      { id: "h0", role: "user", content: "internal", hidden: true, ts: now - 3500 },
      { id: "t0", role: "activity", kind: "tool", content: "ran ls", ts: now - 3000 },
    ],
  });
  bots.set("b2", { id: "b2", name: "Paused One", harness: { provider: "codex" }, vm: { status: "paused" }, messages: [] });
  bots.set("b3", { id: "b3", name: "dup", messages: [] });
  bots.set("b4", { id: "b4", name: "DUP", messages: [] });
  const broadcast = (event, data) => {
    for (const t of taps) t(event, data);
  };
  const sent = [];
  const stopped = [];
  const deps = {
    dataDir: "",
    port: 0,
    appVersion: () => "9.9.9-test",
    loadBots: async () => [...bots.values()].map((b) => ({ ...b })),
    getBot: async (id) => (bots.has(id) ? structuredClone(bots.get(id)) : null),
    busyIds: () => busy,
    limited: () => false,
    send: async (botId, text) => {
      const ts = Date.now();
      const id = `u${ts}`;
      const b = bots.get(botId);
      b.messages.push({ id, role: "user", content: text, ts });
      broadcast("message", { botId, id, role: "user", content: text, ts });
      sent.push({ botId, text });
      if (busy.has(botId)) return { id, ts, queued: true };
      // A fake turn: busy now, a reply after a moment, then idle.
      setTimeout(() => {
        busy.add(botId);
        b.messages.push({ id: `act${ts}`, role: "activity", kind: "tool", content: "thinking", ts: Date.now() });
      }, 50);
      setTimeout(() => {
        b.messages.push({ id: `a${ts}`, role: "assistant", content: `echo: ${text}`, ts: Date.now() });
        busy.delete(botId);
        broadcast("bot", structuredClone(b));
      }, 600);
      return { id, ts, queued: false };
    },
    stop: async (botId) => {
      const was = busy.has(botId);
      busy.delete(botId);
      stopped.push(botId);
      return { stopped: was };
    },
    subscribe: (fn) => {
      taps.add(fn);
      return () => taps.delete(fn);
    },
  };
  return { deps, busy, bots, sent, stopped, broadcast };
}

async function listen(app) {
  return await new Promise((resolve) => {
    const srv = app.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

const tmpData = await fs.mkdtemp(path.join(os.tmpdir(), "sub8-control-"));
const world = stubWorld();
world.deps.dataDir = tmpData;
const app = express();
app.use(express.json());
const srv = await listen(app);
const port = srv.address().port;
world.deps.port = port;
app.use(control.CONTROL_PREFIX, control.controlRouter(world.deps));
const base = `http://127.0.0.1:${port}${control.CONTROL_PREFIX}`;
const rec = control.ensureControlFile(tmpData, port);
const auth = { authorization: `Bearer ${rec.token}` };
const get = (p, headers = auth) => fetch(base + p, { headers });
const post = (p, body, headers = auth) =>
  fetch(base + p, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body || {}) });

await test("control.json is created 0600 with url, token and version", async () => {
  const file = control.controlFilePath(tmpData);
  const st = await fs.stat(file);
  assert.equal(st.mode & 0o777, 0o600);
  const j = JSON.parse(await fs.readFile(file, "utf8"));
  assert.equal(j.url, base);
  assert.equal(j.version, 1);
  assert.match(j.token, /^s8c_[A-Za-z0-9_-]{24,}$/);
  assert.equal(j.enabled, true);
  // Stable across loads.
  assert.equal(control.ensureControlFile(tmpData, port).token, j.token);
});

await test("no token, a wrong token, or a bad scheme is 401 with a JSON error", async () => {
  for (const headers of [{}, { authorization: "Bearer nope" }, { authorization: `Basic ${rec.token}` }, { authorization: `Bearer ${rec.token}x` }]) {
    const r = await get("/status", headers);
    assert.equal(r.status, 401);
    const j = await r.json();
    assert.equal(j.ok, false);
    assert.equal(j.error.code, "unauthorized");
    assert.ok(!JSON.stringify(j).includes(rec.token), "error must not echo the token");
  }
});

await test("a browser request (Origin header) is refused even with the token", async () => {
  const r = await get("/status", { ...auth, origin: "http://evil.example" });
  assert.equal(r.status, 403);
});

await test("a non-loopback remote address is refused before the token is checked", async () => {
  assert.equal(control.isLoopback("127.0.0.1"), true);
  assert.equal(control.isLoopback("::1"), true);
  assert.equal(control.isLoopback("::ffff:127.0.0.1"), true);
  for (const addr of ["192.168.5.2", "10.0.2.2", "172.17.0.1", "::ffff:192.168.5.2", "", undefined]) {
    assert.equal(control.isLoopback(addr), false, String(addr));
    let status = 0;
    let body = null;
    let nexted = false;
    const res = {
      status(c) {
        status = c;
        return this;
      },
      json(b) {
        body = b;
        return this;
      },
      setHeader() {},
    };
    const req = { socket: { remoteAddress: addr }, headers: { authorization: `Bearer ${rec.token}` } };
    control.controlGate(world.deps)(req, res, () => (nexted = true));
    assert.equal(nexted, false, `gate let ${addr} through`);
    assert.equal(status, 403);
    assert.equal(body.error.code, "forbidden");
  }
});

await test("status counts bots by state", async () => {
  const j = await (await get("/status")).json();
  assert.equal(j.ok, true);
  assert.equal(j.version, "9.9.9-test");
  assert.equal(j.bots.total, 4);
  assert.equal(j.bots.paused, 1);
  assert.equal(j.bots.idle, 3);
});

await test("bots lists summaries; show resolves by id or name; unknown is 404; ambiguous name is 409", async () => {
  const { bots } = await (await get("/bots")).json();
  const scout = bots.find((b) => b.id === "b1");
  assert.equal(scout.name, "Scout");
  assert.equal(scout.provider, "claude");
  assert.equal(scout.model, "opus");
  assert.equal(scout.location, "local");
  assert.equal(scout.status, "idle");
  assert.equal(scout.lastReply.text, "hi there");
  assert.equal(bots.find((b) => b.id === "b2").status, "paused");
  const byName = await (await get("/bots/scout")).json();
  assert.equal(byName.bot.id, "b1");
  assert.deepEqual(byName.bot.recent.map((m) => m.id), ["u0", "a0"], "hidden and activity rows are not chat");
  const missing = await get("/bots/nobody");
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, "not_found");
  assert.equal((await get("/bots/dup")).status, 409);
  assert.equal((await get("/no/such/route")).status, 404);
});

await test("messages honours since, limit and activity", async () => {
  const all = (await (await get("/bots/b1/messages")).json()).messages;
  assert.deepEqual(all.map((m) => m.id), ["u0", "a0"]);
  const since = (await (await get(`/bots/b1/messages?since=${all[0].ts}`)).json()).messages;
  assert.deepEqual(since.map((m) => m.id), ["a0"]);
  const lim = await (await get("/bots/b1/messages?limit=1")).json();
  assert.deepEqual(lim.messages.map((m) => m.id), ["a0"]);
  assert.equal(lim.hasMore, true);
  const act = (await (await get("/bots/b1/messages?activity=1")).json()).messages;
  assert.ok(act.some((m) => m.role === "activity"));
});

await test("send starts a turn, wait returns the reply, a second send while busy steers", async () => {
  const empty = await post("/bots/b1/messages", { text: "  " });
  assert.equal(empty.status, 400);
  const r = await (await post("/bots/b1/messages", { text: "first" })).json();
  assert.equal(r.ok, true);
  assert.equal(r.delivery, "started");
  assert.match(r.messageId, /^u\d+/);
  await sleep(150);
  assert.ok(world.busy.has("b1"));
  const listed = (await (await get("/bots")).json()).bots.find((b) => b.id === "b1");
  assert.equal(listed.status, "working");
  assert.equal(listed.turn.request, "first");
  const steer = await (await post("/bots/b1/messages", { text: "also this" })).json();
  assert.equal(steer.delivery, "steered");
  const w = await (await post(`/bots/b1/wait?timeoutMs=5000&since=${r.ts}`)).json();
  assert.equal(w.done, true);
  assert.equal(w.timedOut, false);
  assert.equal(w.status, "idle");
  assert.equal(w.reply.text, "echo: first");
  assert.deepEqual(world.sent.map((s) => s.text), ["first", "also this"]);
});

await test("send with wait blocks until the reply", async () => {
  const t0 = Date.now();
  const r = await (await post("/bots/b2/messages", { text: "ping", wait: true, timeoutMs: 5000 })).json();
  assert.ok(Date.now() - t0 >= 500, "returned before the fake turn finished");
  assert.equal(r.wait.done, true);
  assert.equal(r.wait.reply.text, "echo: ping");
});

await test("wait times out cleanly on a bot that stays busy", async () => {
  world.busy.add("b3");
  const r = await (await post("/bots/b3/wait?timeoutMs=400")).json();
  assert.equal(r.done, false);
  assert.equal(r.timedOut, true);
  assert.equal(r.status, "working");
});

await test("stop calls the app's stop and reports whether a turn was running", async () => {
  const r = await (await post("/bots/b3/stop")).json();
  assert.equal(r.stopped, true);
  assert.equal(world.busy.has("b3"), false);
  const again = await (await post("/bots/b3/stop")).json();
  assert.equal(again.stopped, false);
  assert.equal((await post("/bots/zzz/stop")).status, 404);
});

await test("events streams status changes and new messages", async () => {
  const ac = new AbortController();
  const res = await fetch(`${base}/events`, { headers: auth, signal: ac.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/event-stream/);
  const seen = [];
  const reader = (async () => {
    const dec = new TextDecoder();
    let buf = "";
    try {
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = /event: (\S+)/.exec(block)?.[1];
          const data = /data: (.*)/.exec(block)?.[1];
          if (ev) seen.push({ ev, data: data ? JSON.parse(data) : null });
        }
      }
    } catch {
      /* aborted */
    }
  })();
  await sleep(100);
  await post("/bots/b1/messages", { text: "via events" });
  for (let i = 0; i < 40 && !seen.some((e) => e.ev === "message" && e.data.message.role === "assistant"); i++) await sleep(100);
  ac.abort();
  await reader;
  assert.equal(seen[0].ev, "hello");
  assert.ok(seen.some((e) => e.ev === "message" && e.data.botId === "b1" && e.data.message.text === "via events"), "user message event");
  assert.ok(seen.some((e) => e.ev === "status" && e.data.botId === "b1" && e.data.status === "working"), "working status event");
  assert.ok(seen.some((e) => e.ev === "message" && e.data.message.text === "echo: via events"), "reply event");
  assert.ok(seen.some((e) => e.ev === "status" && e.data.status === "idle"), "idle status event");
});

await test("turning the API off answers 403 disabled; regenerate invalidates the old token", async () => {
  control.setControlEnabled(tmpData, port, false);
  const off = await get("/status");
  assert.equal(off.status, 403);
  assert.equal((await off.json()).error.code, "disabled");
  control.setControlEnabled(tmpData, port, true);
  assert.equal((await get("/status")).status, 200);
  const fresh = control.regenerateControlToken(tmpData, port);
  assert.notEqual(fresh.token, rec.token);
  assert.equal((await get("/status")).status, 401);
  assert.equal((await get("/status", { authorization: `Bearer ${fresh.token}` })).status, 200);
  assert.equal(control.tokenHint(fresh.token), `…${fresh.token.slice(-4)}`);
});

srv.closeAllConnections?.();
srv.close();
await fs.rm(tmpData, { recursive: true, force: true });

// ---------------------------------------------------------------------------
// Part 2: the real server

function runCli(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ code, out, err }));
    child.stdin.end();
  });
}

function mcpSession(env, requests) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, "mcp"], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    const replies = [];
    child.stdout.on("data", (d) => {
      out += d;
      let i;
      while ((i = out.indexOf("\n")) >= 0) {
        const line = out.slice(0, i);
        out = out.slice(i + 1);
        if (line.trim()) replies.push(JSON.parse(line));
        if (replies.length >= requests.filter((r) => r.id !== undefined).length) child.stdin.end();
      }
    });
    child.on("close", () => resolve(replies));
    for (const r of requests) child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...r })}\n`);
    setTimeout(() => child.kill(), 10_000).unref();
  });
}

await withTempData(async ({ base: appBase, data }) => {
  // Plant two bots through the store itself, pointed at the same temp dir.
  process.env.SUB8BOT_DATA = data;
  const store = await import("@sub8/store");
  const a = store.newBot({ name: "Alpha" });
  a.messages = [{ id: "u1", role: "user", content: "hi", ts: Date.now() - 2000 }, { id: "r1", role: "assistant", content: "hello from alpha", ts: Date.now() - 1000 }];
  const b = store.newBot({ name: "Beta" });
  await store.saveBots([a, b]);

  const file = path.join(data, "control.json");
  const st = await fs.stat(file);
  assert.equal(st.mode & 0o777, 0o600, "control.json must be 0600");
  const j = JSON.parse(await fs.readFile(file, "utf8"));
  const env = { SUB8_CONTROL_FILE: file };

  await test("live server: control.json points at this server and the token is required", async () => {
    assert.equal(j.url, `${appBase}/api/control/v1`);
    const anon = await fetch(`${j.url}/status`);
    assert.equal(anon.status, 401);
    assert.equal((await anon.json()).error.code, "unauthorized");
    const ok = await fetch(`${j.url}/bots`, { headers: { authorization: `Bearer ${j.token}` } });
    assert.equal(ok.status, 200);
    const names = (await ok.json()).bots.map((x) => x.name).sort();
    assert.deepEqual(names, ["Alpha", "Beta"]);
  });

  await test("live server: the internal token does not open the control API", async () => {
    const internal = (await fs.readFile(path.join(data, "internal-token"), "utf8")).trim();
    const r = await fetch(`${j.url}/status`, { headers: { authorization: `Bearer ${internal}` } });
    assert.equal(r.status, 401);
  });

  await test("live server: Settings routes refuse a non-browser caller and never return the token in GET", async () => {
    const r = await fetch(`${appBase}/api/control-access`);
    assert.equal(r.status, 403);
    assert.equal((await fetch(`${appBase}/api/control-access/reveal`, { method: "POST" })).status, 403);
    const browser = { "sec-fetch-site": "same-origin" };
    const g = await (await fetch(`${appBase}/api/control-access`, { headers: browser })).json();
    assert.equal(g.enabled, true);
    assert.equal(g.file, file);
    assert.match(g.cliPath, /bin[\\/]sub8ctl\.mjs$/);
    assert.match(g.mcpCommand, /^claude mcp add sub8 -- node ".*sub8ctl\.mjs" mcp$/);
    assert.ok(!JSON.stringify(g).includes(j.token), "GET /api/control-access leaked the token");
    const rev = await (await fetch(`${appBase}/api/control-access/reveal`, { method: "POST", headers: browser })).json();
    assert.equal(rev.token, j.token);
  });

  await test("CLI: status, bots, show, and a clean error on a bad token", async () => {
    const s = await runCli(["status"], env);
    assert.equal(s.code, 0, s.err);
    assert.match(s.out, /bots: 2 total/);
    const bl = await runCli(["bots"], env);
    assert.equal(bl.code, 0, bl.err);
    assert.match(bl.out, /Alpha/);
    assert.match(bl.out, /hello from alpha/);
    const sh = await runCli(["show", "alpha", "--json"], env);
    assert.equal(sh.code, 0, sh.err);
    assert.equal(JSON.parse(sh.out).id, a.id);
    const none = await runCli(["show", "nobody"], env);
    assert.equal(none.code, 1);
    assert.match(none.err, /no bot with that id or name/);
    const bogus = path.join(data, "bogus-control.json");
    await fs.writeFile(bogus, JSON.stringify({ ...j, token: "s8c_wrongwrongwrongwrongwrongwrong" }), { mode: 0o600 });
    const bad = await runCli(["status"], { SUB8_CONTROL_FILE: bogus });
    assert.equal(bad.code, 3);
    assert.ok(!bad.err.includes(j.token));
  });

  await test("CLI: stop on an idle bot reports nothing running", async () => {
    const r = await runCli(["stop", "Beta"], env);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Nothing was running/);
  });

  await test("MCP: initialize, tools/list and a list_bots call over stdio", async () => {
    const replies = await mcpSession(env, [
      { id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
      { method: "notifications/initialized" },
      { id: 2, method: "tools/list" },
      { id: 3, method: "tools/call", params: { name: "list_bots", arguments: {} } },
      { id: 4, method: "tools/call", params: { name: "get_bot", arguments: { bot: "nobody" } } },
    ]);
    const byId = Object.fromEntries(replies.map((r) => [r.id, r]));
    assert.equal(byId[1].result.serverInfo.name, "sub8");
    const names = byId[2].result.tools.map((t) => t.name).sort();
    for (const n of ["list_bots", "get_bot", "read_messages", "send_message", "stop_bot"]) assert.ok(names.includes(n), n);
    const listed = JSON.parse(byId[3].result.content[0].text);
    assert.deepEqual(listed.map((x) => x.name).sort(), ["Alpha", "Beta"]);
    assert.equal(byId[4].result.isError, true);
  });
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} control-api tests passed`);
process.exit(failed.length ? 1 : 0);
