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
 * What a worker is handed when the lead sends it something: the fact of it.
 * The contract (do it; your final message is your answer and is delivered for
 * you) lives in the team system prompt — an instruction inside the message
 * only gets acknowledged back ("Got it, I'll…").
 */
export function wrapWorkerDispatch({ who, text }: WorkerDispatch = {}): string {
  const name = String(who || "your lead").trim() || "your lead";
  return `${name} (your lead): ${String(text || "").trim()}`;
}

export function chiefReportStored(fromName: unknown, short: unknown): string {
  const name = String(fromName || "Teammate").trim() || "Teammate";
  return `${name} replies: ${String(short || "").trim()}`;
}

/** Context handed to the lead with a teammate's reply, so it can decide. */
export interface ChiefReportOpts {
  /** The user's request that led to the delegation. */
  userAsk?: string | undefined;
  /** Everything the lead has handed out for that request ("Pixel: Say a random number"). */
  handed?: readonly string[] | undefined;
  /** All replies gathered for that request, delivered together. */
  replies?: readonly { name: string; text: string }[] | undefined;
}

/**
 * What the lead is handed when teammates answer: the facts — the user's
 * request, what it handed out, every reply. The principle (the user already
 * sees these; speak only to add something; nothing_to_add otherwise) lives in
 * the team system prompt, not here: an instruction inside the message gets
 * acknowledged back instead of followed.
 */
export function chiefReportLlm(fromName: unknown, short: unknown, opts: ChiefReportOpts = {}): string {
  const many = (opts.replies || []).filter((r) => r && String(r.text || "").trim());
  const stored = many.length ? many.map((r) => chiefReportStored(r.name, r.text)).join("\n") : chiefReportStored(fromName, short);
  const userAsk = String(opts.userAsk || "").trim();
  const handed = (opts.handed || []).map((h) => String(h || "").trim()).filter(Boolean);
  return [
    "Teammate report (this is not the user speaking):",
    userAsk ? `The user asked you: "${userAsk.slice(0, 300)}"` : "",
    handed.length ? `You handed out:\n${handed.map((h) => `- ${h.slice(0, 160)}`).join("\n")}` : "",
    stored,
    "(Nothing to add → nothing_to_add.)",
  ].filter(Boolean).join("\n");
}
