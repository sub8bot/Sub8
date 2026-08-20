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
  const own = msgs.filter((m) => !m.speakerName || m.speakerName === bot.name);
  const pick = own.length ? own : msgs;
  return pick.length ? pick[pick.length - 1].content : "";
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

  const job = await api(`/api/teams/${created.id}/job`, {
    method: "PUT",
    body: {
      title: "SF food map",
      steps: [
        ...FOODS.map((f) => {
          const w = workers.find((x) => x.name === f.name);
          return { label: f.name, bot_id: w?.id };
        }),
        { label: "Summary", bot_id: chiefId },
      ],
    },
  });
  console.log("job", job.title, job.steps.map((s) => s.label).join(", "));

  const assigns = FOODS.map((f) => `- ${f.name}: Maps "${f.query}" on YOUR screen. update_task running, then done with detail "<place> <rating>". message_teammate Scout ONE line.`).join("\n");
  const prompt = `You are Scout, chief of Maps Kitchen. The progress bar already has steps: ${FOODS.map((f) => f.name).join(", ")}, Summary.

Do not search Maps yourself. Assign ALL five via message_teammate (parallel is fine):
${assigns}

Watch list_tasks. When the five food steps are done (or blocked), send_message a short 5-line list: food → place → rating. Then update_task label=Summary status=done and STOP. No re-search. No upsert_routine. City is ${CITY}.`;

  console.log("dispatching Maps food job to Scout");
  await api(`/api/teams/${created.id}/messages`, {
    method: "POST",
    body: { content: prompt, toIds: [chiefId] },
  });

  const done = await waitUntil(
    async () => {
      const teams = await api("/api/teams");
      const t = teams.find((x) => x.id === created.id);
      const steps = t?.job?.steps || [];
      const foods = steps.filter((s) => s.label !== "Summary");
      const summary = steps.find((s) => s.label === "Summary");
      const foodsDone = foods.length === FOODS.length && foods.every((s) => s.status === "done" || s.status === "blocked");
      if (foodsDone && summary?.status === "done") {
        const bots = await api("/api/bots");
        const chief = bots.find((x) => x.id === chiefId);
        return { job: t.job, chief, bots, text: lastAssistant(chief) };
      }
      const line = steps.map((s) => `${s.label}:${s.status}${s.detail ? `(${s.detail.slice(0, 24)})` : ""}`).join(" ");
      console.log("job", line || "(none)");
      return null;
    },
    { timeoutMs: DEADLINE_MS, every: 5000 },
  );

  if (!done) {
    const bots = await api("/api/bots");
    const chief = bots.find((b) => b.id === chiefId);
    const teams = await api("/api/teams");
    console.error("TIMEOUT. job", JSON.stringify(teams.find((t) => t.id === created.id)?.job || {}, null, 2));
    console.error("last Scout:\n", lastAssistant(chief));
    process.exit(1);
  }

  console.log("OK job complete");
  console.log(done.job.steps.map((s) => `${s.label} ${s.status} ${s.detail || ""}`).join("\n"));
  if (done.text) console.log("\nScout:\n", done.text.slice(0, 800));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
