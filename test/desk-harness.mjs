// FIRST import, always: runTurn now WRITES to the store (it clears the
// awaitingUserSelection latch), and @sub8/store binds its data dir once at
// load. Without this pin the suite would reach the real data/bots.json.
import "../testing/e2e/isolate-data.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fsSync from "node:fs";
import net from "node:net";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { harnessEnabled, normalizeTurn, feedGrokLine, grokToolFromEvent, grokArgs, selftest, resolveMcpBotId, grokSessionId, writeHarnessHome, harnessMcpEnv, probeMcpTools, isClaudeProvider, claudeArgs, feedClaudeLine, runTurn } from "../server/desk-harness/harness.mjs";
import { tryCloudStateTool, CLOUD_STATE_TOOLS } from "../server/desk-harness/mcp-cloud.mjs";
import fs from "node:fs/promises";
import path from "node:path";

assert.equal(harnessEnabled({}), false);
assert.equal(harnessEnabled({ DESK_HARNESS: "0" }), false);
assert.equal(harnessEnabled({ DESK_HARNESS: "1" }), true);
assert.equal(harnessEnabled({ DESK_HARNESS: "1\n" }), false, "exact '1' only — never treat a dirty flag as on");

// normalizeTurn accepts BOTH the executor contract and the task's simple shape,
// so the DeskTurn DO can drive grok-build with the same relay code.
const exec = normalizeTurn({
  content: "hi",
  history: [{ role: "user", content: "x" }],
  system: "sys",
  display: 2,
  model: { provider: "xai", id: "grok-4.6", apiKey: "K", baseUrl: "https://api.x.ai/v1/" },
  callback: { botId: "b1", url: "https://sub8.bot/api/brain/executor-tool", computerId: "cmp_1" },
});
assert.equal(exec.text, "hi");
assert.equal(exec.botId, "b1");
assert.equal(exec.display, 2);
assert.equal(exec.model, "grok-4.6");
assert.equal(exec.apiKey, "K");
assert.equal(exec.baseUrl, "https://api.x.ai/v1"); // trailing slash trimmed
assert.equal(exec.authFile, null);
assert.equal(exec.callback.url, "https://sub8.bot/api/brain/executor-tool");
assert.equal(exec.callback.computerId, "cmp_1");

const simple = normalizeTurn({ botId: "b2", text: "yo", provider: "grok-oauth", auth: { access_token: "T" } });
assert.equal(simple.text, "yo");
assert.equal(simple.botId, "b2");
assert.ok(simple.isOAuth);
assert.deepEqual(simple.authFile, { access_token: "T" }); // OAuth → injected as auth.json
assert.equal(simple.apiKey, "");
const oidcBody = {
  botId: "b2",
  text: "yo",
  provider: "grok-oauth",
  model: { provider: "grok-oauth", id: "grok-4.6", apiKey: "must-not-become-XAI_API_KEY" },
  auth: {
    "https://auth.x.ai::cid": {
      auth_mode: "oidc",
      key: "tok",
      user_id: "00000000-0000-4000-8000-000000000001",
      create_time: "2026-01-01T00:00:00.000Z",
    },
  },
};
const oidc = normalizeTurn(oidcBody);
assert.ok(oidc.isOAuth);
assert.equal(oidc.apiKey, ""); // OAuth must not copy model.apiKey or process.env.XAI_API_KEY
assert.equal(oidc.authFile["https://auth.x.ai::cid"].auth_mode, "oidc");
const keyOnly = normalizeTurn({ botId: "b3", text: "z", provider: "xai", auth: "xai-abc" });
assert.equal(keyOnly.apiKey, "xai-abc"); // string auth on a non-oauth provider → API key
assert.equal(keyOnly.authFile, null);

// feedGrokLine emits the executor-contract event shapes.
const acc = { reply: "", parts: [] };
const evs = [];
feedGrokLine(JSON.stringify({ type: "tool_call", toolName: "browser", rawInput: { action: "snapshot" } }), acc, (e) => evs.push(e));
feedGrokLine(JSON.stringify({ params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "hi" } } } }), acc, (e) => evs.push(e));
feedGrokLine(JSON.stringify({ type: "result", result: "Final answer." }), acc, (e) => evs.push(e));
assert.deepEqual(evs.find((e) => e.type === "tool"), { type: "tool", name: "browser", args: { action: "snapshot" } });
assert.ok(evs.some((e) => e.type === "delta" && e.text === "hi"));
assert.match(acc.reply, /Final answer\./);
console.log("ok desk-harness (normalize + events)");

// grok-build 1.0.5 wraps MCP as use_tool + ACP session/update. Tool rows must
// unwrap to computer/mouse_move (not use_tool / generic "tool").
const acpMove = {
  method: "session/update",
  params: {
    update: {
      sessionUpdate: "tool_call",
      toolCallId: "call-1",
      title: "use_tool",
      rawInput: { tool_name: "sub8__computer", tool_input: { action: "mouse_move", x: 400, y: 300 } },
    },
  },
};
assert.deepEqual(grokToolFromEvent(acpMove), {
  name: "computer",
  args: { action: "mouse_move", x: 400, y: 300 },
});
assert.equal(
  grokToolFromEvent({
    method: "session/update",
    params: { update: { sessionUpdate: "tool_call_update", toolCallId: "call-1", title: "sub8__computer" } },
  }),
  "skip",
);
assert.equal(grokToolFromEvent({ type: "tool_call", toolName: "search_tool", rawInput: { query: "computer" } }), "skip");
assert.deepEqual(
  grokToolFromEvent({
    type: "tool_call",
    toolName: "use_tool",
    rawInput: { tool_name: "sub8__computer", tool_input: { action: "left_click", x: 400, y: 300 } },
  }),
  { name: "computer", args: { action: "left_click", x: 400, y: 300 } },
);
const acpEvs = [];
feedGrokLine(JSON.stringify(acpMove), { reply: "", parts: [] }, (e) => acpEvs.push(e));
feedGrokLine(
  JSON.stringify({
    method: "session/update",
    params: { update: { sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "completed" } },
  }),
  { reply: "", parts: [] },
  (e) => acpEvs.push(e),
);
assert.deepEqual(
  acpEvs.filter((e) => e.type === "tool"),
  [{ type: "tool", name: "computer", args: { action: "mouse_move", x: 400, y: 300 } }],
);
console.log("ok desk-harness (unwrap grok use_tool → computer)");

// Full wiring selftest: canned grok stream → home/config/auth + tool+delta+done.
const steps = await selftest();
assert.ok(steps.length >= 3, "selftest should assert home, turn, and spawn env");
console.log(`ok desk-harness selftest (${steps.join("; ")})`);

// Guard: the /turn contract stays aligned with executor-client.mjs. Skipped when
// the sibling sub8-cloud repo isn't checked out next to this one (e.g. CI).
const clientUrl = new URL("../../sub8-cloud/src/executor-client.mjs", import.meta.url);
if (fsSync.existsSync(clientUrl)) {
  const client = fsSync.readFileSync(clientUrl, "utf8");
  for (const marker of ["/turn", 'event.type === "error"', 'event.type === "done"', "event.content"]) {
    assert.ok(client.includes(marker), `executor-client.mjs no longer has ${marker} — re-check the /turn contract`);
  }
  console.log("ok desk-harness (executor /turn contract aligned)");
} else {
  console.log("ok desk-harness (executor contract guard skipped — sub8-cloud not checked out)");
}

const harnessClientUrl = new URL("../../sub8-cloud/src/harness-client.mjs", import.meta.url);
if (fsSync.existsSync(harnessClientUrl)) {
  const client = fsSync.readFileSync(harnessClientUrl, "utf8");
  for (const marker of [":3011", "/turn", "grok-oauth", "auth_mode", "oidc", 'event.type === "done"', "executor-tool", "SITE_URL", "cloudflare:sockets"]) {
    assert.ok(client.includes(marker), `harness-client.mjs missing ${marker}`);
  }
  console.log("ok desk-harness (harness-client /turn + oidc auth.json aligned)");
}

const aliased = await resolveMcpBotId("cloud-missing-bot");
assert.equal(typeof aliased, "string");
console.log("ok desk-harness (mcp bot alias)");

const uuid = grokSessionId("desk-local");
assert.match(uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
assert.equal(grokSessionId("desk-local"), uuid, "session id must be stable");
assert.equal(grokSessionId("11111111-2222-4333-a444-555555555555"), "11111111-2222-4333-a444-555555555555");
const a = grokArgs({ prompt: "hi", model: "grok-4.6", work: "/tmp" });
const b = grokArgs({ prompt: "hi", model: "grok-4.6", work: "/tmp" });
const sidA = a[a.indexOf("--session-id") + 1];
const sidB = b[b.indexOf("--session-id") + 1];
assert.match(sidA, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
assert.notEqual(sidA, sidB, "each turn must get a fresh session UUID");
assert.equal(a.includes("--resume"), false);
const errAcc = { reply: "" };
const errEvs = [];
feedGrokLine("Error: Session ID abc is already in use.", errAcc, (e) => errEvs.push(e));
assert.equal(errEvs.some((e) => e.type === "error"), false, "CLI errors must not trip Worker fallback");
assert.match(errAcc.reply, /already in use/);
const jsonErr = { reply: "" };
feedGrokLine(JSON.stringify({ type: "error", message: "Not signed in." }), jsonErr, () => {});
assert.match(jsonErr.reply, /Not signed in/);
console.log("ok desk-harness (grok session UUID)");

assert.ok(CLOUD_STATE_TOOLS.has("create_teammate") && CLOUD_STATE_TOOLS.has("message_teammate"));
const skipped = await tryCloudStateTool("computer", { action: "screenshot" }, { SUB8_CLOUD_CALLBACK_URL: "https://example.test/t" });
assert.equal(skipped, null, "desk tools must stay local");
const noCb = await tryCloudStateTool("create_teammate", { name: "A" }, {});
assert.equal(noCb, null, "local grok-build must keep store-backed teammates");
const captured = [];
const okCloud = await tryCloudStateTool(
  "create_teammate",
  { name: "Scout A", job: "DC restaurant" },
  {
    SUB8_CLOUD_CALLBACK_URL: "https://example.test/api/brain/executor-tool",
    SUB8_CLOUD_COMPUTER_ID: "cmp_x",
    SUB8_CLOUD_BOT_ID: "cloud-cmp_x",
    SUB8_DESK_TOKEN: "desk-secret",
  },
  async (url, init) => {
    captured.push({ url, init });
    return {
      ok: true,
      json: async () => ({ text: "created Scout A id=cloud-cmp_x-scouta display=:2" }),
    };
  },
);
assert.equal(captured[0].url, "https://example.test/api/brain/executor-tool");
assert.match(captured[0].init.headers.Authorization, /Bearer desk-secret/);
const posted = JSON.parse(captured[0].init.body);
assert.equal(posted.name, "create_teammate");
assert.equal(posted.computerId, "cmp_x");
assert.equal(posted.botId, "cloud-cmp_x");
assert.match(okCloud.content[0].text, /cloud-cmp_x-scouta/);
assert.equal(okCloud.isError, undefined);
const failCloud = await tryCloudStateTool(
  "message_teammate",
  { bot_id: "nope", content: "go" },
  {
    SUB8_CLOUD_CALLBACK_URL: "https://example.test/t",
    SUB8_DESK_TOKEN: "desk-secret",
  },
  async () => ({ ok: false, status: 401, json: async () => ({ error: "bad desk token" }) }),
);
assert.equal(failCloud.isError, true);
assert.match(failCloud.content[0].text, /bad desk token/);
console.log("ok desk-harness (cloud state tools callback)");

const cloudHome = await writeHarnessHome({
  botId: "cloud-bot",
  callback: { url: "https://example.test/t", computerId: "cmp_x", botId: "cloud-cmp_x" },
  deskToken: "desk-secret",
  display: 2,
});
const cloudToml = await fs.readFile(path.join(cloudHome, "config.toml"), "utf8");
assert.match(cloudToml, /SUB8_CLOUD_CALLBACK_URL = "https:\/\/example.test\/t"/);
assert.match(cloudToml, /SUB8_CLOUD_COMPUTER_ID = "cmp_x"/);
assert.match(cloudToml, /SUB8_DESK_TOKEN = "desk-secret"/);
assert.match(cloudToml, /SUB8_DISPLAY = "2"/);
console.log("ok desk-harness (GROK_HOME injects Worker callback)");

const oidcHome = await writeHarnessHome({
  botId: "selftest-oidc",
  authFile: oidcBody.auth,
});
const oidcFile = JSON.parse(await fs.readFile(path.join(oidcHome, "auth.json"), "utf8"));
assert.equal(oidcFile["https://auth.x.ai::cid"].auth_mode, "oidc");
assert.equal(oidcFile["https://auth.x.ai::cid"].key, "tok");
const keyHome = await writeHarnessHome({ botId: "selftest-apikey" });
assert.equal(fsSync.existsSync(path.join(keyHome, "auth.json")), false, "API-key GROK_HOME must not keep host auth.json");
console.log("ok desk-harness (oauth auth.json vs api-key unlink)");

const serverSrc = fsSync.readFileSync(new URL("../server/desk-harness/server.mjs", import.meta.url), "utf8");
assert.match(serverSrc, /DESK_HARNESS_PORT \|\| 3011/);
assert.match(serverSrc, /!harnessEnabled\(\)/);
assert.match(serverSrc, /application\/x-ndjson/);

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverJs = path.join(root, "server/desk-harness/server.mjs");

function spawnHarness(extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  delete env.DESK_HARNESS;
  if ("DESK_HARNESS" in extraEnv) env.DESK_HARNESS = extraEnv.DESK_HARNESS;
  return spawn(process.execPath, [serverJs], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
}

function waitExit(child, ms = 8000) {
  let out = "";
  child.stdout.on("data", (c) => {
    out += c;
  });
  child.stderr.on("data", (c) => {
    out += c;
  });
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, arg) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      fn(arg);
    };
    const t = setTimeout(() => {
      child.kill("SIGKILL");
      finish(reject, new Error(`timeout waiting for exit: ${out}`));
    }, ms);
    child.on("exit", (code) => finish(resolve, { code, out }));
  });
}

function waitText(child, re, ms = 15000) {
  let out = "";
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, arg) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      child.stdout.off("data", onData);
      child.stderr.off("data", onData);
      child.off("exit", onExit);
      fn(arg);
    };
    const t = setTimeout(() => {
      child.kill("SIGKILL");
      finish(reject, new Error(`timeout waiting ${re}: ${out}`));
    }, ms);
    const onData = (c) => {
      out += c;
      if (re.test(out)) finish(resolve, out);
    };
    const onExit = (code) => finish(reject, new Error(`exited ${code}: ${out}`));
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", onExit);
  });
}

function stopChild(child) {
  return new Promise((resolve) => {
    if (child.exitCode != null) return resolve();
    child.on("exit", resolve);
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 2000);
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

{
  const child = spawnHarness({});
  const { code, out } = await waitExit(child);
  assert.equal(code, 2);
  assert.match(out, /DESK_HARNESS=1/);
  console.log("ok desk-harness (refuses to serve without DESK_HARNESS=1)");
}

async function pollHealth(port, want, ms = 20000) {
  const start = Date.now();
  for (;;) {
    const res = await fetch(`http://127.0.0.1:${port}/health`).catch(() => null);
    const body = res?.ok ? await res.json().catch(() => null) : null;
    if (body && want(body)) return body;
    if (Date.now() - start > ms) throw new Error(`/health never satisfied: ${JSON.stringify(body)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

{
  const port = await freePort();
  const child = spawnHarness({
    DESK_HARNESS: "1",
    DESK_HARNESS_PORT: String(port),
    DESK_TOKEN: "test-token",
  });
  try {
    await waitText(child, /desk-harness on/);
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 200);
    const body = await health.json();
    assert.equal(body.ok, true);
    assert.equal(body.harness, true);
    // The tools probe against the REAL mcp-sub8: it must answer true, and it
    // must be a count, not a literal. `mcp` is absent until the first handshake
    // lands — absent means "unknown" on the wire, never "down".
    const withMcp = await pollHealth(port, (b) => b.mcp !== undefined);
    assert.equal(withMcp.mcp, true, "the real mcp-sub8 must hand back tools");
    assert.ok(withMcp.tools > 1, `expected a real tool count, got ${withMcp.tools}`);
    const unauth = await fetch(`http://127.0.0.1:${port}/turn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hi" }),
    });
    assert.equal(unauth.status, 401);
  } finally {
    await stopChild(child);
  }
  console.log(`ok desk-harness (GET /health + POST /turn 401 on :${port}; default port 3011)`);
}

// --- Claude as an alternative harness on the desk ----------------------------
// The desktop has run Claude for a while (host-cli.mjs runHostCli); the desk was
// grok-only, so a user whose Grok balance is exhausted had no way to drive a
// cloud desk at all.
{
  const { EventEmitter } = await import("node:events");

  assert.equal(isClaudeProvider("claude"), true);
  assert.equal(isClaudeProvider("claude-oauth"), true);
  assert.equal(isClaudeProvider("grok-oauth"), false);
  assert.equal(isClaudeProvider(""), false);

  const args = claudeArgs({ prompt: "hi", model: "haiku", sessionId: "s1", mcpFile: "/tmp/mcp.json", system: "RULES" });
  assert.equal(args[args.indexOf("--output-format") + 1], "stream-json");
  assert.equal(args[args.indexOf("--mcp-config") + 1], "/tmp/mcp.json");
  assert.ok(args.includes("--strict-mcp-config"), "must not inherit ambient MCP config");
  assert.equal(args[args.indexOf("--session-id") + 1], "s1");
  assert.equal(args[args.indexOf("--append-system-prompt") + 1], "RULES");
  assert.equal(args[args.indexOf("--model") + 1], "haiku");
  assert.equal(args[args.indexOf("--fallback-model") + 1], "haiku");
  assert.ok(!claudeArgs({ prompt: "hi", sessionId: "s2", mcpFile: "/tmp/m.json" }).includes("--append-system-prompt"));

  // Claude stream-json folds into the same {tool,delta,done} the Worker reads.
  const acc = { reply: "", parts: [] };
  const events = [];
  const emit = (e) => events.push(e);
  feedClaudeLine(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "computer", input: { action: "screenshot" } }] } }), acc, emit);
  feedClaudeLine(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "On the desk now." }] } }), acc, emit);
  const tool = events.find((e) => e.type === "tool");
  assert.equal(tool?.name, "computer");
  assert.equal(tool?.args?.action, "screenshot");
  assert.ok(events.some((e) => e.type === "delta" && /On the desk now/.test(e.text)));
  assert.match(acc.reply, /On the desk now/);

  // A Claude turn spawns the claude binary with ANTHROPIC creds, never XAI.
  let captured = null;
  const emitted = [];
  process.env.XAI_API_KEY = "xai-should-not-leak";
  await runTurn(
    { botId: "claude-bot", content: "hello", provider: "claude", model: { id: "claude-sonnet-4-5", apiKey: "sk-ant-test" } },
    (e) => emitted.push(e),
    {
      spawnGrok: (spec) => {
        captured = spec;
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = () => {};
        setTimeout(() => {
          child.stdout.emit("data", Buffer.from(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Claude here." }] } }) + "\n"));
          child.emit("close", 0);
        }, 5);
        return child;
      },
    },
  );
  delete process.env.XAI_API_KEY;
  assert.match(String(captured.bin || ""), /claude/, "must spawn the claude CLI");
  assert.equal(captured.env.ANTHROPIC_API_KEY, "sk-ant-test");
  assert.equal(captured.env.XAI_API_KEY, undefined, "an XAI key must never reach Claude");
  assert.ok(captured.args.includes("--mcp-config"), "sub8 tools must be wired");
  assert.match(String(emitted.find((e) => e.type === "done")?.content || ""), /Claude here/);
}
// A droplet-wide XAI_API_KEY must never become Claude's ANTHROPIC_API_KEY: a
// subscription turn carries no key by design, and inheriting one shadows the
// ~/.claude login and fails auth against Anthropic.
{
  process.env.XAI_API_KEY = "xai-droplet-wide";
  const t = normalizeTurn({ botId: "b", content: "hi", provider: "claude", model: { provider: "claude", id: "claude-sonnet-4-5" } });
  assert.equal(t.apiKey, "", "a keyless Claude turn must stay keyless");
  const g = normalizeTurn({ botId: "b", content: "hi", provider: "xai", model: { provider: "xai", id: "grok-4.6" } });
  assert.equal(g.apiKey, "xai-droplet-wide", "grok still inherits the droplet key");
  delete process.env.XAI_API_KEY;
}
console.log("ok desk-harness (claude alternative)");

/* ------------------------------------------------ /health sees a dead mcp-sub8 --
 * The defect this replaces: `{ok:true,harness:true,grok:true}` proved only that
 * the HTTP listener answered and that `grok --version` exited 0, so a desk whose
 * mcp-sub8 was dead stayed green for three days while every turn ran with zero
 * tools. Both cases below run WITHOUT a droplet: SUB8BOT_ROOT moves the app root
 * so mcpScript() resolves to a planted mcp-sub8.
 */
function plantRoot(name, source) {
  const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), `sub8-mcp-${name}-`));
  fsSync.mkdirSync(path.join(dir, "server"), { recursive: true });
  const text = typeof source === "function" ? source(dir) : source;
  fsSync.writeFileSync(path.join(dir, "server", "mcp-sub8.mjs"), text, { mode: 0o755 });
  return dir;
}

// Exactly the production failure: the file list rotted and mcp-sub8 died on a
// missing import.
const DEAD_MCP = `import { gone } from "./this-file-does-not-exist.mjs";\nconsole.log(gone);\n`;

{
  const r = await probeMcpTools({
    timeoutMs: 10000,
    spec: { command: process.execPath, args: [path.join(plantRoot("dead", DEAD_MCP), "server", "mcp-sub8.mjs")], env: { PATH: process.env.PATH, HOME: process.env.HOME } },
  });
  assert.equal(r.ok, false, "a dead mcp-sub8 must probe false");
  assert.equal(r.tools, 0);
  assert.match(r.error, /Cannot find module/, "and must say why");

  // A hung MCP server is down too, and must not hang the caller.
  const hung = await probeMcpTools({ timeoutMs: 500, spec: { command: "/bin/sh", args: ["-c", "sleep 30"], env: {} } });
  assert.equal(hung.ok, false);
  assert.match(hung.error, /timed out/);

  // A handshake that lists NOTHING is toolless, which is the outage's symptom.
  const empty = await probeMcpTools({
    timeoutMs: 5000,
    spec: { command: process.execPath, args: ["-e", `process.stdin.on("data",(c)=>{for(const l of String(c).trim().split("\\n")){const m=JSON.parse(l);process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:m.id,result:m.id===2?{tools:[]}:{}})+"\\n")}});setTimeout(()=>{},5000)`], env: {} },
  });
  assert.equal(empty.ok, false);
  assert.match(empty.error, /no tools/);

  // The real thing, through the real launch path (mcpServerSpec + config.toml env).
  const live = await probeMcpTools({ botId: "desk-local" });
  assert.equal(live.ok, true, `the repo's own mcp-sub8 must probe true: ${live.error || ""}`);
  assert.ok(live.tools > 1, `expected the real tool list, got ${live.tools}`);

  // The probe spawns what a turn spawns — same env keys, same values.
  const env = harnessMcpEnv({ botId: "b1", internalToken: "tok", port: 3011 });
  assert.equal(env.SUB8BOT_BOT_ID, "b1");
  assert.equal(env.SUB8_INTERNAL_TOKEN, "tok");
  assert.equal(env.SUB8_INTERNAL_URL, "http://127.0.0.1:3011");
  console.log("ok desk-harness (mcp probe: dead, hung, toolless and live)");
}

{
  const dead = plantRoot("dead-health", DEAD_MCP);
  const port = await freePort();
  const child = spawnHarness({
    DESK_HARNESS: "1",
    DESK_HARNESS_PORT: String(port),
    DESK_TOKEN: "test-token",
    SUB8BOT_ROOT: dead,
    SUB8BOT_DATA: path.join(dead, "data"),
  });
  try {
    await waitText(child, /desk-harness on/);
    const body = await pollHealth(port, (b) => b.mcp !== undefined);
    assert.equal(body.mcp, false, "/health must go false when mcp-sub8 is dead");
    assert.equal(body.tools, 0);
    // ...and the desk is still UP and can still be handed a turn: this field is
    // a tools signal, not a liveness one. harnessIsUp/harnessCanTurn unchanged.
    assert.equal(body.ok, true);
    assert.equal(body.harness, true);
  } finally {
    await stopChild(child);
    fsSync.rmSync(dead, { recursive: true, force: true });
  }
  console.log(`ok desk-harness (GET /health reports mcp:false for a dead mcp-sub8 on :${port})`);
}

{
  // /health is polled with 400-800ms deadlines, so the probe must be CACHED, not
  // run per request. This mcp-sub8 counts its own spawns.
  // The spawn log path is baked in, not passed: mcpServerSpec hands the child
  // only PATH, HOME and the sub8 keys, which is itself worth pinning.
  const counted = plantRoot(
    "counted",
    (dir) => `import fs from "node:fs";
fs.appendFileSync(${JSON.stringify(path.join(dir, "spawns.txt"))}, "spawn\\n");
process.stdin.on("data", (c) => {
  for (const line of String(c).trim().split("\\n")) {
    if (!line) continue;
    const msg = JSON.parse(line);
    const result = msg.method === "tools/list" ? { tools: [{ name: "computer" }, { name: "browser" }] } : {};
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\\n");
  }
});
setInterval(() => {}, 1000);
`,
  );
  const spawnLog = path.join(counted, "spawns.txt");
  fsSync.writeFileSync(spawnLog, "");
  const port = await freePort();
  const child = spawnHarness({
    DESK_HARNESS: "1",
    DESK_HARNESS_PORT: String(port),
    DESK_TOKEN: "test-token",
    SUB8BOT_ROOT: counted,
    SUB8BOT_DATA: path.join(counted, "data"),
    DESK_HARNESS_MCP_TTL_MS: "600000",
  });
  try {
    await waitText(child, /desk-harness on/);
    const body = await pollHealth(port, (b) => b.mcp !== undefined);
    assert.equal(body.mcp, true);
    assert.equal(body.tools, 2, "the count is the handshake's, not a literal");
    const started = Date.now();
    for (let i = 0; i < 12; i += 1) {
      const b = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
      assert.equal(b.mcp, true);
      assert.equal(b.tools, 2);
    }
    const spawns = fsSync.readFileSync(spawnLog, "utf8").trim().split("\n").filter(Boolean).length;
    assert.equal(spawns, 1, `12 /health calls must reuse ONE handshake, saw ${spawns}`);
    assert.ok(Date.now() - started < 2000, "cached /health must stay off the subprocess path");
  } finally {
    await stopChild(child);
    fsSync.rmSync(counted, { recursive: true, force: true });
  }
  // The desk harness dispatches by an if-chain on method+url, so a route
// registered twice means the second copy is unreachable — silently, since both
// branches typecheck and the first one always wins. GET /claude/auth/export was
// listed twice, once orphaned among the auth-status handlers and once beside
// /claude/auth/import where it belongs. Anyone editing the second copy would
// have seen no effect at all.
{
  const path = await import("node:path");
  const here = path.dirname(fileURLToPath(import.meta.url));
  // Prefer the hand-written source; fall back for the pre-conversion spelling.
  const file = [".mts", ".mjs"]
    .map((ext) => path.join(here, "..", "server", "desk-harness", "server" + ext))
    .find((f) => fsSync.existsSync(f));
  assert.ok(file, "could not find server/desk-harness/server.*");
  const src = fsSync.readFileSync(file, "utf8");

  const seen = new Map();
  const dupes = [];
  for (const m of src.matchAll(/req\.method === "([A-Z]+)"\s*&&\s*req\.url === "([^"]+)"/g)) {
    const key = `${m[1]} ${m[2]}`;
    if (seen.has(key)) dupes.push(key);
    seen.set(key, true);
  }
  assert.deepEqual(dupes, [], `these routes are registered more than once, so the later copy is dead: ${dupes.join(", ")}`);
  // Not vacuous: it has to be seeing real routes.
  assert.ok(seen.size >= 6, `expected to find the route table, saw ${seen.size} routes`);
  assert.ok(seen.has("GET /claude/auth/export"), "the export route should still be registered exactly once");
}

  console.log("ok desk-harness (the tools probe is cached, never per request)");
}
