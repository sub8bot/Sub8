import { getChannel } from "@sub8/store/channels";
import { enqueueWake } from "@sub8/wakes";

/** What a dispatch fans out to: one room, or one peer bot. */
export type SendToAgentResult =
  | { ok: true; queued: number; type: "channel"; channelId: string }
  | { ok: true; queued: number; type: "peer"; botId: string };

/** The slice of a stored chat row `isFollowUpDispatch` reads. */
export interface DispatchMessage {
  role?: string | undefined;
  speakerRole?: string | undefined;
}

/** The named arguments `wrapWorkerDispatch` accepts. */
export interface WorkerDispatch {
  who?: unknown;
  role?: unknown;
  text?: unknown;
  followUp?: boolean | undefined;
}

/** Spec SendToAgent is not the old 240-char team ping. Truncate only at this cap. */
export const SEND_TO_AGENT_MAX = 8000;

export function sendToAgentContent(raw: unknown): string {
  return String(raw ?? "").trim().slice(0, SEND_TO_AGENT_MAX);
}

/** Pure helpers for team dispatch. Kept out of index.mjs so tests can import them. */

function normId(value: unknown): string {
  return String(value ?? "").trim();
}

function idsEqual(a: unknown, b: unknown): boolean {
  return normId(a).toLowerCase() === normId(b).toLowerCase();
}

/**
 * SendToAgent / message_teammate: fire-and-forget. Enqueues a peer wake
 * (bot UUID) or channel fan-in wakes (every member except sender). Does not
 * wait for a reply.
 */
export async function sendToAgent(fromId: unknown, targetId: unknown, content: unknown): Promise<SendToAgentResult> {
  const from = normId(fromId);
  const target = normId(targetId);
  const text = sendToAgentContent(content);
  if (!from) throw new Error("fromId required");
  if (!target) throw new Error("targetId required");
  if (!text) throw new Error("content required");

  const channel = await getChannel(target);
  const memberIds = channel?.memberIds || channel?.group?.memberIds;
  if (channel && Array.isArray(memberIds)) {
    const recipients = memberIds.filter((id) => !idsEqual(id, from));
    for (const botId of recipients) {
      enqueueWake({
        type: "channel",
        botId,
        payload: { fromId: from, channelId: channel.id, content: text },
      });
    }
    return { ok: true, queued: recipients.length, type: "channel", channelId: channel.id };
  }

  enqueueWake({
    type: "peer",
    botId: target,
    payload: { fromId: from, content: text },
  });
  return { ok: true, queued: 1, type: "peer", botId: target };
}

export const messageTeammate = sendToAgent;

export function isFollowUpDispatch(messages: readonly (DispatchMessage | null | undefined)[] | null = []): boolean {
  return (messages || []).some(
    (m) => m?.speakerRole === "chief" && (m.role === "user" || m.role === "assistant"),
  );
}

export function storedChiefToWorker(who: unknown, text: unknown): string {
  const name = String(who || "Chief").trim() || "Chief";
  return `${name}: ${String(text || "").trim()}`;
}

/**
 * What a worker is handed when the lead sends it something. Message-centric:
 * the worker just does the thing and ANSWERS. Its final reply is delivered to
 * the lead and posted in the team channel automatically — no update_task /
 * message_teammate ceremony required (a plain "say hello" has no task, and
 * demanding one is how a worker ends up answering "Ready for assignment").
 * Job tools stay available for real tracked work; they are not the report path.
 */
export function wrapWorkerDispatch({ who, role, text, followUp = false }: WorkerDispatch = {}): string {
  const name = String(who || "a teammate").trim() || "a teammate";
  const r = String(role || "teammate").trim() || "teammate";
  const body = String(text || "").trim();
  if (followUp) {
    return `${name} (${r}, your lead) sent a follow-up. Use YOUR screen. Do not restart work you already finished unless they said the last result was wrong or blocked.

${body}

Reply with your answer in one short message — it is delivered to ${name} and shown in the team channel automatically. If you already gave this answer, say so in one line. Then stop.`;
  }
  return `${name} (${r}, your lead) asked you to do this:

${body}

If this needs no computer — a greeting, a question, something you can simply say — answer it directly in one short message and do NOT take a screenshot or touch the screen. Only if it truly needs the computer, use YOUR screen (your DISPLAY / Chrome), not theirs.
Either way your final message must BE the answer itself: it is delivered to ${name} and shown in the team channel automatically. So never reply with a status like "message sent", "notified ${name}", or "standing by" — reply with the answer (for "say hello", the answer is hello). If there is a tracked job step assigned to you, update_task when its status actually changes. Then stop.`;
}

export function chiefReportStored(fromName: unknown, short: unknown): string {
  const name = String(fromName || "Teammate").trim() || "Teammate";
  return `${name} replies: ${String(short || "").trim()}`;
}

/** Extra flags `chiefReportLlm` accepts. */
export interface ChiefReportOpts {
  followUp?: boolean | undefined;
  /** What the lead asked this teammate (the delegation text), so the report is
   * self-contained — a CLI harness does not reliably remember the prior turn. */
  asked?: string | undefined;
  /** The user's request that led to that delegation. */
  userAsk?: string | undefined;
  /** Everything the lead has already handed out for that request ("Pixel: Say a
   * random number"), so it never hands the same thing out twice while waiting. */
  handed?: readonly string[] | undefined;
  /** Several teammates answered: all of their replies, delivered together once
   * the whole delegation set is complete. */
  replies?: readonly { name: string; text: string }[] | undefined;
}

/**
 * The lead's "nothing to add" result. A harness always wants to end a turn
 * with one send_message; without an outlet it invents "standing by" /
 * "waiting for your ask". The lead sends exactly this instead and the server
 * drops it — the user never sees it. The model decides; this is only the
 * protocol token, tolerant of markdown/case.
 */
export const SILENT = "__SILENT__";
export function isSilentReply(text: unknown): boolean {
  const t = String(text || "").trim();
  if (!t || t.length > 20) return false;
  return t.replace(/[*_`~\s.]/g, "").toUpperCase() === "SILENT";
}

/**
 * What the lead is handed when a worker answers. The user ALREADY sees the
 * worker's reply in the team channel, so the lead speaks only to add something:
 * the combined answer when several workers were asked, or the next step. It
 * never re-narrates the reply, never compiles a job list unless one is being
 * tracked, and never complains about the absence of a job.
 */
export function chiefReportLlm(fromName: unknown, short: unknown, opts: ChiefReportOpts = {}): string {
  const many = (opts.replies || []).filter((r) => r && String(r.text || "").trim());
  const stored = many.length ? many.map((r) => chiefReportStored(r.name, r.text)).join("\n") : chiefReportStored(fromName, short);
  const name = many.length ? "your teammates" : String(fromName || "Teammate").trim() || "Teammate";
  const asked = String(opts.asked || "").trim();
  const userAsk = String(opts.userAsk || "").trim();
  const handed = (opts.handed || []).map((h) => String(h || "").trim()).filter(Boolean);
  const context = [
    userAsk ? `The user asked you: "${userAsk.slice(0, 300)}"` : "",
    asked ? `You handed ${name}: "${asked.slice(0, 300)}"` : "",
    handed.length ? `Already handed out for this request (do NOT hand any of these out again — a teammate who has not replied yet is simply still working):\n${handed.map((h) => `- ${h.slice(0, 160)}`).join("\n")}` : "",
  ].filter(Boolean).join("\n");
  if (opts.followUp) {
    return `${context ? `${context}\n` : ""}${stored}

Follow-up from ${name}. The user can already see it in the team channel. Only send_message the user if it changes something they need to know; do not repeat ${name}'s words back. Do not message_teammate ${name} again for the same thing. If there is nothing to add, your one result is send_message with exactly ${SILENT} — it is dropped and the user never sees it. Then stop.`;
  }
  return `${context ? `${context}\n` : ""}${stored}

The user can already see ${name}'s reply in the team channel — do not repeat it back. Decide what, if anything, is left of what the user asked:
- Nothing left (the usual case for a one-piece ask): your one result is send_message with exactly ${SILENT}. It is dropped; the user never sees it. Never send "standing by", "waiting for your ask", "ready", or a question back to the user instead.
- Other teammates still owe replies: ${SILENT} as well, and wait.
- Everything is in and it needs combining (the user asked several teammates for one answer): send_message the user ONE short combined line.
- A next step is needed: take it (message_teammate) and stop.
A short or chatty reply that still answers ("Hello, ready to work") IS an answer — do not send ${name} anything about how they phrased it. If a job is being tracked, update_task the step that changed. Do not create a job for this, do not list_tasks, do not open Chrome or re-search unless ${name} said failed or blocked, and never mention whether a job exists or that you lack context — what was asked is written above.`;
}
