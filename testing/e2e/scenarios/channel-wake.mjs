import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(here), "../../..");

function uid(n) {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

/** Isolated process so `@sub8/store` `dataDir` binds to SUB8BOT_DATA. */
async function exercise() {
  const { createChannel, groupJson, syncGroupJsonToDesk, removeMember } = await import("@sub8/store/channels");
  const { sendToAgent } = await import(path.join(root, "server/teammate.mjs"));
  const { takeWake, listWakes, resetForTest } = await import("@sub8/wakes");

  resetForTest();
  const a = uid(1);
  const b = uid(2);
  const c = uid(3);
  const six = [uid(1), uid(2), uid(3), uid(4), uid(5), uid(6)];

  await assert.rejects(() => createChannel({ name: "Empty", memberIds: [] }), /empty/i);
  await assert.rejects(() => createChannel({ name: "TooMany", memberIds: [...six, uid(7)] }), /max 6/i);

  const ch = await createChannel({ name: "Ops", memberIds: [a, b, c] });
  const g = groupJson(ch);
  assert.equal(g.version, 1);
  assert.deepEqual(g.memberIds, [a, b, c]);

  const files = new Map();
  await syncGroupJsonToDesk(ch, async (dest, text) => {
    files.set(dest, text);
  });
  const groupPath = `/config/agent-data/agents/${ch.id}/group.json`;
  assert.ok(files.has(groupPath));
  assert.equal(JSON.parse(files.get(groupPath)).version, 1);

  const ack = await sendToAgent(a, ch.id, "hello room");
  assert.equal(ack.type, "channel");
  assert.equal(ack.queued, 2);
  assert.equal(listWakes(a).length, 0);
  assert.equal(takeWake(b).type, "channel");
  assert.equal(takeWake(c).payload.channelId, ch.id);
  assert.equal(takeWake(b), null);

  await removeMember(ch.id, b);
  await removeMember(ch.id, c);
  await assert.rejects(() => removeMember(ch.id, a), /cannot remove last member|empty/i);
}

if (process.env.CHANNEL_WAKE_CHILD === "1") {
  await exercise();
}

export async function run() {
  if (process.env.CHANNEL_WAKE_CHILD === "1") return;
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sub8-e2e-chwake-"));
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [here], {
        cwd: root,
        env: { ...process.env, CHANNEL_WAKE_CHILD: "1", SUB8BOT_DATA: tmp, OCTOBOT_DATA: tmp },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      child.stdout.on("data", (buf) => {
        out += buf;
      });
      child.stderr.on("data", (buf) => {
        out += buf;
      });
      child.on("error", reject);
      child.on("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`channel-wake child exited ${code}\n${out}`));
      });
    });
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}
