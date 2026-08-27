import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { harnessHealthy, harnessCanTurn, runDeskTurn } from "../server/desk-client.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "vm", "desk-harness.py");

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

function waitReady(child, ms = 8000) {
  let out = "";
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout: ${out}`)), ms);
    const onData = (c) => {
      out += c;
      if (/desk-harness on/.test(out)) {
        clearTimeout(t);
        resolve(out);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => {
      clearTimeout(t);
      reject(new Error(`exited ${code}: ${out}`));
    });
  });
}

function stop(child) {
  return new Promise((resolve) => {
    if (child.exitCode != null) return resolve();
    child.on("exit", resolve);
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 1500);
  });
}

{
  const port = await freePort();
  const child = spawn("python3", [script], {
    env: { ...process.env, PATH: "/usr/bin:/bin", DESK_HARNESS_PORT: String(port), DESK_TOKEN: "desk-secret" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await waitReady(child);
    const url = `http://127.0.0.1:${port}`;
    assert.equal(await harnessHealthy(url), true);
    assert.equal(await harnessCanTurn(url), false, "no grok in PATH → Mac fallback");
    const unauth = await fetch(`${url}/turn`, { method: "POST", body: "{}" });
    assert.equal(unauth.status, 401);
    const events = [];
    const out = await runDeskTurn({
      url,
      token: "desk-secret",
      body: { content: "hi" },
      onEvent: (e) => events.push(e),
    });
    assert.equal(events[0].type, "error");
    assert.match(events[0].message, /grok not installed/i);
    assert.equal(out.content, "");
  } finally {
    await stop(child);
  }
}

{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sub8-fake-grok-"));
  const grok = path.join(tmp, "grok");
  fs.writeFileSync(
    grok,
    `#!/bin/sh
echo '{"type":"result","result":"hello from desk"}'
`,
    { mode: 0o755 },
  );
  const port = await freePort();
  const child = spawn("python3", [script], {
    env: {
      ...process.env,
      PATH: `${tmp}:/usr/bin:/bin`,
      DESK_HARNESS_PORT: String(port),
      DESK_TOKEN: "desk-secret",
      HOME: tmp,
      GROK_HOME: tmp,
      DESK_WORK: tmp,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await waitReady(child);
    const url = `http://127.0.0.1:${port}`;
    assert.equal(await harnessCanTurn(url), true);
    const events = [];
    const out = await runDeskTurn({
      url,
      token: "desk-secret",
      body: { content: "say hi" },
      onEvent: (e) => events.push(e),
    });
    assert.equal(out.content, "hello from desk");
    assert.equal(events.some((e) => e.type === "error"), false);
    assert.equal(events.at(-1).type, "done");
  } finally {
    await stop(child);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sub8-fake-grok-text-"));
  const grok = path.join(tmp, "grok");
  fs.writeFileSync(
    grok,
    `#!/bin/sh
echo '{"type":"thought","data":"thinking"}'
echo '{"type":"text","data":"P"}'
echo '{"type":"text","data":"ONG"}'
echo '{"type":"end","stopReason":"end_turn"}'
`,
    { mode: 0o755 },
  );
  const port = await freePort();
  const child = spawn("python3", [script], {
    env: {
      ...process.env,
      PATH: `${tmp}:/usr/bin:/bin`,
      DESK_HARNESS_PORT: String(port),
      DESK_TOKEN: "desk-secret",
      HOME: tmp,
      GROK_HOME: tmp,
      DESK_WORK: tmp,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await waitReady(child);
    const events = [];
    const out = await runDeskTurn({
      url: `http://127.0.0.1:${port}`,
      token: "desk-secret",
      body: { content: "say hi" },
      onEvent: (e) => events.push(e),
    });
    assert.equal(out.content, "PONG");
    assert.equal(events.filter((e) => e.type === "delta").map((e) => e.text).join(""), "PONG");
    assert.equal(events.some((e) => e.type === "error"), false);
  } finally {
    await stop(child);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sub8-grok-err-"));
  const grok = path.join(tmp, "grok");
  fs.writeFileSync(
    grok,
    `#!/bin/sh
echo '{"type":"error","message":"Not signed in"}'
exit 1
`,
    { mode: 0o755 },
  );
  const port = await freePort();
  const child = spawn("python3", [script], {
    env: {
      ...process.env,
      PATH: `${tmp}:/usr/bin:/bin`,
      DESK_HARNESS_PORT: String(port),
      DESK_TOKEN: "desk-secret",
      HOME: tmp,
      GROK_HOME: tmp,
      DESK_WORK: tmp,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await waitReady(child);
    const events = [];
    await runDeskTurn({
      url: `http://127.0.0.1:${port}`,
      token: "desk-secret",
      body: { content: "hi" },
      onEvent: (e) => events.push(e),
    });
    assert.equal(events[0].type, "error");
    assert.match(events[0].message, /not signed in/i);
  } finally {
    await stop(child);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sub8-macho-grok-"));
  const grok = path.join(tmp, "grok");
  fs.writeFileSync(grok, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]), { mode: 0o755 });
  const port = await freePort();
  const child = spawn("python3", [script], {
    env: {
      ...process.env,
      PATH: `${tmp}:/usr/bin:/bin`,
      DESK_HARNESS_PORT: String(port),
      DESK_TOKEN: "desk-secret",
      HOME: tmp,
      GROK_HOME: tmp,
      DESK_WORK: tmp,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await waitReady(child);
    const url = `http://127.0.0.1:${port}`;
    assert.equal(await harnessCanTurn(url), false, "Darwin grok on PATH must not count as in-desk grok");
  } finally {
    await stop(child);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

console.log("ok in-desk-harness");
