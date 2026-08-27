import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function fakeBot() {
  return {
    id: "e2e-code-agent",
    name: "E2E",
    vm: {
      computerId: "fake-cmp",
      container: "localbot-fakee2e",
      volume: "localbot-config-fakee2e",
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

/** In-process launchCodeAgent on a fake desk. Must not add a computers.json row. */
export async function run() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sub8-e2e-code-"));
  const prevData = process.env.SUB8BOT_DATA;
  const prevOcto = process.env.OCTOBOT_DATA;
  process.env.SUB8BOT_DATA = tmp;
  process.env.OCTOBOT_DATA = tmp;
  try {
    const stamp = Date.now();
    const { launchCodeAgent, configureCodeAgents, resetForTest, codeAgentsPath } = await import(
      `${pathToFileURL(path.join(root, "server/code-agent.mjs")).href}?e2e=${stamp}`
    );
    const computers = await import(`${pathToFileURL(path.join(root, "server/computers.mjs")).href}?e2e=${stamp}`);
    configureCodeAgents({ dataDir: tmp });
    await resetForTest();

    const before = await computers.listComputers();
    assert.equal(before.length, 0);

    const launched = await launchCodeAgent(
      fakeBot(),
      { prompt: "open a PR that adds a test", cwd: "/config/workspace/app" },
      { vm: fakeVm() },
    );
    assert.equal(launched.status, "running");
    assert.ok(launched.id);

    const after = await computers.listComputers();
    assert.equal(after.length, 0);

    const computersFile = path.join(tmp, "computers.json");
    if (existsSync(computersFile)) {
      const rows = JSON.parse(await fs.readFile(computersFile, "utf8"));
      assert.equal(Array.isArray(rows) ? rows.length : 0, 0);
    }

    const sessions = JSON.parse(await fs.readFile(codeAgentsPath(), "utf8"));
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].id, launched.id);
    assert.equal(sessions[0].cwd, "/config/workspace/app");
    assert.equal(sessions[0].computerId, "fake-cmp");
  } finally {
    if (prevData == null) delete process.env.SUB8BOT_DATA;
    else process.env.SUB8BOT_DATA = prevData;
    if (prevOcto == null) delete process.env.OCTOBOT_DATA;
    else process.env.OCTOBOT_DATA = prevOcto;
    await fs.rm(tmp, { recursive: true, force: true });
  }
}
