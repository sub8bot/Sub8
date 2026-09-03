import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseClaudeMcpList,
  claudeStatus,
  pluginSlug,
  claudeDisplayName,
  claudePlugins,
  pluginsForHarness,
  harnessesWithPlugins,
  CLAUDE_CONNECTORS_PAGE,
} from "../dist/index.js";

// Verbatim `claude mcp list` output captured from a real machine.
const SAMPLE = `Checking MCP server health…

claude.ai Cloudflare Developer Platform: https://bindings.mcp.cloudflare.com/mcp - ! Needs authentication
claude.ai Indeed: https://mcp.indeed.com/claude/mcp - ✔ Connected
claude.ai Vercel: https://mcp.vercel.com - ✔ Connected
claude.ai Google Calendar: https://calendarmcp.googleapis.com/mcp/v1 - ! Needs authentication
claude.ai Google Drive: https://drivemcp.googleapis.com/mcp/v1 - ✔ Connected
claude.ai Gmail: https://gmailmcp.googleapis.com/mcp/v1 - ✔ Connected
plugin:stripe:stripe: https://mcp.stripe.com (HTTP) - ! Needs authentication
`;

test("parses every server line and skips the header/blank lines", () => {
  const p = parseClaudeMcpList(SAMPLE);
  assert.equal(p.length, 7);
  assert.ok(!p.some((x) => /checking/i.test(x.name)));
});

test("splits name/url/status on the ': ' before the URL, even when the name has colons", () => {
  const stripe = parseClaudeMcpList(SAMPLE).find((x) => x.url === "https://mcp.stripe.com");
  assert.ok(stripe, "stripe entry parsed");
  assert.equal(stripe.id, "plugin-stripe-stripe");
  assert.equal(stripe.name, "stripe");
  assert.equal(stripe.transport, "HTTP");
  assert.equal(stripe.status, "needs_auth");
  assert.equal(stripe.detail, "! Needs authentication");
});

test("connected and needs_auth are told apart", () => {
  const p = parseClaudeMcpList(SAMPLE);
  assert.equal(p.find((x) => x.name === "Gmail").status, "connected");
  assert.equal(p.find((x) => x.name === "Google Drive").status, "connected");
  assert.equal(p.find((x) => x.name === "Google Calendar").status, "needs_auth");
  assert.equal(p.find((x) => x.name === "Cloudflare Developer Platform").status, "needs_auth");
});

test("every entry is tagged with the claude harness and a url", () => {
  for (const x of parseClaudeMcpList(SAMPLE)) {
    assert.equal(x.harness, "claude");
    assert.match(x.url, /^https:\/\//);
  }
});

test("a server with no transport marker still parses", () => {
  const vercel = parseClaudeMcpList(SAMPLE).find((x) => x.name === "Vercel");
  assert.ok(vercel);
  assert.equal(vercel.transport, undefined);
  assert.equal(vercel.status, "connected");
});

test("empty / garbage input yields no plugins rather than throwing", () => {
  assert.deepEqual(parseClaudeMcpList(""), []);
  assert.deepEqual(parseClaudeMcpList("no servers configured"), []);
  assert.deepEqual(parseClaudeMcpList(undefined), []);
});

test("claudeStatus normalizes the status column", () => {
  assert.equal(claudeStatus("✔ Connected"), "connected");
  assert.equal(claudeStatus("! Needs authentication"), "needs_auth");
  assert.equal(claudeStatus("✗ Failed to connect"), "error");
  assert.equal(claudeStatus("something else"), "unknown");
});

test("pluginSlug and claudeDisplayName", () => {
  assert.equal(pluginSlug("claude.ai Google Drive"), "claude-ai-google-drive");
  assert.equal(claudeDisplayName("claude.ai Gmail"), "Gmail");
  assert.equal(claudeDisplayName("plugin:stripe:stripe"), "stripe");
  assert.equal(claudeDisplayName("Plain"), "Plain");
});

test("claudePlugins.listPlugins runs `claude mcp list` through the injected exec and fills connectUrl", async () => {
  const calls = [];
  const exec = {
    async run(file, args, opts) {
      calls.push({ file, args, opts });
      return { stdout: SAMPLE, stderr: "", code: 0 };
    },
  };
  const p = await claudePlugins.listPlugins(exec);
  assert.deepEqual(calls[0].file, "claude");
  assert.deepEqual(calls[0].args, ["mcp", "list"]);
  assert.equal(p.length, 7);
  // Not-connected plugins get somewhere to connect; connected ones do not.
  assert.equal(p.find((x) => x.name === "Google Calendar").connectUrl, CLAUDE_CONNECTORS_PAGE);
  assert.equal(p.find((x) => x.name === "Gmail").connectUrl, undefined);
  // connectUrl() always gives the user somewhere to go.
  assert.equal(claudePlugins.connectUrl(p.find((x) => x.name === "Gmail")), CLAUDE_CONNECTORS_PAGE);
});

test("registry resolves claude and reports unknown harnesses as null", () => {
  assert.equal(pluginsForHarness("claude"), claudePlugins);
  assert.equal(pluginsForHarness("cursor"), null);
  assert.equal(pluginsForHarness(""), null);
  assert.deepEqual(harnessesWithPlugins(), ["claude"]);
});
