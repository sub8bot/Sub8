import test from "node:test";
import assert from "node:assert/strict";
import {
  setHumanControl,
  isHumanControl,
  requestBoxHelp,
  pendingBoxHelp,
  clearBoxHelp,
  requestExternal,
  resetControlForTest,
  releaseHumanControl,
  boxHelpReleasedWake,
} from "../dist/index.js";

resetControlForTest();

test("Take control is a per-Bot flag, and request_box_help never claims the host FS", () => {
  const botId = "bot-help-1";
  assert.equal(isHumanControl(botId), false);
  assert.equal(setHumanControl(botId, true), true);
  assert.equal(isHumanControl(botId), true);
  assert.equal(setHumanControl(botId, false), false);

  const row = requestBoxHelp(botId, { reason: "GitHub 2FA" });
  assert.equal(row.action, "take_control");
  assert.equal(row.hostFs, false);
  assert.equal(row.external, false);
  assert.match(row.reason, /2FA/);
  assert.equal(pendingBoxHelp(botId).reason, row.reason);
  clearBoxHelp(botId);
  assert.equal(pendingBoxHelp(botId), null);

  assert.throws(() => requestBoxHelp(""), /botId required/);
  assert.throws(() => requestExternal(), (err) => err.code === "EXTERNAL_OUT");
});

test("releasing Take control clears the ask and yields the parent's wake", () => {
  const id = "bot-help-2";
  setHumanControl(id, true);
  requestBoxHelp(id, { reason: "GitHub 2FA" });
  const released = releaseHumanControl(id);
  assert.equal(released.wasHeld, true);
  assert.match(released.pending.reason, /2FA/);
  assert.equal(isHumanControl(id), false);
  assert.equal(pendingBoxHelp(id), null);
  const wake = boxHelpReleasedWake(released);
  assert.equal(wake.type, "box-help-released");
  assert.equal(wake.botId, id);
  assert.match(wake.payload.reason, /2FA/);
  assert.throws(() => releaseHumanControl(""), /botId required/);
  assert.throws(() => boxHelpReleasedWake({}), /botId required/);
});
