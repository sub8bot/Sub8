import assert from "node:assert/strict";
import { spawn, get, stop, completeForTest, resetForTest, takeWakes, toolsForType } from "../../../server/subagents.mjs";

/** Task executor: no send_message, CheckSubagent via get, completion wake, stop is not a VM destroy. */
export async function run() {
  resetForTest();
  const tools = toolsForType("executor");
  assert.ok(!tools.includes("send_message"));
  assert.ok(!tools.includes("SendMessage"));

  const job = await spawn({ botId: "parent-e2e", type: "executor", prompt: "Count files in /config/workspace" });
  assert.equal(job.status, "running");
  assert.ok(!job.tools.includes("send_message"));
  assert.equal((await get(job.id)).id, job.id);

  const wake = completeForTest(job.id, { files: 2 });
  assert.equal(wake.type, "subagent-complete");
  assert.equal(wake.parentBotId, "parent-e2e");
  assert.equal((await get(job.id)).status, "done");
  assert.equal(takeWakes()[0].type, "subagent-complete");

  const other = await spawn({ botId: "parent-e2e", type: "executor", prompt: "Second job on the same desk" });
  const cancelled = await stop(other.id);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(typeof cancelled.computerId, "undefined");
}
