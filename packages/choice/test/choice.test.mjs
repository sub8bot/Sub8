import test from "node:test";
import assert from "node:assert/strict";
import {
  AWAITING_BLOCKED,
  applyInternalEmit,
  cardFromSendMessageArgs,
  choiceCard,
  choiceLabel,
  isChoiceCard,
  isSecretCard,
  resolveChoice,
  shouldEndTurn,
  visibleChoiceReply,
} from "../dist/index.js";

const open = {
  id: "ch1",
  kind: "choices",
  pending: true,
  content: "How should I sign in?",
  choices: [
    { id: "takecontrol", label: "Take control" },
    { id: "vault", label: "Use the vault" },
    { id: "pat", label: "GitHub PAT" },
  ],
};

test("isChoiceCard and choiceLabel read the card the UI rendered", () => {
  assert.equal(isChoiceCard(open), true);
  assert.equal(choiceLabel(open, "pat", ""), "GitHub PAT");
  assert.equal(choiceLabel(open, "pat", "ghp_test"), "ghp_test");
});

test("an open card resolves by the id the UI sent", () => {
  const r = resolveChoice([open], { messageId: "ch1", choiceId: "pat" });
  assert.equal(r.ok, true);
  assert.equal(r.already, false);
  assert.equal(r.card.id, "ch1");
  assert.equal(r.label, "GitHub PAT");
});

test("a typed answer wins over the clicked option", () => {
  const r = resolveChoice([open], { messageId: "ch1", choiceId: "custom", custom: "ghp_test" });
  assert.equal(r.ok, true);
  assert.equal(r.label, "ghp_test");
  assert.equal(r.choiceId, "custom");
});

test("a repeat of the same pick on a closed card is success, not an error", () => {
  const closed = { ...open, pending: false, selected: { id: "custom", label: "ghp_test" } };
  const r = resolveChoice([closed], { messageId: "ch1", choiceId: "custom", custom: "ghp_test" });
  assert.equal(r.ok, true);
  assert.equal(r.already, true);
  assert.equal(r.label, "ghp_test");
});

test("a stale messageId falls back to the latest pending card", () => {
  const r = resolveChoice([open], { messageId: "stale-from-sse", choiceId: "pat" });
  assert.equal(r.ok, true);
  assert.equal(r.card.id, "ch1");
  assert.equal(r.label, "GitHub PAT");
});

test("an answer with no card left still goes through, marked missing", () => {
  const r = resolveChoice([], { messageId: "ch1", choiceId: "custom", custom: "still send this" });
  assert.equal(r.ok, true);
  assert.equal(r.missing, true);
  assert.equal(r.label, "still send this");
});

test("no card and no label is the only hard failure", () => {
  const r = resolveChoice([], { messageId: "ch1", choiceId: "pat" });
  assert.equal(r.ok, false);
  assert.equal(r.error, "choice is not open");
});

test("a choiceId that matches nothing asks the human to pick again", () => {
  const r = resolveChoice([open], { messageId: "ch1", choiceId: "nope" });
  assert.equal(r.ok, false);
  assert.match(r.error, /pick an option/);
});

test("send_message type=widget builds a pending choices card that ends the turn", () => {
  const card = cardFromSendMessageArgs({ id: "b1", name: "Bot" }, {
    type: "widget",
    widget: { prompt: "Ship it?", options: [{ label: "Yes", value: "yes" }, { label: "No" }], allowCustom: true },
  });
  assert.equal(card.kind, "choices");
  assert.equal(card.pending, true);
  assert.equal(card.content, "Ship it?");
  assert.equal(shouldEndTurn(card), true);
});
test("a secret-request card keeps the credential out of the transcript", () => {
  const card = cardFromSendMessageArgs({ id: "b1" }, { type: "secret-request", secret: { label: "GitHub PAT", connector: "vault", field: "password" } });
  assert.equal(card.kind, "secret-request");
  assert.equal(card.secretTarget.connector, "vault");
  assert.equal(isChoiceCard(card), true);
  const shown = visibleChoiceReply(card, "ghp_liveSecretShouldNeverLand");
  assert.equal(shown.secret, true);
  assert.equal(shown.selectedLabel, "provided");
  assert.equal(shown.userContent, "Credential provided.");
  assert.match(shown.nextTurn, /not in this transcript/i);
  assert.equal(JSON.stringify(shown).includes("ghp_"), false);
  const convo = [{ ...card, pending: false, selected: { id: "custom", label: shown.selectedLabel } }, { role: "user", content: shown.userContent }];
  assert.equal(JSON.stringify(convo).includes("ghp_"), false);
});
test("a widget spelled as question + choices is still a choices card", () => {
  const card = cardFromSendMessageArgs({ id: "b1", name: "Bot" }, {
    type: "widget",
    question: "What should this one do?",
    choices: [{ id: "a", label: "X / notifications" }],
  });
  assert.equal(shouldEndTurn(card), true);
  assert.equal(card.kind, "choices");
});

test("applyInternalEmit dedupes by id and latches awaitingUserSelection", () => {
  const bot = { messages: [] };
  applyInternalEmit(bot, { role: "assistant", kind: "choices", content: "Ship?", pending: true, id: "ch-new" });
  assert.equal(bot.awaitingUserSelection, true);
  assert.equal(bot.messages.length, 1);
  applyInternalEmit(bot, { role: "assistant", kind: "choices", content: "Ship?", pending: true, id: "ch-new" });
  assert.equal(bot.messages.length, 1, "dedupe by id");
  const secretBot = { messages: [] };
  applyInternalEmit(secretBot, { role: "assistant", kind: "secret-request", content: "PAT", pending: true });
  assert.equal(secretBot.awaitingUserSelection, true);
  applyInternalEmit(secretBot, { role: "assistant", content: "plain" });
  assert.equal(secretBot.awaitingUserSelection, true, "plain text does not clear wait");
});

// ---------------------------------------------------------------------------
// A credential ask that also carries `question`
// ---------------------------------------------------------------------------

test("a secret-request that also fills `question` still builds a MASKED card", () => {
  // send_message's inputSchema offers `type`, `question` and `secret` side by
  // side, and `question` is the only question-shaped field in it — so a model
  // told "type=secret-request masked credential" fills `question` with the
  // prompt and leaves `secret` off. Before the arms were reordered that landed
  // in the widget arm and produced kind:"choices" with no `secret` and no
  // `secretTarget`, i.e. an ordinary text field, and everything downstream
  // treats the answer as ordinary text.
  const card = cardFromSendMessageArgs({ id: "b1", name: "Bot" }, {
    type: "secret-request",
    question: "Paste the GitHub PAT",
  });
  assert.equal(card.kind, "secret-request");
  assert.equal(card.secret, true);
  assert.equal(card.content, "Paste the GitHub PAT");
  assert.deepEqual(card.secretTarget, { connector: "vault", field: "secret" });
  assert.equal(isSecretCard(card), true);
  const shown = visibleChoiceReply(card, "ghp_liveSecretShouldNeverLand");
  assert.equal(shown.secret, true);
  assert.equal(JSON.stringify(shown).includes("ghp_"), false);
});

test("a `secret` block wins over a `question` written beside it", () => {
  // The other spelling of the same call: no `type`, but a real secret block.
  // `args.question` used to capture it first, so the connector/field the caller
  // named were dropped and the credential was never routed to the vault.
  const card = cardFromSendMessageArgs({ id: "b1" }, {
    question: "Paste the deploy key",
    secret: { connector: "vault", field: "password" },
  });
  assert.equal(card.kind, "secret-request");
  assert.deepEqual(card.secretTarget, { connector: "vault", field: "password" });
  assert.equal(card.content, "Paste the deploy key");
  assert.equal(visibleChoiceReply(card, "ssh-ed25519 AAAA").userContent, "Credential provided.");
});

test("an ordinary widget is untouched by the secret arm running first", () => {
  // The reorder must only move secret-shaped calls. A widget with no `secret`
  // key at all still takes the widget arm, whichever way `type` is spelled.
  for (const args of [
    { type: "widget", widget: { prompt: "Ship it?", options: [{ id: "y", label: "Yes" }] } },
    { type: "widget", question: "Ship it?", choices: [{ id: "y", label: "Yes" }] },
    { question: "Ship it?", choices: [{ id: "y", label: "Yes" }] },
  ]) {
    const card = cardFromSendMessageArgs({ id: "b1" }, args);
    assert.equal(card.kind, "choices", JSON.stringify(args));
    assert.equal(card.secret, undefined, JSON.stringify(args));
    assert.equal(card.secretTarget, undefined, JSON.stringify(args));
  }
});

test("a masked card always takes a typed answer, whatever allow_custom said", () => {
  // A secret card with allowCustom:false would be unanswerable — the typed
  // field IS the card. Two layers hold that: the secret arm never forwards
  // allow_custom, and choiceCard forces it back on for any secret card.
  const card = cardFromSendMessageArgs({ id: "b1" }, { type: "secret-request", secret: {}, allow_custom: false });
  assert.equal(card.allowCustom, true);
  assert.equal(card.kind, "secret-request");
  assert.equal(choiceCard({ bot: { id: "b1" }, question: "PAT", choices: [], allowCustom: false, secret: true }).allowCustom, true);
  // The same argument on an ordinary card is honoured, so the force is aimed.
  assert.equal(choiceCard({ bot: { id: "b1" }, question: "Q", choices: [{ id: "y", label: "Yes" }], allowCustom: false }).allowCustom, false);
});

// ---------------------------------------------------------------------------
// What send_message drops on the way into a card
// ---------------------------------------------------------------------------

test("`content` is dropped whenever the same call also names a question", () => {
  // `w.prompt || args.question || args.content` — content is third. A card is
  // the WHOLE reply (the plain-text arm below it never runs), so the prose the
  // model wrote is not shown anywhere: the user sees "Which one?" and never the
  // three flights it refers to. Pinned as-is; giving content a home means
  // emitting two rows, which is a change at the three call sites, not here.
  const dropped = cardFromSendMessageArgs({ id: "b1" }, {
    type: "widget",
    content: "I found 3 flights: SFO 07:10, SFO 11:45, SFO 18:20.",
    question: "Which one?",
  });
  assert.equal(dropped.content, "Which one?");
  assert.equal(JSON.stringify(dropped).includes("SFO"), false, "the prose has nowhere to go");
  // When it is the only text it is used, which is why the fallback exists.
  const kept = cardFromSendMessageArgs({ id: "b1" }, { type: "widget", content: "Only text" });
  assert.equal(kept.content, "Only text");
  // And with nothing at all there is no card: an empty widget is not a question
  // (the handler tells the model to ask something specific or just continue).
  assert.equal(cardFromSendMessageArgs({ id: "b1" }, { type: "widget" }), null);
});

test("choices without a question are not a card at all — the buttons vanish", () => {
  // Nothing in the trigger reads `args.choices`, so `send_message({content,
  // choices})` returns null and the call sites fall through to a plain text
  // bubble. The options the model offered are silently gone.
  const card = cardFromSendMessageArgs({ id: "b1" }, {
    content: "Pick one",
    choices: [{ id: "a", label: "Yes" }, { id: "b", label: "No" }],
  });
  assert.equal(card, null);
  assert.equal(shouldEndTurn(card), false);
});

test("choices given as bare strings all drop out, leaving a card nobody can answer", () => {
  // The schema says items are objects, but a model that writes ["Yes","No"]
  // gets `c.label`/`c.value` undefined on every entry, so the .filter drops
  // them all. Pair that with allow_custom:false and the card has no buttons AND
  // no text field — yet it is `pending` and ends the turn, so the bot is left
  // waiting on an answer the UI cannot collect.
  const card = cardFromSendMessageArgs({ id: "b1" }, { question: "Yes or no?", choices: ["Yes", "No"], allow_custom: false });
  assert.deepEqual(card.choices, []);
  assert.equal(card.allowCustom, false);
  assert.equal(card.pending, true);
  assert.equal(shouldEndTurn(card), true);
  // ...and there is no answer that resolves it.
  assert.equal(resolveChoice([card], { messageId: card.id, choiceId: "Yes" }).ok, false);
  assert.equal(resolveChoice([card], { messageId: card.id }).ok, false);
});

test("two choices sharing an id make the second one unreachable", () => {
  // choiceCard takes `c.id` verbatim and never checks it is unique, and
  // choiceLabel resolves with .find — first match wins. The user clicks "No"
  // and the transcript records "Yes".
  const card = cardFromSendMessageArgs({ id: "b1" }, {
    question: "Ship it?",
    choices: [{ id: "a", label: "Yes" }, { id: "a", label: "No" }],
  });
  assert.deepEqual(card.choices, [{ id: "a", label: "Yes" }, { id: "a", label: "No" }]);
  assert.equal(choiceLabel(card, "a"), "Yes");
  assert.equal(resolveChoice([card], { messageId: card.id, choiceId: "a" }).label, "Yes");
});

// ---------------------------------------------------------------------------
// resolveChoice: answered twice, never offered, typed when typing was off
// ---------------------------------------------------------------------------

test("a second, different pick on a closed card reports the FIRST pick", () => {
  // POST /choice returns early on `already` — no user row, no turn — so this is
  // how a changed mind is swallowed rather than mis-sent. The label handed back
  // is the one already on the card, not the one just clicked.
  const closed = {
    id: "ch1",
    kind: "choices",
    pending: false,
    selected: { id: "yes", label: "Yes" },
    choices: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }],
  };
  const r = resolveChoice([closed], { messageId: "ch1", choiceId: "no" });
  assert.equal(r.ok, true);
  assert.equal(r.already, true);
  assert.equal(r.label, "Yes", "the first answer, not the second");
  assert.equal(r.choiceId, "yes");
});

test("`already` is not asserted for an open card the user is answering twice fast", () => {
  // samePick only reads `card.selected`, which an open card has not got, so two
  // in-flight clicks both come back already:false and both run a turn. That is
  // the double-send the closed-card branch above exists to stop — it only stops
  // it once the first click has landed on disk.
  const open2 = { id: "ch2", kind: "choices", pending: true, choices: [{ id: "y", label: "Yes" }] };
  const first = resolveChoice([open2], { messageId: "ch2", choiceId: "y" });
  const second = resolveChoice([open2], { messageId: "ch2", choiceId: "y" });
  assert.equal(first.already, false);
  assert.equal(second.already, false);
  // It is only `selected` that turns it on, even while `pending` is still true.
  const half = { ...open2, selected: { id: "y", label: "Yes" } };
  assert.equal(resolveChoice([half], { messageId: "ch2", choiceId: "y" }).already, true);
});

test("allowCustom is a UI hint — resolveChoice takes a typed answer anyway", () => {
  // Nothing in the resolver reads card.allowCustom, so a POST /choice body with
  // `custom` resolves a card that offered no text field. Worth knowing before
  // treating allow_custom:false as a constraint on what can come back.
  const card = cardFromSendMessageArgs({ id: "b1" }, {
    question: "Ship it?",
    choices: [{ id: "y", label: "Yes" }],
    allow_custom: false,
  });
  assert.equal(card.allowCustom, false);
  const r = resolveChoice([card], { messageId: card.id, custom: "actually, roll back" });
  assert.equal(r.ok, true);
  assert.equal(r.label, "actually, roll back");
  assert.equal(r.choiceId, "custom");
});

test("any row carrying a choices array is treated as an open card", () => {
  // isChoiceCard falls back to Array.isArray(m.choices) and pending defaults to
  // open, so a plain assistant row that happens to carry `choices: []` becomes
  // the fallback target for an answer whose real card is gone — and the caller
  // then stamps pending/selected onto a message that was never a card.
  const plain = { id: "m1", role: "assistant", content: "here you go", choices: [] };
  assert.equal(isChoiceCard(plain), true);
  const r = resolveChoice([plain], { messageId: "a-card-that-is-gone", custom: "yes" });
  assert.equal(r.ok, true);
  assert.equal(r.missing, false, "it found a card rather than reporting the real one missing");
  assert.equal(r.card.id, "m1");
});

test("an option labelled \"I'll describe it\" is refused until something is typed", () => {
  const card = { id: "d1", kind: "choices", pending: true, choices: [{ id: "own", label: "I'll describe it myself" }] };
  const clicked = resolveChoice([card], { messageId: "d1", choiceId: "own" });
  assert.equal(clicked.ok, false);
  assert.match(clicked.error, /type what this Bot should do/);
  // Typing it is fine — the typed text replaces the label before the guard runs.
  const typed = resolveChoice([card], { messageId: "d1", choiceId: "own", custom: "I'll describe it now: watch the inbox" });
  assert.equal(typed.ok, true);
  assert.match(typed.label, /watch the inbox/);
});

test("a lost card downgrades a credential to plain text", () => {
  // visibleChoiceReply decides secrecy from the CARD, and resolveChoice's
  // `missing` arm hands back `card: null` with the raw answer as the label. So
  // if the secret-request row is gone (message deleted, or a UI that kept a
  // stale id) POST /choice writes the typed credential into the transcript as a
  // user message and feeds it to the next turn — the one thing the masked field
  // exists to prevent. Pinned as-is: the missing arm has nothing left to read
  // the card's kind off, so the fix belongs at the route, which still knows.
  const r = resolveChoice([], { messageId: "gone", custom: "ghp_liveSecretShouldNeverLand" });
  assert.equal(r.ok, true);
  assert.equal(r.missing, true);
  assert.equal(r.card, null);
  const shown = visibleChoiceReply(r.card, r.label);
  assert.equal(shown.secret, false);
  assert.equal(shown.userContent, "ghp_liveSecretShouldNeverLand");
  assert.equal(shown.nextTurn, "ghp_liveSecretShouldNeverLand");
});
// ---------------------------------------------------------------------------
// awaitingUserSelection: the gate that ends a turn on a card
// ---------------------------------------------------------------------------

/**
 * The three send_message call sites (server/agent.mts, server/mcp-sub8.mts and
 * the ask_user arms of both) are the same four lines: block on the flag, build
 * the card, push the row, latch the flag. applyInternalEmit is the packaged
 * form of the last two — it is what POST /api/internal/emit runs when the
 * out-of-process MCP server reports a card.
 */
function sendMessage(bot, args) {
  if (bot.awaitingUserSelection) return { blocked: true, text: AWAITING_BLOCKED };
  const card = cardFromSendMessageArgs(bot, args);
  if (card) {
    applyInternalEmit(bot, card);
    return { blocked: false, text: "asked the user; wait for their pick in chat", card };
  }
  return { blocked: false, text: "sent", content: String(args.content || "") };
}

test("once a card is up, the rest of the turn has no voice at all", () => {
  // The gate sits ABOVE the card check, so a turn that asked a question cannot
  // then narrate, ack, or ask a second thing — the point being that the turn
  // stops and the human's pick arrives as the next message. Worth pinning
  // because "send_message is your only voice" makes the blast radius of the
  // latch the whole turn, not just further widgets.
  const bot = { id: "b1", name: "Bot", messages: [] };
  const asked = sendMessage(bot, { type: "widget", question: "Ship it?", choices: [{ id: "y", label: "Yes" }] });
  assert.equal(asked.blocked, false);
  assert.equal(bot.awaitingUserSelection, true);
  assert.equal(sendMessage(bot, { content: "Booked seat 14C." }).text, AWAITING_BLOCKED);
  assert.equal(sendMessage(bot, { type: "widget", question: "Which seat?" }).text, AWAITING_BLOCKED);

  // Resolving is pure: it reads the rows and reports a verdict, it never writes
  // the bot — so whoever answers the card is the one that lowers the flag, and
  // every caller in the tree does it with its own assignment.
  const answered = resolveChoice(bot.messages, { messageId: asked.card.id, choiceId: "y" });
  assert.equal(answered.ok, true);
  assert.equal(answered.label, "Yes");
  assert.equal(bot.awaitingUserSelection, true, "resolveChoice does not touch the bot");

  // Replaying rows through the one ingress this package gives an out-of-process
  // desk never lowers it either — applyInternalEmit only ever latches.
  for (const row of [
    { ...asked.card, pending: false, selected: { id: "y", label: "Yes" } },
    { id: "u1", role: "user", content: "Yes" },
    { id: "a1", role: "assistant", content: "Booked." },
  ]) {
    applyInternalEmit(bot, row);
    assert.equal(bot.awaitingUserSelection, true, `${row.id} must not clear the latch`);
  }

  bot.awaitingUserSelection = false;
  assert.equal(sendMessage(bot, { content: "Booked seat 14C." }).text, "sent");
});

test("a card is latched by its kind, and a `secret: true` row latches without one", () => {
  // The latch fires on kind OR a bare `secret` flag, which is how the two
  // secret spellings both end the turn. A row with neither never latches, so a
  // card whose `kind` was lost in transit is shown to the user without the turn
  // ever stopping for it.
  const kinds = { messages: [] };
  applyInternalEmit(kinds, { id: "k1", role: "assistant", kind: "choices", choices: [] });
  assert.equal(kinds.awaitingUserSelection, true);

  const bare = { messages: [] };
  applyInternalEmit(bare, { id: "k2", role: "assistant", secret: true });
  assert.equal(bare.awaitingUserSelection, true);

  const lost = { messages: [] };
  applyInternalEmit(lost, { id: "k3", role: "assistant", content: "Ship it?", choices: [{ id: "y", label: "Yes" }] });
  assert.equal(lost.awaitingUserSelection, undefined, "a card with no kind renders but never stops the turn");
  // ...and it is still a card to the resolver, so the answer lands on a turn
  // that already moved on.
  assert.equal(isChoiceCard(lost.messages[0]), true);
  assert.equal(shouldEndTurn(lost.messages[0]), false);
});

test("choiceCard fills ids from value, then position, and drops labelless options", () => {
  const card = choiceCard({
    bot: { id: "b1", name: "Bot" },
    question: "Pick",
    choices: [{ value: "yes", label: "Yes" }, { label: "No" }, { id: "z" }, { value: "maybe" }],
  });
  // `{id:"z"}` has no label and no value, so it is dropped — but the ids of the
  // options AROUND it are assigned from the pre-filter index, so they do not
  // renumber and stay stable across a dropped entry.
  assert.deepEqual(card.choices, [
    { id: "yes", label: "Yes" },
    { id: "b", label: "No" },
    { id: "maybe", label: "maybe" },
  ]);
  assert.equal(choiceLabel(card, "b"), "No");
  assert.equal(choiceLabel(card, "c"), "", "the dropped option answers nothing");
});
