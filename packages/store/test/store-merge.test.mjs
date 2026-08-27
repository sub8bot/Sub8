/**
 * unionMessages merge semantics. This lived in test/choice.mjs, which moved to
 * packages/choice — a store assertion that merely used a choice card as its
 * fixture. It then lived in test/store-merge.mjs; store is a package now, so it
 * lands here.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { unionMessages } from "../dist/index.js";

const open = {
  id: "ch1",
  kind: "choices",
  pending: true,
  content: "How should I sign in?",
  choices: [{ id: "pat", label: "GitHub PAT" }],
};

test("an answered choices card beats the still-open copy, whichever way round they merge", () => {
  // SSE can hand the client the still-open card after disk already has the
  // answered one. The answered copy has to win, or the widget reopens.
  const answered = { ...open, pending: false, selected: { id: "custom", label: "ghp_test" } };
  const staleOpen = { ...open, pending: true };
  const merged = unionMessages([staleOpen], [answered]);
  const card = merged.find((m) => m.id === "ch1");
  assert.equal(card.pending, false);
  assert.equal(card.selected.label, "ghp_test");
});

test("rows without an id are dropped and the union sorts by ts", () => {
  const merged = unionMessages(
    [{ id: "b", ts: 2 }, { ts: 3 }],
    [{ id: "a", ts: 1 }],
  );
  assert.deepEqual(
    merged.map((m) => m.id),
    ["a", "b"],
  );
});
