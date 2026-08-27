/**
 * Pins Stop actually stopping the work.
 *
 * POST /api/bots/:id/stop answered {ok:true,stopped:true} while a `sleep 300`
 * kept running on the desk: stopTurn only killed processes matching
 * "/usr/local/bin/grok ", and a bot on harness {provider:"default"} runs its
 * shell work as a plain bash. Grok also re-parents its shell children to pid 1,
 * so killing grok never took them either.
 */
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { harnessStop } from "../server/desk-client.mjs";
import { deskKillScript, workEnvArgs, WORK_ENV } from "../server/vm.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

/* --- the marker every bit of desk work carries --- */
assert.equal(WORK_ENV, "SUB8_WORK");
assert.deepEqual(workEnvArgs("b9a0740c-7a94"), ["-e", "SUB8_WORK=b9a0740c-7a94"]);
assert.deepEqual(workEnvArgs(""), [], "no id, no marker — never mark work as everyone's");
assert.deepEqual(workEnvArgs("a b;rm -rf /"), ["-e", "SUB8_WORK=abrm-rf"], "the mark goes into a shell script");

/* --- the sweep finds a bot's own work, not the desk's --- */
const script = deskKillScript("bot-7", { grokFallback: false });
assert.match(script, /SUB8_WORK=bot-7/);
assert.match(script, /\/proc\/\[0-9\]\*\/environ/, "environ, so children that setsid away are still found");
assert.match(script, /kill -\$1/);
assert.match(script, /sweep TERM/);
assert.match(script, /sweep KILL/, "TERM then KILL — a stop that waits forever is not a stop");
assert.match(script, /\*chrome\*/, "Stop stops commands; it does not close the desk's browser");
assert.ok(!/\[ "1" = "1" \]/.test(script), "no grok fallback once the marker did the work");
const legacy = deskKillScript("", { grokFallback: true });
assert.match(legacy, /\[ "1" = "1" \]/, "an old desk with unmarked grok still gets the grok kill");
assert.match(legacy, /bin\\\/grok/, "the awk pattern is the old grok-only kill");
// bash must be able to run it.
assert.equal(spawnSync("bash", ["-n"], { input: script }).status, 0, "kill script must be valid shell");
assert.equal(spawnSync("bash", ["-n"], { input: legacy }).status, 0);

/* --- harnessStop: same shape as the cloud client --- */
function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}
{
  const seen = [];
  const { server, port } = await serve(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    seen.push({ url: req.url, auth: req.headers.authorization, body: Buffer.concat(chunks).toString("utf8") });
    if (req.url !== "/stop") {
      res.writeHead(404).end("{}");
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, stopped: 2 }));
  });
  const url = `http://127.0.0.1:${port}`;
  assert.deepEqual(await harnessStop({ url, token: "tok", botId: "b1" }), { ok: true, stopped: 2 });
  assert.equal(seen[0].url, "/stop");
  assert.equal(seen[0].auth, "Bearer tok");
  assert.deepEqual(JSON.parse(seen[0].body), { botId: "b1" });
  // Never throws — a stop that fails must not take the whole stop path down.
  assert.deepEqual(await harnessStop({ url, token: "" }), { ok: false, stopped: 0 });
  assert.deepEqual(await harnessStop({ url: "", token: "tok" }), { ok: false, stopped: 0 });
  server.close();
  assert.deepEqual(await harnessStop({ url, token: "tok", timeoutMs: 300 }), { ok: false, stopped: 0 });
}
{
  // An older desk whose harness predates /stop answers 404, and the caller
  // falls back to sweeping the container.
  const { server, port } = await serve((req, res) => {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  assert.deepEqual(await harnessStop({ url: `http://127.0.0.1:${port}`, token: "t" }), { ok: false, stopped: 0 });
  server.close();
}

/* --- the in-desk harness really kills its grok, driven by the real client --- */
const python = ["python3", "python"].find((p) => spawnSync(p, ["-c", "print(1)"]).status === 0);
if (!python) {
  console.log("note: no python3 — the in-desk harness leg was skipped");
} else {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sub8-desk-stop-"));
  const marker = path.join(tmp, "env.txt");
  const alive = path.join(tmp, "alive.txt");
  // A stand-in for grok: records the work marker it inherited, then runs long.
  await fs.writeFile(
    path.join(tmp, "grok"),
    `#!/bin/sh\nprintf '%s\\n' "$SUB8_WORK" > ${JSON.stringify(marker)}\necho $$ > ${JSON.stringify(alive)}\nsleep 120\n`,
    { mode: 0o755 },
  );
  const port = await new Promise((resolve) => {
    const probe = http.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const p = probe.address().port;
      probe.close(() => resolve(p));
    });
  });
  const child = spawn(python, [path.join(root, "vm", "desk-harness.py")], {
    env: {
      ...process.env,
      PATH: `${tmp}:${process.env.PATH}`,
      DESK_HARNESS_PORT: String(port),
      DESK_TOKEN: "desk-tok",
      HOME: tmp,
      GROK_HOME: tmp,
      DESK_WORK: tmp,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const url = `http://127.0.0.1:${port}`;
  const gone = () => child.exitCode !== null;
  const until = async (fn, ms = 8000) => {
    const t0 = Date.now();
    for (;;) {
      if (await fn()) return true;
      if (Date.now() - t0 > ms) return false;
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  const up = await until(async () => {
    if (gone()) return false;
    try {
      return (await fetch(`${url}/health`, { signal: AbortSignal.timeout(500) })).ok;
    } catch {
      return false;
    }
  });
  assert.ok(up, "desk-harness did not come up");

  // A turn is in flight; the fake grok is running inside it.
  const turn = fetch(`${url}/turn`, {
    method: "POST",
    headers: { Authorization: "Bearer desk-tok", "Content-Type": "application/json" },
    body: JSON.stringify({ botId: "b9a0740c", content: "sleep on the desk" }),
  }).then((r) => r.text());
  assert.ok(await until(async () => fsSync.existsSync(alive)), "fake grok never started");
  const pid = Number((await fs.readFile(alive, "utf8")).trim());
  assert.equal((await fs.readFile(marker, "utf8")).trim(), "b9a0740c", "the turn's work must carry the bot's marker");
  assert.equal(spawnSync("kill", ["-0", String(pid)]).status, 0, "grok stand-in should be alive");

  // A stop for a DIFFERENT bot leaves this desk's work alone: one desk, one team.
  assert.deepEqual(await harnessStop({ url, token: "desk-tok", botId: "someone-else" }), { ok: true, stopped: 0 });
  assert.equal(spawnSync("kill", ["-0", String(pid)]).status, 0, "another bot's stop must not stop this turn");
  // Bad token is refused.
  assert.deepEqual(await harnessStop({ url, token: "wrong", botId: "b9a0740c" }), { ok: false, stopped: 0 });

  const stop = await harnessStop({ url, token: "desk-tok", botId: "b9a0740c" });
  assert.deepEqual(stop, { ok: true, stopped: 1 });
  assert.ok(
    await until(async () => spawnSync("kill", ["-0", String(pid)]).status !== 0),
    "the work kept running after a stop that reported success",
  );
  await turn;
  child.kill("SIGKILL");
  await fs.rm(tmp, { recursive: true, force: true });
}

/* --- one stop writes "Stopped." exactly once --- */
/**
 * Read the HAND-WRITTEN source of a server module, whatever it is spelled today.
 *
 * The assertions below are structural claims about how the code is written —
 * that exactly one place says "Stopped.", that every harness branch guards on
 * the abort signal. Once a module converts, its `.mjs` is tsc output, and tsc
 * puts a single-statement `if` body on its own line, so
 * `/if \(signal\?\.aborted\) return bot;/` matched 3 times in the source and 0
 * in the emit. That is a formatting change, not a missing guard. Preferring
 * `.mts` keeps these assertions pointed at the thing they are actually about,
 * before and after each module converts.
 */
const serverSource = (name) => {
  for (const ext of [".mts", ".mjs"]) {
    const file = path.join(root, "server", name + ext);
    if (fsSync.existsSync(file)) return readFileSync(file, "utf8");
  }
  throw new Error(`no source found for server/${name}`);
};

const agentSrc = serverSource("agent");
const indexSrc = serverSource("index");
assert.equal(
  (indexSrc.match(/content: "Stopped\."/g) || []).length,
  1,
  "the stop endpoint is the one place that says it",
);
assert.ok(
  !/content: "Stopped\."/.test(agentSrc),
  "the turn loop must not post a second Stopped. when it notices the abort",
);
for (const branch of ['const text = await runGrokBuild', 'await hostCli.runHostCli']) {
  assert.ok(agentSrc.includes(branch));
}
assert.ok(
  (agentSrc.match(/if \(signal\?\.aborted\) return bot;/g) || []).length >= 3,
  "every harness branch drops its final text on a stop instead of echoing Stopped.",
);
// Tolerates an erasing `as` cast on the bot: typing index.mts turned this into
// `vm.stopDeskWork(b as vm.DeskBot, ...)`. The cast compiles away, so the
// substance — stopDeskWork called with the bot AND the internal token — is
// what gets asserted, not the exact spelling of the argument.
assert.match(
  indexSrc,
  /vm\.stopDeskWork\(\s*b(?:\s+as\s+[\w.]+)?\s*,\s*\{\s*token:\s*internalToken\s*\}\s*\)/,
  "stopTurn must stop the desk, not just the loop",
);

console.log("ok desk-stop");
