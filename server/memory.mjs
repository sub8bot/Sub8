import path from "node:path";
import * as vm from "./vm.mjs";
import { cadenceLabel } from "./routines.mjs";

export function agentRoot(bot) {
  return `/config/agent-data/agents/${bot.id}`;
}

export function slug(text) {
  const s = String(text || "job")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return s || "job";
}

export function resolveMemoryPath(bot, raw) {
  const p = String(raw || "").trim();
  if (!p) throw new Error("path required");
  const abs = p.startsWith("/") ? p : path.posix.join(agentRoot(bot), p);
  const n = path.posix.normalize(abs);
  if (n.includes("..") || n === "/" || n === "/config") throw new Error("invalid path");
  const ok =
    n === "/config/workspace" ||
    n.startsWith("/config/workspace/") ||
    n === "/config/agent-data" ||
    n.startsWith("/config/agent-data/");
  if (!ok) throw new Error("path must be under /config/agent-data or /config/workspace");
  return n;
}

function ym(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function iso(ts = Date.now()) {
  return new Date(ts).toISOString();
}

export function seedProfile(bot) {
  const title = String(bot?.title || "").trim();
  const desc = String(bot?.description || "").trim();
  return [
    `# ${bot?.name || "Bot"}`,
    title ? `${title}` : "",
    desc ? `\n${desc}` : "",
    "",
    "Lasting facts I should remember go here. Update this file when something should persist across turns.",
    "",
  ]
    .filter((l, i, a) => !(l === "" && a[i - 1] === ""))
    .join("\n");
}

function hasVm(bot) {
  return Boolean(bot?.vm?.container) && bot.vm.status !== "missing";
}

async function writeIfMissing(container, dest, text) {
  const cur = await vm.readFileFromContainer(container, dest);
  if (String(cur || "").trim()) return false;
  await vm.writeFileToContainer(container, dest, text);
  return true;
}

export async function ensureLayout(bot) {
  if (!hasVm(bot)) return null;
  const box = bot.vm.container;
  const root = agentRoot(bot);
  await vm.mkdirpInContainer(box, `${root}/memory/log`);
  await vm.mkdirpInContainer(box, `${root}/automations`);
  await vm.mkdirpInContainer(box, `/config/agent-data/user-memory/by-agent/${bot.id}`);
  await vm.mkdirpInContainer(box, `/config/agent-data/workflows`);
  await vm.mkdirpInContainer(box, `/config/workspace`);
  await writeIfMissing(box, `${root}/memory/profile.md`, seedProfile(bot));
  await writeIfMissing(
    box,
    `${root}/profile.json`,
    `${JSON.stringify(
      { id: bot.id, name: bot.name || "Bot", title: bot.title || "", description: bot.description || "" },
      null,
      2,
    )}\n`,
  );
  await writeIfMissing(
    box,
    `/config/agent-data/user-memory/by-agent/${bot.id}/profile.md`,
    `# ${bot.name || "Bot"}\n\nShared facts every assistant on this computer should know.\n`,
  );
  for (const r of bot.routines || []) {
    if (!r?.id) continue;
    const dir = `${root}/automations/${slug(r.name || r.id)}`;
    await vm.mkdirpInContainer(box, dir);
    await writeIfMissing(
      box,
      `${dir}/automation.json`,
      `${JSON.stringify(
        {
          id: r.id,
          name: r.name || "Routine",
          cadence: cadenceLabel(r),
          instruction: String(r.instruction || "").slice(0, 4000),
        },
        null,
        2,
      )}\n`,
    );
    await writeIfMissing(box, `${dir}/runs.jsonl`, "");
  }
  return root;
}

export async function digest(bot, { max = 1400 } = {}) {
  if (!hasVm(bot)) return "";
  try {
    await ensureLayout(bot);
    const box = bot.vm.container;
    const root = agentRoot(bot);
    const profile = await vm.readFileFromContainer(box, `${root}/memory/profile.md`);
    const log = await vm.readFileFromContainer(box, `${root}/memory/log/${ym()}.md`);
    const logTail = String(log || "")
      .trim()
      .split("\n")
      .slice(-8)
      .join("\n");
    let runs = "";
    for (const r of (bot.routines || []).slice(0, 4)) {
      const raw = await vm.readFileFromContainer(box, `${root}/automations/${slug(r.name || r.id)}/runs.jsonl`);
      const last = String(raw || "")
        .trim()
        .split("\n")
        .filter(Boolean)
        .slice(-2);
      if (last.length) runs += `\n${r.name}:\n${last.join("\n")}`;
    }
    const body = [`## ${bot.name || "Bot"}`, String(profile || "").trim(), logTail ? `\nRecent log:\n${logTail}` : "", runs]
      .filter(Boolean)
      .join("\n")
      .trim();
    if (body.length <= max) return body;
    return `${body.slice(0, max).trim()}\n…`;
  } catch {
    return "";
  }
}

export async function promptBlock(bot) {
  const root = agentRoot(bot);
  const facts = await digest(bot);
  const lines = [
    "",
    "## Memory on my computer",
    "Durable notes live on this disk (not an API, not curl). Home is `/config`.",
    `- Lasting facts: \`${root}/memory/profile.md\``,
    `- Dated history: \`${root}/memory/log/${ym()}.md\``,
    `- Shared facts: \`/config/agent-data/user-memory/by-agent/${bot.id}/profile.md\``,
    "- Working files: `/config/workspace/`",
    bot?.teamId
      ? "This computer is shared with your team. `/config/workspace/` is the shared project folder. Teammates' notes are on the same disk under `/config/agent-data/agents/<their-id>/`. Do not treat the machine as private."
      : "",
    "Each turn already includes a short digest. For the full note, `shell` `cat`/`rg` or the `memory` tool. Writes: `memory` (write/append) or `shell`. After a repeating job, append what changed so the next run continues instead of starting over.",
  ];
  if (facts) lines.push("", "### Digest", facts);
  lines.push("");
  return lines.join("\n");
}

export async function appendFile(bot, dest, text) {
  const box = bot.vm.container;
  const prev = await vm.readFileFromContainer(box, dest);
  const next = `${prev || ""}${prev && !String(prev).endsWith("\n") ? "\n" : ""}${text}${String(text).endsWith("\n") ? "" : "\n"}`;
  await vm.mkdirpInContainer(box, path.posix.dirname(dest));
  await vm.writeFileToContainer(box, dest, next);
}

export async function noteRoutineFire(bot, routine, now = Date.now()) {
  if (!hasVm(bot) || !routine) return { n: (routine?.runs || []).length, path: "" };
  await ensureLayout(bot);
  const box = bot.vm.container;
  const dir = `${agentRoot(bot)}/automations/${slug(routine.name || routine.id)}`;
  await vm.mkdirpInContainer(box, dir);
  const n = (Array.isArray(routine.runs) ? routine.runs.length : 0) || 1;
  const line = JSON.stringify({
    n,
    ts: now,
    at: iso(now),
    name: routine.name || "Routine",
    event: "fired",
  });
  await appendFile(bot, `${dir}/runs.jsonl`, `${line}\n`);
  const stamp = `## ${iso(now)}\n- Routine “${routine.name || "Routine"}” fired (run ${n}). Continue from prior notes; do not start over.\n`;
  await appendFile(bot, `${agentRoot(bot)}/memory/log/${ym(now)}.md`, stamp);
  return { n, path: `${dir}/runs.jsonl` };
}

export async function recentRuns(bot, routine, limit = 5) {
  if (!hasVm(bot) || !routine) return "";
  const raw = await vm.readFileFromContainer(
    bot.vm.container,
    `${agentRoot(bot)}/automations/${slug(routine.name || routine.id)}/runs.jsonl`,
  );
  return String(raw || "")
    .trim()
    .split("\n")
    .filter(Boolean)
    .slice(-limit)
    .join("\n");
}

export async function routineFirePrompt(bot, accepted, now = Date.now(), timeZone = "") {
  const r = accepted[0];
  if (!r) return "Standing routine is due.";
  const n = Array.isArray(r.runs) ? r.runs.length : 1;
  const last = r.runs?.[r.runs.length - 2]?.ts || r.lastRunAt || 0;
  const ago = last ? Math.max(1, Math.round((now - last) / 60_000)) : null;
  let hist = "";
  try {
    await noteRoutineFire(bot, r, now);
    hist = await recentRuns(bot, r, 5);
  } catch {
    /* desk may be down */
  }
  const root = agentRoot(bot);
  const auto = `${root}/automations/${slug(r.name || r.id)}`;
  const when = ago != null ? (n > 1 ? `run ${n}, last ran ${ago} min ago` : `run ${n}, first fire`) : `run ${n}`;
  return [
    `Standing routine “${r.name || "Routine"}” is due (${when}, ${cadenceLabel(r, timeZone).toLowerCase()}).`,
    "This is a repeating job, not a first-time task. Continue from previous progress. Do not start over, do not redo finished work, do not ignore the log.",
    `History on my computer: \`${auto}/runs.jsonl\` and \`${root}/memory/log/${ym(now)}.md\`.`,
    hist ? `Recent runs:\n${hist}` : "No prior run notes yet — create them as you go.",
    "After you make progress, append a short note with the memory tool (action=append) so the next fire can continue. If nothing material changed, append one line saying so and stop.",
    "",
    "Job:",
    r.instruction || "",
  ].join("\n");
}

export async function handleMemory(bot, args = {}) {
  if (!hasVm(bot)) return { text: "Computer is not running yet.", ok: false };
  const action = String(args.action || "read").toLowerCase();
  await ensureLayout(bot);
  if (action === "list") {
    const dir = args.path ? resolveMemoryPath(bot, args.path) : `/config/agent-data/agents/${bot.id}`;
    const r = await vm.shell(bot, `find ${JSON.stringify(dir)} -maxdepth 4 -type f 2>/dev/null | head -80`);
    return { text: r.output || "(empty)", ok: r.ok };
  }
  const dest = resolveMemoryPath(bot, args.path);
  if (action === "read") {
    const text = await vm.readFileFromContainer(bot.vm.container, dest);
    return { text: text || "(empty)", ok: true };
  }
  const content = String(args.content ?? "");
  if (action === "write") {
    await vm.mkdirpInContainer(bot.vm.container, path.posix.dirname(dest));
    await vm.writeFileToContainer(bot.vm.container, dest, content.endsWith("\n") ? content : `${content}\n`);
    return { text: `wrote ${dest}`, ok: true };
  }
  if (action === "append") {
    await appendFile(bot, dest, content);
    return { text: `appended ${dest}`, ok: true };
  }
  return { text: "action must be read, write, append, or list", ok: false };
}
