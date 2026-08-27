import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  HARNESS_PORT,
  HEALTH_PATH,
  TURN_PATH,
  STOP_PATH,
  NDJSON_CONTENT_TYPE,
  TURN_EVENT_TYPES,
  isClaudeProvider,
  isOAuthProvider,
  isToolEvent,
  isDeltaEvent,
  isDoneEvent,
  isErrorEvent,
  isTurnEvent,
  turnEventReject,
  parseTurnEventLine,
  encodeTurnEvent,
  createTurnEventDecoder,
  decodeTurnEvents,
  isHarnessHealth,
  isStopResponse,
  harnessIsUp,
  harnessCanTurn,
  harnessToolsState,
  harnessHasTools,
  parseHarnessHealth,
  turnRequestProblems,
  isTurnRequest,
  assertTurnRequest,
  isSimpleTurnRequest,
  isHarnessTurnBody,
  isGrokAuthFile,
  isGrokAuthRecord,
} from "../dist/index.js";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = path.join(pkgRoot, "fixtures");
const readFixture = (name) => readFileSync(path.join(fixtures, name), "utf8");
const readFixtureBytes = (name) => new Uint8Array(readFileSync(path.join(fixtures, name)));
const readJsonFixture = (name) => JSON.parse(readFixture(name));

const feed = async (chunks, options = {}) => {
  const seen = [];
  const decoder = createTurnEventDecoder({ onEvent: (e) => seen.push(e), ...options });
  for (const c of chunks) await decoder.push(c);
  const result = await decoder.finish();
  return { seen, result };
};

/* ---------------------------------------------------------------- constants */

test("wire constants match both implementations", () => {
  // cloud/src/harness-client.mjs, cloud/src/digitalocean.mjs,
  // server/desk-client.mjs and server/desk-harness/server.mjs all hardcode 3011.
  assert.equal(HARNESS_PORT, 3011);
  assert.equal(HEALTH_PATH, "/health");
  assert.equal(TURN_PATH, "/turn");
  assert.equal(STOP_PATH, "/stop");
  assert.equal(NDJSON_CONTENT_TYPE, "application/x-ndjson");
  assert.deepEqual([...TURN_EVENT_TYPES], ["tool", "delta", "done", "error"]);
});

test("provider predicates are prefix/substring, matching harness.mjs", () => {
  assert.equal(isClaudeProvider("claude"), true);
  // The case cloud's `row.provider === "claude"` gets wrong today.
  assert.equal(isClaudeProvider("claude-max"), true);
  assert.equal(isClaudeProvider("Claude"), true);
  assert.equal(isClaudeProvider("xai"), false);
  assert.equal(isClaudeProvider("grok-oauth"), false);
  assert.equal(isOAuthProvider("grok-oauth"), true);
  assert.equal(isOAuthProvider("xai"), false);
  assert.equal(isClaudeProvider(undefined), false);
});

/* ------------------------------------------------------------- event guards */

test("a well-formed event of each type is accepted", () => {
  const tool = { type: "tool", name: "computer", args: { action: "mouse_move", x: 1, y: 2 } };
  const delta = { type: "delta", text: "hello" };
  const done = { type: "done", content: "all set", usage: { llmCalls: 2, promptTokens: 10, completionTokens: 3 } };
  const error = { type: "error", message: "grok spawn failed: ENOENT" };

  assert.equal(isToolEvent(tool), true);
  assert.equal(isDeltaEvent(delta), true);
  assert.equal(isDoneEvent(done), true);
  assert.equal(isErrorEvent(error), true);
  for (const e of [tool, delta, done, error]) {
    assert.equal(isTurnEvent(e), true);
    assert.equal(turnEventReject(e), null);
  }
  // usage is optional; runTurn always sends it, older harnesses did not.
  assert.equal(isDoneEvent({ type: "done", content: "" }), true);
  // Guards do not cross-accept.
  assert.equal(isToolEvent(delta), false);
  assert.equal(isDoneEvent(error), false);
});

test("a malformed event is rejected with a reason, never silently accepted", () => {
  const cases = [
    [null, "not-object"],
    [[{ type: "delta", text: "x" }], "not-object"],
    ["delta", "not-object"],
    [{}, "missing-type"],
    [{ type: "" }, "missing-type"],
    [{ type: 7 }, "missing-type"],
    // A harness that grew a new event type the client has not been taught.
    [{ type: "status", state: "thinking" }, "unknown-type"],
    // The real failure mode: right type tag, wrong payload.
    [{ type: "delta" }, "bad-shape"],
    [{ type: "delta", text: 42 }, "bad-shape"],
    [{ type: "tool", args: {} }, "bad-shape"],
    [{ type: "tool", name: "computer" }, "bad-shape"],
    [{ type: "tool", name: "computer", args: [] }, "bad-shape"],
    [{ type: "done" }, "bad-shape"],
    [{ type: "done", content: "x", usage: { llmCalls: 1 } }, "bad-shape"],
    [{ type: "error" }, "bad-shape"],
    [{ type: "error", message: { code: 500 } }, "bad-shape"],
  ];
  for (const [value, reason] of cases) {
    assert.equal(isTurnEvent(value), false, `expected reject: ${JSON.stringify(value)}`);
    assert.equal(turnEventReject(value), reason, `wrong reason for ${JSON.stringify(value)}`);
  }
});

test("parseTurnEventLine separates blank, malformed and valid lines", () => {
  assert.deepEqual(parseTurnEventLine(""), { ok: "blank" });
  assert.deepEqual(parseTurnEventLine("   \r"), { ok: "blank" });
  assert.deepEqual(parseTurnEventLine("not json"), { ok: false, reason: "not-json", line: "not json" });
  assert.deepEqual(parseTurnEventLine("[1,2]"), { ok: false, reason: "not-object", line: "[1,2]" });
  const good = parseTurnEventLine('{"type":"delta","text":"hi"}');
  assert.equal(good.ok, true);
  assert.deepEqual(good.event, { type: "delta", text: "hi" });
});

test("encodeTurnEvent writes the exact wire line and refuses a bad event", () => {
  const line = encodeTurnEvent({ type: "delta", text: "hi" });
  assert.equal(line, '{"type":"delta","text":"hi"}\n');
  assert.equal(line.endsWith("\n"), true);
  const back = parseTurnEventLine(line);
  assert.equal(back.ok, true);
  assert.deepEqual(back.event, { type: "delta", text: "hi" });
  // A producer bug fails where it happens, not as a dropped line on the far end.
  assert.throws(() => encodeTurnEvent({ type: "delta" }), /bad-shape/);
  assert.throws(() => encodeTurnEvent({ type: "status" }), /unknown-type/);
});

/* ------------------------------------------------------------- turn streams */

test("a well-formed turn streams tool, delta and done and yields the final content", async () => {
  const stream =
    encodeTurnEvent({ type: "tool", name: "browser", args: { browser_action: "navigate", url: "https://x.ai" } }) +
    encodeTurnEvent({ type: "delta", text: "Looking" }) +
    encodeTurnEvent({ type: "delta", text: " it up." }) +
    encodeTurnEvent({ type: "tool", name: "computer", args: { action: "screenshot" } }) +
    encodeTurnEvent({ type: "done", content: "  Done looking it up.  ", usage: { llmCalls: 2, promptTokens: 40, completionTokens: 9 } });

  const { seen, result } = await feed([new TextEncoder().encode(stream)]);
  assert.equal(seen.length, 5);
  assert.deepEqual(seen.map((e) => e.type), ["tool", "delta", "delta", "tool", "done"]);
  // Trimmed, matching createNdjsonParser in cloud/src/harness-client.mjs.
  assert.equal(result.content, "Done looking it up.");
  assert.equal(result.done.usage.llmCalls, 2);
  assert.equal(result.error, null);
  assert.deepEqual(result.counts, { tool: 2, delta: 2, done: 1, error: 0, total: 5 });
  assert.equal(result.malformedCount, 0);
});

test("an error turn surfaces the error and leaves content empty", async () => {
  const stream =
    encodeTurnEvent({ type: "delta", text: "starting" }) +
    encodeTurnEvent({ type: "error", message: "grok failed: ENOENT. Is grok installed?" });
  const { result } = await feed([new TextEncoder().encode(stream)]);
  assert.equal(result.error.message, "grok failed: ENOENT. Is grok installed?");
  assert.equal(result.done, null);
  // Both clients treat "no done" as a failed turn.
  assert.equal(result.content, "");
});

test("a stream that ends mid-line is not mistaken for a completed turn", async () => {
  const { result } = await feed([new TextEncoder().encode('{"type":"delta","text":"half')]);
  assert.equal(result.content, "");
  assert.equal(result.counts.total, 0);
  assert.equal(result.malformedCount, 1);
  assert.equal(result.malformed[0].reason, "not-json");
});

test("malformed lines are reported, not dropped, and do not stop the stream", async () => {
  const onMalformed = [];
  const stream = [
    '{"type":"delta","text":"before"}',
    "grok-build: warning, this is not json",
    '{"type":"status","state":"thinking"}',
    '{"type":"tool","name":"computer"}',
    '{"type":"done","content":"finished"}',
  ].join("\n") + "\n";

  const { seen, result } = await feed([new TextEncoder().encode(stream)], {
    onMalformed: (line, reason) => onMalformed.push(reason),
  });
  assert.deepEqual(seen.map((e) => e.type), ["delta", "done"]);
  assert.equal(result.content, "finished");
  assert.equal(result.malformedCount, 3);
  assert.deepEqual(onMalformed, ["not-json", "unknown-type", "bad-shape"]);
  assert.equal(result.malformed[1].line, '{"type":"status","state":"thinking"}');
});

/* ------------------------------------------------------- non-ASCII (the bug) */

const NON_ASCII_REPLY = "Cheapest is $240 Frontier SFO→DCA — non‑stop, 06:15 départ. 🛫";

test("non-ASCII survives an em dash split across chunk boundaries", async () => {
  const stream =
    encodeTurnEvent({ type: "delta", text: NON_ASCII_REPLY }) +
    encodeTurnEvent({ type: "done", content: NON_ASCII_REPLY, usage: { llmCalls: 1, promptTokens: 5, completionTokens: 5 } });
  const bytes = new TextEncoder().encode(stream);
  // An em dash is 3 bytes but 1 JS char; the emoji is 4. Splitting anywhere
  // inside either is what corrupted every reply containing one.
  assert.ok(bytes.length > stream.length, "fixture must contain multi-byte characters");

  for (let cut = 0; cut <= bytes.length; cut++) {
    const { result } = await feed([bytes.subarray(0, cut), bytes.subarray(cut)]);
    assert.equal(result.content, NON_ASCII_REPLY, `corrupted when split at byte ${cut}`);
    assert.equal(result.malformedCount, 0, `malformed line when split at byte ${cut}`);
  }
});

test("non-ASCII survives one-byte-at-a-time delivery", async () => {
  const bytes = new TextEncoder().encode(encodeTurnEvent({ type: "done", content: NON_ASCII_REPLY }));
  const chunks = [];
  for (let i = 0; i < bytes.length; i++) chunks.push(bytes.subarray(i, i + 1));
  const { result } = await feed(chunks);
  assert.equal(result.content, NON_ASCII_REPLY);
  assert.equal(result.malformedCount, 0);
});

test("the fixture turn (CJK, arrow, em dash, non-breaking hyphen, emoji) round-trips byte-exactly", async () => {
  const bytes = readFixtureBytes("turn-stream.ndjson");
  const text = readFixture("turn-stream.ndjson");
  const mid = Math.floor(bytes.length / 2);
  const { seen, result } = await feed([bytes.subarray(0, mid), bytes.subarray(mid)]);
  assert.equal(result.malformedCount, 0);
  assert.deepEqual(result.counts, { tool: 3, delta: 2, done: 1, error: 0, total: 6 });
  assert.equal(result.content, "Cheapest is $240 Frontier SFO→DCA — non‑stop, 06:15 départ. 🛫");
  assert.equal(seen[0].args.url, "https://flights.example/搜索");
  // The whole-body path must agree with the streaming path, exactly.
  assert.deepEqual(decodeTurnEvents(text).content, result.content);
  assert.deepEqual(decodeTurnEvents(bytes).counts, result.counts);
});

test("PIN: decoding each chunk on its own corrupts multi-byte text (why the decoder is streaming)", () => {
  // This is the bug shape, reproduced. It is a test so that anyone who
  // "simplifies" createTurnEventDecoder into a per-chunk decode sees it fail.
  const bytes = new TextEncoder().encode(encodeTurnEvent({ type: "done", content: NON_ASCII_REPLY }));
  let naive = "";
  for (let i = 0; i < bytes.length; i++) naive += new TextDecoder().decode(bytes.subarray(i, i + 1));
  assert.notEqual(naive, new TextDecoder().decode(bytes));
  assert.ok(naive.includes("�"), "per-chunk decode should produce replacement characters");
  // And this is why no guard can save a caller that decodes per chunk: the
  // replacement characters land INSIDE a JSON string, so the line still parses
  // as a perfectly valid done event — carrying a corrupted reply.
  const parsed = parseTurnEventLine(naive);
  assert.equal(parsed.ok, true);
  assert.notEqual(parsed.event.content, NON_ASCII_REPLY);
  assert.ok(parsed.event.content.includes("�"));
});

/* --------------------------------------------------------------- /health */

test("health guards match harnessHealthy and harnessCanTurn on both sides", () => {
  const up = { ok: true, harness: true, grok: true };
  assert.equal(isHarnessHealth(up), true);
  assert.equal(harnessIsUp(up), true);
  assert.equal(harnessCanTurn(up), true);

  const noGrok = { ok: true, harness: true, grok: false };
  assert.equal(harnessIsUp(noGrok), true);
  assert.equal(harnessCanTurn(noGrok), false);

  assert.equal(harnessIsUp({ ok: false, harness: true, grok: true }), false);
  // The older pi executor on :3010 answers without `harness`.
  assert.equal(isHarnessHealth({ ok: true }), false);
  assert.equal(harnessIsUp({ ok: true }), false);
  // Stringly-typed booleans are a drift, not a health.
  assert.equal(isHarnessHealth({ ok: "true", harness: "true", grok: "true" }), false);

  assert.deepEqual(parseHarnessHealth('{"ok":true,"harness":true,"grok":true}'), up);
  assert.equal(parseHarnessHealth("not json"), null);
  assert.equal(parseHarnessHealth('{"ok":true}'), null);

  assert.equal(isStopResponse({ ok: true, stopped: 1 }), true);
  assert.equal(isStopResponse({ ok: true }), false);
});

/* --------------------------------------------------- /health: the tools probe */

// The three-day toolless outage: ok/harness/grok all true, mcp-sub8 dead. `mcp`
// is the only field that can see it, so the first thing to pin is that it CAN
// go false while everything else stays true.
test("mcp:false is tools-down while the desk itself stays up", () => {
  const dead = { ok: true, harness: true, grok: true, mcp: false, tools: 0 };
  assert.equal(isHarnessHealth(dead), true);
  assert.equal(harnessIsUp(dead), true, "a dead mcp-sub8 must NOT make the desk look down");
  assert.equal(harnessCanTurn(dead), true, "grok is still installed — that meaning does not change");
  assert.equal(harnessToolsState(dead), "down");
  assert.equal(harnessHasTools(dead), false);
});

test("mcp:true is the only thing that proves tools", () => {
  const live = { ok: true, harness: true, grok: true, mcp: true, tools: 37 };
  assert.equal(isHarnessHealth(live), true);
  assert.equal(harnessIsUp(live), true);
  assert.equal(harnessToolsState(live), "up");
  assert.equal(harnessHasTools(live), true);

  // A desk that is down has no tools either — but that is "down", not "unknown".
  assert.equal(harnessToolsState({ ok: false, harness: true, mcp: true }), "down");
  // ...while a body that is not a health at all teaches us NOTHING about tools.
  assert.equal(harnessToolsState(null), "unknown");
  assert.equal(harnessToolsState({ ok: true }), "unknown");
  assert.equal(harnessHasTools(null), false);
});

// The whole backward-compatibility story. Desks in production run the harness
// that predates the probe; if absence read as "down" this change would bench
// every one of them the day it shipped.
test("a harness that does not send mcp is UNKNOWN, never down", () => {
  const today = { ok: true, harness: true, grok: true }; // byte-for-byte what the old harness answers
  assert.equal(isHarnessHealth(today), true, "the payload today's desks send must still validate");
  assert.equal(harnessIsUp(today), true);
  assert.equal(harnessCanTurn(today), true);
  assert.equal(harnessToolsState(today), "unknown", "absent mcp must never read as down");
  assert.equal(harnessHasTools(today), false, "and must never read as proof either");
  assert.deepEqual(parseHarnessHealth('{"ok":true,"harness":true,"grok":true}'), today);

  // Same for the Claude desk (no grok) and the pre-grok body.
  assert.equal(harnessToolsState({ ok: true, harness: true }), "unknown");
  assert.equal(harnessIsUp({ ok: true, harness: true }), true);

  // A harness reporting tools but not mcp is still only a hint: gate on mcp.
  assert.equal(harnessToolsState({ ok: true, harness: true, tools: 37 }), "unknown");
});

test("the new fields are typed, and drift is rejected", () => {
  assert.equal(isHarnessHealth({ ok: true, harness: true, mcp: "true" }), false);
  assert.equal(isHarnessHealth({ ok: true, harness: true, mcp: 1 }), false);
  assert.equal(isHarnessHealth({ ok: true, harness: true, tools: "37" }), false);
  assert.equal(isHarnessHealth({ ok: true, harness: true, tools: -1 }), false);
  assert.equal(isHarnessHealth({ ok: true, harness: true, tools: Number.NaN }), false);
  assert.equal(isHarnessHealth({ ok: true, harness: true, mcp: true, tools: 0 }), true);
  assert.equal(parseHarnessHealth('{"ok":true,"harness":true,"mcp":"yes"}'), null);
  const parsed = parseHarnessHealth('{"ok":true,"harness":true,"grok":true,"mcp":false,"tools":0}');
  assert.equal(parsed?.mcp, false);
  assert.equal(parsed?.tools, 0);
  assert.equal(harnessHasTools(parsed), false);
});

// The exact bodies server/desk-harness/server.mjs healthBody() builds.
test("every body the desk harness can answer round-trips", () => {
  for (const body of [
    { ok: true, harness: true, grok: true }, // first probe still in flight
    { ok: true, harness: true, grok: false }, // Claude desk, probe in flight
    { ok: true, harness: true, grok: true, mcp: true, tools: 37 },
    { ok: true, harness: true, grok: true, mcp: false, tools: 0 },
    { ok: true, harness: true, grok: false, mcp: true, tools: 37 },
  ]) {
    const wire = JSON.stringify(body);
    assert.deepEqual(parseHarnessHealth(wire), body, wire);
    assert.equal(harnessIsUp(body), true, `${wire} must stay up`);
  }
});

/* ----------------------------------------------------------- turn requests */

test("the body harnessTurn() actually sends validates", () => {
  const req = readJsonFixture("turn-request.json");
  assert.deepEqual(turnRequestProblems(req), []);
  assert.equal(isTurnRequest(req), true);
  assert.equal(isGrokAuthFile(req.auth), true);
  assert.equal(assertTurnRequest(req), req);

  const claude = readJsonFixture("turn-request-claude.json");
  assert.deepEqual(turnRequestProblems(claude), []);
  // A Claude-subscription turn has no API key by design.
  assert.equal(claude.model.apiKey, "");
});

test("turnRequestProblems catches the drifts that have broken production", () => {
  const base = readJsonFixture("turn-request.json");
  const withoutAuth = { ...base };
  delete withoutAuth.auth;
  assert.deepEqual(turnRequestProblems(withoutAuth), ['provider "grok-oauth" requires auth (grok auth.json)']);

  // The observed bug: a Claude user's turn sent as grok-oauth / grok-4.6.
  const claude = readJsonFixture("turn-request-claude.json");
  const grokModelForClaude = { ...claude, model: { ...claude.model, id: "grok-4.6" } };
  assert.deepEqual(turnRequestProblems(grokModelForClaude), [
    'provider "claude" cannot run model.id "grok-4.6"',
  ]);

  // normalizeTurn prefers the top-level provider; disagreement silently picks one.
  const split = { ...claude, model: { ...claude.model, provider: "xai" } };
  assert.deepEqual(turnRequestProblems(split), [
    'model.provider "xai" disagrees with provider "claude"',
  ]);

  // A flat {access_token} blob is what grok-build silently ignores.
  const flatAuth = { ...base, auth: { access_token: "xai-…" } };
  assert.ok(turnRequestProblems(flatAuth).some((p) => p.startsWith("auth must be")));
});

test("turnRequestProblems reports every structural fault, not just the first", () => {
  assert.deepEqual(turnRequestProblems("nope"), ["body is not an object"]);
  assert.deepEqual(turnRequestProblems(null), ["body is not an object"]);
  const problems = turnRequestProblems({ history: "recent", display: 0, callback: { url: "sub8.bot" } });
  assert.deepEqual(problems, [
    "botId must be a non-empty string",
    "content must be a string",
    "history must be an array",
    "display must be an integer >= 1",
    "provider must be a non-empty string",
    "model must be {provider,id,apiKey,baseUrl} with a non-empty id",
    "callback must be {url,computerId,botId} with an http(s) url",
  ]);
  const badHistory = { ...readJsonFixture("turn-request.json"), history: [{ role: "bot", content: "x" }] };
  assert.deepEqual(turnRequestProblems(badHistory), ["history[0] must be {role,content,ts?}"]);
  assert.throws(() => assertTurnRequest({}), /invalid harness turn request/);
});

test("the older simple body normalizeTurn() still accepts stays part of the contract", () => {
  const simple = { botId: "desk-local", text: "hi", model: "grok-4.6", provider: "xai" };
  assert.equal(isSimpleTurnRequest(simple), true);
  assert.equal(isTurnRequest(simple), false);
  assert.equal(isHarnessTurnBody(simple), true);
  assert.equal(isHarnessTurnBody(readJsonFixture("turn-request.json")), true);
  assert.equal(isHarnessTurnBody({ botId: "desk-local" }), false);
});

test("a Claude provider never needs grok auth.json", () => {
  // "claude-oauth" matches isOAuthProvider by name, but Claude authenticates
  // from claudeAuth or a ~/.claude login on the desk. Requiring grok's
  // auth.json fired on every legitimate Claude turn.
  const base = {
    botId: "b",
    content: "hi",
    provider: "claude-oauth",
    // harness-client always sends all four model fields, apiKey/baseUrl
    // possibly empty — a subscription turn has no key.
    model: { provider: "claude-oauth", id: "claude-sonnet-4-5", apiKey: "", baseUrl: "" },
  };
  assert.deepEqual(turnRequestProblems(base), [], "no grok auth demanded of Claude");
  // grok-oauth with no auth is still reported.
  const grok = {
    ...base,
    provider: "grok-oauth",
    model: { provider: "grok-oauth", id: "grok-4.6", apiKey: "", baseUrl: "" },
  };
  assert.ok(
    turnRequestProblems(grok).some((p) => /requires auth/.test(p)),
    "grok-oauth without auth must still be flagged",
  );
});

test("grok is a capability, not a liveness signal", () => {
  // A harness that omits grok must not read as DOWN — that would take a working
  // desk out of service. And a Claude desk runs turns with no grok installed.
  assert.equal(harnessIsUp({ ok: true, harness: true }), true, "no grok field still means up");
  assert.equal(harnessIsUp({ ok: true, harness: true, grok: false }), true, "grok:false is still up");
  assert.equal(harnessCanTurn({ ok: true, harness: true }), false, "but a grok turn is not worth attempting");
  assert.equal(harnessCanTurn({ ok: true, harness: true, grok: true }), true);
  assert.equal(harnessIsUp({ ok: true }), false, "harness is still required");
  assert.equal(harnessIsUp({ ok: false, harness: true }), false);
});

/* ------------------------------------------------- parseTurnEventLine, hard */

// ParsedLine.ok is THREE-valued, and "blank" is a truthy string. A consumer
// written as `if (parsed.ok) use(parsed.event)` therefore takes the success
// branch on the empty tail every newline-terminated stream ends with, and hands
// its caller `undefined` as an event. Only `=== true` is a success test.
test("parsed.ok is three-valued, and the blank tail is truthy without an event", () => {
  const blank = parseTurnEventLine("");
  assert.equal(blank.ok, "blank");
  assert.ok(blank.ok, "a naive `if (parsed.ok)` takes the success branch here");
  assert.equal(blank.event, undefined, "...and there is no event behind it");
  assert.equal("reason" in blank, false, "nor a reason to log");

  const bad = parseTurnEventLine("{");
  assert.equal(bad.ok, false);
  assert.equal(bad.ok === true, false);
  const good = parseTurnEventLine('{"type":"done","content":"x"}');
  assert.equal(good.ok === true, true);
});

test("a valid JSON scalar is not-object, and the reported line is the trimmed raw", () => {
  // "the body parsed but is not an event" has to stay distinguishable from
  // "the body is not JSON": one means the harness drifted, the other means the
  // subprocess wrote a log line to stdout.
  for (const line of ["null", "42", "0", "true", "false", '"delta"', '"{}"']) {
    assert.deepEqual(parseTurnEventLine(line), { ok: false, reason: "not-object", line });
  }
  // Whitespace and CRLF are framing, not content: what gets logged is trimmed.
  assert.deepEqual(parseTurnEventLine('  {"type":"nope"}  \r'), {
    ok: false,
    reason: "unknown-type",
    line: '{"type":"nope"}',
  });
  assert.equal(parseTurnEventLine("\t\r\n ").ok, "blank");
  // Null/undefined reach here from a caller that split a Buffer badly.
  assert.equal(parseTurnEventLine(undefined).ok, "blank");
  assert.equal(parseTurnEventLine(null).ok, "blank");
});

test("a megabyte line parses whole; a megabyte of garbage is logged at 200 chars", async () => {
  const huge = "a".repeat(1_000_000);
  const parsed = parseTurnEventLine(encodeTurnEvent({ type: "done", content: huge }));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.event.content.length, 1_000_000, "no line-length cap on a VALID event");

  // A harness that dumps a stack trace to stdout must not put a megabyte into
  // whatever the caller logs — but onMalformed still sees all of it, because
  // that is the hook that has to identify the drift.
  const seenLines = [];
  const { result } = await feed([new TextEncoder().encode(`${"x".repeat(500_000)}\n`)], {
    onMalformed: (line) => seenLines.push(line),
  });
  assert.equal(result.malformed[0].line.length, 200, "the recorded line is capped");
  assert.equal(seenLines[0].length, 500_000, "the callback is not");
  assert.equal(result.malformedCount, 1);

  // Same shape for the number of lines: `malformed` is a sample, and a caller
  // that reports `malformed.length` as "how many lines the harness got wrong"
  // reports 8 for a harness that got 200 of them wrong.
  const flood = await feed([new TextEncoder().encode(`${Array.from({ length: 200 }, (_, i) => `log line ${i}`).join("\n")}\n`)]);
  assert.equal(flood.result.malformed.length, 8, "the recorded sample is capped");
  assert.equal(flood.result.malformedCount, 200, "the count is not");
  assert.equal(flood.result.counts.total, 0);
});

/* -------------------------------------------------------------- NDJSON framing */

// The producer writes `${JSON.stringify(event)}\n`, but nothing between the
// desk and the Worker guarantees the last byte survives: a proxy that trims, a
// socket closed on the newline. Dropping the tail loses the whole reply.
test("the last event still counts when the trailing newline never arrives", async () => {
  const line = encodeTurnEvent({ type: "done", content: "the whole reply" });
  const unterminated = line.slice(0, -1);
  assert.equal(unterminated.endsWith("\n"), false);

  const { seen, result } = await feed([new TextEncoder().encode(unterminated)]);
  assert.deepEqual(seen.map((e) => e.type), ["done"]);
  assert.equal(result.content, "the whole reply");
  assert.equal(result.malformedCount, 0);
  // The whole-body path has to agree, or the streaming and buffered clients
  // disagree about whether the same turn succeeded.
  assert.equal(decodeTurnEvents(unterminated).content, "the whole reply");
});

test("framing survives CRLF, blank lines, many lines per chunk and a split line", async () => {
  const events = [
    { type: "tool", name: "shell", args: { command: "ls" } },
    { type: "delta", text: "one" },
    { type: "done", content: "two" },
  ];
  // A stream written by something that thinks NDJSON means \r\n, with a blank
  // line between records (a keep-alive) and a leading blank.
  const wire = `\r\n${events.map((e) => `${JSON.stringify(e)}\r\n\r\n`).join("")}`;
  const bytes = new TextEncoder().encode(wire);

  // All of it in one chunk...
  const whole = await feed([bytes]);
  assert.deepEqual(whole.seen.map((e) => e.type), ["tool", "delta", "done"]);
  assert.equal(whole.result.content, "two");
  assert.equal(whole.result.malformedCount, 0, "\\r and blank lines are framing, not garbage");

  // ...and split at every single byte, which is what a real socket does.
  for (let cut = 0; cut <= bytes.length; cut++) {
    const { seen, result } = await feed([bytes.subarray(0, cut), bytes.subarray(cut)]);
    assert.deepEqual(seen.map((e) => e.type), ["tool", "delta", "done"], `lost an event at byte ${cut}`);
    assert.equal(result.content, "two", `wrong content at byte ${cut}`);
    assert.equal(result.malformedCount, 0, `malformed at byte ${cut}`);
  }

  // A lone "\n" arriving as its own chunk closes the line before it.
  const enc = new TextEncoder();
  const split = await feed([
    enc.encode('{"type":"delta","text":"a"}'),
    enc.encode("\n"),
    enc.encode('{"type":"done","content":"b"}\n'),
  ]);
  assert.equal(split.result.content, "b");
  assert.equal(split.result.counts.total, 2);
});

test("finish() is idempotent, and a push after it is loud", async () => {
  // Callers close the decoder in a `finally` AND on the happy path. The tail
  // must be consumed once, not twice — a double-counted `done` would double a
  // usage number that gets billed.
  const decoder = createTurnEventDecoder();
  await decoder.push(new TextEncoder().encode(encodeTurnEvent({ type: "done", content: "x" }).slice(0, -1)));
  const first = await decoder.finish();
  const second = await decoder.finish();
  assert.equal(first, second, "finish returns the same result object");
  assert.deepEqual(first.counts, { tool: 0, delta: 0, done: 1, error: 0, total: 1 });
  assert.equal(first.content, "x");
  await assert.rejects(() => decoder.push("more"), /already finished/);
});

test("a done whose content is only whitespace is still a done", async () => {
  // Both clients report "harness turn ended without a result" when content is
  // "". A model that legitimately replies with nothing produces exactly that
  // string, so the failure test is `done === null`, never `!content`.
  const { result } = await feed([new TextEncoder().encode(encodeTurnEvent({ type: "done", content: "   \n\t " }))]);
  assert.equal(result.content, "", "content is trimmed to nothing");
  assert.notEqual(result.done, null, "but the turn DID complete");
  assert.equal(result.done.content, "   \n\t ", "and the raw content is kept");
  assert.equal(result.counts.done, 1);
  assert.equal(result.error, null);

  // Contrast: a stream that really ended without a done.
  const { result: none } = await feed([new TextEncoder().encode(encodeTurnEvent({ type: "delta", text: "hi" }))]);
  assert.equal(none.content, "");
  assert.equal(none.done, null);
});

/* ------------------------------------------------------ /health: the full grid */

test("every ok x harness x mcp combination is pinned", () => {
  // Rows are [ok, harness, mcp, up, toolsState]. The invariant the grid
  // exists to hold: absent mcp is "unknown" on EVERY live row, and mcp is
  // never allowed to change `up`.
  const grid = [
    [true, true, undefined, true, "unknown"],
    [true, true, true, true, "up"],
    [true, true, false, true, "down"],
    [true, false, undefined, false, "down"],
    [true, false, true, false, "down"],
    [true, false, false, false, "down"],
    [false, true, undefined, false, "down"],
    [false, true, true, false, "down"],
    [false, true, false, false, "down"],
    [false, false, undefined, false, "down"],
    [false, false, true, false, "down"],
    [false, false, false, false, "down"],
  ];
  for (const [ok, harness, mcp, up, tools] of grid) {
    const body = mcp === undefined ? { ok, harness } : { ok, harness, mcp };
    const label = JSON.stringify(body);
    assert.equal(isHarnessHealth(body), true, `${label} is a well-formed health body`);
    assert.equal(harnessIsUp(body), up, `harnessIsUp ${label}`);
    assert.equal(harnessToolsState(body), tools, `harnessToolsState ${label}`);
    assert.equal(harnessHasTools(body), tools === "up", `harnessHasTools ${label}`);
    // grok never moves either verdict; only harnessCanTurn reads it.
    assert.equal(harnessIsUp({ ...body, grok: true }), up, `grok:true must not change up for ${label}`);
    assert.equal(harnessToolsState({ ...body, grok: false }), tools, `grok:false must not change tools for ${label}`);
    assert.equal(harnessCanTurn({ ...body, grok: true }), up, `harnessCanTurn ${label}`);
    assert.equal(harnessCanTurn({ ...body, grok: false }), false, `no grok, no turn: ${label}`);
  }
});

test("a body that is not a health teaches nothing — including the un-parsed one", () => {
  for (const body of [
    null,
    undefined,
    "",
    0,
    false,
    [],
    [{ ok: true, harness: true }],
    "not json",
    { ok: true },
    { harness: true },
    { ok: 1, harness: 1 },
    // The footgun: harnessIsUp does NOT parse. Handing it the response TEXT
    // instead of the parsed body benches a perfectly healthy desk.
    '{"ok":true,"harness":true,"grok":true}',
  ]) {
    const label = JSON.stringify(body) ?? "undefined";
    assert.equal(isHarnessHealth(body), false, `${label} must not validate`);
    assert.equal(harnessIsUp(body), false, `${label} is not up`);
    assert.equal(harnessCanTurn(body), false, `${label} cannot turn`);
    assert.equal(harnessToolsState(body), "unknown", `${label} says nothing about tools`);
    assert.equal(harnessHasTools(body), false, `${label} proves nothing about tools`);
  }
  // ...and that last one IS a healthy desk once it goes through the parser.
  assert.equal(harnessIsUp(parseHarnessHealth('{"ok":true,"harness":true,"grok":true}')), true);
  assert.equal(parseHarnessHealth(""), null);
  assert.equal(parseHarnessHealth(undefined), null);
  assert.equal(parseHarnessHealth("[]"), null);
});

// One bad field takes the WHOLE body down, and the two verdicts then move in
// opposite directions: liveness fails closed (bench it) while tools fails open
// (do not bench it). That asymmetry is deliberate — a body we cannot read must
// never be read as proof of tools — but it means a desk whose mcp-sub8 is
// provably dead stops reporting "down" the moment any other field drifts. Any
// new field added to HarnessHealth must therefore be OPTIONAL and permissive,
// or shipping it silently un-benches every broken desk in production.
test("one drifted field fails liveness CLOSED and tools OPEN", () => {
  const dead = { ok: true, harness: true, grok: true, mcp: false, tools: 0 };
  assert.equal(harnessToolsState(dead), "down", "a readable body reports the dead handshake");

  for (const drift of [{ grok: "true" }, { tools: "0" }, { tools: -1 }, { tools: Number.NaN }, { mcp: "false" }]) {
    const body = { ...dead, ...drift };
    const label = JSON.stringify(drift);
    assert.equal(isHarnessHealth(body), false, `${label} is drift`);
    assert.equal(harnessIsUp(body), false, `${label}: liveness fails closed`);
    assert.equal(
      harnessToolsState(body),
      "unknown",
      `${label}: tools fails OPEN — mcp:false no longer benches this desk`,
    );
    assert.equal(harnessHasTools(body), false, `${label}: still never proof`);
  }
  // Extra fields the client has not been taught are NOT drift: a harness may
  // add to the body without every consumer being redeployed first.
  const grown = { ...dead, mcpError: "spawn mcp-sub8 ENOENT", probedAt: 1756000000000 };
  assert.equal(isHarnessHealth(grown), true, "an added field must not invalidate the body");
  assert.equal(harnessToolsState(grown), "down");
  assert.deepEqual(parseHarnessHealth(JSON.stringify(grown)), grown);
});

test("isStopResponse is the /stop contract, and 0 stopped is a success", () => {
  assert.equal(isStopResponse({ ok: true, stopped: 0 }), true, "nothing was running, and that is fine");
  assert.equal(isStopResponse({ ok: false, stopped: 0 }), true);
  assert.equal(isStopResponse({ ok: true, stopped: "1" }), false);
  assert.equal(isStopResponse({ ok: true, stopped: Number.NaN }), false);
  assert.equal(isStopResponse({ stopped: 1 }), false);
  assert.equal(isStopResponse(null), false);
});

/* ------------------------------------------------ turn requests, harder cases */

// A record that is MISSING user_id or create_time is read by grok-build 1.0.5 as
// unsigned: it ignores key/refresh_token and the turn comes back "Not signed
// in", which downstream is indistinguishable from a model failure. That is why
// harness-client fills in a placeholder UUID and a now() timestamp rather than
// leaving either off (cloud/src/harness-client.ts, and the same two fields are
// marked "required by grok-build 1.0.5" in server/desk-harness/README.md).
test("a grok auth record is a keyed OIDC record with every field present", () => {
  const record = {
    auth_mode: "oidc",
    key: "xai-oauth-access-token",
    refresh_token: "xai-refresh",
    expires_at: "2026-08-25T12:00:00.000Z",
    oidc_issuer: "https://auth.x.ai",
    oidc_client_id: "b1a00492-073a-47ea-816f-4c329264a828",
    user_id: "00000000-0000-4000-8000-000000000001",
    create_time: "2026-08-25T11:00:00.000Z",
  };
  assert.equal(isGrokAuthRecord(record), true);

  for (const field of Object.keys(record)) {
    const missing = { ...record };
    delete missing[field];
    assert.equal(isGrokAuthRecord(missing), false, `a record without ${field} is not signed in`);
  }
  // `key` is the access token: a record carrying an empty one authenticates
  // nothing, so it is refused even though the field is there.
  assert.equal(isGrokAuthRecord({ ...record, key: "" }), false);
  // refresh_token genuinely may be empty — harness-client sends
  // String(row.refreshToken || "") — so demanding it would cry wolf.
  assert.equal(isGrokAuthRecord({ ...record, refresh_token: "" }), true);
  assert.equal(isGrokAuthRecord({ ...record, auth_mode: "oauth" }), false);

  // The FILE is keyed `${issuer}::${clientId}`. grok-build looks the record up
  // by that key, so a well-formed record under the wrong key is still nothing.
  const key = "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828";
  assert.equal(isGrokAuthFile({ [key]: record }), true);
  assert.equal(isGrokAuthFile({ "auth.x.ai": record }), false, "the :: separator is the lookup");
  assert.equal(isGrokAuthFile({}), false, "an empty file is not a signed-in file");
  assert.equal(isGrokAuthFile({ [key]: record, bad: record }), false, "one bad key spoils the file");

  const base = readJsonFixture("turn-request.json");
  const noRecord = { ...base, auth: { [key]: { ...record, oidc_issuer: undefined } } };
  assert.deepEqual(turnRequestProblems(noRecord), [
    "auth must be a grok auth.json keyed `${issuer}::${clientId}`",
  ]);
});

// UNPROVEN, deliberately not enforced: `isString` accepts "" for user_id and
// create_time, so a producer writing String(row.x || "") would emit a record
// this guard calls valid. Every source in this repo says grok-build 1.0.5
// requires the fields to be PRESENT — none of them says whether it tells ""
// apart from absent, and that is a claim about a third-party binary I did not
// run. Tightening on inference is the wrong risk: if grok-build accepts "", a
// tightened guard reports "not signed in" to a user who IS signed in, which is
// worse than the silent failure it would catch. Nothing in this repo builds
// such a record today (grokAuthUserId falls back to a placeholder UUID,
// grokAuthCreatedAt to now()), so the gap is currently unreachable. To settle
// it: write an auth.json with user_id:"" on a desk and run a grok turn.
test("a present-but-empty user_id or create_time is not signed in", { skip: true }, () => {
  const record = {
    auth_mode: "oidc",
    key: "xai-oauth-access-token",
    refresh_token: "xai-refresh",
    expires_at: "2026-08-25T12:00:00.000Z",
    oidc_issuer: "https://auth.x.ai",
    oidc_client_id: "b1a00492-073a-47ea-816f-4c329264a828",
    user_id: "00000000-0000-4000-8000-000000000001",
    create_time: "2026-08-25T11:00:00.000Z",
  };
  assert.equal(isGrokAuthRecord({ ...record, user_id: "" }), false);
  assert.equal(isGrokAuthRecord({ ...record, create_time: "" }), false);
});

test("every optional field may be omitted, one at a time", () => {
  // An older Worker sends fewer fields than today's. Each omission has to stay
  // valid on its own, or a deploy skew refuses turns that used to run.
  const base = readJsonFixture("turn-request.json");
  assert.deepEqual(turnRequestProblems(base), []);
  for (const field of ["history", "system", "display", "callback"]) {
    const trimmed = { ...base };
    delete trimmed[field];
    assert.deepEqual(turnRequestProblems(trimmed), [], `omitting ${field} must stay valid`);
  }
  // Down to the four fields that are genuinely required.
  const minimal = { botId: base.botId, content: base.content, provider: "xai", model: base.model };
  assert.deepEqual(turnRequestProblems({ ...minimal, model: { ...base.model, provider: "xai" } }), []);
  // ...and an explicit undefined is the same as absent, which is what
  // JSON.parse of a body that never had the key produces anyway.
  assert.deepEqual(turnRequestProblems({ ...base, system: undefined, callback: undefined }), []);
});

test("content may be empty, an id may not be blank, and display counts from 1", () => {
  const base = readJsonFixture("turn-request.json");
  // A wake-driven turn legitimately carries no user text. Tightening this to
  // non-empty would refuse every one of them.
  assert.deepEqual(turnRequestProblems({ ...base, content: "" }), []);
  assert.deepEqual(turnRequestProblems({ ...base, history: [] }), []);

  assert.deepEqual(turnRequestProblems({ ...base, botId: "   " }), ["botId must be a non-empty string"]);
  assert.deepEqual(turnRequestProblems({ ...base, content: null }), ["content must be a string"]);

  // display is an X display number: 0 is not one, and neither is "1".
  for (const [display, ok] of [[1, true], [2, true], [0, false], [-1, false], [1.5, false], ["1", false]]) {
    const problems = turnRequestProblems({ ...base, display });
    assert.equal(problems.length === 0, ok, `display ${JSON.stringify(display)}`);
    if (!ok) assert.deepEqual(problems, ["display must be an integer >= 1"]);
  }
});

test("an unset model.provider is not a disagreement", () => {
  // normalizeTurn prefers the top-level provider and falls back to the model's.
  // "" means "not stated", so it must not be reported as conflicting — but any
  // stated, different value must be, because the two select different CLIs.
  const base = readJsonFixture("turn-request-claude.json");
  assert.deepEqual(turnRequestProblems({ ...base, model: { ...base.model, provider: "" } }), []);
  assert.deepEqual(turnRequestProblems({ ...base, model: { ...base.model, provider: "claude-max" } }), [
    'model.provider "claude-max" disagrees with provider "claude"',
  ]);
  // A blank top-level provider is reported once, as missing — not twice.
  assert.deepEqual(turnRequestProblems({ ...base, provider: "  " }), [
    "provider must be a non-empty string",
    'model.provider "claude" disagrees with provider "  "',
  ]);
  assert.equal(isTurnRequest({ ...base, model: { ...base.model, provider: "" } }), true);
});
