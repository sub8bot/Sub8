# @sub8/choice

The ask_user card: what `send_message` has to look like to become a widget, and
what happens when the human answers it.

Moved verbatim from `server/choice.mjs` (170 lines, zero internal imports). The
emitted JS is token-for-token the original.

## What is here

- **Building** — `choiceCard` and `cardFromSendMessageArgs`. One send_message
  call can arrive in several dialects (`type: "widget"` with a `widget` block, a
  bare `question` + `choices`, `type: "secret-request"` with a `secret` block);
  all of them land on the same card shape.
- **Ending the turn** — `shouldEndTurn`. A pending card means the Bot is waiting
  on a human, so the turn stops there rather than looping. `AWAITING_BLOCKED` is
  what the model is told if it tries to act anyway.
- **Resolving** — `resolveChoice`, `choiceLabel`. POST /choice is racy: the id
  the UI sends may not be on disk yet, and a double-Enter arrives twice. So a
  missing row falls back to the latest pending card, and a repeat of a pick that
  already landed returns `already: true` instead of "choice is not open".
- **Secrets** — `isSecretCard`, `visibleChoiceReply`. A credential typed into
  the secure field never reaches the transcript: what gets stored is the label
  `provided` and the sentence "Credential provided."

## What is deliberately NOT here

The vault. `secretTarget` names a connector and a field; `server/vault.mjs` is
what actually holds the value, and `server/index.mjs` routes it there.
