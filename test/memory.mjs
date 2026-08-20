import assert from "node:assert/strict";
import { resolveMemoryPath, slug, seedProfile, agentRoot } from "../server/memory.mjs";

function test(name, fn) {
  try {
    fn();
    console.log(`ok  ${name}`);
  } catch (err) {
    console.error(`not ok ${name}`);
    throw err;
  }
}

const bot = { id: "e0880729-a7f3-46a2-bead-ceecaa3f76fc", name: "Lead" };

test("agent root is on the desk", () => {
  assert.equal(agentRoot(bot), `/config/agent-data/agents/${bot.id}`);
});

test("relative paths land in the agent folder", () => {
  assert.equal(resolveMemoryPath(bot, "memory/profile.md"), `${agentRoot(bot)}/memory/profile.md`);
});

test("workspace paths are allowed", () => {
  assert.equal(resolveMemoryPath(bot, "/config/workspace/pipeline.md"), "/config/workspace/pipeline.md");
});

test("host Mac paths are rejected", () => {
  assert.throws(() => resolveMemoryPath(bot, "/Users/dan/secret"), /must be under/);
  assert.throws(() => resolveMemoryPath(bot, "/etc/passwd"), /must be under/);
  assert.throws(() => resolveMemoryPath(bot, "../../../../etc/passwd"), /must be under|invalid path/);
});

test("slug is filesystem-safe", () => {
  assert.equal(slug("Job hunt through Thursday"), "job-hunt-through-thursday");
});

test("seed profile stays short", () => {
  const md = seedProfile({ name: "Dan's Army", title: "Ops", description: "Helps on the desk." });
  assert.match(md, /Dan's Army/);
  assert.doesNotMatch(md, /Standing instructions/);
});

console.log("ok memory");
