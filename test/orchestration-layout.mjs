import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_DATA_ROOT, agentDir } from "../packages/orchestration/dist/paths.js";
import {
  AGENT_DATA_ROOT as memoryRoot,
  agentDir as memoryAgentDir,
  agentRoot,
  applyProfile,
  ensureLayout,
  hydrateFromProfile,
  layoutPaths,
  profileRecord,
  writeProfile,
} from "../server/memory.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = path.join(repo, "packages/orchestration/fixtures");
const SOLO = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

function test(name, fn) {
  try {
    fn();
    console.log(`ok  ${name}`);
  } catch (err) {
    console.error(`not ok ${name}`);
    throw err;
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`ok  ${name}`);
  } catch (err) {
    console.error(`not ok ${name}`);
    throw err;
  }
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

test("package AGENT_DATA_ROOT stays under /config", () => {
  assert.equal(AGENT_DATA_ROOT, "/config/agent-data");
  assert.equal(memoryRoot, AGENT_DATA_ROOT);
  assert.equal(agentDir(SOLO), `${AGENT_DATA_ROOT}/agents/${SOLO}`);
  assert.equal(memoryAgentDir(SOLO), agentDir(SOLO));
});

test("agentRoot matches agentDir", () => {
  const bot = { id: SOLO, name: "Lead" };
  assert.equal(agentRoot(bot), agentDir(SOLO));
  assert.equal(typeof ensureLayout, "function");
  assert.equal(typeof layoutPaths, "function");
});

test("layoutPaths names match orchestration fixtures", () => {
  const bot = { id: SOLO, name: "Lead" };
  const p = layoutPaths(bot);
  const rel = {
    profileJson: `agents/${SOLO}/profile.json`,
    memoryProfile: `agents/${SOLO}/memory/profile.md`,
    memoryLog: `agents/${SOLO}/memory/log`,
    automations: `agents/${SOLO}/automations`,
    userMemoryDir: `user-memory/by-agent/${SOLO}`,
    userMemoryProfile: `user-memory/by-agent/${SOLO}/profile.md`,
    workflows: "workflows",
    projects: "projects",
  };
  for (const [key, suffix] of Object.entries(rel)) {
    assert.equal(p[key], `${AGENT_DATA_ROOT}/${suffix}`, key);
  }
  assert.equal(p.workspace, "/config/workspace");
  assert.ok(p.dirs.includes(p.projects));
  assert.ok(p.dirs.includes(p.memoryLog));
  assert.doesNotMatch(JSON.stringify(p), /\/home\/box/);
  assert.doesNotMatch(JSON.stringify(p), /\/Users\//);

  assert.ok(existsSync(path.join(fixtures, rel.profileJson)));
  assert.ok(existsSync(path.join(fixtures, rel.memoryProfile)));
  assert.ok(existsSync(path.join(fixtures, rel.automations, "demo", "automation.json")));
  assert.ok(existsSync(path.join(fixtures, rel.userMemoryProfile)));
  assert.ok(readdirSync(path.join(fixtures, rel.workflows)).some((id) => existsSync(path.join(fixtures, "workflows", id, "SKILL.md"))));
});

await testAsync("ensureLayout seeds fixture paths on a mock desk", async () => {
  const { dirs, files, io } = mockVm();
  const bot = {
    id: SOLO,
    name: "Lead",
    title: "Chief",
    description: "Coordinates teammates on the shared computer.",
    vm: { container: "desk-test", status: "running" },
    routines: [{ id: "demo", name: "Demo", instruction: "Check the desk and report anything that needs attention." }],
  };
  const root = await ensureLayout(bot, io);
  const p = layoutPaths(bot);
  assert.equal(root, p.root);
  for (const dir of p.dirs) assert.ok(dirs.includes(dir), dir);
  assert.ok(files.has(p.profileJson));
  assert.ok(files.has(p.memoryProfile));
  assert.ok(files.has(p.userMemoryProfile));
  const autoDir = `${p.automations}/demo`;
  assert.ok(dirs.includes(autoDir));
  assert.ok(files.has(`${autoDir}/automation.json`));
  const profile = JSON.parse(files.get(p.profileJson));
  assert.equal(profile.id, SOLO);
  assert.equal(profile.name, "Lead");
  assert.equal(profileRecord(bot).id, SOLO);
});

await testAsync("profile.json is canonical; bots.json is only an index", async () => {
  const { files, io } = mockVm();
  const bot = {
    id: SOLO,
    name: "HostName",
    title: "Chief",
    description: "from host",
    instructions: "host brief",
    teamRole: "chief",
    vm: { container: "desk-test", status: "running" },
  };
  const p = layoutPaths(bot);
  files.set(
    p.profileJson,
    `${JSON.stringify({ id: SOLO, name: "DeskName", title: "Lead", description: "from desk", instructions: "desk brief", teamRole: "chief" }, null, 2)}\n`,
  );
  await hydrateFromProfile(bot, io);
  assert.equal(bot.name, "DeskName");
  assert.equal(bot.description, "from desk");
  assert.equal(bot.instructions, "desk brief");
  await ensureLayout(bot, io);
  const kept = JSON.parse(files.get(p.profileJson));
  assert.equal(kept.name, "DeskName", "ensureLayout must not clobber desk profile with host index");
  bot.name = "Renamed";
  bot.description = "updated";
  await writeProfile(bot, io);
  assert.equal(JSON.parse(files.get(p.profileJson)).name, "Renamed");
  const other = { id: SOLO, name: "x" };
  applyProfile(other, { id: "not-this-bot", name: "Nope" });
  assert.equal(other.name, "x");
});

await testAsync("ensureLayout skips when the computer is not running", async () => {
  const { dirs, files, io } = mockVm();
  assert.equal(await ensureLayout({ id: SOLO, vm: { status: "missing" } }, io), null);
  assert.equal(dirs.length, 0);
  assert.equal(files.size, 0);
});

console.log("ok orchestration-layout");
