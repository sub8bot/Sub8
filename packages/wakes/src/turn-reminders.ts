/** 0.18-style SendMessage reminders. Hidden user lines; not shown as chat bubbles. */

import type { Reminder, ReminderKind, ReminderOptions, ReminderRow, TurnMessage } from "./types.js";

export const ACK_THRESHOLD = 1;
export const SEND_THRESHOLD = 6;

export const ACK_REMINDER =
  "You opened this turn by calling tools without first acknowledging the user. Invoke send_message type=text with a one-line ack RIGHT NOW, then continue. Plain assistant text is never shown.";

export const DELIVERY_REMINDER =
  "You have made several tool calls without send_message. The user is watching silence. Invoke send_message now with a brief update or the result. Ack ≠ delivery.";

function isSend(m: TurnMessage): boolean {
  if (!m) return false;
  if (m.kind === "choices" || m.kind === "secret-request") return true;
  if (m.role === "assistant" && m.kind !== "tool" && m.kind !== "think" && String(m.content || "").trim()) return true;
  return m.name === "send_message";
}

function isTool(m: TurnMessage): boolean {
  return m && (m.kind === "tool" || m.role === "activity" || m.name === "computer" || m.name === "shell" || m.name === "browser");
}

export function countToolsSinceSendMessage(messages: TurnMessage[] = []): number {
  let n = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (!m || m.hidden) continue;
    if (m.role === "user" && !m.hidden) break;
    if (isSend(m)) break;
    if (isTool(m)) n += 1;
  }
  return n;
}

export function hasTextSendThisTurn(messages: TurnMessage[] = []): boolean {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (!m) continue;
    if (m.role === "user" && !m.hidden && !m.reminder) return false;
    if (isSend(m) && m.kind !== "choices") return true;
  }
  return false;
}

export function needsAckReminder(messages: TurnMessage[] = [], { hidden = false }: ReminderOptions = {}): boolean {
  if (hidden) return false;
  if (hasTextSendThisTurn(messages)) return false;
  return countToolsSinceSendMessage(messages) >= ACK_THRESHOLD;
}

export function needsDeliveryReminder(messages: TurnMessage[] = [], { hidden = false }: ReminderOptions = {}): boolean {
  if (hidden) return false;
  return countToolsSinceSendMessage(messages) > SEND_THRESHOLD;
}

export function reminderFor(messages: TurnMessage[], opts: ReminderOptions = {}): Reminder | null {
  if (needsDeliveryReminder(messages, opts)) return { kind: "delivery", content: DELIVERY_REMINDER };
  if (needsAckReminder(messages, opts)) return { kind: "ack", content: ACK_REMINDER };
  return null;
}

export function reminderMessage(kind: ReminderKind): ReminderRow {
  const content = kind === "delivery" ? DELIVERY_REMINDER : ACK_REMINDER;
  return {
    id: `rem${Date.now()}${kind}`,
    role: "user",
    content,
    hidden: true,
    reminder: true,
    ts: Date.now(),
  };
}
