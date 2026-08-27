import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sub8-code-agent-"));
process.env.SUB8BOT_DATA = tmp;
process.env.OCTOBOT_DATA = tmp;

const computers = await import(path.join(root, "server/computers.mjs"));
const codeAgent = await import(path.join(root, "server/code-agent.mjs"));
codeAgent.configureCodeAgents({ dataDir: tmp });

const {
  launchCodeAgent,
  listCodeAgents,
  getCodeAgent,
  replyCodeAgent,
  cancelCodeAgent,
  deleteCodeAgent,
  completeForTest,
  resetForTest,
  codeAgentsPath,
  botHasDesk,
  takeWakes,
  assertCodeAgentCwd,
} = codeAgent;

const deskBot = () => ({
  id: "bot-desk-1",
  name: "Lead",
  vm: {
    computerId: "cmp-1",
    container: "localbot-botdesk",
    volume: "localbot-config-botdesk",
    status: "running",
  },
});

async function seedComputer() {
  await fs.mkdir(tmp, { recursive: true });
  await fs.writeFile(
    path.join(tmp, "computers.json"),
    JSON.stringify(
      [
        {
          id: "cmp-1",
          name: "Lead's desk",
          container: "localbot-botdesk",
          volume: "localbot-config-botdesk",
          status: "running",
        },
      ],
      null,
      2,
    ),
  );
}

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

await seedComputer();
await resetForTest();

await test("cwd /Users/... throws and /config/workspace/foo is accepted", () => {
  assert.equal(assertCodeAgentCwd("/config/workspace/foo"), "/config/workspace/foo");
  assert.throws(() => assertCodeAgentCwd("/Users/someone/secret"), /under \/config/);
  assert.throws(() => assertCodeAgentCwd("/config/../Users/someone/secret"), /under \/config/);
});

await test("launch fails if bot has no desk, without a billing error", async () => {
  await resetForTest();
  await assert.rejects(
    () => launchCodeAgent({ id: "no-desk" }, { prompt: "fix it", cwd: "/config/workspace/foo" }),
    (err) => {
      assert.match(String(err.message), /no (desk|computer)/i);
      assert.doesNotMatch(String(err.message), /billing|Stripe|NEED_BILLING|402|entitled/i);
      return true;
    },
  );
  assert.equal(botHasDesk({ id: "x" }), false);
  assert.equal(botHasDesk({ id: "x", vm: {} }), false);
  assert.equal(botHasDesk(deskBot()), true);
});

await test("launch returns running immediately and does not add a computer", async () => {
  await resetForTest();
  await seedComputer();
  const before = await computers.listComputers();
  assert.equal(before.length, 1);
  const bot = deskBot();
  const launched = await launchCodeAgent(bot, {
    repoUrl: "https://github.com/example/app.git",
    prompt: "open a PR that adds a test",
    branch: "code-agent/a5",
    cwd: "/config/workspace/foo",
  });
  assert.equal(launched.status, "running");
  assert.ok(launched.id);
  const after = await computers.listComputers();
  assert.equal(after.length, before.length);
  assert.equal(after[0].id, "cmp-1");
  const disk = JSON.parse(await fs.readFile(path.join(tmp, "computers.json"), "utf8"));
  assert.equal(disk.length, 1);
  const sessions = JSON.parse(await fs.readFile(codeAgentsPath(), "utf8"));
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].cwd, "/config/workspace/foo");
  assert.equal(sessions[0].computerId, "cmp-1");
  assert.equal(sessions[0].status, "running");
});

await test("cwd /Users/... is rejected on launch; /config/workspace/foo is stored", async () => {
  await resetForTest();
  const bot = deskBot();
  await assert.rejects(
    () => launchCodeAgent(bot, { prompt: "nope", cwd: "/Users/someone/project" }),
    /under \/config/,
  );
  const ok = await launchCodeAgent(bot, { prompt: "yes", cwd: "/config/workspace/foo" });
  const got = await getCodeAgent(bot, ok.id);
  assert.equal(got.cwd, "/config/workspace/foo");
});

await test("cancel does not change bot.vm and does not pause the desk", async () => {
  await resetForTest();
  const bot = deskBot();
  const vmSnap = JSON.stringify(bot.vm);
  const launched = await launchCodeAgent(bot, { prompt: "wip", cwd: "/config/workspace/foo" });
  const cancelled = await cancelCodeAgent(bot, launched.id);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(JSON.stringify(bot.vm), vmSnap);
  assert.equal(bot.vm.status, "running");
  assert.equal(bot.vm.computerId, "cmp-1");
  const rows = await computers.listComputers();
  assert.equal(rows[0].status, "running");
});

await test("reply appends; completeForTest wakes; delete drops the record only", async () => {
  await resetForTest();
  await seedComputer();
  const bot = deskBot();
  const vmSnap = JSON.stringify(bot.vm);
  const launched = await launchCodeAgent(bot, { prompt: "ship it", cwd: "/config/workspace/app" });
  const replied = await replyCodeAgent(bot, launched.id, "also run the tests");
  assert.equal(replied.messages.at(-1).content, "also run the tests");
  const listed = await listCodeAgents(bot);
  assert.equal(listed.length, 1);
  const wake = await completeForTest(launched.id, { prUrl: "https://github.com/example/app/pull/1" });
  assert.equal(wake.type, "code-agent-complete");
  assert.equal(wake.botId, bot.id);
  assert.equal(wake.id, launched.id);
  assert.equal(wake.prUrl, "https://github.com/example/app/pull/1");
  assert.equal((await getCodeAgent(bot, launched.id)).status, "done");
  assert.equal(takeWakes()[0].type, "code-agent-complete");
  const { listWakes } = await import("@sub8/wakes");
  assert.equal(listWakes(bot.id).some((w) => w.type === "code-agent-complete" && w.payload.id === launched.id), true);
  const gone = await deleteCodeAgent(bot, launched.id);
  assert.equal(gone.deleted, true);
  assert.equal(await getCodeAgent(bot, launched.id), null);
  assert.equal((await listCodeAgents(bot)).length, 0);
  assert.equal(JSON.stringify(bot.vm), vmSnap);
  assert.equal((await computers.listComputers()).length, 1);
});

await test("optional vm.write/exec stay under /config", async () => {
  await resetForTest();
  const writes = [];
  const execs = [];
  const vm = {
    write: async (p, body) => {
      writes.push({ p, body });
    },
    exec: async (cmd) => {
      execs.push(cmd);
      return { ok: true, output: "" };
    },
  };
  const launched = await launchCodeAgent(
    deskBot(),
    { prompt: "clone on the box", cwd: "/config/workspace/foo" },
    { vm },
  );
  assert.equal(launched.status, "running");
  assert.ok(execs.length);
  assert.ok(writes.length);
  assert.ok(writes.every((w) => w.p.startsWith("/config/")));
  assert.ok(execs.every((cmd) => cmd.includes("/config/")));
});

await test("module does not call Stripe, attachComputer, or computers.json writers", () => {
  const src = readFileSync(path.join(root, "server/code-agent.mjs"), "utf8");
  assert.doesNotMatch(src, /\battachComputer\b|\bensureComputerForBot\b|\bsaveComputer\b|\bentitledQty\b|\bNEED_BILLING\b/);
  assert.doesNotMatch(src, /from ["'][^"']*computers\.mjs["']/);
  assert.doesNotMatch(src, /from ["'][^"']*stripe[^"']*["']/i);
  assert.doesNotMatch(src, /\bpauseContainer\b|\bstopVm\b|\bremoveComputer\b/);
});

console.log("ok code-agent");
