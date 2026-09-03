/** Resolve an ask_user / send_message widget the human just answered. */

import type {
  ChoiceBot,
  ChoiceCard,
  ChoiceCardArgs,
  ChoiceInput,
  ChoiceReply,
  ChoiceResolution,
  ChoiceRow,
  ResolveChoiceArgs,
  SecretSpec,
  SendMessageArgs,
  WidgetSpec,
} from "./types.js";

export const AWAITING_BLOCKED =
  "This turn is already waiting on the user (you sent a question widget or handed the computer back). Wait for their reply — it arrives as the next message.";

export function choiceCard({ bot, question, hint, choices, allowCustom = true, secret = false, dismissOnMoveOn = false }: ChoiceCardArgs): ChoiceCard {
  const opts = Array.isArray(choices) && choices.length
    ? choices.map((c: ChoiceInput, i) => ({
        id: String(c.id || c.value || String.fromCharCode(97 + i)),
        label: String(c.label || c.value || "").trim(),
      })).filter((c) => c.label)
    : [];
  return {
    id: `ch${Date.now()}${Math.random().toString(36).slice(2, 5)}`,
    role: "assistant",
    kind: secret ? "secret-request" : "choices",
    content: String(question || "What should we do?"),
    hint: String(hint || ""),
    choices: opts,
    allowCustom: secret ? true : allowCustom !== false,
    dismissOnMoveOn: Boolean(dismissOnMoveOn),
    pending: true,
    secret: secret || undefined,
    speakerId: bot?.id,
    speakerName: bot?.name,
    ts: Date.now(),
  };
}

export function cardFromSendMessageArgs(bot: ChoiceCardArgs["bot"], args: SendMessageArgs = {}): ChoiceCard | null {
  const type = String(args.type || "text").trim() || "text";
  // Secret first, widget second. send_message's schema offers `question` at the
  // top level next to `secret` and `type`, so a model asking for a credential
  // routinely fills BOTH (`{type:"secret-request", question:"Paste the PAT"}`).
  // With the widget arm first, `args.question` captured that call and built an
  // ordinary `kind:"choices"` card: no `secret`, no `secretTarget`, so
  // `visibleChoiceReply` reported `secret:false` and POST /choice wrote the
  // typed credential straight into the transcript and the next turn. The two
  // shapes can only be told apart by which arm wins, and only one direction is
  // safe to be wrong in — a widget rendered as a masked field is an annoyance,
  // a credential rendered as a plain field is a leak.
  if (type === "secret-request" || args.secret) {
    const s: SecretSpec = args.secret && typeof args.secret === "object" ? (args.secret as SecretSpec) : {};
    const card = choiceCard({
      bot,
      question: s.label || args.question || "Paste the credential",
      hint: s.description || "This stays out of chat.",
      choices: [],
      allowCustom: true,
      secret: true,
    });
    card.secretTarget = { connector: s.connector || "vault", field: s.field || "secret" };
    return card;
  }
  if (type === "widget" || args.widget || args.question) {
    const w: WidgetSpec = args.widget && typeof args.widget === "object" ? (args.widget as WidgetSpec) : {};
    const question = String(w.prompt || args.question || args.content || "").trim();
    const choices = w.options || args.choices || [];
    const hasChoices = Array.isArray(choices) && choices.length > 0;
    // A widget with NO question and NO options is not a real question — it used
    // to render a useless "What should we do?" card with an empty free-text box.
    // Answer null so the caller tells the model to ask something specific or
    // just continue, instead of stopping the turn on a blank prompt.
    if (!question && !hasChoices) return null;
    return choiceCard({
      bot,
      question: question || "What would you like?",
      hint: w.helpText || args.hint || "",
      choices,
      allowCustom: w.allowCustom ?? args.allow_custom,
      dismissOnMoveOn: w.dismissOnMoveOn,
    });
  }
  return null;
}

export function shouldEndTurn(card: ChoiceRow | null | undefined): boolean {
  return Boolean(card && (card.kind === "choices" || card.kind === "secret-request") && card.pending !== false);
}

/** Resolve an ask_user card the human just clicked or typed into. */

export function isChoiceCard(m: ChoiceRow | null | undefined): boolean {
  return Boolean(m && (m.kind === "choices" || m.kind === "secret-request" || Array.isArray(m.choices)));
}

export function isSecretCard(card: ChoiceRow | null | undefined): boolean {
  return Boolean(card?.kind === "secret-request" || card?.secret);
}

/** What goes on disk / in the next user turn. Never the typed secret. */
export function applyInternalEmit(bot: ChoiceBot | null | undefined, data: ChoiceRow | null | undefined): ChoiceBot | null | undefined {
  if (!bot || !data || typeof data !== "object") return bot;
  bot.messages = bot.messages || [];
  if (data.id && bot.messages.some((m) => m.id === data.id)) return bot;
  bot.messages.push(data);
  if (data.kind === "choices" || data.kind === "secret-request" || data.secret) {
    bot.awaitingUserSelection = true;
  }
  return bot;
}

export function visibleChoiceReply(card: ChoiceRow | null | undefined, label?: string): ChoiceReply {
  if (isSecretCard(card)) {
    return {
      secret: true,
      selectedLabel: "provided",
      userContent: "Credential provided.",
      nextTurn: "The user provided the credential in the secure field. It is not in this transcript.",
    };
  }
  const text = String(label || "").trim();
  return { secret: false, selectedLabel: text, userContent: text, nextTurn: text };
}

export function choiceLabel(card: ChoiceRow | null | undefined, choiceId?: string, custom?: string): string {
  const typed = String(custom || "").trim();
  if (typed) return typed;
  const picked = (card?.choices || []).find((c) => String(c.id) === String(choiceId || ""));
  return String(picked?.label || "").trim();
}

function samePick(card: ChoiceRow | null | undefined, choiceId: string | undefined, label: string): boolean {
  const sel = card?.selected;
  if (!sel) return false;
  if (label && String(sel.label || "") === String(label)) return true;
  if (choiceId && String(sel.id) === String(choiceId)) return true;
  return false;
}

/**
 * Find the card to close for POST /choice.
 * - Prefer the id the UI sent.
 * - If that row is missing (SSE showed it before disk caught up), use the latest pending card.
 * - If that row is already closed, treat a repeat of the same pick as success so a
 *   double-Enter / double-click does not alert "choice is not open".
 */
export function resolveChoice(messages: ChoiceRow[], { messageId, choiceId, custom }: ResolveChoiceArgs = {}): ChoiceResolution {
  const rows: ChoiceRow[] = Array.isArray(messages) ? messages : [];
  const id = String(messageId || "");
  const byId = id ? rows.find((m) => String(m.id) === id && isChoiceCard(m)) : null;
  const pending = [...rows].reverse().find((m) => isChoiceCard(m) && m.pending !== false);
  const card = byId || pending || null;
  const label = choiceLabel(card, choiceId, custom);

  if (byId && byId.pending === false) {
    return {
      ok: true,
      already: true,
      card: byId,
      label: byId.selected?.label || label,
      choiceId: byId.selected?.id || choiceId || "custom",
    };
  }

  if (!card) {
    if (label) {
      return { ok: true, missing: true, card: null, label, choiceId: choiceId || "custom" };
    }
    return { ok: false, error: "choice is not open" };
  }

  if (card.pending === false) {
    return {
      ok: true,
      already: true,
      card,
      label: card.selected?.label || label,
      choiceId: card.selected?.id || choiceId || "custom",
    };
  }

  if (!label) return { ok: false, error: "pick an option or type one" };
  if (/i'?ll describe/i.test(label) && !String(custom || "").trim()) {
    return { ok: false, error: "type what this Bot should do" };
  }

  return {
    ok: true,
    card,
    label,
    choiceId: String(custom || "").trim() ? "custom" : choiceId || "custom",
    already: samePick(card, choiceId, label),
    missing: false,
  };
}
