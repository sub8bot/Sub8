#!/usr/bin/env node
/**
 * Delete the current Claude desk group, create 5 Claude bots on one VM,
 * then run 60 unique worker-cooperation tests. Wall clock cap: 4 hours.
 */
const BASE = process.env.SUB8_URL || "http://127.0.0.1:8787";
const DEADLINE = Date.now() + 4 * 60 * 60 * 1000;
const PER_TEST_MS = 3 * 60 * 1000;
const HARNESS = { provider: "claude", model: "default" };

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

function testsFor(workers) {
  const [a, b, c, d] = workers;
  const sites = [
    ["https://example.com", "https://example.org"],
    ["https://example.net", "https://example.edu"],
    ["https://wikipedia.org", "https://www.iana.org/domains/reserved"],
    ["https://httpbin.org/html", "https://httpbin.org/json"],
    ["https://httpbin.org/uuid", "https://httpbin.org/headers"],
    ["https://jsonplaceholder.typicode.com/todos/1", "https://jsonplaceholder.typicode.com/users/1"],
    ["https://jsonplaceholder.typicode.com/posts/1", "https://jsonplaceholder.typicode.com/comments/1"],
    ["https://news.ycombinator.com", "https://example.com"],
    ["https://github.com", "https://gitlab.com"],
    ["https://www.w3.org", "https://developer.mozilla.org"],
  ];
  const out = [];
  let n = 0;
  const add = (title, prompt) => {
    n += 1;
    out.push({ n, title, prompt });
  };

  add(
    "window census",
    `Use list_teammates. Ask each worker (${a}, ${b}, ${c}, ${d}) via message_teammate to reply with their Sub8 window title only. When they answer you, summarize all four titles in send_message.`,
  );
  add(
    "hello relay",
    `Ask ${a} via message_teammate to say a one-word hello. When you receive ${a}'s reply, send that exact word to ${b} and have ${b} echo it back. Then send_message the echoed word.`,
  );
  add(
    "idle all",
    `message_teammate every worker to stay idle, no clicks, and reply "idle". After replies, send_message "all idle".`,
  );

  for (const [u1, u2] of sites) {
    add(
      `split ${new URL(u1).hostname} / ${new URL(u2).hostname}`,
      `Assign ${a} to open ${u1} in THEIR Chrome window and reply with the page title. Assign ${b} to open ${u2} in THEIR window and reply with the page title. Do not open those URLs yourself. When both have replied, send_message both titles.`,
    );
  }

  const facts = [
    [`${a}`, `${b}`, "What is 17+24? Reply with the number only."],
    [`${b}`, `${c}`, "Name the HTTP status for OK. Reply with the number only."],
    [`${c}`, `${d}`, "How many bits in a byte? Reply with the number only."],
    [`${d}`, `${a}`, "Primary color that is not red or yellow? One word."],
    [`${a}`, `${c}`, "ISO 2-letter code for Japan? Two letters."],
    [`${b}`, `${d}`, "First prime after 10? Number only."],
  ];
  for (const [from, to, q] of facts) {
    add(
      `ask ${from} then tell ${to}`,
      `Ask ${from} via message_teammate: "${q}" When they reply, message_teammate ${to} with that answer and have ${to} confirm it. Then send_message the confirmed answer.`,
    );
  }

  const solos = [
    [`${a}`, "https://example.com", "h1 text"],
    [`${b}`, "https://example.org", "h1 text"],
    [`${c}`, "https://httpbin.org/html", "first heading"],
    [`${d}`, "https://example.net", "title"],
  ];
  for (const [w, url, want] of solos) {
    add(
      `${w} fetch ${want}`,
      `Only ${w} should use the computer. message_teammate ${w} to open ${url} and reply with the ${want}. Other workers stay idle. When ${w} replies, send_message it.`,
    );
  }

  const chain = [
    [a, b, c],
    [b, c, d],
    [d, a, b],
    [c, d, a],
  ];
  let token = 1;
  for (const [x, y, z] of chain) {
    const word = `TOKEN${token++}`;
    add(
      `relay ${word} ${x}->${y}->${z}`,
      `Start a relay. message_teammate ${x} to reply with the exact string ${word}. When they do, send that string to ${y} to echo. Then send ${y}'s echo to ${z} to echo. send_message the final echo from ${z}.`,
    );
  }

  add(
    "count teammates",
    `list_teammates, then ask ${a} how many teammates they see (they should list_teammates too). send_message both counts.`,
  );
  add(
    "rename then greet",
    `Do not rename anyone. Ask ${b} via message_teammate what their name is. send_message their reply.`,
  );
  add(
    "two idle one work",
    `message_teammate ${a} and ${c} to reply "parked". message_teammate ${b} to open https://example.com and reply with the title. send_message all three replies.`,
  );
  add(
    "color names",
    `Ask ${a} to reply with the color of the sky in one word. Ask ${b} to reply with the color of grass in one word. send_message both words.`,
  );
  add(
    "http methods",
    `Ask ${c} the difference between GET and POST in one sentence. Ask ${d} what PUT is for in one sentence. send_message both sentences.`,
  );
  add(
    "timezone check",
    `Ask each worker to reply with the current local time on the desk if they can see a clock, otherwise "no clock". Summarize.`,
  );
  add(
    "no cross windows",
    `Remind ${a} and ${b} they must only drive their own Sub8: window. Each replies with their window tag. send_message both tags.`,
  );
  add(
    "example h1 pair",
    `Assign ${c} example.com H1 and ${d} example.org H1. Summarize both.`,
  );
  add(
    "json todo",
    `Assign ${a} to open https://jsonplaceholder.typicode.com/todos/1 and reply with the title field. send_message that title.`,
  );
  add(
    "json user",
    `Assign ${b} to open https://jsonplaceholder.typicode.com/users/1 and reply with the username. send_message it.`,
  );
  add(
    "iana word",
    `Assign ${c} to open https://www.iana.org/domains/reserved and reply with one reserved name they see. send_message it.`,
  );
  add(
    "mdn word",
    `Assign ${d} to open https://developer.mozilla.org and reply with the page title. send_message it.`,
  );
  add(
    "github title",
    `Assign ${a} to open https://github.com and reply with the page title only. Others idle. send_message the title.`,
  );
  add(
    "triple ping",
    `Ping ${a}, ${b}, and ${c} with "ack?" Each must reply "ack". send_message how many acks you got.`,
  );
  add(
    "delta last",
    `Ask ${d} to pick a fruit and tell ${a}. When ${a} tells you the fruit, send_message it.`,
  );
  add(
    "math split",
    `Ask ${a} 9*9. Ask ${b} 8*8. send_message both products.`,
  );
  add(
    "spell reverse",
    `Ask ${c} to reverse the word TEAM and reply. send_message the reversed word.`,
  );
  add(
    "worker census names",
    `Ask ${a} to list teammate names they know via list_teammates. send_message that list.`,
  );
  add(
    "stay parked",
    `Tell all workers "parked, no navigation". Collect four parked replies. send_message "parked 4".`,
  );
  add(
    "one url two readers",
    `Both ${a} and ${b} open https://example.com independently in their own windows and each report H1. send_message if they match.`,
  );
  add(
    "handoff url",
    `Ask ${a} for a URL they would open (they should pick https://example.org). Send that URL to ${b} to actually open and report the title. send_message the title.`,
  );
  add(
    "status words",
    `Ask each worker for a single status word: ready/busy/blocked. send_message the four words.`,
  );
  add(
    "final rollup",
    `Ask ${a} and ${b} for one thing they did this session in five words. send_message both lines.`,
  );

  while (out.length < 60) {
    const i = out.length + 1;
    const w = workers[i % workers.length];
    add(
      `unique ping ${i}`,
      `This is unique test #${i}. message_teammate ${w} to reply with the code U${String(i).padStart(2, "0")}. send_message that code.`,
    );
  }
  return out.slice(0, 60);
}

async function waitUntil(fn, { timeoutMs, every = 3000 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await fn();
    if (v) return v;
    if (Date.now() >= DEADLINE) throw new Error("global 4h deadline");
    await sleep(every);
  }
  return null;
}

async function botById(id) {
  const bots = await api("/api/bots");
  return bots.find((b) => b.id === id) || null;
}

async function waitQuiet(ids, timeoutMs) {
  return waitUntil(
    async () => {
      const bots = await api("/api/bots");
      const live = ids.map((id) => bots.find((b) => b.id === id)).filter(Boolean);
      if (live.some((b) => b.busy)) return null;
      return live;
    },
    { timeoutMs, every: 4000 },
  );
}

async function waitDesk(chiefId) {
  console.log("waiting for shared desk…");
  const ok = await waitUntil(
    async () => {
      const b = await botById(chiefId);
      const vm = b?.vm || {};
      return vm.status === "running" && (vm.setup?.ready || vm.chrome) ? b : null;
    },
    { timeoutMs: 8 * 60 * 1000, every: 5000 },
  );
  if (!ok) throw new Error("desk did not become ready");
  console.log("desk ready", ok.vm?.container, ok.vm?.status);
}

async function main() {
  const logPath = new URL("../data/team-coop-run.jsonl", import.meta.url);
  const { mkdir, appendFile, writeFile } = await import("node:fs/promises");
  await mkdir(new URL("../data/", import.meta.url), { recursive: true });
  await writeFile(logPath, "", "utf8");
  const log = async (row) => {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...row });
    console.log(line);
    await appendFile(logPath, `${line}\n`);
  };

  await api("/api/health");
  const existing = await api("/api/teams");
  for (const t of existing) {
    console.log("deleting team", t.name, t.id);
    await api(`/api/teams/${t.id}?wipe=1`, { method: "DELETE", body: { wipe: true } });
  }

  const claude = HARNESS;
  const created = await api("/api/teams", {
    method: "POST",
    body: {
      name: "Coop five",
      members: [
        { name: "Chief", role: "chief", harness: claude },
        { name: "Alpha", role: "worker", harness: claude },
        { name: "Bravo", role: "worker", harness: claude },
        { name: "Charlie", role: "worker", harness: claude },
        { name: "Delta", role: "worker", harness: claude },
      ],
    },
  });
  const chiefId = created.chiefId;
  const workers = created.members.filter((m) => m.role === "worker").map((m) => m.name);
  const ids = created.memberIds;
  console.log("created", created.name, ids);
  await waitDesk(chiefId);

  const cases = testsFor(workers);
  const summary = { ok: 0, fail: 0, skip: 0, results: [] };
  for (const t of cases) {
    if (Date.now() >= DEADLINE) {
      summary.skip += cases.length - (t.n - 1);
      break;
    }
    const before = await botById(chiefId);
    const beforeN = (before?.messages || []).length;
    const prompt = `Cooperation test ${t.n}/60 — ${t.title}.\nYou are Chief. Workers: ${workers.join(", ")}. Use list_teammates and message_teammate. Do the computer work through workers when a URL is involved. ${t.prompt}\nWhen finished, send_message a short result.`;
    try {
      await api(`/api/bots/${chiefId}/messages`, { method: "POST", body: { content: prompt } });
      const quiet = await waitQuiet(ids, Math.min(PER_TEST_MS, DEADLINE - Date.now()));
      const after = await botById(chiefId);
      const newMsgs = (after?.messages || []).slice(beforeN);
      const reply = [...newMsgs].reverse().find((m) => m.role === "assistant" && m.content && m.kind !== "choices");
      const workerTouched = (await api("/api/bots")).filter((b) => workers.includes(b.name));
      const handed = workerTouched.some((w) =>
        (w.messages || []).some((m) => m.speakerId === chiefId || /says:/i.test(m.content || "")),
      );
      const ok = Boolean(quiet && reply);
      const row = {
        n: t.n,
        title: t.title,
        ok,
        handed,
        busyTimeout: !quiet,
        reply: reply ? String(reply.content).slice(0, 280) : "",
      };
      if (ok) summary.ok += 1;
      else summary.fail += 1;
      summary.results.push(row);
      await log(row);
    } catch (err) {
      summary.fail += 1;
      const row = { n: t.n, title: t.title, ok: false, error: err.message };
      summary.results.push(row);
      await log(row);
    }
  }
  const recap = {
    done: true,
    ok: summary.ok,
    fail: summary.fail,
    skip: summary.skip,
    team: created.id,
    log: String(logPath.pathname),
  };
  await log(recap);
  await writeFile(new URL("../data/team-coop-summary.json", import.meta.url), JSON.stringify(summary, null, 2));
  console.log("DONE", recap);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
