/**
 * The secret-request card must not promise something the current place does not
 * do.
 *
 * Locally, answering one POSTs to /api/bots/:id/choice, which routes a
 * secretPick to the vault or mcpRemote.setServerAuth (server/index.mts) and
 * never writes it to the thread — so "It is not in this chat" is true.
 *
 * In the Cloud place, submitChoice sets `q.value = \`Picked: ${label}\`` and
 * calls onSend, and for a secret-request card `label` IS the typed secret — so
 * the credential goes into the chat. Showing the local promise there is worse
 * than showing nothing: a false assurance is what convinces someone to paste a
 * production credential.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const src = await fs.readFile(new URL("../web/app.ts", import.meta.url), "utf8");
const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log("ok  " + name);
  } catch (err) {
    results.push({ name, ok: false });
    console.error("FAIL " + name);
    console.error(err);
  }
}

test("the 'not in this chat' promise is gated on the local place", () => {
  const promise = "Credential saved. It is not in this chat.";
  assert.ok(src.includes(promise), "the local copy still exists");
  // It must sit on the false branch of an isCloudPlace() test, not stand alone.
  const idx = src.indexOf(promise);
  const before = src.slice(Math.max(0, idx - 700), idx);
  assert.match(
    before,
    /isCloudPlace\(\)/,
    "the promise must be gated on the place — in Cloud the secret IS in the chat",
  );
});

test("the Cloud branch says the answer is part of the chat", () => {
  assert.match(
    src,
    /on Cloud this answer is part of the chat/,
    "the Cloud copy must say what actually happens",
  );
});

test("the input is still masked in both places", () => {
  assert.match(
    src,
    /m\.kind === "secret-request" \? 'type="password"/,
    "masking guards against shoulder-surfing regardless of destination",
  );
});

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `${failed.length} failed` : "ok secret-card-copy");
process.exit(failed.length ? 1 : 0);
