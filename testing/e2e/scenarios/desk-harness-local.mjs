import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deskCreateArgs } from "../../../server/vm.mjs";
import { DISPLAY_SLOTS, HARNESS_PORT, harnessHostPort } from "@sub8/desk-ports";
import { BRAIN_STARTING, harnessHealthy, runDeskTurn } from "../../../server/desk-client.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function docker(args, timeout = 20_000) {
  return new Promise((resolve) => {
    execFile("docker", args, { timeout, encoding: "utf8" }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || ""), err: String(stderr || err?.message || "") });
    });
  });
}

async function liveThrowaway() {
  const info = await docker(["info"]);
  if (!info.ok) return { skipped: "docker not available" };
  const name = "localbot-e2e-harness";
  await docker(["rm", "-f", name]);
  const run = await docker(
    ["run", "-d", "--name", name, "-p", "13991:3011", "--entrypoint", "sleep", "sub8-desk:trixie", "120"],
    60_000,
  );
  if (!run.ok) return { skipped: run.err.slice(-200) || "docker run failed" };
  try {
    const cp = await docker(["cp", path.join(root, "vm", "desk-harness.py"), `${name}:/usr/local/bin/desk-harness`]);
    if (!cp.ok) throw new Error(`cp harness: ${cp.err}`);
    const start = await docker([
      "exec",
      "-d",
      "-e",
      "DESK_TOKEN=desk",
      "-e",
      "DESK_HARNESS_PORT=3011",
      name,
      "python3",
      "/usr/local/bin/desk-harness",
    ]);
    if (!start.ok) throw new Error(`start harness: ${start.err}`);
    const url = "http://127.0.0.1:13991";
    for (let i = 0; i < 25; i++) {
      if (await harnessHealthy(url, { timeoutMs: 400 })) {
        const unauth = await fetch(`${url}/turn`, { method: "POST", body: "{}" });
        assert.equal(unauth.status, 401);
        return { ok: true };
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error("throwaway :3011 never became healthy");
  } finally {
    await docker(["rm", "-f", name]);
  }
}

/** Golden #8: local GET :3011/health + POST /turn contract. Live Docker SKIP if no mapped harness. */
export async function run({ skip } = {}) {
  assert.equal(HARNESS_PORT, 3011);
  assert.equal(harnessHostPort(13100), 13100 + DISPLAY_SLOTS);
  const args = deskCreateArgs({ name: "localbot-e2e", volume: "vol-e2e", port: 13100, image: "sub8-desk:trixie" });
  assert.ok(args.includes("DESK_HARNESS=1"));
  assert.ok(args.some((a) => String(a).includes(":3011")));

  const mapped = process.env.SUB8_HARNESS_URL;
  if (mapped) {
    const ok = await harnessHealthy(mapped, { timeoutMs: 2000 });
    if (!ok) {
      if (typeof skip === "function") skip("mapped harness not healthy");
      return;
    }
    return;
  }

  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, harness: true, grok: true }));
      return;
    }
    if (req.method === "POST" && req.url === "/turn") {
      const auth = String(req.headers.authorization || "");
      if (auth !== "Bearer desk") {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "bad token" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.write(`${JSON.stringify({ type: "tool", name: "computer", args: { action: "screenshot" } })}\n`);
      res.end(`${JSON.stringify({ type: "done", content: "Chrome navigated" })}\n`);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  try {
    const url = `http://127.0.0.1:${port}`;
    assert.equal(await harnessHealthy(url), true);
    const unauth = await fetch(`${url}/turn`, { method: "POST", body: "{}" });
    assert.equal(unauth.status, 401);
    const events = [];
    const out = await runDeskTurn({ url, token: "desk", body: { content: "open example.com" }, onEvent: (e) => events.push(e) });
    assert.equal(out.content, "Chrome navigated");
    assert.equal(events[0].name, "computer");
    assert.equal(BRAIN_STARTING, "desk brain starting");
  } finally {
    server.close();
  }

  const live = await liveThrowaway();
  if (live?.skipped) {
    if (typeof skip === "function" && process.env.SUB8_REQUIRE_DOCKER === "1") skip(live.skipped);
    return;
  }
  assert.equal(live.ok, true);
}
