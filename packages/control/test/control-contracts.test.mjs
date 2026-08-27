/**
 * Every exported contract of @sub8/control, with the weight on the refusals.
 * Two of them matter more than the rest:
 *
 *  - request_box_help is a tool the model calls with its own arguments. The row
 *    it produces is the record that the ask never claimed the host filesystem,
 *    so no argument may widen it.
 *  - Take control is what stops the agent clicking while a human is typing a
 *    password, so who holds it, and whether a release really releases, is a
 *    safety property and not bookkeeping.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  boxHelpReleasedWake,
  clearBoxHelp,
  isHumanControl,
  pendingBoxHelp,
  releaseHumanControl,
  requestBoxHelp,
  requestExternal,
  resetControlForTest,
  setHumanControl,
} from "../dist/index.js";

test("no argument to request_box_help can widen the ask", () => {
  resetControlForTest();
  // The model writes these arguments. Only `reason` is read; hostFs, external
  // and action are fixed by the module, not negotiable by the caller.
  const row = requestBoxHelp("bot-1", {
    reason: "GitHub 2FA",
    hostFs: true,
    external: true,
    action: "grant_root",
    scope: "/Users/someone",
    allow: ["/Users/someone/.ssh"],
  });
  assert.equal(row.hostFs, false);
  assert.equal(row.external, false);
  assert.equal(row.action, "take_control");
  assert.deepEqual(Object.keys(row), ["botId", "action", "reason", "at", "hostFs", "external"]);
  assert.equal("scope" in row, false, "unknown keys are dropped, not carried into the row");
  assert.equal("allow" in row, false);
  // The stored copy is the same shape, so what the human is shown cannot differ
  // from what was asked for.
  assert.deepEqual(pendingBoxHelp("bot-1"), row);
  resetControlForTest();
});

test("request_box_help does not grant the desk by itself", () => {
  resetControlForTest();
  requestBoxHelp("bot-1", { reason: "captcha" });
  // Asking is not taking: `held` only flips when the human presses the button.
  assert.equal(isHumanControl("bot-1"), false);
  resetControlForTest();
});

test("requestExternal refuses whatever it is handed", () => {
  // There is no argument, path or flag that opens the host filesystem.
  for (const args of [[], ["/Users/someone"], [{ path: "/Users/someone", allow: true }], [null], [""]]) {
    assert.throws(
      () => requestExternal(...args),
      (err) => err.code === "EXTERNAL_OUT" && /out of scope/.test(err.message),
      `requestExternal(${JSON.stringify(args)}) must throw`,
    );
  }
});

test("every entry point that needs a botId refuses a blank one with NEED_BOT", () => {
  resetControlForTest();
  const blanks = ["", "   ", "\n\t", null, undefined, 0, false];
  const isNeedBot = (err) => err.code === "NEED_BOT" && /botId required/.test(err.message);
  for (const id of blanks) {
    assert.throws(() => requestBoxHelp(id, { reason: "x" }), isNeedBot, `requestBoxHelp(${String(id)})`);
    assert.throws(() => releaseHumanControl(id), isNeedBot, `releaseHumanControl(${String(id)})`);
    assert.throws(() => boxHelpReleasedWake({ botId: id }), isNeedBot, `boxHelpReleasedWake(${String(id)})`);
  }
  // The wake builder is also called with the whole release row, which may be
  // missing entirely if a caller lost it.
  assert.throws(() => boxHelpReleasedWake(), isNeedBot);
  assert.throws(() => boxHelpReleasedWake({}), isNeedBot);
  // A refused ask leaves nothing behind.
  assert.equal(pendingBoxHelp(""), null);
});

test("a blank botId never holds the desk", () => {
  resetControlForTest();
  for (const id of ["", null, undefined, 0]) {
    assert.equal(setHumanControl(id, true), false, `${String(id)} must not take control`);
    assert.equal(isHumanControl(id), false);
  }
  // …and no bot inherits it either.
  assert.equal(isHumanControl("bot-1"), false);
});

test("any truthy `on` holds the desk, so callers coerce before they call", () => {
  resetControlForTest();
  // server/index.mjs and server/cloud/turn.mjs both pass Boolean(...) for this
  // reason: a raw "false" off a query string or JSON body reads as true here
  // and would take the desk away from a running agent.
  assert.equal(setHumanControl("bot-1", "false"), true);
  assert.equal(isHumanControl("bot-1"), true);
  for (const off of [false, 0, "", null, undefined, Number.NaN]) {
    setHumanControl("bot-1", true);
    assert.equal(setHumanControl("bot-1", off), false, `${String(off)} must release`);
    assert.equal(isHumanControl("bot-1"), false);
  }
  resetControlForTest();
});

test("setHumanControl does not trim, and release does — a padded id is another desk", () => {
  resetControlForTest();
  // Pinned rather than endorsed: setHumanControl keys on the raw string while
  // requestBoxHelp / releaseHumanControl trim theirs, so a caller that passes a
  // padded id holds a desk that release cannot let go of. Every caller today
  // passes bot.id, which is a UUID.
  setHumanControl("  bot-1  ", true);
  assert.equal(isHumanControl("  bot-1  "), true);
  assert.equal(isHumanControl("bot-1"), false, "the padded id is a different key");
  assert.equal(releaseHumanControl("  bot-1  ").wasHeld, false, "release trims, so it misses it");
  assert.equal(isHumanControl("  bot-1  "), true, "and the padded hold survives the release");
  resetControlForTest();
});

test("a blank reason falls back to copy that tells the human what to do", () => {
  resetControlForTest();
  for (const reason of ["", "   ", null, undefined, 0]) {
    const row = requestBoxHelp("bot-1", { reason });
    assert.match(row.reason, /Take control \(login, 2FA, captcha, or payment\)/);
  }
  assert.match(requestBoxHelp("bot-1").reason, /Take control/, "no options bag at all is fine");
  assert.match(requestBoxHelp("bot-1", { reason: "  Bank OTP  " }).reason, /^Bank OTP$/, "a real reason is trimmed");
  assert.ok(requestBoxHelp("bot-1", { reason: "x" }).at > 0, "the ask is timestamped");
  resetControlForTest();
});

test("a second ask replaces the first, and the release reports the newest reason", () => {
  resetControlForTest();
  requestBoxHelp("bot-1", { reason: "GitHub 2FA" });
  requestBoxHelp("bot-1", { reason: "Bank OTP" });
  assert.equal(pendingBoxHelp("bot-1").reason, "Bank OTP", "asks do not queue");
  const released = releaseHumanControl("bot-1");
  assert.equal(released.pending.reason, "Bank OTP");
  assert.match(boxHelpReleasedWake(released).payload.reason, /Bank OTP/);
  resetControlForTest();
});

test("control is per bot: holding or releasing one never touches another", () => {
  resetControlForTest();
  setHumanControl("bot-1", true);
  setHumanControl("bot-2", true);
  requestBoxHelp("bot-1", { reason: "one" });
  requestBoxHelp("bot-2", { reason: "two" });

  releaseHumanControl("bot-1");
  assert.equal(isHumanControl("bot-1"), false);
  assert.equal(isHumanControl("bot-2"), true, "bot-2 still has a human at the keyboard");
  assert.equal(pendingBoxHelp("bot-1"), null);
  assert.equal(pendingBoxHelp("bot-2").reason, "two");

  clearBoxHelp("bot-2");
  assert.equal(pendingBoxHelp("bot-2"), null);
  assert.equal(isHumanControl("bot-2"), true, "clearing the ask does not hand the desk back");
  resetControlForTest();
});

test("releasing a desk nobody held is a no-op, and a second release carries no stale reason", () => {
  resetControlForTest();
  const cold = releaseHumanControl("bot-cold");
  assert.deepEqual(cold, { botId: "bot-cold", wasHeld: false, pending: null });
  assert.equal(boxHelpReleasedWake(cold).payload.reason, "", "nothing to quote back at the parent");

  setHumanControl("bot-1", true);
  requestBoxHelp("bot-1", { reason: "GitHub 2FA" });
  assert.equal(releaseHumanControl("bot-1").wasHeld, true);
  const again = releaseHumanControl("bot-1");
  assert.equal(again.wasHeld, false);
  assert.equal(again.pending, null, "a double release must not re-wake the parent with the old ask");
  assert.equal(boxHelpReleasedWake(again).payload.reason, "");
  resetControlForTest();
});

test("the release row hands back the stored ask itself, so callers read it and stop", () => {
  resetControlForTest();
  const asked = requestBoxHelp("bot-1", { reason: "GitHub 2FA" });
  const peeked = pendingBoxHelp("bot-1");
  assert.equal(peeked, asked, "pendingBoxHelp returns the stored row, not a copy");
  const released = releaseHumanControl("bot-1");
  assert.equal(released.pending, asked, "and so does the release — treat it as read-only");
  assert.equal(released.botId, "bot-1");
  resetControlForTest();
});

test("ids are trimmed and coerced the same way at every door", () => {
  resetControlForTest();
  const row = requestBoxHelp("  bot-1  ", { reason: "x" });
  assert.equal(row.botId, "bot-1");
  assert.equal(pendingBoxHelp("bot-1").reason, "x");
  assert.equal(pendingBoxHelp("  bot-1  ").reason, "x");
  assert.equal(boxHelpReleasedWake({ botId: "  bot-1  " }).botId, "bot-1");

  // A number off a JSON body becomes the same key at every door rather than a
  // second, invisible bot.
  requestBoxHelp(42, { reason: "numeric" });
  assert.equal(pendingBoxHelp("42").reason, "numeric");
  assert.equal(pendingBoxHelp(42).reason, "numeric");
  assert.equal(releaseHumanControl(42).pending.reason, "numeric");

  clearBoxHelp("");
  clearBoxHelp(null);
  assert.equal(pendingBoxHelp("bot-1").reason, "x", "a blank clear must not wipe someone else's ask");
  resetControlForTest();
});

test("the wake the parent gets names the bot and quotes only the reason", () => {
  resetControlForTest();
  setHumanControl("bot-1", true);
  requestBoxHelp("bot-1", { reason: "GitHub 2FA" });
  const wake = boxHelpReleasedWake(releaseHumanControl("bot-1"));
  assert.deepEqual(wake, {
    type: "box-help-released",
    botId: "bot-1",
    payload: { reason: "GitHub 2FA" },
  });
  resetControlForTest();
});

test("resetControlForTest empties both the holds and the asks", () => {
  setHumanControl("bot-1", true);
  requestBoxHelp("bot-2", { reason: "x" });
  resetControlForTest();
  assert.equal(isHumanControl("bot-1"), false);
  assert.equal(pendingBoxHelp("bot-2"), null);
});
