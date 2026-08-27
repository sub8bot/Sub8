import assert from "node:assert/strict";
import { cardFromSendMessageArgs, visibleChoiceReply } from "@sub8/choice";

/** Golden #3: PAT / secret-request never written to conversation JSON. */
export async function run() {
  const card = cardFromSendMessageArgs(
    { id: "bot-1", name: "Bot" },
    { type: "secret-request", secret: { label: "GitHub PAT", connector: "vault", field: "password" } },
  );
  const shown = visibleChoiceReply(card, "ghp_shouldNotPersistInChat");
  const conversation = [
    { ...card, pending: false, selected: { id: "custom", label: shown.selectedLabel } },
    { id: "u1", role: "user", content: shown.userContent, ts: 1 },
  ];
  const dumped = JSON.stringify(conversation);
  assert.equal(dumped.includes("ghp_"), false);
  assert.equal(dumped.includes("shouldNotPersistInChat"), false);
  assert.match(dumped, /Credential provided/);
}
