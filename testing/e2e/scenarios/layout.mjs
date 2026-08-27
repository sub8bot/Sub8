import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_DATA_ROOT, agentDir } from "../../../packages/orchestration/dist/paths.js";
import { ensureLayout, layoutPaths } from "../../../server/memory.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const fixtures = path.join(root, "packages/orchestration/fixtures");
const SOLO = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

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

/** Fixture-only layout contract. Live Docker is SKIP in docker-desk.mjs. */
export async function run() {
  assert.equal(AGENT_DATA_ROOT, "/config/agent-data");
  assert.equal(agentDir(SOLO), `${AGENT_DATA_ROOT}/agents/${SOLO}`);
  assert.doesNotMatch(agentDir(SOLO), /\/home\/box/);

  const profileJson = path.join(fixtures, "agents", SOLO, "profile.json");
  const memoryProfile = path.join(fixtures, "agents", SOLO, "memory", "profile.md");
  const automation = path.join(fixtures, "agents", SOLO, "automations", "demo", "automation.json");
  const userMem = path.join(fixtures, "user-memory", "by-agent", SOLO, "profile.md");
  assert.ok(existsSync(profileJson));
  assert.ok(existsSync(memoryProfile));
  assert.ok(existsSync(automation));
  assert.ok(existsSync(userMem));
  const auto = JSON.parse(readFileSync(automation, "utf8"));
  assert.equal(typeof auto.name, "string");
  assert.equal(typeof auto.prompt, "string");
  assert.equal(typeof auto.enabled, "boolean");

  const workflows = path.join(fixtures, "workflows");
  assert.ok(readdirSync(workflows).some((id) => existsSync(path.join(workflows, id, "SKILL.md"))));

  const { dirs, files, io } = mockVm();
  const bot = {
    id: SOLO,
    name: "Lead",
    title: "Chief",
    description: "Coordinates teammates on the shared computer.",
    vm: { container: "desk-test", status: "running" },
    routines: [{ id: "demo", name: "Demo", instruction: "Check the desk." }],
  };
  const seeded = await ensureLayout(bot, io);
  const p = layoutPaths(bot);
  assert.equal(seeded, p.root);
  for (const dir of p.dirs) assert.ok(dirs.includes(dir), dir);
  assert.ok(dirs.includes(p.projects));
  assert.ok(files.has(p.profileJson));
  assert.ok(files.has(p.memoryProfile));
  assert.ok(files.has(p.userMemoryProfile));
  assert.ok(files.has(`${p.automations}/demo/automation.json`));
  const profile = JSON.parse(files.get(p.profileJson));
  assert.equal(profile.id, SOLO);
  assert.equal(profile.name, "Lead");
}
