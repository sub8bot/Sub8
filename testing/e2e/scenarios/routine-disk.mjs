import assert from "node:assert/strict";
import { upsertRoutine, automationJson, automationPath } from "@sub8/automations";

/** upsert writes spec-shaped AutomationJson; host bot.routines[] stays the scheduler. */
export async function run() {
  const bot = { id: "bot-e2e-routine", name: "Lead", routines: [], vm: { status: "missing" } };
  const { routine } = upsertRoutine(bot, {
    name: "Inbox",
    instruction: "Watch the inbox every 15 minutes and summarize new mail.",
    intervalMs: 15 * 60_000,
  });
  assert.ok(routine);
  assert.equal(bot.routines.length, 1);
  assert.equal(bot.routines[0].id, routine.id);

  const json = automationJson(routine);
  assert.deepEqual(Object.keys(json), ["name", "prompt", "schedule", "enabled", "createdAt", "lastRunAt"]);
  assert.equal(json.name, "Inbox");
  assert.equal(json.prompt, routine.instruction);
  assert.equal(json.schedule, "@every 15m");
  assert.equal(json.enabled, true);
  assert.equal(json.lastRunAt, null);
  assert.equal(typeof json.createdAt, "number");
  assert.equal(
    automationPath(bot.id, routine),
    `/config/agent-data/agents/${bot.id}/automations/inbox/automation.json`,
  );
}
