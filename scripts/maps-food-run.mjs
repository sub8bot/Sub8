#!/usr/bin/env node
/**
 * One chief + five scouts on one Linux computer, each on their own X display.
 * Each scout opens Google Maps on THEIR screen, searches a different food in
 * San Francisco, and reports the top place back. Chief compiles.
 * Does not touch AikaBotto or other non-test teams.
 */
const BASE = process.env.SUB8_URL || "http://127.0.0.1:8787";
const DEADLINE_MS = Number(process.env.MAPS_FOOD_MS || 12 * 60 * 1000);
const HARNESS = { provider: "claude", model: "default" };
const CITY = "San Francisco";
const FOODS = [
  { name: "Pizza", query: "pizza in San Francisco" },
  { name: "Tacos", query: "tacos in San Francisco" },
  { name: "Sushi", query: "sushi in San Francisco" },
  { name: "Ramen", query: "ramen in San Francisco" },
  { name: "Burgers", query: "burgers in San Francisco" },
];
const TEST_TEAM_NAMES = new Set(["Desk Lab", "Maps Kitchen"]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
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
  if (!res.ok) throw new Error(`${opts.method || "GET"} ${path} ${res.status}: ${data?.error || text.slice(0, 200)}`);
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

function lastAssistant(bot) {
  const msgs = (bot.messages || []).filter((m) => m.role === "assistant" && m.content);
  return msgs.length ? msgs[msgs.length - 1].content : "";
}

function anyReport(bot) {
  const msgs = (bot.messages || []).filter((m) => m.role === "assistant" && m.content);
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (looksLikeReport(msgs[i].content)) return msgs[i].content;
  }
  return "";
}

function looksLikeReport(text) {
  const t = String(text || "").toLowerCase();
  if (t.length < 80) return false;
  if (/assign(ed|ing)? all|running in parallel|i'll compile|i will compile|once all five|holding off the desk|i'll load the tools/i.test(t)) {
    if (!/\d\.\d/.test(t) && !/★/.test(t)) return false;
  }
  const foods = FOODS.filter((f) => t.includes(f.name.toLowerCase()));
  const rated = (t.match(/\d\.\d/g) || []).length;
  const failed = /failed|none|couldn't|could not|no result/i.test(t);
  return foods.length >= 4 && (rated >= 3 || (rated >= 1 && failed));
}

function dockerEnv() {
  const env = { ...process.env };
  if (!env.DOCKER_HOST) {
    const home = env.HOME || "";
    env.DOCKER_HOST = `unix://${home}/.colima/default/docker.sock`;
  }
  return env;
}

async function dockerRun(args, { stdio = "inherit" } = {}) {
  const { spawn } = await import("node:child_process");
  await new Promise((resolve, reject) => {
    const child = spawn("docker", args, { env: dockerEnv(), stdio });
    child.on("close", (code) => (code === 0 ? resolve() : resolve()));
    child.on("error", reject);
  });
}

async function dockerUpdateMem(container, mem = "6g") {
  await dockerRun(["update", "--memory", mem, "--memory-swap", mem, container]);
}

async function installDeskScripts(container) {
  const { fileURLToPath } = await import("node:url");
  const path = await import("node:path");
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..") + "/";
  const files = [
    ["vm/desk-display.sh", "desk-display"],
    ["vm/page-agent.py", "page-agent"],
    ["vm/chrome-desktop.sh", "chrome-desktop"],
    ["vm/chrome-one-tab.py", "chrome-one-tab"],
  ];
  for (const [rel, dest] of files) {
    await dockerRun(["cp", `${root}${rel}`, `${container}:/tmp/${dest}`], { stdio: "ignore" });
  }
  await dockerRun([
    "exec",
    "-u",
    "root",
    container,
    "bash",
    "-lc",
    "install -m 755 /tmp/desk-display /usr/local/bin/desk-display && install -m 755 /tmp/page-agent /usr/local/bin/page-agent && install -m 755 /tmp/chrome-desktop /usr/local/bin/chrome-desktop && install -m 755 /tmp/chrome-one-tab /usr/local/bin/chrome-one-tab",
  ]);
}

async function startWorkerDisplays(container, n = 6) {
  for (let i = 2; i <= n; i++) {
    await dockerRun(["exec", "-u", "abc", "-e", "HOME=/config", container, "/usr/local/bin/desk-display", String(i)]);
  }
}

async function main() {
  await api("/api/health");
  const bots0 = await api("/api/bots");
  const aika = bots0.find((b) => /aika/i.test(b.name || ""));
  if (aika) console.log("leaving", aika.name, aika.id, "alone");

  const teams = await api("/api/teams");
  for (const t of teams) {
    if (!TEST_TEAM_NAMES.has(t.name)) {
      console.log("skip team", t.name);
      continue;
    }
    console.log("deleting test team", t.name, t.id);
    await api(`/api/teams/${t.id}?wipe=1`, { method: "DELETE", body: { wipe: true } });
  }

  const created = await api("/api/teams", {
    method: "POST",
    body: {
      name: "Maps Kitchen",
      members: [
        { name: "Scout", role: "chief", harness: HARNESS },
        ...FOODS.map((f) => ({ name: f.name, role: "worker", harness: HARNESS })),
      ],
    },
  });
  const chiefId = created.chiefId;
  const workers = created.members.filter((m) => m.role === "worker");
  console.log("created", created.name, "chief", created.members.find((m) => m.role === "chief")?.name, "workers", workers.map((w) => w.name).join(", "));

  console.log("waiting for shared desk…");
  const ready = await waitUntil(
    async () => {
      const b = (await api("/api/bots")).find((x) => x.id === chiefId);
      const vm = b?.vm || {};
      const health = await api(`/api/bots/${chiefId}/stream-health`).catch(() => ({}));
      if (health.ok && health.chrome && (vm.status === "running" || health.running)) return b;
      return null;
    },
    { timeoutMs: 4 * 60 * 1000, every: 4000 },
  );
  if (!ready) throw new Error("desk did not become ready");
  const container = ready.vm?.container;
  console.log("desk ready", container, ready.vm?.status, "display", ready.vm?.display);
  if (container) {
    await dockerUpdateMem(container, process.env.LOCALBOT_MEMORY || "6g");
    await installDeskScripts(container);
    await startWorkerDisplays(container, 6);
    console.log("worker displays :2-:6 up");
  }

  const roster = (await api("/api/bots")).filter((b) => (created.memberIds || []).includes(b.id));
  for (const b of roster) {
    console.log(" ", b.name, b.teamRole || "", b.vm?.display || "?", b.vm?.debugPort || "");
  }

  const assigns = FOODS.map((f) => `- ${f.name}: on YOUR screen, open Maps for "${f.query}", reply with the top restaurant name and rating (or "none").`).join("\n");
  const prompt = `You are Scout, chief of Maps Kitchen. Workers: ${FOODS.map((f) => f.name).join(", ")}.

This team shares ONE Linux computer (same /config disk) but EACH worker has their own X display and Chrome (one tab). Do not drive a teammate's screen. Do not search Maps yourself.

Assign ALL five workers now via message_teammate (they can run in parallel):
${assigns}

Tell each worker: use the browser tool (navigate + snapshot + click/fill by ref). computer is only for dialogs. One tab. City is ${CITY}. This is a one-shot. Do not upsert_routine.

When all five have replied, send_message a short list: food → place → rating. Then STOP. Do not re-search Maps. Do not verify a worker's listing unless they reported none. If someone failed after one reminder, mark them failed and finish with what you have.`;

  console.log("dispatching Maps food job to Scout");
  await api(`/api/teams/${created.id}/messages`, {
    method: "POST",
    body: { content: prompt, toIds: [chiefId] },
  });

  const t0 = Date.now();
  const done = await waitUntil(
    async () => {
      const bots = await api("/api/bots");
      const chief = bots.find((b) => b.id === chiefId);
      if (!chief) return null;
      const compiled = anyReport(chief);
      if (compiled) return { chief, text: compiled, bots };
      if (chief.busy) return null;
      const text = lastAssistant(chief);
      const ids = new Set(created.memberIds);
      if (bots.some((b) => ids.has(b.id) && b.busy)) return null;
      const spoken = workers.filter((w) => lastAssistant(bots.find((x) => x.id === w.id)).length > 60).length;
      if (spoken >= 4 && looksLikeReport(text)) return { chief, text, bots };
      if (spoken >= 4 && Date.now() - t0 > 3 * 60_000 && text && text.length > 80 && /pizza|tacos|sushi|ramen|burger/i.test(text)) {
        return { chief, text, bots, weak: true };
      }
      return null;
    },
    { timeoutMs: DEADLINE_MS, every: 5000 },
  );

  if (!done) {
    const bots = await api("/api/bots");
    const chief = bots.find((b) => b.id === chiefId);
    console.error("TIMEOUT. last Scout message:\n", lastAssistant(chief));
    for (const w of workers) {
      const b = bots.find((x) => x.id === w.id);
      console.error(w.name, lastAssistant(b).slice(0, 240));
    }
    process.exit(1);
  }

  console.log(done.weak ? "WEAK report (desk went quiet)" : "OK report");
  console.log(done.text);
  for (const w of workers) {
    const b = done.bots.find((x) => x.id === w.id);
    const t = lastAssistant(b);
    if (t) console.log(`--- ${w.name} ---\n${t.slice(0, 400)}\n`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
