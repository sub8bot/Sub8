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

export function wrapWorkerDispatch({ who, role, text, followUp = false }: WorkerDispatch = {}): string {
  const name = String(who || "a teammate").trim() || "a teammate";
  const r = String(role || "teammate").trim() || "teammate";
  const body = String(text || "").trim();
  if (followUp) {
    return `${name} (${r}) sent a note. Use YOUR screen. Do not restart the search unless they said the last result was wrong or blocked.

${body}

If your step is already done, message_teammate ${name} one line and stop. Do not set update_task running again. Only update_task if status or detail actually changed. Then stop.`;
  }
  return `${name} (${r}) assigned you this. Use YOUR screen (your DISPLAY / Chrome), not theirs.

${body}

Start with update_task status=running. When finished: update_task status=done (or blocked) with a one-line detail, then message_teammate ${name} ONE short line. Do not write a long report to the chief. Long notes stay in your own chat. Web: browser navigate/snapshot/click. Then stop.`;
}

export function chiefReportStored(fromName: unknown, short: unknown): string {
  const name = String(fromName || "Teammate").trim() || "Teammate";
  return `${name} replies: ${String(short || "").trim()}`;
}

/** Extra flags `chiefReportLlm` accepts. */
export interface ChiefReportOpts {
  followUp?: boolean | undefined;
}

export function chiefReportLlm(fromName: unknown, short: unknown, opts: ChiefReportOpts = {}): string {
  const stored = chiefReportStored(fromName, short);
  if (opts.followUp) {
    return `${stored}

This is a follow-up reply from a teammate, not a new job. send_message the user their one-line answer. Do not list_tasks. Do not recompile the job. Do not message_teammate them again asking for the same thing. Then stop.`;
  }
  return `${stored}

This is a teammate report, not a new job and not a routine. Do not upsert_routine. Do not invent extra files. Do not open Chrome or re-search unless they said failed/blocked. list_tasks. Compile from those details (latest) for EVERY non-Summary step, including any you did yourself. send_message that list, update_task Summary done, and stop.`;
}
