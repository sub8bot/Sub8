#!/usr/bin/env node
/**
 * Chief + separate bots per city: well-rated food in San Francisco, Austin, New York.
 * Leaves AikaBotto alone. Set SKIP_CLEANUP=1 when another test desk must stay up.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = process.env.SUB8_URL || "http://127.0.0.1:8787";
const DEADLINE_MS = Number(process.env.FOOD_MS || 12 * 60 * 1000);
const HARNESS = { provider: "claude", model: "default" };
const TEAM_NAME = process.env.FOOD_TEAM_NAME || "Cities Kitchen";
const CITIES = ["San Francisco", "Austin", "New York"];
const USER_PROMPT =
  "look for good food in San Francisco, Austin, and New York. Do it faster using multiple bots, one city each. For each city pick one well-rated dinner spot (name, rating, area).";
const AIKA = "6d6cfe52-6696-45b8-a69a-33cd2b66c8dd";
const SKIP_CLEANUP = process.env.SKIP_CLEANUP === "1";
const DESK_MEM = process.env.DESK_MEM || "3g";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

async function api(p, opts = {}) {
  const res = await fetch(`${BASE}${p}`, {
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) throw new Error(`${opts.method || "GET"} ${p} ${res.status}: ${data?.error || text.slice(0, 200)}`);
  return data;
}

async function waitUntil(fn, { timeoutMs, every = 4000 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await fn();
    if (v) return v;
    await sleep(every);
  }
  return null;
}

function dockerEnv() {
  const env = { ...process.env };
  if (!env.DOCKER_HOST) env.DOCKER_HOST = `unix://${env.HOME || ""}/.colima/default/docker.sock`;
  return env;
}

function docker(args) {
  return new Promise((resolve) => {
    const child = spawn("docker", args, { env: dockerEnv() });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (out += d.toString()));
    child.on("close", (code) => resolve({ ok: code === 0, out, code }));
  });
}

async function installDeskScripts(container) {
  const files = [
    ["vm/desk-display.sh", "desk-display"],
    ["vm/page-agent.py", "page-agent"],
    ["vm/chrome-desktop.sh", "chrome-desktop"],
    ["vm/chrome-one-tab.py", "chrome-one-tab"],
    ["vm/desk-init.sh", "desk-init"],
  ];
  for (const [rel, dest] of files) {
    await docker(["cp", `${root}/${rel}`, `${container}:/tmp/${dest}`]);
  }
  await docker([
    "exec",
    "-u",
    "root",
    container,
    "bash",
    "-lc",
    "install -m 755 /tmp/desk-display /usr/local/bin/desk-display && install -m 755 /tmp/page-agent /usr/local/bin/page-agent && install -m 755 /tmp/chrome-desktop /usr/local/bin/chrome-desktop && install -m 755 /tmp/chrome-one-tab /usr/local/bin/chrome-one-tab && mkdir -p /config/chrome-desk /config/workspace && chown -R abc:abc /config/chrome-desk /config/workspace && chown -R abc:abc /config/chrome-desk-* 2>/dev/null || true",
  ]);
  await docker([
    "exec",
    "-u",
    "abc",
    "-e",
    "DISPLAY=:1",
    "-e",
    "HOME=/config",
    container,
    "bash",
    "-lc",
    "nohup /usr/local/bin/chrome-desktop 'https://www.google.com/?hl=en&gl=us' >/tmp/chrome-heal.log 2>&1 &",
  ]);
}

function lastAssistant(bot) {
  const msgs = (bot.messages || []).filter((m) => m.role === "assistant" && m.content);
  const own = msgs.filter((m) => !m.speakerName || m.speakerName === bot.name);
  const pick = own.length ? own : msgs;
  return pick.length ? pick[pick.length - 1].content : "";
}

async function inspectChrome(container) {
  const mains = await docker([
    "exec",
    container,
    "sh",
    "-c",
    'ps -eo pid,rss,cmd | grep "[c]hrome" | grep -v -- "--type=" | grep -v crashpad',
  ]);
  const leftover = (mains.out || "")
    .split("\n")
    .filter((l) => l.trim() && l.includes("chrome") && !l.includes("user-data-dir"));
  const cdp = await docker([
    "exec",
    container,
    "sh",
    "-c",
    "ss -lntp 2>/dev/null | grep 922 || netstat -lntp 2>/dev/null | grep 922 || true",
  ]);
  const owner = await docker(["exec", container, "sh", "-c", "ls -ld /config/chrome-desk /config/chrome-desk-* 2>/dev/null || true"]);
  return { mains: mains.out.trim(), leftover, cdp: cdp.out.trim(), owner: owner.out.trim() };
}

function analyze({ job, chief, bots, chrome }) {
  const issues = [];
  const steps = job?.steps || [];
  const work = steps.filter((s) => !/^summary$/i.test(s.label || ""));
  const labels = work.map((s) => s.label || "").join(" ").toLowerCase();
  if (work.length < 3) issues.push(`job bar has ${work.length} work steps, expected 3 cities`);
  for (const city of CITIES) {
    const token = city.split(" ")[0].toLowerCase();
    if (!labels.includes(token.toLowerCase()) && !labels.includes(city.toLowerCase())) {
      issues.push(`job bar missing ${city}`);
    }
  }
  const summary = steps.find((s) => /^summary$/i.test(s.label || ""));
  if (summary && work.some((s) => s.status !== "done" && s.status !== "blocked") && summary.status === "done") {
    issues.push("Summary marked done before all city steps finished");
  }
  const compiled = (chief.messages || []).filter(
    (m) => m.role === "assistant" && !m.toId && /san francisco|austin|new york|compiled|dinner/i.test(m.content || ""),
  );
  const lastCompile = compiled.at(-1)?.content || lastAssistant(chief);
  for (const city of CITIES) {
    if (lastCompile && !new RegExp(city.split(" ")[0], "i").test(lastCompile)) {
      issues.push(`compiled list may omit ${city}`);
    }
  }
  const leak = (chief.messages || []).some((m) => /teammate report, not a new job/i.test(m.content || ""));
  if (leak) issues.push("prompt leak still in chief chat");
  if (chrome.leftover.length) issues.push(`leftover unprofiled Chrome still running (${chrome.leftover.length})`);
  if (!/9222/.test(chrome.cdp) && !/9222/.test(chrome.mains)) issues.push("CDP 9222 not listening on chief display");
  return { issues, lastCompile, steps };
}

async function main() {
  await api("/api/health");
  const bots0 = await api("/api/bots");
  const aika = bots0.find((b) => b.id === AIKA || /aika/i.test(b.name || ""));
  if (aika) console.log("leaving", aika.name, aika.id, "alone");

  if (!SKIP_CLEANUP) {
    const running = await docker(["ps", "--format", "{{.Names}}"]);
    for (const name of (running.out || "").split("\n").map((s) => s.trim()).filter(Boolean)) {
      if (!name.startsWith("localbot-")) continue;
      if (aika?.vm?.container && name === aika.vm.container) continue;
      if (name.includes("6d6cfe52")) continue;
      console.log("stopping extra desk", name);
      await docker(["stop", "-t", "8", name]);
    }
  }

  const teams = await api("/api/teams");
  for (const t of teams) {
    if (t.name !== TEAM_NAME) continue;
    console.log("deleting previous", t.name, t.id);
    await api(`/api/teams/${t.id}?wipe=1`, { method: "DELETE", body: { wipe: true } });
  }

  const created = await api("/api/teams", {
    method: "POST",
    body: { name: TEAM_NAME, members: [{ name: "Scout", role: "chief", harness: HARNESS }] },
  });
  const chiefId = created.chiefId;
  console.log("created", created.name, "chief", chiefId);

  const ready = await waitUntil(
    async () => {
      const b = (await api("/api/bots")).find((x) => x.id === chiefId);
      const health = await api(`/api/bots/${chiefId}/stream-health`).catch(() => ({}));
      if (health.ok && health.chrome && (b?.vm?.status === "running" || health.running)) return b;
      process.stdout.write(".");
      return null;
    },
    { timeoutMs: 4 * 60 * 1000, every: 4000 },
  );
  if (!ready) throw new Error("desk did not become ready");
  const container = ready.vm?.container;
  console.log("\ndesk ready", container);
  if (container) {
    await docker(["update", "--memory", DESK_MEM, "--memory-swap", DESK_MEM, container]);
    await installDeskScripts(container);
    console.log("desk scripts installed");
  }

  await api(`/api/teams/${created.id}/messages`, {
    method: "POST",
    body: { content: USER_PROMPT, toIds: [chiefId] },
  });
  console.log("dispatched user prompt");

  const done = await waitUntil(
    async () => {
      const t = (await api("/api/teams")).find((x) => x.id === created.id);
      const steps = t?.job?.steps || [];
      const work = steps.filter((s) => !/^summary$/i.test(s.label || ""));
      const summary = steps.find((s) => /^summary$/i.test(s.label || ""));
      const line = steps.map((s) => `${s.label}:${s.status}`).join(" ") || "(no job yet)";
      console.log("job", line);
      const workDone = work.length >= 2 && work.every((s) => s.status === "done" || s.status === "blocked");
      if (workDone && summary?.status === "done") {
        const bots = await api("/api/bots");
        const roster = bots.filter((b) => (created.memberIds || []).includes(b.id) || b.teamId === created.id);
        const chief = roster.find((b) => b.id === chiefId);
        return { job: t.job, chief, bots: roster };
      }
      return null;
    },
    { timeoutMs: DEADLINE_MS, every: 8000 },
  );

  const bots = await api("/api/bots");
  const roster = bots.filter((b) => b.teamId === created.id);
  const chief = roster.find((b) => b.id === chiefId);
  const t = (await api("/api/teams")).find((x) => x.id === created.id);
  const chrome = container ? await inspectChrome(container) : { mains: "", leftover: [], cdp: "", owner: "" };
  const result = analyze({ job: t?.job || done?.job, chief, bots: roster, chrome });

  console.log("\n=== Chrome ===\n" + chrome.mains);
  console.log("CDP:\n" + chrome.cdp);
  console.log("profiles:\n" + chrome.owner);
  console.log("\n=== Job ===");
  console.log((t?.job?.steps || []).map((s) => `${s.label} ${s.status} ${s.detail || ""}`).join("\n"));
  console.log("\n=== Last chief ===\n" + (result.lastCompile || "").slice(0, 1200));
  console.log("\n=== Issues ===");
  if (!result.issues.length) console.log("none");
  else result.issues.forEach((i) => console.log("- " + i));

  if (!done) {
    console.error("TIMEOUT");
    process.exit(1);
  }
  if (result.issues.length) process.exit(2);
  console.log("\nOK cities food job complete with no analyzer issues");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
