import assert from "node:assert/strict";
import { assertUserTurnDelivery } from "../../../server/delivery.mjs";

/** In-process delivery contract (ack first, last send_message is the result). */
export async function run() {
  const happy = assertUserTurnDelivery([
    { name: "send_message", args: { content: "On it" } },
    { name: "shell", args: { command: "ls /config/workspace" } },
    { name: "send_message", args: { content: "3 files" } },
  ]);
  assert.equal(happy.ok, true);
  assert.equal(happy.reason, "");

  const alias = assertUserTurnDelivery([
    { name: "SendMessage", args: { content: "Looking" } },
    { name: "web_search", args: { query: "flights" } },
    { name: "send_message", args: { content: "SFO-DCA 7am" } },
  ]);
  assert.equal(alias.ok, true);

  const missing = assertUserTurnDelivery([
    { name: "shell", args: { command: "ls" } },
    { name: "computer", args: { action: "screenshot" } },
  ]);
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /no send_message/);

  const ackOnly = assertUserTurnDelivery(
    [
      { name: "send_message", args: { content: "On it" } },
      { name: "shell", args: { command: "ls" } },
    ],
    { resultExpected: true },
  );
  assert.equal(ackOnly.ok, false);
  assert.match(ackOnly.reason, /ack is the only send_message; result expected/);
}
