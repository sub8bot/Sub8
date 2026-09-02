/**
 * mcp-sub8 redacted vault secrets from the `shell` tool and nowhere else. Two
 * consequences, both real:
 *
 *  - `browser`. vault_fill pastes a stored password into whatever the desktop
 *    currently has focused. pasteSecret is xdotool-level (getwindowfocus +
 *    ctrl+v), so it CANNOT tell a password field from a plain text input, and
 *    page-agent's snapshot emits value="<AX value>" for every textbox. So a
 *    model could paste a credential into an ordinary input and read it right
 *    back out of the next snapshot — into its context and the transcript.
 *
 *  - `send_message` / `message_teammate`. server/agent.mts:1789 — the SAME tool
 *    in the other harness — redacts model-authored content before emitting it.
 *    The MCP path did not, so a secret obtained by any means was written
 *    verbatim into chat, the stored message list and team history.
 *
 * The first half below tests redactSecrets for real. The second half is a
 * source assertion, deliberately: driving callTool for `browser` needs a live
 * container and a page-agent, so pinning the call sites is the honest way to
 * keep them from being dropped. test/control-route.mjs uses the same technique
 * for the same reason.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import * as vault from "../server/vault.mjs";

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log("PASS", name);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log("FAIL", name, "-", err.message);
  }
}

const PASSWORD = "hunter2-not-a-real-password";

await test("redactSecrets masks a secret anywhere in a page snapshot", async () => {
  const snapshot = `textbox "Search" value="${PASSWORD}" ref=e12`;
  const out = vault.redactSecrets(snapshot, [PASSWORD]);
  assert.equal(out.includes(PASSWORD), false, "the pasted password read straight back out");
  assert.match(out, /\[secret\]/);
});

await test("redactSecrets masks every occurrence, not just the first", async () => {
  const out = vault.redactSecrets(`${PASSWORD} and again ${PASSWORD}`, [PASSWORD]);
  assert.equal(out.includes(PASSWORD), false);
  assert.equal(out.match(/\[secret\]/g).length, 2);
});

await test("redactSecrets is safe with regex metacharacters in the secret", async () => {
  const nasty = "p+a.s*s(w)ord[1]";
  assert.equal(vault.redactSecrets(`x ${nasty} y`, [nasty]).includes(nasty), false);
});

// Documented limit, not an endorsement: short secrets are skipped, and a
// screenshot is pixels so nothing can mask it.
await test("KNOWN: secrets under 4 chars are not masked", async () => {
  assert.equal(vault.redactSecrets("pin 123", ["123"]), "pin 123");
});

// ---- the call sites -----------------------------------------------------

const src = await fs.readFile(new URL("../server/mcp-sub8.mts", import.meta.url), "utf8");

const arm = (label, re) =>
  test(`${label} redacts before it returns`, async () => {
    assert.match(src, re, `${label} no longer redacts — a vault secret can reach the model`);
  });

await arm("browser", /return \{ content: \[\{ type: "text", text: vault\.redactSecrets\(r\.text/);
await arm("send_message", /const content = vault\.redactSecrets\(String\(args\.content/);
await arm("message_teammate", /const content = vault\.redactSecrets\(sendToAgentContent\(rawBody\)/);

await arm("memory", /const memText = vault\.redactSecrets\(r\.text/);
await arm("read", /vault\.redactSecrets\(raw, await vault\.listSecrets\(\)\)/);

await test("the shell arm that already redacted still does", async () => {
  assert.equal((src.match(/vault\.redactSecrets\(/g) || []).length >= 7, true, "a redaction call site was removed");
});

// The arm regexes above match the SHAPE of the call, and the counter above
// counts call sites — neither looks at what is being redacted AGAINST. Setting
// the secret source to an empty list leaves every call site intact and every
// regex matching, while disabling the shell tool's output redaction AND the
// `secrets.some(s => cmd.includes(s))` block that refuses to put a vault secret
// on a command line. Pin the source, not just the call.
await test("every redaction is fed a real secret list, not an empty one", async () => {
  const sources = src.match(/const secrets(?::\s*[^=]+)? = await vault\.listSecrets\(\);/g) || [];
  assert.ok(
    sources.length >= 2,
    `the shell and browser arms must source secrets from vault.listSecrets(); found ${sources.length}`,
  );
  // A typed empty literal is the exact mutation that slipped through.
  assert.equal(
    /const secrets\s*:\s*string\[\]\s*=\s*\[\]/.test(src),
    false,
    "a redaction arm is redacting against an empty list",
  );
  // Inline calls must pass the live lookup too, never a bare [].
  assert.equal(
    /vault\.redactSecrets\([^)]*,\s*\[\]\s*\)/.test(src),
    false,
    "a redactSecrets call passes an empty secret list",
  );
});

// agent.mts is the OTHER host harness and drifted from mcp-sub8 twice already
// (browser and message_teammate), so pin its sinks too rather than trusting
// that the two files stay in step.
const agentSrc = await fs.readFile(new URL("../server/agent.mts", import.meta.url), "utf8");

const armAgent = (label, re) =>
  test(`agent.mts ${label} redacts before it returns`, async () => {
    assert.match(agentSrc, re, `agent.mts ${label} no longer redacts — a vault secret can reach the model`);
  });

await armAgent("browser", /return \{ text: vault\.redactSecrets\(r\.text \|\| ""/);
await armAgent("message_teammate", /const content = vault\.redactSecrets\(sendToAgentContent\(rawBody\)/);
await armAgent("memory", /return \{ text: vault\.redactSecrets\(r\.text \|\| "", await vault\.listSecrets\(\)\) \}/);
await armAgent("read", /if \(r\.kind === "text"\) return \{ text: vault\.redactSecrets\(r\.text!, secrets\) \}/);

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `${failed.length} failed` : "ok mcp-redaction");
process.exit(failed.length ? 1 : 0);
