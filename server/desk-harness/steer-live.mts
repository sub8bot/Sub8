/**
 * Mid-task steering on a desk (POST /steer in server.mts).
 *
 * One record per running /turn, keyed by the bot and X display it drives. POST
 * /steer pushes into that turn's TurnInbox (../steer.mts), which hands the line
 * to the live Claude session or interrupts and resumes Grok Build, and waits at
 * most STEER_WAIT_MS for the inbox to say delivered or not. A line that is not
 * delivered by then is taken back out, so the Worker, which still holds it, can
 * queue it without it running twice.
 */
import { TurnInbox } from "../steer.mjs";

const STEER_WAIT_MS = Number(process.env.DESK_HARNESS_STEER_WAIT_MS || 6000);

export interface SteerResult {
  id: string;
  delivered: boolean;
  reason?: string | undefined;
}

export interface LiveTurn {
  botId: string;
  display: number;
  inbox: TurnInbox;
  waiters: Map<string, (r: SteerResult) => void>;
}

export const liveTurns = new Set<LiveTurn>();

export function openLiveTurn(botId: string, display: number, opts: { debounceMs?: number; maxWaitMs?: number } = {}): LiveTurn {
  const waiters = new Map<string, (r: SteerResult) => void>();
  const live: LiveTurn = {
    botId,
    display,
    waiters,
    inbox: new TurnInbox({
      ...opts,
      onDelivery: (ids, state) => {
        if (!state) return;
        const settled = new Set<string>();
        for (const id of ids) {
          const done = waiters.get(id);
          if (!done) continue;
          waiters.delete(id);
          settled.add(id);
          done(state === "delivered" ? { id, delivered: true } : { id, delivered: false, reason: "not-steerable" });
        }
        // Not delivered: the caller queues it, so it must not also run here.
        if (state === "queued" && settled.size) live.inbox.nudges = live.inbox.nudges.filter((n) => !n.messageId || !settled.has(n.messageId));
      },
    }),
  };
  liveTurns.add(live);
  return live;
}

/**
 * The turn is over. Lines a caller is still waiting on go back to it as not
 * delivered; lines that were delivered but handed back (a failed Grok resume)
 * are returned for the done event.
 */
export function closeLiveTurn(live: LiveTurn): string[] {
  liveTurns.delete(live);
  const out: string[] = [];
  for (const n of live.inbox.drain()) {
    const done = n.messageId ? live.waiters.get(n.messageId) : undefined;
    if (done && n.messageId) {
      live.waiters.delete(n.messageId);
      done({ id: n.messageId, delivered: false, reason: "turn-ended" });
    } else if (String(n.text || "").trim()) out.push(n.text);
  }
  for (const [id, done] of live.waiters) done({ id, delivered: false, reason: "turn-ended" });
  live.waiters.clear();
  return out;
}

/** Normalize a /steer body's messages: strings or {id?, text}. */
function steerMessages(raw: unknown): Array<{ id: string; text: string }> {
  const list = Array.isArray(raw) ? raw : [];
  const out: Array<{ id: string; text: string }> = [];
  for (const m of list) {
    const text = String(typeof m === "string" ? m : (m as { text?: unknown; content?: unknown })?.text ?? (m as { content?: unknown })?.content ?? "").trim();
    if (!text) continue;
    const given = typeof m === "object" && m ? String((m as { id?: unknown }).id || "").trim() : "";
    out.push({ id: given || `steer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, text });
  }
  return out;
}

export async function steerLiveTurn(
  body: { botId?: unknown; display?: unknown; messages?: unknown },
  { waitMs = STEER_WAIT_MS }: { waitMs?: number } = {},
): Promise<{ delivered: boolean; reason?: string; results: SteerResult[] }> {
  const msgs = steerMessages(body.messages);
  if (!msgs.length) return { delivered: false, reason: "empty", results: [] };
  const botId = String(body.botId || "").trim();
  const display = Number(body.display) > 0 ? Number(body.display) : 0;
  const onDisplay = [...liveTurns].filter((l) => !display || l.display === display);
  const live = onDisplay.find((l) => !botId || l.botId === botId);
  if (!live) {
    const reason = onDisplay.length ? "other-bot" : "no-turn";
    return { delivered: false, reason, results: msgs.map((m) => ({ id: m.id, delivered: false, reason })) };
  }
  const results = await Promise.all(
    msgs.map(
      (m) =>
        new Promise<SteerResult>((resolve) => {
          const timer = setTimeout(() => {
            if (!live.waiters.has(m.id)) return;
            live.waiters.delete(m.id);
            live.inbox.nudges = live.inbox.nudges.filter((n) => n.messageId !== m.id);
            resolve({ id: m.id, delivered: false, reason: "timeout" });
          }, waitMs);
          timer.unref?.();
          live.waiters.set(m.id, (r) => {
            clearTimeout(timer);
            resolve(r);
          });
          live.inbox.push({ text: m.text, messageId: m.id });
        }),
    ),
  );
  const delivered = results.every((r) => r.delivered);
  const reason = delivered ? undefined : results.find((r) => !r.delivered)?.reason;
  return { delivered, ...(reason ? { reason } : {}), results };
}
