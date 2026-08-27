/**
 * The Take control HTTP wiring. This lived in test/control.mjs, which moved to
 * packages/control — a package test cannot reach into server/, and this asserts
 * how server/index.mjs uses @sub8/control, not what the module does.
 *
 * Releasing Take control has to durable-wake the parent, or a Bot that asked for
 * a login sits there after the human finishes and nothing resumes it.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(root, "../server/index.mjs"), "utf8");
assert.match(src, /\/api\/bots\/:id\/control[\s\S]*enqueueWake\(boxHelpReleasedWake/);
assert.match(src, /live\.awaitingUserSelection = false/);


// The client side of the same flag. The "control" SSE event carries TWO
// payloads: the Take control toggle sends `on`, and request_box_help sends
// {requestBoxHelp, reason} with NO `on`. The handler did
// `state.humanControl = Boolean(on)`, so a bot asking for help set the flag
// FALSE and repainted the chrome as "Take control" — the opposite of the truth,
// and it wiped the flag if the human was already driving.
const client = readFileSync(path.join(root, "../web/app.js"), "utf8");
assert.match(
  client,
  /addEventListener\("control"[\s\S]{0,1400}?typeof on !== "boolean"/,
  'the "control" handler must ignore a frame that carries no `on`',
);
assert.doesNotMatch(
  client,
  /addEventListener\("control"[\s\S]{0,400}?humanControl = Boolean\(on\)/,
  "Boolean(on) turns a request_box_help frame into humanControl=false",
);


// Three lifetime bugs around the same turn loop. Driving them end-to-end needs
// a real harness turn that THROWS mid-flight, so these pin the wiring instead —
// the same technique, and for the same reason, as the assertions above.

// notifiedThisTurn is added unconditionally when a worker messages its chief
// mid-turn. The delete used to sit in the `try`, after the awaited runTurn, so a
// turn that threw (harness error, or the user pressing Stop) jumped to the catch
// and left the key behind — and the NEXT dispatch to that worker then saw it,
// suppressed the forced step-ping, and the chief waited forever.
const runTurnSrc = src.slice(src.indexOf("async function runUserTurn"));
const finallyAt = runTurnSrc.indexOf("finally {");
const deleteAt = runTurnSrc.indexOf("notifiedThisTurn.delete");
assert.ok(finallyAt > 0, "runUserTurn must still have a finally");
assert.ok(deleteAt > 0, "the notifiedThisTurn key must still be cleared somewhere");
assert.ok(
  deleteAt > finallyAt,
  "notifiedThisTurn must be cleared in the finally, not after the awaited runTurn",
);

// takeWakeOfType splices the wake out of wakes.json and persists BEFORE the turn
// exists, so a turn the epoch guard discards took the message with it and
// nothing retried. fireDurableWake now puts it back.
assert.match(
  src,
  /function fireDurableWake[\s\S]{0,1800}?requeueWake\(/,
  "fireDurableWake must re-queue SILENTLY (requeueWake), or the subscriber re-fires it at the new epoch",
);
assert.match(src, /onSkipped/, "enqueueTurn must expose the skipped path");

// held is an in-memory Set; a restart while the human was driving reported
// "nobody is driving", and wakes are durable enough to survive the restart the
// flag did not.
assert.match(src, /restoreHumanControl/, "boot must re-arm Take control from the persisted flag");
assert.match(src, /humanControl = Boolean\(on\)/, "Take control must be persisted to the bot row");

console.log("ok control-route");
