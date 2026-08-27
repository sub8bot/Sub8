import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { cardFromSendMessageArgs, shouldEndTurn } from "@sub8/choice";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sub8-mcp-remote-"));
process.env.SUB8BOT_DATA = tmp;
process.env.OCTOBOT_DATA = tmp;

const remote = await import("../dist/mcp-remote.js");

test("a remote MCP server is reached over a public URL or not at all", () => {
  assert.throws(() => remote.assertMcpUrl("http://127.0.0.1:3000"), /localhost/);
  assert.throws(() => remote.assertMcpUrl("file:///etc/passwd"), /file:/);
  assert.match(remote.assertMcpUrl("https://mcp.example.com/sse"), /^https:\/\/mcp\.example.com/);
});

const calls = [];
function stubFetch() {
  remote.setFetch(async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const method = JSON.parse(init.body).method;
    if (method === "initialize") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05" } }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    if (method === "tools/list") {
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: [{ name: "list_issues", inputSchema: { type: "object" } }] } }),
        { headers: { "Content-Type": "application/json" } },
      );
    }
    if (method === "tools/call") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 3, result: { content: [{ type: "text", text: "ok" }] } }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("nope", { status: 500 });
  });
}

let added;

test("addServer, getMcpTools and callMcpTool, with the token never in the reply", async () => {
  stubFetch();
  added = await remote.addServer({ name: "linear", url: "https://mcp.example.com/sse" });
  assert.equal(added.name, "linear");
  assert.equal(added.hasAuth, false);
  assert.equal("headers" in added, false);

  const listed = await remote.getMcpTools(added.id);
  assert.equal(listed.tools[0].name, "list_issues");
  assert.ok(!JSON.stringify(listed).includes("Authorization"));

  const called = await remote.callMcpTool(added.id, "list_issues", { team: "eng" });
  assert.equal(called.result.content[0].text, "ok");
  assert.equal(calls.some((c) => c.body.method === "tools/call"), true);
});

test("401 is needsAuth, not a failure, and the Connect card ends the turn", async () => {
  remote.setFetch(async () => new Response("no", { status: 401 }));
  const auth = await remote.getMcpTools(added.id);
  assert.equal(auth.needsAuth, true);

  const card = cardFromSendMessageArgs({ id: "b1", name: "Bot" }, remote.connectCard({ id: "b1" }, added));
  assert.equal(shouldEndTurn(card), true);
  assert.equal(card.kind, "secret-request");
  assert.equal(card.secretTarget.connector, "mcp");
  assert.equal(card.secretTarget.field, added.id);
});

test("the token lands on disk and nowhere else, and removeServer clears the row", async () => {
  await remote.setServerAuth(added.id, "tok_secret_value");
  const after = (await remote.listServers()).find((s) => s.id === added.id);
  assert.equal(after.hasAuth, true);
  const disk = JSON.parse(await fs.readFile(path.join(tmp, "mcp-servers.json"), "utf8"));
  assert.match(disk[0].headers.Authorization, /tok_secret_value/);
  assert.equal(JSON.stringify(after).includes("tok_secret_value"), false);

  await remote.removeServer(added.id);
  assert.equal((await remote.listServers()).length, 0);
});

test.after(async () => {
  remote.resetForTest();
  await fs.rm(tmp, { recursive: true, force: true });
});

// assertMcpUrl is a pure STRING match, so a public-looking name that resolves
// into a private range walked straight through it. The local API on :8787
// serves /api/computers/:id/:action and the /api/vault mutators with NO auth,
// so add_mcp_server + get_mcp_tools was a way to drive the host Mac's own
// control plane. webFetch has resolved since 90e4dd1; this path never did.
test("a public name that resolves to loopback is refused, before any request", async () => {
  const row = { id: "r-ssrf", name: "looks-public", url: "https://mcp.evil.test/sse", headers: {} };
  let fetched = false;
  remote.setFetch(async () => {
    fetched = true;
    return new Response("{}", { headers: { "Content-Type": "application/json" } });
  });
  remote.setLookup(async () => [{ address: "127.0.0.1" }]);
  try {
    await assert.rejects(() => remote.rpc(row, "tools/list"), /127\.0\.0\.1/);
    assert.equal(fetched, false, "the POST must never leave — checking after the fact is too late");
  } finally {
    remote.setLookup(null);
  }
});

test("the cloud metadata address is refused too", async () => {
  const row = { id: "r-meta", name: "meta", url: "https://metadata.evil.test/", headers: {} };
  remote.setLookup(async () => [{ address: "169.254.169.254" }]);
  try {
    await assert.rejects(() => remote.rpc(row, "tools/list"), /169\.254\.169\.254/);
  } finally {
    remote.setLookup(null);
  }
});

// Checked at CALL time, not only when stored: a record that is public when the
// server is added can point at loopback by the time it is used.
test("a row that was public when added is still re-checked when called", async () => {
  remote.setLookup(async () => [{ address: "93.184.216.34" }]);
  let row;
  try {
    stubFetch();
    row = await remote.addServer({ name: "drifts", url: "https://mcp.drifts.test/sse" });
    assert.ok(row, "a public host must be addable");
  } finally {
    remote.setLookup(null);
  }
  remote.setLookup(async () => [{ address: "10.0.0.5" }]);
  try {
    await assert.rejects(() => remote.rpc(row, "tools/list"), /10\.0\.0\.5/);
  } finally {
    remote.setLookup(null);
  }
});

// And a genuinely public server is untouched.
test("a public MCP server still answers", async () => {
  remote.setLookup(async () => [{ address: "93.184.216.34" }]);
  try {
    stubFetch();
    const row = { id: "r-ok", name: "ok", url: "https://mcp.example.com/sse", headers: {} };
    const out = await remote.rpc(row, "tools/list");
    assert.ok(out, "the guard must not break a legitimate server");
  } finally {
    remote.setLookup(null);
  }
});
