/** One line in a thread, as the Worker and the local store both spell it. */
export interface ChatMessage {
  id?: string;
  role?: string;
  ts?: number;
  content?: string;
  kind?: string;
}

export interface CloudDraftBot {
  id?: string;
  messages?: ChatMessage[];
  /** The Worker could not read this bot's thread; keep whatever we already had. */
  messagesFailed?: boolean;
}

export interface CloudDraft {
  computers?: unknown[];
  bots?: CloudDraftBot[];
}

/** Status lines like "desk brain starting" are not chat. Busy uses the working icon. */
export function isTransientChatStatus(m: ChatMessage | null | undefined): boolean {
  if (!m) return false;
  if (m.kind === "status") return true;
  return String(m.content || "").trim().toLowerCase() === "desk brain starting";
}

/** Union two cloud threads by id. Never replace a non-empty local list with []. */
export function mergeCloudMessages(
  prev: ChatMessage[] | null | undefined,
  incoming: ChatMessage[] | null | undefined,
): ChatMessage[] {
  const had = Array.isArray(prev) ? prev : [];
  if (!Array.isArray(incoming)) return had;
  if (!incoming.length && had.length) return had;
  const map = new Map<string, ChatMessage>();
  for (const m of [...had, ...incoming]) {
    if (!m) continue;
    const key = m.id || `${m.role || ""}:${m.ts || 0}:${String(m.content || "").slice(0, 48)}`;
    map.set(key, m);
  }
  return [...map.values()].sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0)).slice(-120);
}

export function mergeCloudDraft(prev: CloudDraft | null | undefined, next: CloudDraft | null | undefined): CloudDraft {
  if (!next || typeof next !== "object") return prev || { computers: [], bots: [] };
  const oldBots = prev?.bots || [];
  const bots = (next.bots || []).map((b) => {
    const old = oldBots.find((x) => x.id === b.id);
    if (b.messagesFailed) return { ...b, messages: old?.messages || b.messages || [] };
    return { ...b, messages: mergeCloudMessages(old?.messages, b.messages) };
  });
  return { ...next, bots };
}
