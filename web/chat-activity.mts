/** One activity or chat row, as the thread stores it. */
export type ChatActivityMsg = {
  role?: string | undefined;
  kind?: string | undefined;
  name?: string | undefined;
  action?: string | undefined;
  summary?: string | undefined;
  content?: string | undefined;
};

/** Client busy flags. `serverBusy` / `clientTurn` / `liveTool` stay in the browser. */
export type ChatBusyBot = {
  busy?: boolean | undefined;
  serverBusy?: boolean | undefined;
  clientTurn?: boolean | undefined;
  liveTool?: ChatActivityMsg | null | undefined;
};

export type ChatBusyEvent =
  | { type: "send" }
  | { type: "stop" }
  | { type: "error" }
  | { type: "bot"; busy?: boolean | undefined }
  | { type: "tool"; name?: string | undefined; args?: { action?: string | undefined } | undefined }
  | { type: "message"; msg?: ChatActivityMsg | undefined };

const GENERIC_WORKING = /^(working(?:\s+via\s+\S+)?|working on the computer)$/i;

function title(s: string): string {
  const t = s.replaceAll("_", " ").trim();
  if (!t) return "";
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** The CLI harness reports MCP tools as `mcp__sub8__vault_fill` and its own as `ToolSearch`; strip that to the tool. */
export function toolKey(name: string): string {
  const raw = String(name || "").trim();
  const m = /^mcp__[a-z0-9_-]+?__(.+)$/i.exec(raw);
  return (m ? m[1]! : raw).toLowerCase();
}

/** Progressive labels for the sub8 tools (and the CLI's own), by tool key. */
const TOOL_LABELS: Record<string, string> = {
  vault_list: "Checking saved logins",
  vault_fill: "Pasting the password",
  show_user: "Sharing a screenshot",
  ask_user: "Asking you a question",
  request_box_help: "Asking you to take control",
  memory: "Checking my notes",
  list_tasks: "Checking my tasks",
  update_task: "Updating a task",
  set_job: "Setting the job",
  list_routines: "Checking routines",
  upsert_routine: "Saving a routine",
  disable_routine: "Pausing a routine",
  delete_routine: "Removing a routine",
  list_teammates: "Checking the team",
  create_teammate: "Bringing in a teammate",
  message_teammate: "Messaging a teammate",
  delete_teammate: "Closing a teammate",
  rename_bot: "Renaming",
  update_bot: "Updating my settings",
  web_search: "Searching the web",
  web_fetch: "Reading a page",
  read: "Reading a file",
  await_shell: "Waiting on a command",
  task: "Starting a background task",
  check_subagent: "Checking a background task",
  create_channel: "Creating a channel",
  update_channel: "Updating a channel",
  nothing_to_add: "Nothing to add",
  toolsearch: "Picking tools",
  bash: "Running a command",
  websearch: "Searching the web",
  webfetch: "Reading a page",
};

function actionLabel(name: string, action: string): string {
  const n = toolKey(name);
  const a = action.toLowerCase();
  if (n === "vault_fill" && a === "username") return "Pasting the username";
  if (TOOL_LABELS[n] && n !== "computer" && n !== "browser" && n !== "shell") return TOOL_LABELS[n]!;
  if (a === "screenshot") return "Looked at the screen";
  if (a === "open") return "Opened Chrome";
  if (a === "snapshot") return "Read the page";
  if (n === "browser") {
    if (a === "click") return "Browser click";
    if (a === "wait") return "Browser wait";
    if (a) return `Browser ${a}`;
  }
  if (a === "click" || a === "left_click") return "Clicked";
  if (a === "double_click") return "Double-clicked";
  if (a === "right_click") return "Right-clicked";
  if (a === "type") return "Typed";
  if (a === "key") return "Pressed a key";
  if (a === "scroll") return "Scrolled";
  if (a === "mouse_move") return "Moved the pointer";
  if (a === "wait") return "Waited";
  if (a === "shell" || n === "shell") return "Ran a command";
  return title(a) || title(n.replace(/_/g, " "));
}

export function isActivityRow(m: ChatActivityMsg | null | undefined): boolean {
  if (!m) return false;
  return m.kind === "think" || m.kind === "tool" || m.role === "activity";
}

export function isGenericWorkingLabel(s: string): boolean {
  return GENERIC_WORKING.test(s.trim());
}

export function activityLabel(m: ChatActivityMsg | null | undefined): string {
  if (!m) return "Starting…";
  const summary = String(m.summary || "").trim();
  const name = String(m.name || "").trim();
  const action = String(m.action || "").trim();
  if (summary && !isGenericWorkingLabel(summary)) return summary;
  if (isGenericWorkingLabel(summary) && (action === "screenshot" || (!action && name === "computer"))) {
    return "Starting on the computer";
  }
  return actionLabel(name, action) || "Starting…";
}

export function lastActivity(messages: ChatActivityMsg[] | null | undefined): ChatActivityMsg | null {
  const rows = Array.isArray(messages) ? messages : [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const m = rows[i];
    // A step from before the user's latest message belongs to the last turn,
    // not this one: "Opened Chrome" from an hour ago is not what it is doing now.
    if (m && m.role === "user") return null;
    if (m && isActivityRow(m) && m.kind !== "think") return m;
  }
  return null;
}

export function liveBusyLabel(opts: {
  busy?: boolean | undefined;
  messages?: ChatActivityMsg[] | null | undefined;
  liveTool?: ChatActivityMsg | null | undefined;
}): string | null {
  if (!opts.busy) return null;
  if (opts.liveTool) return activityLabel(opts.liveTool);
  const last = lastActivity(opts.messages);
  if (last) return activityLabel(last);
  return "Starting…";
}

export function isTurnClosingAssistant(m: ChatActivityMsg | null | undefined): boolean {
  if (!m || m.role !== "assistant") return false;
  if (m.kind === "tool" || m.kind === "think" || m.kind === "choices" || m.kind === "secret-request") return false;
  const text = String(m.content || "").trim();
  if (!text) return false;
  if (/^Created \S+ on this desk to /i.test(text)) return false;
  if (/^Created \S+ to /i.test(text)) return false;
  if (/^To [^:]+: FIRST TASK/i.test(text)) return false;
  if (/^Still working on my computer/i.test(text)) return false;
  if (/^Got it\. I'll use that while I keep working/i.test(text)) return false;
  return true;
}

export function applyChatBusy(bot: ChatBusyBot, event: ChatBusyEvent): ChatBusyBot {
  if (event.type === "send") {
    bot.clientTurn = true;
    bot.serverBusy = true;
    bot.busy = true;
    bot.liveTool = null;
    return bot;
  }
  if (event.type === "stop" || event.type === "error") {
    bot.clientTurn = false;
    bot.serverBusy = false;
    bot.busy = false;
    bot.liveTool = null;
    return bot;
  }
  if (event.type === "bot") {
    if (typeof event.busy === "boolean") {
      bot.serverBusy = event.busy;
      bot.busy = event.busy;
      if (!event.busy) {
        bot.clientTurn = false;
        bot.liveTool = null;
      }
    }
    return bot;
  }
  if (event.type === "tool") {
    if (event.name === "send_message") return bot;
    if (bot.serverBusy === false && !bot.clientTurn) return bot;
    bot.busy = true;
    bot.liveTool = { name: event.name, action: event.args?.action };
    return bot;
  }
  if (event.type === "message") {
    const msg = event.msg;
    if (isActivityRow(msg)) {
      bot.liveTool = msg;
      if (bot.clientTurn || bot.serverBusy !== false) bot.busy = true;
      return bot;
    }
    if (isTurnClosingAssistant(msg)) {
      bot.busy = false;
      bot.clientTurn = false;
      bot.liveTool = null;
    }
    return bot;
  }
  return bot;
}

/** A row the transcript renders as a notice instead of a normal reply. */
export type ChatNoticeKind = "limit" | "error" | "system";

export type ChatNoticeMsg = ChatActivityMsg & {
  id?: string | undefined;
  ts?: number | undefined;
  image?: string | undefined;
  speakerName?: string | undefined;
  speakerId?: string | undefined;
  toId?: string | undefined;
};

/**
 * A usage or rate limit the harness hit, as the harness worded it: "You've hit
 * your weekly limit · resets Oct 3, 4pm (UTC)", "Claude usage limit reached.
 * Your limit will reset at 5pm", "Rate limit exceeded". Null for anything else.
 * `scope` is the window when the text names one ("weekly", "5-hour").
 */
export function usageLimitInfo(text: unknown): { scope: string; reset: string } | null {
  const t = String(text ?? "").trim();
  if (!t || t.length > 600) return null;
  const hit =
    /\b(?:you['’]?ve|you have)\s+(?:hit|reached|used up)\s+(?:your\s+)?([a-z0-9-]+(?:\s[a-z0-9-]+)?\s+)?(?:usage\s+)?limit\b/i.exec(t) ||
    /\b(?:([a-z0-9-]+)\s+)?usage limit (?:reached|exceeded|hit)\b/i.exec(t) ||
    /^(?:error:?\s*)?(?:429\s*)?(?:api\s+)?()(?:rate|quota) limit(?:ed| reached| exceeded)?\b/i.exec(t) ||
    /^(?:error:?\s*)?(?:you(?:'re| are)\s+)?()(?:out of|no more) (?:credits|usage|extra usage|quota)\b/i.exec(t);
  if (!hit) return null;
  let scope = String(hit[1] || "").trim().toLowerCase();
  if (/^(your|the|a|claude|grok|codex|api|usage)$/.test(scope)) scope = "";
  const r = /\b(?:resets?|will reset|reset)\s+(?:at\s+|on\s+|in\s+)?([^.\n·]+(?:\([^)]*\))?)/i.exec(t);
  const reset = r ? r[1]!.trim().replace(/[\s,;:]+$/, "") : "";
  return { scope, reset };
}

const ERROR_LEAD =
  /^(?:error\b|⚠|could not\b|couldn['’]t\b|failed\b|cloud chat failed|the (?:harness|desk|brain|model) (?:exited|crashed|failed|stopped)|harness (?:exited|failed|crashed)|request failed|timed out\b|turn (?:failed|timed out))/i;

/** Classify an assistant/system row as a notice, or null for a normal reply. */
export function chatNoticeKind(m: ChatNoticeMsg | null | undefined): ChatNoticeKind | null {
  if (!m) return null;
  if (m.role !== "assistant" && m.role !== "system") return null;
  if (m.kind && m.kind !== "error" && m.kind !== "notice" && m.kind !== "system") return null;
  const text = String(m.content || "").trim();
  if (!text || m.image) return null;
  if (usageLimitInfo(text)) return "limit";
  if (m.kind === "error" || (text.length <= 400 && ERROR_LEAD.test(text))) return "error";
  if (m.kind === "system" || m.kind === "notice" || m.role === "system" || /^stopped\.?$/i.test(text)) return "system";
  return null;
}

/**
 * The key two rows must share to fold into one "×N" bubble. Notices fold when
 * near-identical (case, spacing and numbers ignored, so "resets Oct 3" and
 * "resets Oct 4" still fold); plain assistant replies fold only when the text
 * is exactly the same. User rows, cards and screenshots never fold.
 */
export function chatRepeatKey(m: ChatNoticeMsg | null | undefined): string {
  if (!m || (m.role !== "assistant" && m.role !== "system")) return "";
  if (m.image || m.toId) return "";
  if (m.kind && m.kind !== "error" && m.kind !== "notice" && m.kind !== "system") return "";
  const text = String(m.content || "").trim();
  if (!text) return "";
  const kind = chatNoticeKind(m);
  const who = String(m.speakerId || m.speakerName || "");
  if (kind) {
    const norm = text.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ");
    return `${kind}:${who}:${norm}`;
  }
  return `same:${who}:${text}`;
}

export type ChatRun<T> = { first: T; last: T; items: T[]; skipped: T[] };

/**
 * Fold consecutive rows that share a repeat key into runs. Activity rows
 * (think/tool) sitting between two members of the same run are absorbed into
 * it, so a routine that does a step and then hits the same limit every ten
 * minutes still reads as one bubble. Everything else passes through as a run
 * of one, in order.
 */
export function collapseRepeats<T extends ChatNoticeMsg>(rows: T[], keyOf: (m: T) => string = chatRepeatKey): ChatRun<T>[] {
  const out: ChatRun<T>[] = [];
  let i = 0;
  while (i < rows.length) {
    const m = rows[i]!;
    const key = keyOf(m);
    const run: ChatRun<T> = { first: m, last: m, items: [m], skipped: [] };
    i += 1;
    if (key) {
      for (;;) {
        let j = i;
        while (j < rows.length && isActivityRow(rows[j])) j += 1;
        if (j < rows.length && keyOf(rows[j]!) === key) {
          run.skipped.push(...rows.slice(i, j));
          run.items.push(rows[j]!);
          run.last = rows[j]!;
          i = j + 1;
          continue;
        }
        break;
      }
    }
    out.push(run);
  }
  return out;
}

/** "12s", "1:05", "1:02:09" for a running turn. */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/** Seconds after which a turn still on its first label offers Stop and Retry. */
export const TURN_STALL_MS = 45_000;
/** Seconds before the working row starts showing elapsed time. */
export const TURN_CLOCK_AFTER_MS = 4_000;

/**
 * What the working row says for a turn that has been running `elapsed` ms
 * with `label` as its live step. A turn that never got past "Starting…" by
 * TURN_STALL_MS is called out as stalled so the UI can offer a way out.
 */
export function workingRowState(label: string, elapsed: number): { text: string; clock: string; stalled: boolean } {
  const starting = /^starting\b/i.test(label.trim());
  const stalled = starting && elapsed >= TURN_STALL_MS;
  return {
    text: stalled ? "Still starting…" : label,
    clock: elapsed >= TURN_CLOCK_AFTER_MS ? formatElapsed(elapsed) : "",
    stalled,
  };
}
