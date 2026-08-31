import assert from "node:assert/strict";
import {
  resolveMemoryPath,
  slug,
  seedProfile,
  seedProjectMd,
  parseProjectMd,
  agentRoot,
  AGENT_DATA_ROOT,
  layoutPaths,
  projectDir,
  projectMdPath,
  projectMemoryShard,
  projectLayoutPaths,
  projectSlug,
  mergeMemoryPrecedence,
  MEMORY_PRECEDENCE,
  memoryBackend,
} from "../server/memory.mjs";

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
  assert.equal(AGENT_DATA_ROOT, "/config/agent-data");
  assert.equal(agentRoot(bot), `${AGENT_DATA_ROOT}/agents/${bot.id}`);
});

test("relative paths land in the agent folder", () => {
  assert.equal(resolveMemoryPath(bot, "memory/profile.md"), `${agentRoot(bot)}/memory/profile.md`);
});

test("workspace paths are allowed", () => {
  assert.equal(resolveMemoryPath(bot, "/config/workspace/pipeline.md"), "/config/workspace/pipeline.md");
});

test("host Mac paths are rejected", () => {
  assert.throws(() => resolveMemoryPath(bot, "/Users/someone/secret"), /must be under/);
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

test("ensureLayout still names an empty projects directory", () => {
  const p = layoutPaths(bot);
  assert.equal(p.projects, `${AGENT_DATA_ROOT}/projects`);
  assert.ok(p.dirs.includes(p.projects));
  assert.equal(p.dirs.includes(`${AGENT_DATA_ROOT}/projects/job-hunt`), false);
});

test("projectDir is under agent-data/projects/<slug>", () => {
  assert.equal(projectSlug("Job hunt through Thursday"), "job-hunt-through-thursday");
  assert.equal(projectDir("Job hunt through Thursday"), `${AGENT_DATA_ROOT}/projects/job-hunt-through-thursday`);
  assert.equal(projectDir("foo/bar"), `${AGENT_DATA_ROOT}/projects/foo-bar`);
  assert.equal(projectMdPath("ops"), `${AGENT_DATA_ROOT}/projects/ops/project.md`);
  assert.throws(() => projectDir(""), /invalid project slug/);
  assert.throws(() => projectDir("..."), /invalid project slug/);
});

test("project shards are memory/by-agent/<uuid>", () => {
  const shard = projectMemoryShard("Job hunt", bot.id);
  assert.equal(shard, `${AGENT_DATA_ROOT}/projects/job-hunt/memory/by-agent/${bot.id}`);
  const p = projectLayoutPaths("Job hunt", bot.id);
  assert.equal(p.root, projectDir("Job hunt"));
  assert.equal(p.projectMd, `${p.root}/project.md`);
  assert.equal(p.shardDir, shard);
  assert.equal(p.shardProfile, `${shard}/profile.md`);
  assert.equal(resolveMemoryPath(bot, `${shard}/profile.md`), `${shard}/profile.md`);
  assert.throws(() => projectMemoryShard("ops", ""), /bot id required/);
});

test("project.md has name and description frontmatter", () => {
  const md = seedProjectMd({ name: "Job hunt", description: "Shared notes for Thursday." });
  const parsed = parseProjectMd(md);
  assert.equal(parsed.name, "Job hunt");
  assert.equal(parsed.description, "Shared notes for Thursday.");
  assert.match(md, /^---\nname: Job hunt\ndescription: Shared notes for Thursday.\n---\n/);
  assert.match(md, /memory\/by-agent/);
});

test("mergeMemoryPrecedence is own agent → project → user-memory", () => {
  assert.deepEqual([...MEMORY_PRECEDENCE], ["agent", "project", "user"]);
  const merged = mergeMemoryPrecedence({
    agent: { city: "Austin", drink: "tea" },
    project: { city: "NYC", repo: "bot" },
    user: { city: "SF", name: "Dan" },
  });
  assert.deepEqual(merged.precedence, ["agent", "project", "user"]);
  assert.equal(merged.facts.city, "Austin");
  assert.equal(merged.facts.drink, "tea");
  assert.equal(merged.facts.repo, "bot");
  assert.equal(merged.facts.name, "Dan");

  const text = mergeMemoryPrecedence({
    agent: "Prefers Austin.",
    project: "Team in NYC.",
    user: "Dan lives in SF.",
  });
  assert.equal(text.text, "Prefers Austin.\n\nTeam in NYC.\n\nDan lives in SF.");
  assert.ok(text.text.indexOf("Austin") < text.text.indexOf("NYC"));
  assert.ok(text.text.indexOf("NYC") < text.text.indexOf("SF"));

  const aliased = mergeMemoryPrecedence({
    own: { city: "Austin" },
    project: { city: "NYC" },
    userMemory: { city: "SF" },
  });
  assert.equal(aliased.facts.city, "Austin");
});

test("memoryBackend treats a Cloud deskUrl as ready, not as 'computer is not running'", () => {
  assert.equal(
    memoryBackend({
      id: "cloud-cmp_x",
      vm: { deskUrl: "http://10.0.0.1:3001", deskToken: "tok", status: "running" },
    }),
    "remote",
  );
  assert.equal(memoryBackend({ id: "x", vm: { container: "localbot-x", status: "running" } }), "docker");
  assert.equal(memoryBackend({ id: "x", vm: { deskUrl: "http://10.0.0.1:3001" } }), "none");
  assert.equal(memoryBackend({ id: "x" }), "none");
});

console.log("ok memory");
