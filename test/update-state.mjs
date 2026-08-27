import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TOOLS } from "../server/tools-catalog.mjs";
import {
  handleUpdateState,
  resolveStateMemoryPath,
  UPDATE_STATE_TARGETS,
  UPDATE_STATE_ACTIONS,
} from "../server/update-state.mjs";
import { skillMdPath } from "@sub8/skills";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const botId = "e0880729-a7f3-46a2-bead-ceecaa3f76fc";

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log("ok  " + name);
    })
    .catch((err) => {
      console.error("not ok " + name);
      throw err;
    });
}

function sampleBot(extra = {}) {
  return { id: botId, name: "Lead", description: "Ops", routines: [], ...extra };
}

function memoryIo() {
  const files = new Map();
  const writer = async (p, text) => {
    if (text == null) {
      files.delete(p);
      return;
    }
    files.set(p, String(text));
  };
  return { files, writer };
}

await test("TOOLS catalogs update_state with spec targets", () => {
  const row = TOOLS.find((t) => t.function?.name === "update_state");
  assert.ok(row, "update_state missing from tools-catalog");
  assert.deepEqual(row.function.parameters.required, ["target", "action"]);
  assert.deepEqual(row.function.parameters.properties.target.enum, [...UPDATE_STATE_TARGETS]);
});

await test("resolveStateMemoryPath uses agent/user/project tiers", () => {
  const bot = sampleBot();
  assert.equal(
    resolveStateMemoryPath(bot, { tier: "profile" }),
    `/config/agent-data/agents/${botId}/memory/profile.md`,
  );
  assert.equal(resolveStateMemoryPath(bot, { tier: "note" }), `/config/agent-data/agents/${botId}/memory/notes.md`);
  assert.equal(
    resolveStateMemoryPath(bot, { scope: "user", tier: "profile" }),
    `/config/agent-data/user-memory/by-agent/${botId}/profile.md`,
  );
  assert.equal(
    resolveStateMemoryPath(bot, { scope: "project", slug: "job-hunt", tier: "profile" }),
    `/config/agent-data/projects/job-hunt/memory/by-agent/${botId}/profile.md`,
  );
  assert.equal(
    resolveStateMemoryPath(bot, { path: "memory/profile.md" }),
    `/config/agent-data/agents/${botId}/memory/profile.md`,
  );
});

await test("memory write and forget call injected handleMemory", async () => {
  const bot = sampleBot();
  const calls = [];
  const write = await handleUpdateState(
    bot,
    { target: "memory", action: "write", content: "Prefer the state API.", tier: "note" },
    {
      handleMemory: async (_b, args) => {
        calls.push(args);
        return { ok: true, text: `wrote ${args.path}` };
      },
    },
  );
  assert.equal(write.ok, true);
  assert.equal(calls[0].action, "write");
  assert.equal(calls[0].content, "Prefer the state API.");
  assert.equal(calls[0].path, `/config/agent-data/agents/${botId}/memory/notes.md`);

  const forget = await handleUpdateState(
    bot,
    { target: "memory", action: "forget", scope: "user", tier: "profile" },
    {
      handleMemory: async (_b, args) => {
        calls.push(args);
        return { ok: true, text: `wrote ${args.path}` };
      },
    },
  );
  assert.equal(forget.ok, true);
  assert.equal(calls[1].action, "write");
  assert.equal(calls[1].content, "");
  assert.equal(calls[1].path, `/config/agent-data/user-memory/by-agent/${botId}/profile.md`);
});

await test("memory write falls back to injected appendFile", async () => {
  const bot = sampleBot();
  const writes = [];
  const r = await handleUpdateState(
    bot,
    { target: "memory", action: "write", path: "/config/workspace/facts.md", content: "keep" },
    {
      handleMemory: undefined,
      appendFile: async (_b, dest, text) => {
        writes.push({ dest, text });
      },
    },
  );
  assert.equal(r.ok, true);
  assert.deepEqual(writes, [{ dest: "/config/workspace/facts.md", text: "keep" }]);
});

await test("routine create/update/pause/resume/delete via upsertRoutine stub", async () => {
  const bot = sampleBot();
  const specs = [];
  const r = {
    id: "rt-1",
    name: "Inbox",
    instruction: "Check the team inbox every 15 minutes and post once if anything new landed.",
    enabled: true,
  };
  const created = await handleUpdateState(
    bot,
    {
      target: "routine",
      action: "create",
      name: "Inbox",
      instruction: r.instruction,
      interval_minutes: 15,
    },
    {
      upsertRoutine: (b, spec) => {
        specs.push(spec);
        assert.equal(spec.forceNew, true);
        b.routines = [{ ...r }];
        return { routine: b.routines[0], merged: false };
      },
    },
  );
  assert.equal(created.ok, true);
  assert.equal(created.persist, true);
  assert.equal(bot.routines.length, 1);
  assert.match(created.text, /Created "Inbox"/);

  const updated = await handleUpdateState(
    bot,
    { target: "routine", action: "update", id: "rt-1", instruction: `${r.instruction} Answer mentions.` },
    {
      upsertRoutine: (b, spec) => {
        specs.push(spec);
        assert.equal(spec.id, "rt-1");
        assert.equal(spec.forceReplace, true);
        b.routines[0].instruction = spec.instruction;
        return { routine: b.routines[0], merged: true };
      },
    },
  );
  assert.equal(updated.ok, true);
  assert.match(updated.text, /Updated "Inbox"/);

  const paused = await handleUpdateState(bot, { target: "routine", action: "pause", id: "rt-1" });
  assert.equal(paused.ok, true);
  assert.equal(bot.routines[0].enabled, false);
  const resumed = await handleUpdateState(bot, { target: "routine", action: "resume", id: "rt-1" });
  assert.equal(resumed.ok, true);
  assert.equal(bot.routines[0].enabled, true);
  const deleted = await handleUpdateState(bot, { target: "routine", action: "delete", id: "rt-1" });
  assert.equal(deleted.ok, true);
  assert.equal(bot.routines.length, 0);
  assert.equal(specs.length, 2);
});

await test("routine create uses exported upsertRoutine", async () => {
  const bot = sampleBot();
  const r = await handleUpdateState(bot, {
    target: "routine",
    action: "create",
    name: "Inbox",
    instruction: "Check the team inbox every 15 minutes and post once if anything new landed.",
    interval_minutes: 15,
  });
  assert.equal(r.ok, true, r.text);
  assert.equal(bot.routines.length, 1);
  assert.equal(bot.routines[0].enabled, true);
  const id = bot.routines[0].id;
  const paused = await handleUpdateState(bot, { target: "routine", action: "pause", id });
  assert.equal(paused.ok, true);
  assert.equal(bot.routines[0].enabled, false);
});

await test("skill write/delete uses injected writer", async () => {
  const bot = sampleBot();
  const io = memoryIo();
  const written = await handleUpdateState(
    bot,
    {
      target: "skill",
      action: "write",
      id: "inbox-triage",
      name: "Inbox triage",
      description: "Use when the user wants mail sorted.",
      body: "# Steps\n1. Open the inbox.\n",
    },
    { writer: io.writer },
  );
  assert.equal(written.ok, true, written.text);
  assert.ok(io.files.has(skillMdPath("inbox-triage")));
  const blocked = await handleUpdateState(
    bot,
    { target: "skill", action: "delete", id: "inbox-triage" },
    { writer: io.writer },
  );
  assert.equal(blocked.ok, false);
  assert.match(blocked.text, /confirm required/);
  assert.equal(io.files.has(skillMdPath("inbox-triage")), true);
  const gone = await handleUpdateState(
    bot,
    { target: "skill", action: "delete", id: "inbox-triage", confirm: true },
    { writer: io.writer },
  );
  assert.equal(gone.ok, true, gone.text);
  assert.equal(io.files.has(skillMdPath("inbox-triage")), false);
});

await test("profile set updates name and description", async () => {
  const bot = sampleBot();
  const r = await handleUpdateState(bot, {
    target: "profile",
    action: "set",
    name: "Chief",
    description: "Leads the desk.",
  });
  assert.equal(r.ok, true);
  assert.equal(r.persist, true);
  assert.equal(bot.name, "Chief");
  assert.equal(bot.description, "Leads the desk.");
});

await test("project create/join/leave call injected helpers", async () => {
  const bot = sampleBot();
  const calls = [];
  const created = await handleUpdateState(
    bot,
    { target: "project", action: "create", name: "Job hunt", description: "Thursday search." },
    {
      createProject: async (opts) => {
        calls.push(["create", opts]);
        return { ...opts, slug: opts.slug || "job-hunt" };
      },
    },
  );
  assert.equal(created.ok, true);
  assert.match(created.text, /job-hunt/);

  const joined = await handleUpdateState(
    bot,
    { target: "project", action: "join", slug: "job-hunt" },
    {
      joinProject: async (id, slug, opts) => {
        calls.push(["join", id, slug, opts?.name]);
        return { slug, memberIds: [id] };
      },
    },
  );
  assert.equal(joined.ok, true);
  assert.deepEqual(calls[1], ["join", botId, "job-hunt", ""]);

  const left = await handleUpdateState(
    bot,
    { target: "project", action: "leave", slug: "job-hunt" },
    {
      leaveProject: async (id, slug) => {
        calls.push(["leave", id, slug]);
        return { slug, memberIds: [] };
      },
    },
  );
  assert.equal(left.ok, true);
  assert.deepEqual(calls[2], ["leave", botId, "job-hunt"]);
});

await test("avatar settings and channel return not wired", async () => {
  const bot = sampleBot();
  for (const target of ["avatar", "settings", "channel"]) {
    const r = await handleUpdateState(bot, { target, action: "set" });
    assert.equal(r.ok, false);
    assert.match(r.text, /not wired/);
  }
});

await test("missing target/action and unknown target fail clearly", async () => {
  const bot = sampleBot();
  assert.match((await handleUpdateState(bot, { action: "write" })).text, /target required/);
  assert.match((await handleUpdateState(bot, { target: "memory" })).text, /action required/);
  assert.match((await handleUpdateState(bot, { target: "widget", action: "set" })).text, /unknown target/);
  assert.equal((await handleUpdateState(null, { target: "profile", action: "set" })).ok, false);
});

await test("mcp-sub8 still has cloud_agent, tryCloudStateTool, aliases, and update_state", () => {
  const src = readFileSync(path.join(root, "server/mcp-sub8.mjs"), "utf8");
  assert.match(src, /from ["']\.\/update-state\.mjs["']/);
  assert.match(src, /handleUpdateState/);
  assert.match(src, /name: "update_state"/);
  assert.match(src, /name: "cloud_agent"/);
  assert.match(src, /tryCloudStateTool/);
  assert.match(src, /from ["']\.\/desk-harness\/mcp-cloud\.mjs["']/);
  assert.match(src, /CloudAgent:\s*"cloud_agent"/);
  assert.match(src, /SendMessage:\s*"send_message"/);
  assert.match(src, /SendToAgent:\s*"message_teammate"/);
  assert.match(src, /CreateAgent:\s*"create_teammate"/);
  assert.doesNotMatch(src, /wakes\.mjs/);
  assert.equal(UPDATE_STATE_ACTIONS.memory.join("|"), "write|forget");
});
