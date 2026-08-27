import assert from "node:assert/strict";
import { TOOLS } from "../server/tools-catalog.mjs";
import { assertUserTurnDelivery } from "../server/delivery.mjs";

function test(name, fn) {
  try {
    fn();
    console.log(`ok  ${name}`);
  } catch (err) {
    console.error(`not ok ${name}`);
    throw err;
  }
}

const send = TOOLS.find((t) => t.function?.name === "send_message");
const desc = send?.function?.description || "";

test("send_message description is the user-visible delivery contract", () => {
  assert.match(desc, /User-visible/);
  assert.match(desc, /ack first/i);
  assert.match(desc, /Ack ≠ delivery/);
  assert.match(desc, /last send_message is the result/);
});

test("happy path ack then result", () => {
  const got = assertUserTurnDelivery([
    { name: "send_message", args: { content: "On it" } },
    { name: "shell", args: { command: "ls /config/workspace" } },
    { name: "send_message", args: { content: "3 files" } },
  ]);
  assert.equal(got.ok, true);
  assert.equal(got.reason, "");
});

test("SendMessage alias counts as ack then result", () => {
  const got = assertUserTurnDelivery([
    { name: "SendMessage", args: { content: "Looking" } },
    { name: "web_search", args: { query: "flights" } },
    { name: "send_message", args: { content: "SFO-DCA 7am" } },
  ]);
  assert.equal(got.ok, true);
});

test("fail if only tools and no send_message", () => {
  const got = assertUserTurnDelivery([
    { name: "shell", args: { command: "ls" } },
    { name: "computer", args: { action: "screenshot" } },
  ]);
  assert.equal(got.ok, false);
  assert.match(got.reason, /no send_message/);
});

test("fail if ack is the only send_message when resultExpected true", () => {
  const got = assertUserTurnDelivery(
    [
      { name: "send_message", args: { content: "On it" } },
      { name: "shell", args: { command: "ls" } },
    ],
    { resultExpected: true },
  );
  assert.equal(got.ok, false);
  assert.match(got.reason, /ack is the only send_message; result expected/);
});

test("ack-only is ok when result is not expected", () => {
  const got = assertUserTurnDelivery([{ name: "send_message", args: { content: "Yep" } }]);
  assert.equal(got.ok, true);
});
