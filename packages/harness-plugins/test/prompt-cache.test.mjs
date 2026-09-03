import { test } from "node:test";
import assert from "node:assert/strict";
import { pluginsPromptBlock, createPluginsCache, parseClaudeMcpList, shortDetail } from "../dist/index.js";

const SAMPLE = `claude.ai Gmail: https://gmailmcp.googleapis.com/mcp/v1 - ✔ Connected
claude.ai Google Calendar: https://calendarmcp.googleapis.com/mcp/v1 - ! Needs authentication
`;

test("pluginsPromptBlock names connected and not-connected plugins, empty for none", () => {
  const block = pluginsPromptBlock(parseClaudeMcpList(SAMPLE), { settingsPath: "Settings → This Mac → Plugins" });
  assert.match(block, /^## Plugins on this harness/);
  assert.match(block, /Connected now: Gmail\./);
  assert.match(block, /mcp__/);
  assert.match(block, /Not connected \(needs sign-in\): Google Calendar\./);
  assert.match(block, /Settings → This Mac → Plugins → Connect/);
  assert.equal(pluginsPromptBlock([]), "");
  assert.equal(pluginsPromptBlock(undefined), "");
});

test("pluginsPromptBlock separates needs-sign-in from temporarily unavailable, with the reason", () => {
  const rows = parseClaudeMcpList(SAMPLE + "claude.ai Indeed: https://mcp.indeed.com/claude/mcp - ✘ Failed to connect — -32429: Rate limit exceeded for account 1 on toolset claude. Try again in 28 seconds.\n");
  const block = pluginsPromptBlock(rows);
  assert.match(block, /Not connected \(needs sign-in\): Google Calendar\./);
  assert.match(block, /Temporarily unavailable[^\n]*Indeed \(Rate limit exceeded/);
  assert.ok(!/needs sign-in\)[^\n]*Indeed/.test(block), "Indeed is not listed under needs sign-in");
  assert.equal(shortDetail("✘ Failed to connect — -32429: Rate limit exceeded."), "Rate limit exceeded.");
  assert.equal(shortDetail("! Needs authentication"), "Needs authentication");
  assert.equal(shortDetail(undefined), "");
});

function fakeExec(out, calls) {
  return { async run() { calls.push(1); return { stdout: out, stderr: "", code: 0 }; } };
}

test("cache: peek is null before any fetch, then answers from cache; fetch happens once", async () => {
  let t = 1_000_000;
  const cache = createPluginsCache({ ttlMs: 60_000, now: () => t });
  const calls = [];
  const exec = fakeExec(SAMPLE, calls);
  assert.equal(cache.peek("claude", exec), null); // kicks off a refresh
  const e = await cache.get("claude", exec);
  assert.equal(e.plugins.length, 2);
  assert.equal(calls.length, 1, "peek + get shared one in-flight fetch");
  assert.equal(cache.peek("claude", exec).length, 2);
  assert.equal(calls.length, 1, "fresh entry is not refetched");
});

test("cache: stale entries refresh; force refetches; errors keep the previous list", async () => {
  let t = 0;
  const cache = createPluginsCache({ ttlMs: 1_000, now: () => t });
  const calls = [];
  await cache.get("claude", fakeExec(SAMPLE, calls));
  assert.equal(calls.length, 1);
  t = 5_000; // past ttl
  await cache.get("claude", fakeExec(SAMPLE, calls));
  assert.equal(calls.length, 2, "stale -> refetch");
  await cache.get("claude", fakeExec(SAMPLE, calls), { force: true });
  assert.equal(calls.length, 3, "force -> refetch");
  const failing = { async run() { throw new Error("boom"); } };
  const e = await cache.get("claude", failing, { force: true });
  assert.equal(e.error, "boom");
  assert.equal(e.plugins.length, 2, "previous good list survives a failed refresh");
});

test("cache: an unsupported harness yields an empty list without calling exec", async () => {
  const calls = [];
  const cache = createPluginsCache();
  const e = await cache.get("cursor", fakeExec(SAMPLE, calls));
  assert.deepEqual(e.plugins, []);
  assert.equal(calls.length, 0);
});
