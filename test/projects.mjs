import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sub8-projects-"));
process.env.SUB8BOT_DATA = tmp;
process.env.OCTOBOT_DATA = tmp;

const memory = await import(path.join(root, "server/memory.mjs"));

function uid(n) {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function mockVm() {
  const dirs = [];
  const files = new Map();
  return {
    dirs,
    files,
    io: {
      async mkdirpInContainer(_c, dir) {
        dirs.push(dir);
      },
      async readFileFromContainer(_c, dest) {
        return files.get(dest) || "";
      },
      async writeFileToContainer(_c, dest, text) {
        files.set(dest, text);
      },
    },
  };
}

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log("ok  " + name);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.error("not ok " + name);
    throw err;
  }
}

const a = uid(1);
const b = uid(2);

await test("projectsPath is host data/projects.json", () => {
  assert.equal(memory.projectsPath, path.join(tmp, "projects.json"));
});

await test("createProject records slug, name, description and desk paths", async () => {
  const p = await memory.createProject({ name: "Job hunt", description: "Thursday search." });
  assert.equal(p.slug, "job-hunt");
  assert.equal(p.name, "Job hunt");
  assert.equal(p.description, "Thursday search.");
  assert.deepEqual(p.memberIds, []);
  assert.equal(p.dir, "/config/agent-data/projects/job-hunt");
  assert.equal(p.projectMd, "/config/agent-data/projects/job-hunt/project.md");
  assert.equal(p.shardsDir, "/config/agent-data/projects/job-hunt/memory/by-agent");

  const disk = JSON.parse(await fs.readFile(path.join(tmp, "projects.json"), "utf8"));
  assert.equal(disk.length, 1);
  assert.equal(disk[0].slug, "job-hunt");
  assert.deepEqual(disk[0].memberIds, []);
  await assert.rejects(() => memory.createProject({ name: "Job hunt" }), /project exists/);
});

await test("joinProject and leaveProject update host membership", async () => {
  const joined = await memory.joinProject(a, "job-hunt");
  assert.deepEqual(joined.memberIds, [a]);
  assert.equal(joined.shardDir, `/config/agent-data/projects/job-hunt/memory/by-agent/${a}`);

  const again = await memory.joinProject(a, "ops", { name: "Ops", description: "Shared ops notes." });
  assert.equal(again.slug, "ops");
  assert.equal(again.name, "Ops");
  assert.deepEqual(again.memberIds, [a]);

  const two = await memory.joinProject(b, "ops");
  assert.deepEqual(two.memberIds, [a, b]);

  const dup = await memory.joinProject(a, "ops");
  assert.deepEqual(dup.memberIds, [a, b]);

  const left = await memory.leaveProject(a, "ops");
  assert.deepEqual(left.memberIds, [b]);
  assert.equal(left.memberIds.includes(a), false);

  const still = await memory.getProject("ops");
  assert.deepEqual(still.memberIds, [b]);

  const mine = await memory.listJoinedProjects(b);
  assert.equal(mine.some((p) => p.slug === "ops"), true);
  const none = await memory.listJoinedProjects(a);
  assert.equal(none.some((p) => p.slug === "ops"), false);
});

await test("join/leave require UUID membership", async () => {
  await assert.rejects(() => memory.joinProject("Lead", "ops"), /UUID/);
  await assert.rejects(() => memory.leaveProject("Lead", "ops"), /UUID/);
  await assert.rejects(() => memory.leaveProject(a, "missing-project"), /project not found/);
});

await test("join with io seeds project.md and by-agent shard on the desk", async () => {
  const { dirs, files, io } = mockVm();
  const bot = { id: a, name: "Lead", vm: { container: "desk-test", status: "running" } };
  const joined = await memory.joinProject(a, "desk-notes", {
    name: "Desk notes",
    description: "What we learned on the computer.",
    bot,
    io,
  });
  const p = memory.projectLayoutPaths("desk-notes", a);
  assert.equal(joined.dir, p.root);
  for (const dir of [p.root, p.memoryDir, p.shardsDir, p.shardDir]) {
    assert.ok(dirs.includes(dir), dir);
  }
  assert.ok(files.has(p.projectMd));
  assert.ok(files.has(p.shardProfile));
  const parsed = memory.parseProjectMd(files.get(p.projectMd));
  assert.equal(parsed.name, "Desk notes");
  assert.equal(parsed.description, "What we learned on the computer.");
});

await test("ensureLayout still mkdirs empty projects/ and not a slug", async () => {
  const { dirs, files, io } = mockVm();
  const bot = {
    id: a,
    name: "Lead",
    vm: { container: "desk-test", status: "running" },
  };
  await memory.ensureLayout(bot, io);
  const layout = memory.layoutPaths(bot);
  assert.ok(dirs.includes(layout.projects));
  assert.equal(layout.projects, "/config/agent-data/projects");
  assert.equal(
    dirs.some((d) => d.startsWith("/config/agent-data/projects/") && d !== "/config/agent-data/projects"),
    false,
  );
  assert.equal(
    [...files.keys()].some((k) => String(k).includes("/projects/") && String(k).endsWith("project.md")),
    false,
  );
});

await test("ensureProjectLayout skips when the computer is not running", async () => {
  const { dirs, files, io } = mockVm();
  assert.equal(await memory.ensureProjectLayout({ id: a, vm: { status: "missing" } }, "ops"), null);
  assert.equal(dirs.length, 0);
  assert.equal(files.size, 0);
  // mock io still seeds when passed explicitly
  const p = await memory.ensureProjectLayout({ id: a, name: "Lead", vm: { status: "missing" } }, "ops", io, {
    name: "Ops",
  });
  assert.equal(p.root, "/config/agent-data/projects/ops");
  assert.ok(files.has(p.projectMd));
});

console.log("ok projects");
