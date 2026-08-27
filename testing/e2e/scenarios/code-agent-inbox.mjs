import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function fakeBot() {
  return {
    id: "e2e-inbox-code",
    name: "E2E",
    vm: {
      computerId: "fake-cmp-inbox",
      container: "localbot-fakeinbox",
      volume: "localbot-config-fakeinbox",
      status: "running",
    },
  };
}

function fakeVm() {
  return {
    mkdirp: async () => {},
    exec: async () => ({ ok: true, output: "" }),
    write: async () => {},
  };
}

/** Cancel/complete stay on the existing desk: no computers.json row, cwd under /config, wake fires. */
export async function run() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sub8-e2e-inbox-"));
  const prevData = process.env.SUB8BOT_DATA;
  const prevOcto = process.env.OCTOBOT_DATA;
  process.env.SUB8BOT_DATA = tmp;
  process.env.OCTOBOT_DATA = tmp;
  try {
    const stamp = Date.now();
    const {
      launchCodeAgent,
      getCodeAgent,
      cancelCodeAgent,
      completeForTest,
      configureCodeAgents,
      resetForTest,
      takeWakes,
    } = await import(`${pathToFileURL(path.join(root, "server/code-agent.mjs")).href}?e2e=${stamp}`);
    const computers = await import(`${pathToFileURL(path.join(root, "server/computers.mjs")).href}?e2e=${stamp}`);
    configureCodeAgents({ dataDir: tmp });
    await resetForTest();

    const bot = fakeBot();
    const vmSnap = JSON.stringify(bot.vm);
    const launched = await launchCodeAgent(bot, { prompt: "add a test", cwd: "/config/workspace/app" }, { vm: fakeVm() });
    const got = await getCodeAgent(bot, launched.id);
    assert.equal(got.cwd, "/config/workspace/app");
    assert.equal((await computers.listComputers()).length, 0);

    const cancelled = await cancelCodeAgent(bot, launched.id);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(JSON.stringify(bot.vm), vmSnap);
    assert.equal(bot.vm.status, "running");

    const other = await launchCodeAgent(bot, { prompt: "open the PR", cwd: "/config/workspace/app" }, { vm: fakeVm() });
    const wake = await completeForTest(other.id, { prUrl: "https://github.com/example/app/pull/1" });
    assert.equal(wake.type, "code-agent-complete");
    assert.equal(takeWakes()[0].type, "code-agent-complete");
    assert.equal((await computers.listComputers()).length, 0);
    const computersFile = path.join(tmp, "computers.json");
    if (existsSync(computersFile)) {
      const rows = JSON.parse(await fs.readFile(computersFile, "utf8"));
      assert.equal(Array.isArray(rows) ? rows.length : 0, 0);
    }
  } finally {
    if (prevData == null) delete process.env.SUB8BOT_DATA;
    else process.env.SUB8BOT_DATA = prevData;
    if (prevOcto == null) delete process.env.OCTOBOT_DATA;
    else process.env.OCTOBOT_DATA = prevOcto;
    await fs.rm(tmp, { recursive: true, force: true });
  }
}
