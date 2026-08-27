import assert from "node:assert/strict";
import { callTool, computerCommand, deskMessageCard, grokMcpToml, setExec, setFetch, TOOLS } from "../server/mcp-desk.mjs";
import { assertVmShell } from "../server/isolation.mjs";
import { writeDeskMcpConfig } from "../server/vm.mjs";

assert.ok(TOOLS.some((t) => t.name === "computer"));
assert.ok(TOOLS.some((t) => t.name === "shell"));
assert.ok(TOOLS.some((t) => t.name === "send_message"));
assert.ok(TOOLS.some((t) => t.name === "create_teammate"));
assert.ok(TOOLS.some((t) => t.name === "list_teammates"));
assert.ok(TOOLS.some((t) => t.name === "message_teammate"));
assert.ok(TOOLS.some((t) => t.name === "task"));
assert.match(computerCommand({ action: "screenshot" }), /x11grab/);
assert.match(computerCommand({ action: "left_click", x: 10, y: 20 }), /10 20/);
assert.throws(() => assertVmShell("cat /Users/someone/secret"), /host paths/);

const ran = [];
setExec(async (cmd) => {
  ran.push(cmd);
  return { ok: true, output: "SHOT_OK" };
});
const shot = await callTool("computer", { action: "screenshot" });
assert.match(shot.output, /SHOT_OK/);
assert.match(ran[0], /ffmpeg/);

await assert.rejects(() => callTool("shell", { command: "cat /Users/someone/.ssh/id_rsa" }), /host paths/);

const toml = grokMcpToml({
  script: "/usr/local/lib/sub8/mcp-desk.mjs",
  env: { SUB8_INTERNAL_URL: "http://host.docker.internal:8787", SUB8BOT_BOT_ID: "abc" },
});
assert.match(toml, /\[mcp_servers\.sub8\]/);
assert.match(toml, /mcp-desk\.mjs/);
assert.match(toml, /host\.docker\.internal/);
assert.doesNotMatch(toml, /SearchPlugins/);
assert.equal(typeof writeDeskMcpConfig, "function");

{
  const card = deskMessageCard({ type: "widget", widget: { prompt: "Ship?" } });
  assert.equal(card.kind, "choices");
  assert.equal(card.pending, true);
  const secret = deskMessageCard({ type: "secret-request", secret: { label: "PAT", connector: "vault" } });
  assert.equal(secret.kind, "secret-request");

  // The widget arm also fired on a bare `args.question`, and this tool's
  // inputSchema offers `question` beside `type` and `secret` — so the shape a
  // model naturally sends for a credential built a kind:"choices" card. The UI
  // masks only on kind === "secret-request", so the user got an ordinary text
  // box and POST /choice wrote the credential into the transcript. Third copy
  // of the same defect; packages/choice and cloud-tools were already fixed.
  const askedByQuestion = deskMessageCard({ type: "secret-request", question: "Paste your GitHub PAT" });
  assert.equal(askedByQuestion.kind, "secret-request", "a bare question must not downgrade it to a choices card");
  assert.equal(askedByQuestion.secret, true);
  // The widget path is unaffected, and a bare question with no type still is not a secret.
  const stillWidget = deskMessageCard({ type: "widget", question: "Which city?", choices: [{ id: "a", label: "SFO" }] });
  assert.equal(stillWidget.kind, "choices");
  assert.equal((stillWidget.choices || []).length, 1);
  assert.equal(deskMessageCard({ question: "Just asking?" }).kind, "choices");
  const posts = [];
  setFetch(async (url, init) => {
    posts.push({ url, body: JSON.parse(init.body) });
    return { ok: true, json: async () => ({ ok: true, output: "ok" }) };
  });
  process.env.SUB8_INTERNAL_URL = "http://host.docker.internal:8787";
  process.env.SUB8_INTERNAL_TOKEN = "tok";
  process.env.SUB8BOT_BOT_ID = "bot-1";
  const asked = await callTool("send_message", { type: "widget", question: "Ship?" });
  assert.equal(asked.endTurn, true);
  assert.equal(posts.length, 2);
  assert.match(posts[0].url, /\/api\/internal\/emit$/);
  assert.match(posts[1].url, /\/api\/internal\/end-turn$/);
  assert.equal(posts[0].body.data.kind, "choices");
  posts.length = 0;
  const created = await callTool("create_teammate", { name: "Scout", job: "open example.com" });
  assert.match(posts[0].url, /\/api\/internal\/desk-tool$/);
  assert.equal(posts[0].body.name, "create_teammate");
  assert.equal(posts[0].body.args.name, "Scout");
  assert.equal(created.ok, true);
}


console.log("ok mcp-desk");
