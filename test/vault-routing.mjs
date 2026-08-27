/**
 * The octo-vault bridge authorised the wrong bot on a shared desk.
 *
 * Teammates share ONE container — teams.addMember copies the chief's — and the
 * request file is a single fixed path, /tmp/sub8-vault-req.json, carrying no
 * bot id. startVaultBridge polls every 2s over all bots, and the FIRST one it
 * reached read the file and answered it. So an ungranted worker could run
 * `octo-vault fill <chief's-account-id> password` and have it filled under the
 * chief's grants: fieldForBot's grant check is correct, it was simply being
 * asked about the wrong bot.
 *
 * This is not hypothetical for this user — CycleProbe, Scout and Writer all sit
 * on localbot-6715e738.
 *
 * Each teammate does get its own X display, so DISPLAY is what tells co-tenants
 * apart. octo-vault.sh now stamps it (plus a timestamp) and the host only
 * answers requests for its own display.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { ownsVaultRequest, VAULT_REQUEST_STALE_MS, vaultListPath } from "../server/vault.mjs";

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log("PASS", name);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log("FAIL", name, "-", err.message);
  }
}

const NOW = 1_800_000_000_000;
const bot = (display) => ({ id: `bot-${display}`, vm: { container: "localbot-shared", status: "running", display } });
const req = (display, ts = NOW) => ({ cmd: "fill", accountId: "acc-1", field: "password", display, ts });

test("a worker's request is not answered by the chief", () => {
  assert.equal(
    ownsVaultRequest(req(":2"), bot(":1"), NOW),
    false,
    "the chief answered a request made from another display — that is the grant bypass",
  );
});

test("the bot on that display does answer it", () => {
  assert.equal(ownsVaultRequest(req(":2"), bot(":2"), NOW), true);
});

test("every co-tenant refuses a request that is not theirs", () => {
  const claims = [":1", ":2", ":3"].filter((d) => ownsVaultRequest(req(":2"), bot(d), NOW));
  assert.deepEqual(claims, [":2"], `exactly one bot must claim it, got ${JSON.stringify(claims)}`);
});

// An octo-vault that predates this stamps no display. Refusing those would stop
// an un-updated container working at all, so they keep the old behaviour.
test("a request with no display falls back to the old behaviour", () => {
  assert.equal(ownsVaultRequest({ cmd: "fill", accountId: "a" }, bot(":1"), NOW), true);
  assert.equal(ownsVaultRequest(req(""), bot(":1"), NOW), true);
});

test("a bot with no display of its own still answers", () => {
  assert.equal(ownsVaultRequest(req(":2"), { id: "x", vm: { container: "c" } }, NOW), true);
});

// A request naming a display no live bot owns must not wedge the file forever.
// The client only waits 5s, so past the stale window nobody is listening.
test("a stale request is taken by whoever finds it", () => {
  const old = req(":9", NOW - VAULT_REQUEST_STALE_MS - 1);
  assert.equal(ownsVaultRequest(old, bot(":1"), NOW), true, "an abandoned request would block the file");
});

test("a fresh request for another display is NOT taken early", () => {
  const recent = req(":9", NOW - 1000);
  assert.equal(ownsVaultRequest(recent, bot(":1"), NOW), false);
});

test("a request with no timestamp is treated as stale, not as ours to hold", () => {
  // ts missing → Number(undefined||0) is 0 → far past the window. Better to
  // answer it than to leave the file wedged.
  assert.equal(ownsVaultRequest({ cmd: "fill", display: ":9" }, bot(":1"), NOW), true);
});


// The other half of the same problem: `octo-vault list` never went through the
// bridge at all — it cat'd /config/.sub8-vault-list.json, ONE file per
// container. PUT /api/vault/accounts/:id/grants loops over all bots and pushes
// each one's list to that path, so last write won and every teammate read
// whoever was written last. No passwords (publicAccount drops them), but it is
// the grant map — ids, labels, sites, usernames — which is exactly what you
// need to ask for a fill under someone else's grants.
test("each display gets its own granted-account list", () => {
  assert.equal(vaultListPath(":1"), "/config/.sub8-vault-list.1.json");
  assert.equal(vaultListPath(":2"), "/config/.sub8-vault-list.2.json");
  assert.notEqual(vaultListPath(":1"), vaultListPath(":2"), "co-tenants must not share the file");
});

test("a bot with no display keeps the old path, so nothing stops working", () => {
  assert.equal(vaultListPath(""), "/config/.sub8-vault-list.json");
  assert.equal(vaultListPath(null), "/config/.sub8-vault-list.json");
});

// The host writes the file and the shell reads it, from two different
// languages. If they disagree on the name, `list` silently returns nothing.
test("octo-vault.sh derives the same filename the host writes", () => {
  const sh = readFileSync(new URL("../vm/octo-vault.sh", import.meta.url), "utf8");
  assert.match(sh, /tr -cd '0-9'/, "the shell must strip DISPLAY to digits, as vaultListPath does");
  for (const display of [":1", ":2", ":10"]) {
    const n = execFileSync("bash", ["-c", `printf '%s' "${display}" | tr -cd '0-9'`], { encoding: "utf8" });
    assert.equal(
      `/config/.sub8-vault-list.${n}.json`,
      vaultListPath(display),
      `host and shell disagree for DISPLAY=${display}`,
    );
  }
});

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `${failed.length} failed` : `ok vault-routing (${results.length} checks)`);
process.exit(failed.length ? 1 : 0);
