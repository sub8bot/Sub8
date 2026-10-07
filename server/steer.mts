/**
 * Mid-turn steering: chat lines that arrive while a bot is working on a turn.
 *
 * A turn owns one TurnInbox. The chat route pushes each line into it. What
 * happens next depends on the harness running the turn:
 *
 * - API-model tool loop: `pull()` at the top of every step hands the lines to
 *   the model (mode "pull").
 * - A CLI harness that can take input mid-session (Claude Code stream-json) or
 *   be interrupted and resumed (Grok Build `--resume`) attaches a SteerFn. The
 *   inbox debounces (lines within `debounceMs` go together) and hands them to
 *   that function, which delivers them into the SAME live session.
 * - Any other harness calls `unsupported()`: the lines stay queued and run as
 *   the next turn the moment this one ends, exactly as before.
 *
 * Every line with a message id gets a delivery state the UI shows under it:
 * "delivered" (in the running task), "queued" (runs when the task ends), or
 * null (cleared). Nothing is ever dropped: whatever was not delivered is
 * returned by `drain()` for the caller to run after the turn.
 */

export interface Nudge {
  text: string;
  /** The chat row this came from; only rows with an id carry a delivery state. */
  messageId?: string | undefined;
}

/**
 * Hand these lines to the running session. True means the harness took them
 * (written to its input, or an interrupt + resume is under way). False means it
 * cannot right now; the lines stay queued for after the turn.
 */
export type SteerFn = (texts: string[]) => boolean;

export type DeliveryState = "delivered" | "queued" | null;

/** What runTurn and the CLI runners see of the inbox. */
export interface SteeringHooks {
  /** The harness can take lines mid-session from now on. */
  attach(fn: SteerFn): void;
  /** The live session is over (or about to be); later lines wait for the next turn. */
  detach(): void;
  /** This harness cannot be steered; lines run when the turn ends. */
  unsupported(): void;
  /** Lines a harness accepted but could not deliver after all (a resume failed). */
  requeue(texts: string[]): void;
}

export interface TurnInboxOptions {
  debounceMs?: number | undefined;
  /** Upper bound on how long the first line of a burst waits. */
  maxWaitMs?: number | undefined;
  onDelivery?: ((messageIds: string[], state: DeliveryState) => void) | undefined;
}

type Mode = "pending" | "pull" | "steer" | "queue";

export class TurnInbox {
  nudges: Nudge[] = [];
  private mode: Mode = "pending";
  private steerFn: SteerFn | null = null;
  private timer: NodeJS.Timeout | null = null;
  private firstAt = 0;
  private closed = false;
  private readonly debounceMs: number;
  private readonly maxWaitMs: number;
  private readonly onDelivery: (ids: string[], state: DeliveryState) => void;

  constructor({ debounceMs = 1500, maxWaitMs = 4000, onDelivery }: TurnInboxOptions = {}) {
    this.debounceMs = debounceMs;
    this.maxWaitMs = maxWaitMs;
    this.onDelivery = (ids, state) => {
      if (!ids.length || !onDelivery) return;
      try {
        onDelivery(ids, state);
      } catch {
        /* a UI note must never break a turn */
      }
    };
  }

  push(n: Nudge): void {
    this.nudges.push(n);
    if (this.closed) return;
    if (this.mode === "queue") {
      this.mark([n], "queued");
      return;
    }
    if (this.mode === "steer") this.schedule();
  }

  /** The API tool loop: everything waiting goes into the next model call. */
  pull(): string[] {
    if (this.mode === "pending") this.mode = "pull";
    const took = this.nudges.splice(0);
    this.mark(took, "delivered");
    return took.map((n) => n.text);
  }

  get hooks(): SteeringHooks {
    return {
      attach: (fn) => this.attach(fn),
      detach: () => this.detach(),
      unsupported: () => this.unsupported(),
      requeue: (texts) => this.requeue(texts),
    };
  }

  attach(fn: SteerFn): void {
    if (this.closed) return;
    this.steerFn = fn;
    this.mode = "steer";
    if (this.nudges.length) this.schedule();
  }

  detach(): void {
    this.steerFn = null;
    this.clearTimer();
    if (this.closed) return;
    this.mode = "queue";
    this.mark(this.nudges, "queued");
  }

  unsupported(): void {
    this.detach();
  }

  requeue(texts: string[]): void {
    const back = texts.map((text) => ({ text }));
    this.nudges.unshift(...back);
  }

  /** Deliver whatever is waiting now (the debounce timer calls this). */
  flush(): boolean {
    this.clearTimer();
    if (this.closed || this.mode !== "steer" || !this.steerFn || !this.nudges.length) return false;
    const batch = this.nudges.splice(0);
    let ok = false;
    try {
      ok = this.steerFn(batch.map((n) => n.text));
    } catch {
      ok = false;
    }
    if (ok) {
      this.mark(batch, "delivered");
      return true;
    }
    // The session would not take them: they wait for the end of the turn.
    this.nudges.unshift(...batch);
    this.steerFn = null;
    this.mode = "queue";
    this.mark(batch, "queued");
    return false;
  }

  /** The turn is over: whatever was not delivered, for the caller to run next. */
  drain(): Nudge[] {
    this.closed = true;
    this.steerFn = null;
    this.clearTimer();
    return this.nudges.splice(0);
  }

  private schedule(): void {
    const now = Date.now();
    if (!this.timer) this.firstAt = now;
    this.clearTimer();
    const wait = Math.max(0, Math.min(this.debounceMs, this.firstAt + this.maxWaitMs - now));
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, wait);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private mark(list: Nudge[], state: DeliveryState): void {
    const ids = list.map((n) => n.messageId).filter((x): x is string => Boolean(x));
    this.onDelivery(ids, state);
  }
}

/** The prompt a resumed or live session gets with the new lines. */
export function steerPrompt(texts: readonly string[]): string {
  const body = texts.map((t) => String(t || "").trim()).filter(Boolean).join("\n\n");
  return (
    `New message(s) arrived while you were working (from the user unless marked as a teammate):\n\n${body}\n\n` +
    "If they change what you should do, follow them. If they ask something, answer briefly with send_message type=text, then keep going. Otherwise continue the task you were doing."
  );
}
